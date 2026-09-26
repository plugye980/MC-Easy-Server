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
const addonMeta = require('./addon-meta');
const world = require('./world');
const forge = require('./forge');
const { fileHash } = require('./http');
const backup = require('./backup');
const reach = require('./reachability');
const { download } = require('./http');
const { ErrorTranslator, stripColors } = require('./errors');

const NAME = '([A-Za-z0-9_.]{2,17})';
const RE = {
  // 앞의 [시간] [스레드/레벨] [로거] 묶음을 모두 떼어낸다 (Forge 는 로거 이름이 하나 더 붙는다)
  message: /^(?:\[[^\]]*\]\s*)+:?\s*(.*)$/,
  done: /Done \([\d.,]+s\)!/,
  // 서버 본체가 항상 남기는 줄 — 플러그인이 입장/퇴장 문구를 바꿔도 그대로 나온다
  login: new RegExp(`^${NAME}\\[[^\\]]*\\] logged in with entity id`),
  lost: new RegExp(`^${NAME} lost connection`),
  // 입장/퇴장 문구: 칭호 등이 앞에 붙어도("[관리자] Steve joined the game") 잡는다
  join: new RegExp(`(?:^|[\\s\\]>])${NAME} joined the game`),
  leave: new RegExp(`(?:^|[\\s\\]>])${NAME} left the game`),
  chat: /^(?:\[Not Secure\]\s*)?<[^>]+>/,
  uuid: new RegExp(`UUID of player ${NAME} is ([0-9a-f-]{36})`, 'i'),
  list: /There are (\d+) of a max(?: of)? (\d+) players online:?\s*(.*)$/i,
  tpsPaper: /TPS from last 1m, 5m, 15m:\s*\*?([\d.]+)/i,
  mspt: /Average time per tick:\s*([\d.]+)\s*ms/i,
  forgeTps: /Overall\s*:\s*Mean tick time:\s*[\d.]+\s*ms\.\s*Mean TPS:\s*([\d.]+)/i,
  saved: /Saved the (?:game|world)|All dimensions are saved/i,
};
// 앱이 주기적으로 보내는 명령의 응답은 콘솔에 보여주지 않는다
const POLL_NOISE = [RE.list, RE.tpsPaper, RE.mspt, /Mean tick time/i, /The game is running normally|Target tick rate|Percentiles:|^P50|Current Memory Usage/i];

const addonKey = (a) => a.projectId || `file:${a.fileName}`;

const os = require('os');
const AGENT_SRC = path.join(__dirname, 'assets', optimize.AGENT_JAR);

/** 힙 측정 에이전트를 서버 폴더에 둔다 (asar 안에서도 읽을 수 있게 read/write 로 복사) */
function installAgent(dir) {
  try {
    const data = fs.readFileSync(AGENT_SRC);
    const dest = path.join(dir, optimize.AGENT_JAR);
    if (!fs.existsSync(dest) || fs.statSync(dest).size !== data.length) fs.writeFileSync(dest, data);
    return true;
  } catch {
    return false;
  }
}

/** 서버 파일 준비: 보통은 server.jar 로 받고, Forge 는 설치 프로그램을 받아 --installServer 로 설치한다 */
async function fetchServerFiles(dir, jar, javaBin, onProgress, jarName = 'server.jar') {
  const target = jar.installer ? jar.fileName : jarName;
  await download(jar.url, path.join(dir, target), {
    sha256: jar.sha256,
    sha1: jar.sha1,
    onProgress: ({ received, total }) => onProgress({ text: jar.installer ? 'Forge 설치 프로그램 내려받는 중' : '서버 파일 내려받는 중', percent: total ? received / total : 0 }),
  });
  if (!jar.installer) return;
  onProgress({ text: 'Forge 설치 중 (라이브러리 내려받기, 1~3분)', percent: 0.5 });
  await forge.runInstaller(dir, javaBin, jar.fileName, (line) => onProgress({ text: `Forge 설치 중 — ${line.trim().slice(0, 70)}`, percent: 0.5 }));
  forge.cleanupInstaller(dir, jar.fileName);
}

