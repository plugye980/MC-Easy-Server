'use strict';
// 서버 생성 · 실행 · 정지 · 삭제 · 업데이트, 접속자 · 성능 · 자동 백업
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const pidusage = require('pidusage');

const paths = require('./paths');
const { Servers } = require('./store');
const versions = require('./versions');
const java = require('./java');
const system = require('./system');
const props = require('./properties');
const optimize = require('./optimize');
const modrinth = require('./modrinth');
const backup = require('./backup');
const reach = require('./reachability');
const { download } = require('./http');
const { ErrorTranslator, stripColors } = require('./errors');

const NAME = '([A-Za-z0-9_.]{2,17})';
const RE = {
  message: /^\[[^\]]*\]\s*(?:\[[^\]]*\]\s*)?:?\s*(.*)$/,
  done: /Done \([\d.,]+s\)!/,
  join: new RegExp(`^${NAME} joined the game`),
  leave: new RegExp(`^${NAME} left the game`),
  uuid: new RegExp(`UUID of player ${NAME} is ([0-9a-f-]{36})`, 'i'),
  list: /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)$/i,
  tpsPaper: /TPS from last 1m, 5m, 15m:\s*\*?([\d.]+)/i,
  mspt: /Average time per tick:\s*([\d.]+)\s*ms/i,
  saved: /Saved the (?:game|world)|All dimensions are saved/i,
};
// 앱이 주기적으로 보내는 명령의 응답은 콘솔에 보여주지 않는다
const POLL_NOISE = [RE.list, RE.tpsPaper, RE.mspt, /The game is running normally|Target tick rate|Percentiles:|^P50|Current Memory Usage/i];

const DEFAULT_BACKUP = { enabled: true, intervalMin: 30, keep: 10, onStop: true };