const MOD_TYPES = ['forge', 'fabric'];

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
      metrics: { tps: i.metrics.tps, memoryMb: i.metrics.memoryMb, processMb: i.metrics.processMb, cpu: i.metrics.cpu },
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
    if (!o.eula) throw new Error('EULA 동의 필요');
    if (!['paper', 'forge', 'fabric', 'vanilla'].includes(o.type)) throw new Error('서버 종류 선택 필요');
    // 맵 설정은 서버 파일을 받기 전에 먼저 검사한다
    const w = o.world || { type: 'normal' };
    if (w.source !== 'import' && w.type === 'flat') world.validateFlat(w.flat);
    const id = crypto.randomUUID();
    const dir = this.dir(id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      onProgress({ text: '필요한 Java 버전 확인 중', percent: 0 });
      const javaMajor = await versions.requiredJava(o.version);
      const rt = await java.ensure(javaMajor, onProgress);

      onProgress({ text: '서버 파일 정보 가져오는 중', percent: 0 });
      const jar = await versions.serverJar(o.type, o.version);
      await fetchServerFiles(dir, jar, rt.bin, onProgress);
      if (jar.installer && !forge.launchArgs(dir, o.version, jar.build)) throw new Error('Forge 설치 후 실행 파일을 찾지 못함');

      // 포트: 다른 서버와 겹치지 않게
      const taken = Servers.all().map((s) => s.port);
      const port = await reach.findFreePort(Number(o.settings && o.settings.port) || 25565, taken);

      const memoryMb = Number(o.memoryMb) || system.specs().recommendedMb;
      const s = o.settings || {};
      const distances = system.recommendDistances(memoryMb, Number(s.maxPlayers) || 10);
      const values = {
        ...(o.optimize !== false ? optimize.propertyDefaults() : {}),
        ...props.toProperties({ ...s, port, viewDistance: distances.viewDistance, simulationDistance: distances.simulationDistance }),
        ...(w.source === 'import' ? {} : world.toProperties(w, o.version)),
        'level-name': 'world',
      };
      props.write(path.join(dir, 'server.properties'), values);
      // 다른 맵 가져오기
      if (w.source === 'import' && w.importPath) {
        onProgress({ text: '맵 가져오는 중', percent: 0 });
        await world.importInto(dir, 'world', w.importPath);
      }
      fs.writeFileSync(path.join(dir, 'eula.txt'), `# https://aka.ms/MinecraftEULA 에 동의함 (MCES)\neula=true\n`);

      const server = {
        id,
        name: (o.name || '').trim() || `${o.version} ${o.type === 'paper' ? '플러그인' : MOD_TYPES.includes(o.type) ? '모드' : '바닐라'} 서버`,
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

      // 모드 서버: 서버 최적화 모드 기본 설치 (Forge: ModernFix·FerriteCore / Fabric: Fabric API·Lithium·FerriteCore)
      const optMods = { forge: optimize.FORGE_OPTIMIZATION_MODS, fabric: optimize.FABRIC_OPTIMIZATION_MODS }[server.type];
      if (optMods && server.optimize) {
        for (const slug of optMods) {
          try {
            await this.installAddon(id, slug, onProgress);
          } catch (e) {
            this.emit('notice', { id, severity: 'info', title: '최적화 모드 일부 설치 건너뜀', message: `${slug}: ${e.message}` });
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
    if (!server) throw new Error('서버 없음');
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
      // 실제 힙 사용량을 읽기 위한 GC 로그 (이전 실행 기록은 지운다)
      fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
      fs.rmSync(path.join(dir, optimize.GC_LOG), { force: true });
      fs.rmSync(path.join(dir, optimize.HEAP_FILE), { force: true });
      const agent = installAgent(dir) ? optimize.agentArgs() : [];
      i.metrics.memoryMb = null; // 첫 GC 전까지는 측정 중
      // Forge 는 설치 때 만들어진 인자 파일(@...args.txt) 또는 forge jar 로 켠다
      let launch = ['-jar', 'server.jar'];
      if (server.type === 'forge') {
        launch = forge.launchArgs(dir, server.version, server.build);
        if (!launch) throw new Error('Forge 실행 파일 없음 — 업데이트 버튼으로 같은 버전을 다시 설치');
      }
      const args = [...flags, ...optimize.gcLogArgs(rt.major || server.javaMajor), ...agent, ...launch, 'nogui'];
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
    } else if ((r = RE.forgeTps.exec(msg))) {
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
    // 채팅("<Steve> Bob joined the game")은 입장/퇴장으로 보지 않는다
    const chat = RE.chat.test(msg);
    if (!chat && (r = RE.login.exec(msg) || RE.join.exec(msg))) {
      if (!i.players.has(r[1])) {
        const uuid = i.pendingUuid && i.pendingUuid[r[1]];
        i.players.set(r[1], { name: r[1], uuid: uuid || null, joinedAt: Date.now() });
        this.emitServer(id);
      }
    } else if (!chat && (r = RE.lost.exec(msg) || RE.leave.exec(msg))) {
      if (i.players.delete(r[1])) this.emitServer(id);
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
        this.emit('notice', { id, severity: 'info', title: 'Paper 최적화 설정 적용', message: '다음 실행부터 적용' });
      }
    }
    this.poll(id);
    // 그래프가 바로 선을 그릴 수 있게 두 번째 측정을 앞당긴다
    i.timers.push(setTimeout(() => this.poll(id), 1500));
    i.timers.push(setInterval(() => this.poll(id), 5000));
    i.timers.push(setInterval(() => this.sendPoll(id, 'list'), 10000));
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
      else if (server.type === 'forge' && versions.compareVersions(server.version, '1.20.3') < 0) this.sendPoll(id, 'forge tps');
      else if (versions.compareVersions(server.version, '1.20.3') >= 0) this.sendPoll(id, 'tick query');
    }
    try {
      const u = await pidusage(i.proc.pid);
      // 프로세스 메모리(RSS): -Xms=-Xmx · AlwaysPreTouch 때문에 늘 할당량 근처 → 참고용으로만
      i.metrics.processMb = Math.round(u.memory / 1024 / 1024);
      // pidusage 는 코어 하나를 100% 로 센다 → PC 전체 대비 비율로 바꾼다
      i.metrics.cpu = Math.min(100, Math.round(u.cpu / Math.max(1, os.cpus().length)));
    } catch { /* 종료 중 */ }
    // 실제 힙 사용량: 에이전트의 현재 값 → 없으면 마지막 GC 직후 값
    const heap = this.readHeap(id);
    if (heap) {
      i.metrics.memoryMb = heap.usedMb;
      i.metrics.heapBeforeMb = heap.beforeMb;
    }
    i.metrics.history.push({ t: Date.now(), tps: i.metrics.tps, memoryMb: i.metrics.memoryMb, cpu: i.metrics.cpu });
    if (i.metrics.history.length > 180) i.metrics.history.shift();
    this.emit('metrics', { serverId: id, ...i.metrics, history: undefined, point: i.metrics.history[i.metrics.history.length - 1] });
  }

  /** 현재 힙 사용량: 에이전트 파일을 먼저, 없거나 오래됐으면 GC 로그 끝부분 */
  readHeap(id) {
    try {
      const now = optimize.parseHeapFile(fs.readFileSync(path.join(this.dir(id), optimize.HEAP_FILE), 'utf8'));
      if (now) return { usedMb: now.usedMb, beforeMb: null, source: 'agent' };
    } catch { /* 아직 파일 없음 */ }
    const file = path.join(this.dir(id), optimize.GC_LOG);
    try {
      const size = fs.statSync(file).size;
      const len = Math.min(size, 16384);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      fs.closeSync(fd);
      return optimize.parseGcLog(buf.toString('utf8'));
    } catch {
      return null;
    }
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
    i.metrics.memoryMb = null;
    i.metrics.processMb = null;
    i.startedAt = null;
    try { pidusage.clear(); } catch { /* 무시 */ }
    this.log(id, `■ 서버 종료 (종료 코드 ${code})`, 'app');
    if (!wasStopping && code !== 0) {
      this.emit('alert', {
        serverId: id,
        id: `crash-${Date.now()}`,
        severity: 'error',
        title: '서버 비정상 종료',
        message: '위 안내 먼저 확인. 자세한 로그는 콘솔 탭',
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
          this.log(id, '제한 시간 초과 — 강제 종료', 'error');
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
    if (!i.proc) throw new Error('서버 꺼짐');
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
    if (!/^[A-Za-z0-9_.]{2,17}$/.test(name)) throw new Error('잘못된 플레이어 이름');
    const cmds = {
      kick: `kick ${name} 관리자에 의해 퇴장`,
      op: `op ${name}`,
      deop: `deop ${name}`,
      'whitelist-add': `whitelist add ${name}`,
      'whitelist-remove': `whitelist remove ${name}`,
      ban: `ban ${name}`,
      pardon: `pardon ${name}`,
    };
    if (!cmds[action]) throw new Error('알 수 없는 동작');
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
      const byId = new Map((s.addons || []).map((a) => [addonKey(a), a]));
      for (const a of result.installed) {
        const old = byId.get(addonKey(a));
        if (old && old.fileName !== a.fileName) modrinth.removeFile(s, this.dir(id), old.fileName);
        byId.set(addonKey(a), old ? { ...a, dependencyOf: old.dependencyOf } : a);
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
      addons: [...(s.addons || []).filter((a) => !hit.installed.some((x) => addonKey(x) === addonKey(a))), ...hit.installed],
    }));
    this.emitServer(id);
    return hit;
  }

  /**
   * 설치된 목록 + 폴더에 직접 넣은 파일.
   * 직접 추가한 파일은 파일 안의 정보(plugin.yml / fabric.mod.json)로 호환 여부와 빠진 의존성을 붙인다.
   */
  async addons(id) {
    const server = Servers.get(id);
    const dir = this.dir(id);
    const folder = path.join(dir, modrinth.addonFolder(server));
    const locate = (fileName) => {
      const on = path.join(folder, fileName);
      return fs.existsSync(on) ? on : fs.existsSync(`${on}.disabled`) ? `${on}.disabled` : null;
    };
    const list = [...(server.addons || []), ...modrinth.scanFolder(server, dir)];
    for (const a of list) {
      if (a.projectId) continue;
      if (!a.meta) {
        const file = locate(a.fileName);
        a.meta = file ? await addonMeta.inspect(file) : { kind: null, error: '파일 없음' };
        if (a.meta.name) a.title = a.meta.name;
        if (a.meta.version && !a.versionNumber) a.versionNumber = a.meta.version;
      }
      a.compat = addonMeta.compat(a.meta, server.type, server.version);
    }
    const enabled = list.filter((a) => a.enabled);
    for (const a of list) a.missing = a.meta ? addonMeta.missingDependencies(a.meta, enabled) : [];
    return list;
  }

  /**
   * 파일에서 직접 추가 (Modrinth 에 없는 플러그인·모드).
   * 같은 파일이 Modrinth 에 있으면 Modrinth 설치와 똑같이 기록해 업데이트·호환성 검사를 그대로 쓴다.
   * @returns {Promise<{added: object[], rejected: {file: string, reason: string}[]}>}
   */
  async importFiles(id, files) {
    const server = Servers.get(id);
    const dir = this.dir(id);
    const folder = path.join(dir, modrinth.addonFolder(server));
    fs.mkdirSync(folder, { recursive: true });
    const ext = server.type === 'vanilla' ? /\.zip$/i : /\.jar$/i;
    const added = [];
    const rejected = [];
    for (const src of files) {
      const base = path.basename(src);
      if (!ext.test(base)) {
        rejected.push({ file: base, reason: server.type === 'vanilla' ? '데이터팩(.zip)만 가능' : '.jar 파일만 가능' });
        continue;
      }
      const meta = await addonMeta.inspect(src);
      const c = addonMeta.compat(meta, server.type, server.version);
      // 종류가 다른 파일(모드 서버에 플러그인 등)은 넣지 않는다. 버전만 안 맞는 파일은 넣되 꺼 둔다
      if (c.status === 'bad' && c.wrongType) {
        rejected.push({ file: base, reason: c.reason });
        continue;
      }
      const dest = path.join(folder, base);
      if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
      fs.rmSync(`${dest}.disabled`, { force: true });
      const sha1 = await fileHash(dest, 'sha1');
      const sha512 = await fileHash(dest, 'sha512');

      let record = null;
      try {
        const version = await modrinth.lookupByHash(sha1);
        if (version) {
          const project = await modrinth.project(version.project_id);
          const file = version.files.find((f) => f.hashes.sha1 === sha1) || version.files[0];
          record = modrinth.recordFromVersion(project, version, { ...file, filename: base }, { importedFromFile: true });
        }
      } catch { /* 오프라인이면 파일 정보로만 */ }
      if (!record) {
        record = {
          projectId: null,
          source: 'file',
          title: meta.name || base.replace(ext, ''),
          versionNumber: meta.version || null,
          fileName: base,
          size: fs.statSync(dest).size,
          sha1,
          sha512,
          meta,
          // 모드팩 내보내기용: 서버 전용 모드는 접속하는 쪽에 필요 없다
          clientSide: meta.environment === 'server' ? 'unsupported' : 'required',
          enabled: true,
          installedAt: Date.now(),
        };
      }
      if (c.status === 'bad') {
        record.enabled = false;
        fs.renameSync(dest, `${dest}.disabled`);
      }
      Servers.update(id, (s) => ({
        ...s,
        addons: [...(s.addons || []).filter((a) => a.fileName !== base && addonKey(a) !== addonKey(record)), record],
      }));
      added.push({ title: record.title, fileName: base, fromModrinth: !!record.projectId, compat: c, enabled: record.enabled });
    }
    this.emitServer(id);
    return { added, rejected, needsRestart: this.inst(id).status !== 'stopped' };
  }

  /** 직접 추가한 파일들이 목표 버전에서 쓸 수 있는지 (파일 정보 기준) */
  async fileCompat(id, targetVersion) {
    const server = Servers.get(id);
    const list = (await this.addons(id)).filter((a) => !a.projectId && a.enabled);
    const out = { compatible: [], incompatible: [], unknown: [] };
    for (const a of list) {
      const c = addonMeta.compat(a.meta, server.type, targetVersion);
      const item = { title: a.title, fileName: a.fileName, reason: c.reason };
      if (c.status === 'ok') out.compatible.push(item);
      else if (c.status === 'bad') out.incompatible.push(item);
      else out.unknown.push(item);
    }
    return out;
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
    if (!file) throw new Error(`"${name}" 파일 없음 — 플러그인 탭에서 직접 끄기`);
    this.setAddonEnabled(id, file, false);
    return file;
  }

  /** Fabric 모드 id로 파일을 찾아 끈다 (jar 안의 fabric.mod.json은 열지 않고 이름으로 추정) */
  async disableModById(id, modId) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const all = await this.addons(id);
    // 직접 추가한 모드는 fabric.mod.json 의 id 로 정확히 찾는다
    const hit = all.find((a) => (a.meta && a.meta.id === modId) || norm(a.slug || '') === norm(modId) || norm(a.fileName).startsWith(norm(modId)));
    if (!hit) throw new Error(`"${modId}" 모드 파일 없음 — 모드 탭에서 직접 끄기`);
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
    const files = target === server.version ? { compatible: [], incompatible: [], unknown: [] } : await this.fileCompat(id, target);
    return {
      target,
      latest,
      available: list,
      sameVersion: target === server.version,
      incompatible: [...compat.incompatible.map((a) => ({ title: a.title, fileName: a.fileName })), ...files.incompatible],
      compatible: [...compat.compatible.map((a) => ({ title: a.title, fileName: a.fileName })), ...files.compatible],
      unknown: files.unknown,
      javaChange: (await versions.requiredJava(target)) !== server.javaMajor,
    };
  }

  async applyUpdate(id, targetVersion, onProgress = () => {}) {
    const server = Servers.get(id);
    if (versions.compareVersions(targetVersion, server.version) < 0) throw new Error('낮은 버전으로 되돌리기 불가 (월드 손상 위험)');
    const wasRunning = !!this.inst(id).proc;
    if (wasRunning) await this.stop(id);
    const dir = this.dir(id);
    onProgress({ text: '업데이트 전에 월드 백업 중', percent: 0 });
    try {
      await backup.create(id, dir, server.levelName, 'before-update');
    } catch { /* 월드가 없으면 건너뜀 */ }

    const javaMajor = await versions.requiredJava(targetVersion);
    const rt = await java.ensure(javaMajor, onProgress);
    const jar = await versions.serverJar(server.type, targetVersion);
    if (jar.installer) {
      await fetchServerFiles(dir, jar, rt.bin, onProgress);
    } else {
      await fetchServerFiles(dir, jar, rt.bin, onProgress, 'server.jar.new');
      fs.renameSync(path.join(dir, 'server.jar.new'), path.join(dir, 'server.jar'));
    }

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
    if (versionChanged) {
      // 직접 추가한 파일: 새 버전과 맞지 않는다고 표시된 것은 꺼 둔다
      const files = await this.fileCompat(id, targetVersion);
      for (const a of files.incompatible) this.setAddonEnabled(id, a.fileName, false);
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

  // ---------- 맵(월드) ----------
  worldInfo(id) {
    const server = Servers.get(id);
    const dir = this.dir(id);
    const p = props.read(path.join(dir, 'server.properties'));
    return { ...world.fromProperties(p), exists: !!world.worldInfoAt(path.join(dir, server.levelName)), saved: world.worldInfoAt(path.join(dir, server.levelName)) };
  }

  async inspectWorldSource(id, src) {
    const server = id ? Servers.get(id) : null;
    return world.inspectSource(src, server ? server.version : null);
  }

  /** 다른 맵으로 바꾸기: 지금 월드는 먼저 백업 */
  async importWorld(id, src) {
    if (this.inst(id).proc) throw new Error('맵을 바꾸려면 먼저 서버 끄기');
    const server = Servers.get(id);
    const dir = this.dir(id);
    try {
      await backup.create(id, dir, server.levelName, 'before-import');
    } catch { /* 월드가 없으면 건너뜀 */ }
    const r = await world.importInto(dir, server.levelName, src);
    this.emit('backup', { serverId: id });
    this.emitServer(id);
    return r;
  }

  /** 새 설정으로 월드 다시 만들기: 지금 월드는 백업 후 지우고, 다음 실행 때 새로 생성된다 */
  async regenerateWorld(id, w) {
    if (this.inst(id).proc) throw new Error('월드를 다시 만들려면 먼저 서버 끄기');
    const server = Servers.get(id);
    if (w.type === 'flat') world.validateFlat(w.flat);
    const dir = this.dir(id);
    try {
      await backup.create(id, dir, server.levelName, 'before-reset');
    } catch { /* 월드가 없으면 건너뜀 */ }
    world.deleteWorld(dir, server.levelName);
    props.write(path.join(dir, 'server.properties'), world.toProperties(w, server.version));
    this.emit('backup', { serverId: id });
    this.emitServer(id);
    return this.worldInfo(id);
  }

  listBackups(id) {
    return backup.list(id);
  }

  async restoreBackup(id, file) {
    if (this.inst(id).proc) throw new Error('복원은 서버를 끈 뒤 가능');
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