class Instance {
  constructor(id) {
    this.id = id;
    this.proc = null;
    this.status = 'stopped'; // stopped | starting | running | stopping
    this.players = new Map(); // name -> { name, uuid, joinedAt }
    this.console = [];
    this.metrics = { tps: null, memoryMb: 0, cpu: 0, history: [] };
    this.translator = new ErrorTranslator();
    this.timers = [];
    this.pollUntil = 0;
    this.waiters = [];
    this.startedAt = null;
  }
}

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.instances = new Map();
  }

  inst(id) {
    if (!this.instances.has(id)) this.instances.set(id, new Instance(id));
    return this.instances.get(id);
  }

  dir(id) {
    return paths.serverDir(id);
  }

  // ---------- 조회 ----------
  describe(server) {
    const i = this.inst(server.id);
    const settings = props.fromProperties(props.read(path.join(this.dir(server.id), 'server.properties')));
    return {
      ...server,
      settings,
      status: i.status,
      players: [...i.players.values()],
      metrics: { tps: i.metrics.tps, memoryMb: i.metrics.memoryMb, cpu: i.metrics.cpu },
      startedAt: i.startedAt,
    };
  }

  list() {
    return Servers.all().map((s) => this.describe(s));
  }

  get(id) {
    const s = Servers.get(id);
    return s ? this.describe(s) : null;
  }

  history(id) {
    return this.inst(id).metrics.history;
  }

  consoleLines(id) {
    return this.inst(id).console;
  }

  emitServer(id) {
    const s = this.get(id);
    if (s) this.emit('server', s);
  }

  // ---------- 생성 ----------
  /**
   * @param {object} o { name, type, version, memoryMb, eula, optimize, settings:{...friendly} }
   */
  async create(o, onProgress = () => {}) {
    if (!o.eula) throw new Error('EULA에 동의해야 서버를 만들 수 있어요.');
    if (!['paper', 'fabric', 'vanilla'].includes(o.type)) throw new Error('서버 종류를 골라 주세요.');
    const id = crypto.randomUUID();
    const dir = this.dir(id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      onProgress({ text: '필요한 Java 버전 확인 중', percent: 0 });
      const javaMajor = await versions.requiredJava(o.version);
      await java.ensure(javaMajor, onProgress);

      onProgress({ text: '서버 파일 정보 가져오는 중', percent: 0 });
      const jar = await versions.serverJar(o.type, o.version);
      await download(jar.url, path.join(dir, 'server.jar'), {
        sha256: jar.sha256,
        sha1: jar.sha1,
        onProgress: ({ received, total }) => onProgress({ text: '서버 파일 내려받는 중', percent: total ? received / total : 0 }),
      });

      // 포트: 다른 서버와 겹치지 않게
      const taken = Servers.all().map((s) => s.port);
      const port = await reach.findFreePort(Number(o.settings && o.settings.port) || 25565, taken);

      const memoryMb = Number(o.memoryMb) || system.specs().recommendedMb;
      const s = o.settings || {};
      const distances = system.recommendDistances(memoryMb, Number(s.maxPlayers) || 10);
      const values = {
        ...(o.optimize !== false ? optimize.propertyDefaults() : {}),
        ...props.toProperties({ ...s, port, viewDistance: distances.viewDistance, simulationDistance: distances.simulationDistance }),
        'level-name': 'world',
      };
      props.write(path.join(dir, 'server.properties'), values);
      fs.writeFileSync(path.join(dir, 'eula.txt'), `# https://aka.ms/MinecraftEULA 에 동의함 (MC Easy Server)\neula=true\n`);

      const server = {
        id,
        name: (o.name || '').trim() || `${o.version} ${o.type === 'paper' ? '플러그인' : o.type === 'fabric' ? '모드' : '바닐라'} 서버`,
        type: o.type,
        version: o.version,
        build: jar.build || null,
        loaderVersion: jar.loader || null,
        javaMajor,
        memoryMb,
        port,
        optimize: o.optimize !== false,
        optimizedApplied: false,
        levelName: 'world',
        addons: [],
        backup: { ...DEFAULT_BACKUP },
        network: { mode: 'tunnel', address: null },
        createdAt: Date.now(),
      };
      Servers.save(server);

      // Fabric: 서버 최적화 모드 기본 설치
      if (server.type === 'fabric' && server.optimize) {
        for (const slug of optimize.FABRIC_OPTIMIZATION_MODS) {
          try {
            await this.installAddon(id, slug, onProgress);
          } catch (e) {
            this.emit('notice', { id, severity: 'info', title: '최적화 모드 일부를 건너뛰었어요', message: `${slug}: ${e.message}` });
          }
        }
      }
      onProgress({ text: '완료', percent: 1 });
      this.emitServer(id);
      return this.get(id);
    } catch (e) {
      if (!Servers.get(id)) fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  // ---------- 실행 ----------
  async start(id) {
    const server = Servers.get(id);
    if (!server) throw new Error('서버를 찾을 수 없어요.');
    const i = this.inst(id);
    if (i.proc) return;
    const dir = this.dir(id);
    i.status = 'starting';
    i.translator.reset();
    i.players.clear();
    this.emitServer(id);

    try {
      // 같은 포트를 쓰는 다른 서버가 켜져 있는지 먼저 확인
      if (!(await reach.isPortFree(server.port))) {
        i.status = 'stopped';
        this.emitServer(id);
        this.emit('alert', { serverId: id, ...i.translator.check('FAILED TO BIND TO PORT') });
        return;
      }
      const rt = await java.ensure(server.javaMajor, (p) => this.emit('progress', { serverId: id, ...p }));
      if (server.type === 'paper' && server.optimize && !server.optimizedApplied) {
        if (optimize.applyPaperConfigs(dir)) Servers.update(id, { optimizedApplied: true });
      }
      const flags = server.optimize ? optimize.aikarFlags(server.memoryMb) : optimize.plainFlags(server.memoryMb);
      const args = [...flags, '-jar', 'server.jar', 'nogui'];
      this.log(id, `▶ ${path.basename(rt.bin)} ${args.join(' ')}`, 'app');
      const proc = spawn(rt.bin, args, { cwd: dir, windowsHide: true });
      i.proc = proc;
      i.startedAt = Date.now();

      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const l of lines) this.onLine(id, l);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => this.log(id, `실행 실패: ${e.message}`, 'error'));
      proc.on('exit', (code) => this.onExit(id, code));
    } catch (e) {
      i.status = 'stopped';
      this.emitServer(id);
      throw e;
    }
  }

  log(id, line, kind = 'out') {
    const i = this.inst(id);
    const entry = { t: Date.now(), line, kind };
    i.console.push(entry);
    if (i.console.length > 2000) i.console.splice(0, i.console.length - 2000);
    this.emit('console', { serverId: id, ...entry });
  }

  onLine(id, raw) {
    const i = this.inst(id);
    const line = stripColors(raw);
    const m = RE.message.exec(line);
    const msg = (m ? m[1] : line).trim();
    const polling = Date.now() < i.pollUntil;

    // 성능·접속자 응답 처리
    let noise = false;
    let r;
    if ((r = RE.tpsPaper.exec(msg))) {
      this.setTps(id, Math.min(20, parseFloat(r[1])));
      noise = polling;
    } else if ((r = RE.mspt.exec(msg))) {
      const mspt = parseFloat(r[1]);
      this.setTps(id, mspt > 0 ? Math.min(20, 1000 / mspt) : 20);
      noise = polling;
    } else if ((r = RE.list.exec(msg))) {
      const names = r[3].split(',').map((x) => x.trim().replace(/\s*\(.*\)$/, '')).filter(Boolean);
      const now = new Map();
      for (const n of names) now.set(n, i.players.get(n) || { name: n, uuid: null, joinedAt: Date.now() });
      i.players = now;
      this.emitServer(id);
      noise = polling;
    } else if (polling && POLL_NOISE.some((re) => re.test(msg))) {
      noise = true;
    }
    if ((r = RE.uuid.exec(msg))) {
      const p = i.players.get(r[1]) || { name: r[1], joinedAt: Date.now() };
      i.pendingUuid = { ...(i.pendingUuid || {}), [r[1]]: r[2] };
      p.uuid = r[2];
    }
    if ((r = RE.join.exec(msg))) {
      const uuid = i.pendingUuid && i.pendingUuid[r[1]];
      i.players.set(r[1], { name: r[1], uuid: uuid || null, joinedAt: Date.now() });
      this.emitServer(id);
    } else if ((r = RE.leave.exec(msg))) {
      i.players.delete(r[1]);
      this.emitServer(id);
    }
    if (RE.saved.test(msg)) i.waiters.filter((w) => w.re.test(msg)).forEach((w) => w.resolve());

    if (i.status === 'starting' && RE.done.test(msg)) this.onReady(id);

    if (!noise) this.log(id, line);
    const alert = i.translator.check(line);
    if (alert) this.emit('alert', { serverId: id, ...alert });
  }

  waitFor(id, re, timeout) {
    const i = this.inst(id);
    return new Promise((resolve) => {
      const w = { re, resolve: () => { clearTimeout(t); i.waiters = i.waiters.filter((x) => x !== w); resolve(true); } };
      const t = setTimeout(() => { i.waiters = i.waiters.filter((x) => x !== w); resolve(false); }, timeout);
      i.waiters.push(w);
    });
  }

  onReady(id) {
    const i = this.inst(id);
    const server = Servers.get(id);
    i.status = 'running';
    this.emitServer(id);
    this.emit('ready', { serverId: id });
    // Paper 설정 파일은 첫 실행 때 생기므로, 생긴 직후 최적값을 넣어 다음 실행부터 적용한다
    if (server.type === 'paper' && server.optimize && !server.optimizedApplied) {
      if (optimize.applyPaperConfigs(this.dir(id))) {
        Servers.update(id, { optimizedApplied: true });
        this.emit('notice', { id, severity: 'info', title: 'Paper 최적화 설정을 넣었어요', message: '다음에 서버를 다시 켤 때부터 적용돼요.' });
      }
    }
    this.poll(id);
    i.timers.push(setInterval(() => this.poll(id), 5000));
    i.timers.push(setInterval(() => this.sendPoll(id, 'list'), 30000));
    this.scheduleBackup(id);
  }

  sendPoll(id, cmd) {
    const i = this.inst(id);
    if (!i.proc || i.status !== 'running') return;
    i.pollUntil = Date.now() + 2500;
    i.proc.stdin.write(`${cmd}\n`);
  }

  async poll(id) {
    const i = this.inst(id);
    if (!i.proc) return;
    const server = Servers.get(id);
    // TPS: Paper는 tps, 그 외(1.20.3+)는 tick query의 평균 틱 시간을 TPS로 바꾼다
    i.pollTick = (i.pollTick || 0) + 1;
    if (i.pollTick % 2 === 1) {
      if (server.type === 'paper') this.sendPoll(id, 'tps');
      else if (versions.compareVersions(server.version, '1.20.3') >= 0) this.sendPoll(id, 'tick query');
    }
    try {
      const u = await pidusage(i.proc.pid);
      i.metrics.memoryMb = Math.round(u.memory / 1024 / 1024);
      i.metrics.cpu = Math.round(u.cpu);
    } catch { /* 종료 중 */ }
    i.metrics.history.push({ t: Date.now(), tps: i.metrics.tps, memoryMb: i.metrics.memoryMb, cpu: i.metrics.cpu });
    if (i.metrics.history.length > 180) i.metrics.history.shift();
    this.emit('metrics', { serverId: id, ...i.metrics, history: undefined, point: i.metrics.history[i.metrics.history.length - 1] });
  }

  setTps(id, tps) {
    this.inst(id).metrics.tps = Math.round(tps * 10) / 10;
  }

  async onExit(id, code) {
    const i = this.inst(id);
    const wasStopping = i.status === 'stopping';
    i.timers.forEach(clearInterval);
    i.timers = [];
    i.proc = null;
    i.status = 'stopped';
    i.players.clear();
    i.metrics.tps = null;
    i.metrics.memoryMb = 0;
    i.startedAt = null;
    try { pidusage.clear(); } catch { /* 무시 */ }
    this.log(id, `■ 서버가 멈췄어요 (종료 코드 ${code})`, 'app');
    if (!wasStopping && code !== 0) {
      this.emit('alert', {
        serverId: id,
        id: `crash-${Date.now()}`,
        severity: 'error',
        title: '서버가 예기치 않게 꺼졌어요',
        message: '위에 나온 안내가 있으면 먼저 확인해 주세요. 콘솔 탭에서 자세한 로그를 볼 수 있어요.',
        actions: [{ id: 'open-tab', label: '콘솔 보기', payload: { tab: 'console' } }],
      });
    }
    this.emitServer(id);
    i.exitResolvers && i.exitResolvers.forEach((r) => r());
    i.exitResolvers = [];
    const server = Servers.get(id);
    if (server && server.backup && server.backup.onStop && i.ranLongEnough) {
      try {
        const b = await backup.create(id, this.dir(id), server.levelName, 'stop');
        backup.prune(id, server.backup.keep);
        this.emit('backup', { serverId: id, backup: b });
      } catch (e) {
        this.log(id, `정지 백업 실패: ${e.message}`, 'error');
      }
    }
    i.ranLongEnough = false;
  }

  /** 저장 후 정지. timeout 안에 안 꺼지면 그때만 강제 종료한다. */
  stop(id, timeout = 90000) {
    const i = this.inst(id);
    if (!i.proc) return Promise.resolve();
    i.ranLongEnough = i.status === 'running';
    i.status = 'stopping';
    this.emitServer(id);
    return new Promise((resolve) => {
      i.exitResolvers = [...(i.exitResolvers || []), resolve];
      try {
        i.proc.stdin.write('stop\n');
      } catch { /* 이미 닫힘 */ }
      const proc = i.proc;
      setTimeout(() => {
        if (i.proc === proc) {
          this.log(id, '제한 시간 안에 멈추지 않아 강제로 종료해요.', 'error');
          proc.kill('SIGKILL');
        }
      }, timeout);
    });
  }

  async restart(id) {
    await this.stop(id);
    await this.start(id);
  }

  async stopAll() {
    await Promise.all([...this.instances.values()].filter((i) => i.proc).map((i) => this.stop(i.id)));
  }

  anyRunning() {
    return [...this.instances.values()].some((i) => i.proc);
  }

  command(id, cmd) {
    const i = this.inst(id);
    if (!i.proc) throw new Error('서버가 꺼져 있어요.');
    const clean = String(cmd).replace(/^\//, '').replace(/[\r\n]/g, ' ').trim();
    if (!clean) return;
    this.log(id, `> ${clean}`, 'cmd');
    i.proc.stdin.write(`${clean}\n`);
  }

  // ---------- 접속자 ----------
  playerLists(id) {
    const dir = this.dir(id);
    const read = (f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return [];
      }
    };
    return {
      ops: read('ops.json').map((x) => x.name),
      whitelist: read('whitelist.json').map((x) => x.name),
      banned: read('banned-players.json').map((x) => x.name),
    };
  }

  playerAction(id, action, name) {
    if (!/^[A-Za-z0-9_.]{2,17}$/.test(name)) throw new Error('플레이어 이름이 올바르지 않아요.');
    const cmds = {
      kick: `kick ${name} 서버 관리자에 의해 퇴장되었습니다`,
      op: `op ${name}`,
      deop: `deop ${name}`,
      'whitelist-add': `whitelist add ${name}`,
      'whitelist-remove': `whitelist remove ${name}`,
      ban: `ban ${name}`,
      pardon: `pardon ${name}`,
    };
    if (!cmds[action]) throw new Error('알 수 없는 동작이에요.');
    this.command(id, cmds[action]);
    setTimeout(() => this.emit('players-changed', { serverId: id }), 800);
  }

  // ---------- 설정 ----------
  updateSettings(id, patch) {
    const server = Servers.get(id);
    const { memoryMb, name, optimize: opt, backup: bk, network, ...friendly } = patch;
    const next = { ...server };
    if (memoryMb) next.memoryMb = Number(memoryMb);
    if (name !== undefined) next.name = String(name).trim() || server.name;
    if (opt !== undefined) next.optimize = !!opt;
    if (bk) next.backup = { ...server.backup, ...bk };
    if (network) next.network = { ...server.network, ...network };
    if (friendly.port !== undefined) next.port = Number(friendly.port);
    Servers.save(next);
    if (Object.keys(friendly).length) props.write(path.join(this.dir(id), 'server.properties'), props.toProperties(friendly));
    if (bk) this.scheduleBackup(id);
    this.emitServer(id);
    return this.get(id);
  }

  // ---------- 삭제 ----------
  async remove(id, { keepBackups = false } = {}) {
    const i = this.inst(id);
    if (i.proc) await this.stop(id);
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    if (!keepBackups) fs.rmSync(paths.serverBackups(id), { recursive: true, force: true });
    Servers.remove(id);
    this.instances.delete(id);
    this.emit('removed', { serverId: id });
  }

  // ---------- 추가 기능 (플러그인 / 모드 / 데이터팩) ----------
  async installAddon(id, projectId, onProgress = () => {}) {
    const server = Servers.get(id);
    const result = await modrinth.install(server, this.dir(id), projectId, onProgress);
    Servers.update(id, (s) => {
      const byId = new Map((s.addons || []).map((a) => [a.projectId, a]));
      for (const a of result.installed) {
        const old = byId.get(a.projectId);
        if (old && old.fileName !== a.fileName) modrinth.removeFile(s, this.dir(id), old.fileName);
        byId.set(a.projectId, old ? { ...a, dependencyOf: old.dependencyOf } : a);
      }
      return { ...s, addons: [...byId.values()] };
    });
    this.emitServer(id);
    return { ...result, needsRestart: this.inst(id).status !== 'stopped' };
  }

  async installByName(id, name, onProgress) {
    const server = Servers.get(id);
    const hit = await modrinth.installByName(server, this.dir(id), name, onProgress);
    Servers.update(id, (s) => ({
      ...s,
      addons: [...(s.addons || []).filter((a) => !hit.installed.some((x) => x.projectId === a.projectId)), ...hit.installed],
    }));
    this.emitServer(id);
    return hit;
  }

  addons(id) {
    const server = Servers.get(id);
    return [...(server.addons || []), ...modrinth.scanFolder(server, this.dir(id))];
  }

  setAddonEnabled(id, fileName, enabled) {
    const server = Servers.get(id);
    modrinth.setEnabled(server, this.dir(id), fileName, enabled);
    Servers.update(id, (s) => ({ ...s, addons: (s.addons || []).map((a) => (a.fileName === fileName ? { ...a, enabled } : a)) }));
    this.emitServer(id);
  }

  removeAddon(id, fileName) {
    const server = Servers.get(id);
    modrinth.removeFile(server, this.dir(id), fileName);
    Servers.update(id, (s) => ({ ...s, addons: (s.addons || []).filter((a) => a.fileName !== fileName) }));
    this.emitServer(id);
  }

  async disablePluginByName(id, name) {
    const server = Servers.get(id);
    const file = await modrinth.findPluginFileByName(server, this.dir(id), name);
    if (!file) throw new Error(`"${name}" 파일을 찾지 못했어요. 추가 기능 탭에서 직접 꺼 주세요.`);
    this.setAddonEnabled(id, file, false);
    return file;
  }

  /** Fabric 모드 id로 파일을 찾아 끈다 (jar 안의 fabric.mod.json은 열지 않고 이름으로 추정) */
  disableModById(id, modId) {
    const server = Servers.get(id);
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const all = this.addons(id);
    const hit = all.find((a) => norm(a.slug || '') === norm(modId) || norm(a.fileName).startsWith(norm(modId)));
    if (!hit) throw new Error(`"${modId}" 모드 파일을 찾지 못했어요. 추가 기능 탭에서 직접 꺼 주세요.`);
    this.setAddonEnabled(id, hit.fileName, false);
    return hit.fileName;
  }

  async updateAddons(id) {
    const server = Servers.get(id);
    const { updates } = await modrinth.checkCompatibility(server, server.version);
    for (const u of updates) await this.installAddon(id, u.addon.projectId);
    return updates.length;
  }

  // ---------- 서버 업데이트 ----------
  async checkUpdate(id, targetVersion) {
    const server = Servers.get(id);
    const { versions: list, latest } = await versions.listVersions(server.type);
    const target = targetVersion || latest;
    if (versions.compareVersions(target, server.version) < 0) {
      return { target, downgrade: true, incompatible: [], compatible: [], latest, available: list };
    }
    let compat = { compatible: [], incompatible: [], updates: [] };
    if (target !== server.version && (server.addons || []).length) {
      compat = await modrinth.checkCompatibility(server, target);
    }
    const manual = modrinth.scanFolder(server, this.dir(id)).filter((a) => a.enabled);
    return {
      target,
      latest,
      available: list,
      sameVersion: target === server.version,
      incompatible: compat.incompatible.map((a) => ({ title: a.title, fileName: a.fileName })),
      compatible: compat.compatible.map((a) => ({ title: a.title, fileName: a.fileName })),
      unknown: target === server.version ? [] : manual.map((a) => ({ title: a.title, fileName: a.fileName })),
      javaChange: (await versions.requiredJava(target)) !== server.javaMajor,
    };
  }

  async applyUpdate(id, targetVersion, onProgress = () => {}) {
    const server = Servers.get(id);
    if (versions.compareVersions(targetVersion, server.version) < 0) throw new Error('낮은 버전으로는 되돌릴 수 없어요 (월드가 손상될 수 있어요).');
    const wasRunning = !!this.inst(id).proc;
    if (wasRunning) await this.stop(id);
    const dir = this.dir(id);
    onProgress({ text: '업데이트 전에 월드 백업 중', percent: 0 });
    try {
      await backup.create(id, dir, server.levelName, 'before-update');
    } catch { /* 월드가 없으면 건너뜀 */ }

    const javaMajor = await versions.requiredJava(targetVersion);
    await java.ensure(javaMajor, onProgress);
    const jar = await versions.serverJar(server.type, targetVersion);
    await download(jar.url, path.join(dir, 'server.jar.new'), {
      sha256: jar.sha256,
      sha1: jar.sha1,
      onProgress: ({ received, total }) => onProgress({ text: '새 서버 파일 내려받는 중', percent: total ? received / total : 0 }),
    });
    fs.renameSync(path.join(dir, 'server.jar.new'), path.join(dir, 'server.jar'));

    const versionChanged = targetVersion !== server.version;
    Servers.update(id, { version: targetVersion, build: jar.build || null, loaderVersion: jar.loader || server.loaderVersion, javaMajor });

    // 추가 기능: 새 버전에 맞는 파일로 교체, 맞는 게 없으면 비활성화
    if (versionChanged && (server.addons || []).length) {
      const updated = Servers.get(id);
      const { incompatible, updates } = await modrinth.checkCompatibility({ ...updated, version: server.version }, targetVersion);
      for (const u of updates) {
        onProgress({ text: `${u.addon.title} 새 버전으로 교체 중`, percent: 0 });
        try { await this.installAddon(id, u.addon.projectId); } catch { /* 다음 */ }
      }
      for (const a of incompatible) this.setAddonEnabled(id, a.fileName, false);
    }
    onProgress({ text: '업데이트 완료', percent: 1 });
    this.emitServer(id);
    if (wasRunning) await this.start(id);
    return this.get(id);
  }

  // ---------- 백업 ----------
  scheduleBackup(id) {
    const i = this.inst(id);
    if (i.backupTimer) clearInterval(i.backupTimer);
    i.backupTimer = null;
    const server = Servers.get(id);
    if (!server || !server.backup || !server.backup.enabled || i.status !== 'running') return;
    i.backupTimer = setInterval(() => this.backupNow(id, 'auto').catch((e) => this.log(id, `자동 백업 실패: ${e.message}`, 'error')), Math.max(5, server.backup.intervalMin) * 60 * 1000);
    i.timers.push(i.backupTimer);
  }

  async backupNow(id, reason = 'manual') {
    const server = Servers.get(id);
    const i = this.inst(id);
    const running = i.proc && i.status === 'running';
    if (running) {
      i.proc.stdin.write('save-off\n');
      const saved = this.waitFor(id, RE.saved, 20000);
      i.proc.stdin.write('save-all flush\n');
      await saved;
    }
    try {
      const b = await backup.create(id, this.dir(id), server.levelName, reason);
      if (reason === 'auto') backup.prune(id, server.backup.keep);
      this.emit('backup', { serverId: id, backup: b });
      return b;
    } finally {
      if (running && i.proc) i.proc.stdin.write('save-on\n');
    }
  }

  listBackups(id) {
    return backup.list(id);
  }

  async restoreBackup(id, file) {
    if (this.inst(id).proc) throw new Error('복원하려면 먼저 서버를 꺼 주세요.');
    const server = Servers.get(id);
    await backup.restore(id, this.dir(id), server.levelName, file);
    this.emit('backup', { serverId: id });
  }

  deleteBackup(id, file) {
    backup.remove(id, file);
    this.emit('backup', { serverId: id });
  }
}

module.exports = { ServerManager, RE };
