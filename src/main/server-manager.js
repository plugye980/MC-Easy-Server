'use strict';
const { StringDecoder } = require('string_decoder');
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
const serverImport = require('./server-import');
const gamerules = require('./gamerules');
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
const CONSOLE_LOG = 'mces-console.log';
const CONSOLE_LOG_PREV = 'mces-console.prev.log';

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

/** 이번 실행 중 생긴 Java 충돌 기록(hs_err_pid*.log)의 요약 */
function findCrashReport(dir, since) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^hs_err_pid\d+\.log$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => !since || x.t >= since - 2000)
      .sort((a, b) => b.t - a.t);
    if (!files.length) return null;
    const text = fs.readFileSync(path.join(dir, files[0].f), 'utf8');
    // 머리말의 원인 부분만 (# 으로 시작하는 줄)
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith('#') && l.replace(/#/g, '').trim()).slice(0, 12);
    return { file: files[0].f, lines };
  } catch {
    return null;
  }
}

/** 이번 실행에서 서버가 낸 마지막 오류 줄 (예외 이름이나 ERROR 줄). 원인을 담은 "Caused by" 를 우선 */
function lastErrorLine(entries, since) {
  const run = entries.filter((e) => e.kind === 'out' && (!since || e.t >= since));
  const pick = (re) => [...run].reverse().find((e) => re.test(e.line));
  const hit = pick(/^\s*Caused by: /) || pick(/(?:Exception|Error)(?::|\s|$)/) || pick(/\/(?:ERROR|FATAL)\]|\b(?:ERROR|FATAL|SEVERE)\b/);
  if (!hit) return null;
  const text = hit.line.replace(/^(?:\[[^\]]*\]\s*)+:?\s*/, '').replace(/^\s*Caused by:\s*/, '').trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

/** 종료 코드를 쉬운 말로. 모르면 null */
function explainExit(code, { quiet, crash }) {
  if (crash) return 'Java가 충돌로 종료 → 메모리를 낮추거나 최적화 옵션을 끄고 다시 실행. 계속되면 서버 폴더의 hs_err_pid 로그 확인';
  // Windows NTSTATUS (부호 없는/있는 값 모두)
  const u = code === null || code === undefined ? null : code >>> 0;
  if (u === 0xc0000005) return 'Java 메모리 접근 오류(0xC0000005)로 종료 → 백신 프로그램 예외 등록 또는 최적화 옵션을 끄고 다시 실행';
  if (u === 0xc0000409 || u === 0xc0000374) return 'Java가 비정상 종료 → 최적화 옵션을 끄고 다시 실행';
  if (u === 0xc0000142 || u === 0xc0000135) return 'Java를 실행하지 못함 → 설정에서 Java를 다시 받기';
  if (code === 137 || code === -9) return '운영체제가 서버를 강제 종료 (메모리 부족 가능) → 메모리를 낮춰 다시 실행';
  if (quiet) return `출력 없이 종료 (코드 ${code}) → 백신 프로그램이 Java 실행을 막았는지 확인하거나 최적화 옵션을 끄고 다시 실행`;
  return null;
}

/** 앱에서 정한 게임 규칙 값 (예전 형식 ruleOverrides·pendingRules 도 합친다) */
function desiredRules(server) {
  const out = {};
  for (const [k, o] of Object.entries(server.ruleOverrides || {})) out[k] = o && typeof o === 'object' ? o.value : o;
  Object.assign(out, server.pendingRules || {}, server.gameRules || {});
  return out;
}
const rulesPatch = (desired) => ({ gameRules: Object.keys(desired).length ? desired : undefined, ruleOverrides: undefined, pendingRules: undefined });

/** 설정 명령의 대답 (바닐라 문구) */
const SETTING_OK = /is now set to|is currently set to|difficulty has been set|difficulty did not change|default game ?mode is now|Whitelist is (?:now|already) turned|Nothing changed/i;
const SETTING_ERROR = /Unknown or incomplete command|Incorrect argument for command|Unknown game ?rule|Unknown dimension|Invalid (?:integer|boolean)|Expected (?:integer|boolean)|does not exist/i;
const SETTING_REPLY_TIMEOUT = 6000;
const READY_PROBE_AFTER = Number(process.env.MCES_READY_PROBE_MS) || 40000;

/** 이보다 높은 /tick rate 는 경고 (기본 20) */
const TICK_RATE_WARN = 100;

/** 켜진 서버에 명령어로 바로 적용할 수 있는 설정 */
const LIVE_SETTINGS = {
  difficulty: (v) => `difficulty ${v}`,
  gamemode: (v) => `defaultgamemode ${v}`,
  whitelist: (v) => `whitelist ${v ? 'on' : 'off'}`,
};
const SETTING_LABELS = {
  difficulty: '난이도', gamemode: '게임 모드', maxPlayers: '최대 인원', pvp: 'PVP', hardcore: '하드코어', whitelist: '화이트리스트',
  motd: '서버 설명', port: '포트', onlineMode: '정품 인증', allowFlight: '비행 허용', spawnProtection: '스폰 보호 범위',
  viewDistance: '시야 거리', simulationDistance: '시뮬레이션 거리', commandBlocks: '커맨드 블록', memoryMb: '메모리', optimize: '자동 최적화',
};

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.instances = new Map();
  }

  inst(id) {
    if (!this.instances.has(id)) this.instances.set(id, new Instance(id));
    return this.instances.get(id);
  }

  /** 명령을 받을 수 있는 상태 (켜지는 중에도 콘솔 명령은 서버가 준비된 뒤 차례로 처리된다) */
  accepting(id) {
    const i = this.inst(id);
    return !!i.proc && (i.status === 'running' || i.status === 'starting');
  }

  dir(id) {
    // 가져온 서버를 그 자리에서 쓰는 경우 원래 폴더
    const s = Servers.get(id);
    return s && s.externalDir ? s.externalDir : paths.serverDir(id);
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

  /** 콘솔 기록. 앱을 다시 켜 메모리가 비었으면 파일(logs/mces-console.log)에서 불러온다 */
  consoleLines(id) {
    const i = this.inst(id);
    if (i.console.length || !Servers.get(id)) return i.console;
    const logs = path.join(this.dir(id), 'logs');
    for (const name of [CONSOLE_LOG, CONSOLE_LOG_PREV]) {
      let text;
      try {
        text = fs.readFileSync(path.join(logs, name), 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-1999);
      if (!lines.length) continue;
      const t = fs.statSync(path.join(logs, name)).mtimeMs;
      i.console = [
        { t, line: `── 지난 실행 기록 (logs/${name}) ──`, kind: 'app' },
        ...lines.map((l) => {
          const m = /^\[MCES:(\w+)\] (.*)$/.exec(l);
          return m ? { t, line: m[2], kind: m[1] } : { t, line: l, kind: 'out' };
        }),
      ];
      break;
    }
    return i.console;
  }

  /** 켤 때마다 새 기록 파일을 연다 (직전 실행 기록은 mces-console.prev.log 로 남김) */
  openConsoleLog(id) {
    const i = this.inst(id);
    this.closeConsoleLog(id);
    const logs = path.join(this.dir(id), 'logs');
    try {
      fs.mkdirSync(logs, { recursive: true });
      const file = path.join(logs, CONSOLE_LOG);
      if (fs.existsSync(file)) fs.renameSync(file, path.join(logs, CONSOLE_LOG_PREV));
      i.logStream = fs.createWriteStream(file, { flags: 'a' });
      i.logStream.on('error', () => (i.logStream = null));
    } catch {
      i.logStream = null;
    }
  }

  closeConsoleLog(id) {
    const i = this.inst(id);
    if (i.logStream) i.logStream.end();
    i.logStream = null;
  }

  /** 콘솔 한 줄을 파일에도 남긴다. 앱이 쓴 줄은 [MCES:종류] 를 붙여 다시 불러올 때 구분한다 */
  writeConsoleFile(id, entry) {
    const i = this.inst(id);
    const text = `${entry.kind === 'out' ? '' : `[MCES:${entry.kind}] `}${entry.line}\n`;
    if (i.logStream) return i.logStream.write(text);
    try {
      const logs = path.join(this.dir(id), 'logs');
      if (!Servers.get(id) || !fs.existsSync(this.dir(id))) return;
      fs.mkdirSync(logs, { recursive: true });
      fs.appendFileSync(path.join(logs, CONSOLE_LOG), text);
    } catch { /* 기록 실패는 무시 */ }
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
    if (!['paper', 'forge', 'fabric', 'vanilla', 'hybrid'].includes(o.type)) throw new Error('서버 종류 선택 필요');
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
        name: (o.name || '').trim() || `${o.version} ${o.type === 'paper' ? '플러그인' : o.type === 'hybrid' ? '하이브리드' : MOD_TYPES.includes(o.type) ? '모드' : '바닐라'} 서버`,
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
    this.consoleLines(id); // 앱을 다시 켠 뒤면 지난 기록을 먼저 불러 둔다
    this.openConsoleLog(id);
    i.runStartedAt = Date.now(); // 이번 실행의 콘솔 줄만 골라 볼 때 쓴다
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
      let launch = ['-jar', server.jarFile || 'server.jar'];
      if (server.type === 'forge') {
        launch = forge.launchArgs(dir, server.version, server.build);
        if (!launch) throw new Error('Forge 실행 파일 없음 — 업데이트 버튼으로 같은 버전을 다시 설치');
      }
      // Forge 는 콘솔 입력을 JLine 터미널로 받는데, 다른 프로그램이 입력을 넘겨 주는 경우(Windows)
      // 명령이 서버에 닿지 않을 수 있다. JLine 을 끄면 표준 입력을 그대로 읽는다.
      const consoleArgs = server.type === 'forge' || server.type === 'hybrid' ? ['-Dterminal.jline=false', '-Dterminal.ansi=false'] : [];
      // Windows 는 콘솔 출력을 시스템 코드 페이지(CP949)로 내보내 한글이 깨진다. 앱은 UTF-8 로 읽으므로 맞춘다
      consoleArgs.push('-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8');
      const args = [...flags, ...optimize.gcLogArgs(rt.major || server.javaMajor), ...agent, ...consoleArgs, ...launch, 'nogui'];
      this.log(id, `▶ ${path.basename(rt.bin)} ${args.join(' ')}`, 'app');
      const proc = spawn(rt.bin, args, { cwd: dir, windowsHide: true });
      i.proc = proc;
      i.startedAt = Date.now();

      i.outputLines = 0;
      // stdout/stderr 를 따로 모아 줄 단위로 넘긴다 (한 줄이 두 스트림에 섞이지 않게)
      const reader = () => {
        let buf = '';
        const decoder = new StringDecoder('utf8');
        return {
          data: (chunk) => {
            buf += decoder.write(chunk);
            const lines = buf.split(/\r?\n/);
            buf = lines.pop();
            for (const l of lines) {
              i.outputLines++;
              this.onLine(id, l);
            }
          },
          flush: () => {
            buf += decoder.end();
            if (buf.trim()) {
              i.outputLines++;
              this.onLine(id, buf);
            }
            buf = '';
          },
        };
      };
      const out = reader();
      const err = reader();
      proc.stdout.on('data', out.data);
      proc.stderr.on('data', err.data);
      let exited = false;
      const finish = (code, signal) => {
        if (exited) return;
        exited = true;
        out.flush();
        err.flush();
        this.onExit(id, code, signal);
      };
      proc.on('error', (e) => {
        this.log(id, `Java 실행 실패: ${e.message}`, 'error');
        // 실행 파일을 못 찾은 경우 등에는 close 가 오지 않을 수 있다
        setTimeout(() => finish(null, null), 500);
      });
      // exit 는 출력이 다 읽히기 전에 올 수 있으므로 close 를 쓴다
      proc.on('close', (code, signal) => finish(code, signal));
      // 준비 확인 보조: 40초가 지나도 "켜지는 중"이면 list 로 물어본다 (대답은 서버가 준비된 뒤 온다)
      i.readyProbeSent = false;
      i.timers.push(setInterval(() => {
        if (i.proc !== proc || i.status !== 'starting' || Date.now() - i.startedAt < READY_PROBE_AFTER) return;
        i.readyProbeSent = true;
        try { proc.stdin.write('list\n'); } catch { /* 닫힘 */ }
      }, Math.min(10000, READY_PROBE_AFTER / 2)));
    } catch (e) {
      i.status = 'stopped';
      i.proc = null;
      this.log(id, `시작 실패: ${e.message}`, 'error');
      this.closeConsoleLog(id);
      this.emit('alert', {
        serverId: id,
        id: `start-failed-${Date.now()}`,
        severity: 'error',
        title: '서버 시작 실패',
        message: e.message,
        actions: [{ id: 'open-tab', label: '콘솔 보기', payload: { tab: 'console' } }],
      });
      this.emitServer(id);
      throw e;
    }
  }

  log(id, line, kind = 'out') {
    const i = this.inst(id);
    const entry = { t: Date.now(), line, kind };
    // 앱을 다시 켠 뒤라면 지난 기록부터 불러 두고 이어 붙인다
    if (!i.console.length) this.consoleLines(id);
    i.console.push(entry);
    this.writeConsoleFile(id, entry);
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

    // "Done (…)!" 줄을 놓쳐도, 켜지는 중에 보낸 list 에 대답이 오면 준비된 것
    if (i.status === 'starting' && (RE.done.test(msg) || (i.readyProbeSent && RE.list.test(msg)))) this.onReady(id);

    this.checkSettingReply(id, msg);
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
    // 꺼져 있을 때 바꾼 설정 중 명령어로만 월드에 적용되는 것 (난이도)
    if (server.pendingCommands) {
      for (const cmd of Object.values(server.pendingCommands)) {
        try { this.command(id, cmd); } catch { /* 무시 */ }
      }
      Servers.update(id, { pendingCommands: undefined });
    }
    this.applyWorldSettings(id);
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
      else if ((server.type === 'forge' || server.type === 'hybrid') && versions.compareVersions(server.version, '1.20.3') < 0) this.sendPoll(id, 'forge tps');
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

  async onExit(id, code, signal = null) {
    const i = this.inst(id);
    const wasStopping = i.status === 'stopping';
    const wasStarting = i.status === 'starting';
    const startedAt = i.startedAt;
    i.timers.forEach(clearInterval);
    i.timers = [];
    i.proc = null;
    i.status = 'stopped';
    i.players.clear();
    i.replyChecks = [];
    i.metrics.tps = null;
    i.metrics.memoryMb = null;
    i.metrics.processMb = null;
    i.startedAt = null;
    try { pidusage.clear(); } catch { /* 무시 */ }
    // Windows 는 -1 을 4294967295 처럼 부호 없는 값으로 준다
    const shown = code === null ? signal || '없음' : code > 0x7fffffff ? code - 0x100000000 : code;
    this.log(id, `■ 서버 종료 (종료 코드 ${shown})`, 'app');
    if (!wasStopping && (code !== 0 || wasStarting)) {
      // 아무것도 출력하지 않고 꺼졌으면 Java 충돌 기록(hs_err_pid*.log)이나 종료 코드로 원인을 짐작한다
      const quiet = !i.outputLines;
      const crash = findCrashReport(this.dir(id), startedAt);
      if (crash) {
        this.log(id, `Java 충돌 기록: ${crash.file}`, 'error');
        for (const l of crash.lines) this.log(id, l, 'error');
      }
      const hint = explainExit(code, { quiet, crash: !!crash });
      if (hint) this.log(id, hint, 'error');
      const lastError = lastErrorLine(i.console, i.runStartedAt);
      this.emit('alert', {
        serverId: id,
        id: `crash-${Date.now()}`,
        severity: 'error',
        title: wasStarting ? '서버 시작 중 종료' : '서버 비정상 종료',
        message: hint || (lastError ? `마지막 오류: ${lastError}` : '위 안내 먼저 확인. 자세한 로그는 콘솔 탭'),
        actions: [
          { id: 'open-tab', label: '콘솔 보기', payload: { tab: 'console' } },
          ...(crash || quiet ? [{ id: 'open-folder', label: '서버 폴더 열기' }] : []),
        ],
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
    this.closeConsoleLog(id);
  }

  /** 저장 후 정지. timeout 안에 안 꺼지면 그때만 강제 종료한다. */
  stop(id, timeout = 90000) {
    const i = this.inst(id);
    if (!i.proc) return Promise.resolve();
    i.ranLongEnough = i.status === 'running';
    i.status = 'stopping';
    this.emitServer(id);
    return new Promise((resolve) => {
      const proc = i.proc;
      // 정상 종료되면 강제 종료 타이머를 치운다
      const timer = setTimeout(() => {
        if (i.proc === proc) {
          this.log(id, '제한 시간 초과 — 강제 종료', 'error');
          proc.kill('SIGKILL');
        }
      }, timeout);
      i.exitResolvers = [...(i.exitResolvers || []), () => {
        clearTimeout(timer);
        resolve();
      }];
      try {
        i.proc.stdin.write('stop\n');
      } catch { /* 이미 닫힘 */ }
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
    // 틱 속도를 크게 올리면 서버가 따라가지 못해 뒤처짐이 쌓이고, 60초가 넘으면 워치독이 서버를 끈다
    const t = /^(?:minecraft:)?tick\s+rate\s+([\d.]+)/i.exec(clean);
    if (t && Number(t[1]) > TICK_RATE_WARN) {
      this.emit('alert', {
        serverId: id,
        id: `tick-rate-${Date.now()}`,
        severity: 'warn',
        title: '틱 속도가 매우 높음',
        message: `틱 속도 ${t[1]} → 서버가 따라가지 못하면 뒤처짐이 쌓여 약 60초 뒤 워치독이 서버를 강제 종료함`,
        actions: [{ id: 'reset-tick-rate', label: '20으로 되돌리기' }],
      });
    }
  }

  /** 설정용 명령: 보내고 서버의 대답을 확인한다 (거부되거나 대답이 없으면 알림) */
  settingCommand(id, cmd) {
    const i = this.inst(id);
    this.command(id, cmd);
    const check = { cmd, done: false };
    (i.replyChecks = i.replyChecks || []).push(check);
    setTimeout(() => {
      if (check.done) return;
      check.done = true;
      i.replyChecks = (i.replyChecks || []).filter((c) => c !== check);
      if (i.proc && i.status === 'running') this.reportSettingProblem(id, { cmd, reply: null });
    }, SETTING_REPLY_TIMEOUT);
  }

  /** 서버 출력 한 줄이 기다리던 설정 명령의 대답인지 본다 (보낸 순서대로) */
  checkSettingReply(id, msg) {
    const i = this.inst(id);
    if (!i.replyChecks || !i.replyChecks.length) return;
    const ok = SETTING_OK.test(msg);
    const bad = !ok && SETTING_ERROR.test(msg);
    if (!ok && !bad) return;
    const check = i.replyChecks.shift();
    check.done = true;
    // 켜지지 않은 차원(네더·엔드 끔)은 문제가 아니다
    if (bad && !/Unknown dimension|does not exist/i.test(msg)) this.reportSettingProblem(id, { cmd: check.cmd, reply: msg });
  }

  reportSettingProblem(id, problem) {
    const i = this.inst(id);
    (i.replyProblems = i.replyProblems || []).push(problem);
    if (i.replyReport) return;
    // 한꺼번에 보낸 명령은 알림 하나로 묶는다
    i.replyReport = setTimeout(() => {
      const list = i.replyProblems || [];
      i.replyProblems = [];
      i.replyReport = null;
      const rejected = list.filter((p) => p.reply);
      const silent = list.filter((p) => !p.reply);
      if (rejected.length) {
        this.emit('alert', {
          serverId: id,
          id: `setting-rejected-${Date.now()}`,
          severity: 'error',
          title: '서버가 설정 명령을 거부함',
          message: rejected.slice(0, 2).map((p) => `${p.cmd} → ${p.reply}`).join(' · '),
          actions: [{ id: 'open-tab', label: '콘솔 보기', payload: { tab: 'console' } }],
        });
      }
      if (silent.length) {
        this.emit('alert', {
          serverId: id,
          id: `setting-silent-${Date.now()}`,
          severity: 'error',
          title: '서버가 설정 명령에 대답하지 않음',
          message: `${silent[0].cmd}${silent.length > 1 ? ` 외 ${silent.length - 1}개` : ''} → 콘솔 입력이 서버에 닿지 않는 상태일 수 있음. 서버를 다시 켜 보고, 계속되면 콘솔 탭 내용 확인`,
          actions: [{ id: 'open-tab', label: '콘솔 보기', payload: { tab: 'console' } }],
        });
      }
    }, 400);
  }

  /** 다음에 켜질 때 보낼 명령 (같은 key 는 덮어씀) */
  queueCommand(id, key, cmd) {
    Servers.update(id, (s) => ({ ...s, pendingCommands: { ...(s.pendingCommands || {}), [key]: cmd } }));
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
  /**
   * 설정 저장. 켜져 있으면 명령어로 바로 바꿀 수 있는 것(난이도·기본 게임 모드·화이트리스트)은 바로 적용한다.
   * @returns 서버 정보 + applied: { now: string[], restart: string[] } (바뀐 항목 이름)
   */
  updateSettings(id, patch) {
    const server = Servers.get(id);
    const { memoryMb, name, optimize: opt, backup: bk, network, ...friendly } = patch;
    const file = path.join(this.dir(id), 'server.properties');
    const before = props.fromProperties(props.read(file));
    const changed = Object.keys(friendly).filter((k) => friendly[k] !== undefined && String(friendly[k]) !== String(before[k]));
    const next = { ...server };
    if (memoryMb) next.memoryMb = Number(memoryMb);
    if (name !== undefined) next.name = String(name).trim() || server.name;
    if (opt !== undefined) next.optimize = !!opt;
    if (bk) next.backup = { ...server.backup, ...bk };
    if (network) next.network = { ...server.network, ...network };
    if (friendly.port !== undefined) next.port = Number(friendly.port);

    const running = this.accepting(id);
    const now = [];
    const restart = [];
    if (next.name !== server.name) now.push('서버 이름');
    if (next.memoryMb !== server.memoryMb) restart.push(SETTING_LABELS.memoryMb);
    if (next.optimize !== server.optimize) restart.push(SETTING_LABELS.optimize);
    // 1.21.9 이후 PVP·커맨드 블록은 server.properties 가 아니라 게임 규칙이다
    const saved = world.readGameRules(path.join(this.dir(id), server.levelName || 'world'));
    const desired = desiredRules(server);
    const ruleChanges = [];
    for (const k of changed) {
      const ruleKey = gamerules.PROPERTY_RULES[k] && saved ? gamerules.findKey(Object.keys(saved.rules), gamerules.PROPERTY_RULES[k]) : null;
      if (!ruleKey) continue;
      ruleChanges.push(k);
      desired[ruleKey] = !!friendly[k];
      if (running) this.worldCommand(id, gamerules.command(ruleKey, !!friendly[k]));
      now.push(SETTING_LABELS[k]);
    }
    for (const k of changed) {
      if (ruleChanges.includes(k)) continue;
      const cmd = LIVE_SETTINGS[k] && LIVE_SETTINGS[k](friendly[k]);
      if (cmd && running) {
        // 난이도는 월드마다 따로 저장되므로 모든 월드에, 나머지는 서버 전체 명령
        if (k === 'difficulty') this.worldCommand(id, cmd);
        else this.settingCommand(id, cmd);
        now.push(SETTING_LABELS[k] || k);
      } else if (!running) {
        now.push(SETTING_LABELS[k] || k);
      } else {
        restart.push(SETTING_LABELS[k] || k);
      }
    }
    if (!running) {
      // 꺼져 있으면 저장만으로 다음 실행에 반영되므로 전부 "적용"
      now.push(...restart.splice(0));
      if (now.length) this.log(id, `설정 저장 (${now.join(', ')}) — 서버가 꺼져 있어 다음 실행 때 적용`, 'app');
    }
    Object.assign(next, rulesPatch(desired));
    Servers.save(next);
    const values = props.toProperties(friendly);
    if (Object.keys(values).length) {
      props.write(file, values);
      // whitelist 명령은 서버가 자기 설정으로 server.properties 를 다시 쓰므로, 처리된 뒤 한 번 더 쓴다
      if (running && changed.includes('whitelist')) setTimeout(() => props.write(file, values), 1500);
    }
    if (bk) this.scheduleBackup(id);
    this.emitServer(id);
    return { ...this.get(id), applied: { now, restart, running } };
  }

  // ---------- 게임 규칙 (gamerule) · 월드 단위 설정 ----------
  /**
   * 월드마다 따로 저장되는 설정(게임 규칙·난이도)용 명령.
   * Bukkit·Paper 는 오버월드·네더·엔드가 각각 다른 월드라 콘솔 명령이 오버월드에만 적용되므로
   * `execute in <차원> run …` 으로 있는 월드 모두에 보낸다.
   */
  worldCommand(id, cmd) {
    const server = Servers.get(id);
    if (server.type !== 'paper' && server.type !== 'hybrid') return this.settingCommand(id, cmd);
    const dir = this.dir(id);
    const level = server.levelName || 'world';
    // 하이브리드는 월드 폴더 모양이 서버마다 달라 세 차원 모두에 보낸다 (없는 차원은 무시됨)
    const dims = [
      ['minecraft:overworld', level],
      ['minecraft:the_nether', `${level}_nether`],
      ['minecraft:the_end', `${level}_the_end`],
    ].filter(([dim, folder]) => dim === 'minecraft:overworld' || server.type === 'hybrid' || fs.existsSync(path.join(dir, folder)));
    for (const [dim] of dims) this.settingCommand(id, `execute in ${dim} run ${cmd}`);
  }

  /** 켜질 때마다 앱에서 정한 난이도·게임 규칙을 모든 월드에 다시 맞춘다 */
  applyWorldSettings(id) {
    const server = Servers.get(id);
    try {
      const p = props.fromProperties(props.read(path.join(this.dir(id), 'server.properties')));
      this.worldCommand(id, LIVE_SETTINGS.difficulty(p.difficulty));
      for (const [key, value] of Object.entries(desiredRules(server))) this.worldCommand(id, gamerules.command(key, value));
    } catch (e) {
      this.log(id, `설정 적용 실패: ${e.message}`, 'error');
    }
    // 예전 형식(pendingRules/ruleOverrides)은 desired 로 합쳐 둔다
    if (server.pendingRules || server.ruleOverrides) Servers.update(id, rulesPatch(desiredRules(server)));
  }

  /** 월드에 저장된 규칙 + 앱에서 정한 값 */
  gameRules(id) {
    const server = Servers.get(id);
    const saved = world.readGameRules(path.join(this.dir(id), server.levelName || 'world'));
    const running = this.accepting(id);
    if (!saved) return { available: false, running };
    const rules = { ...saved.rules };
    const desired = desiredRules(server);
    const pending = new Set();
    for (const [k, v] of Object.entries(desired)) {
      if (!rules[k]) continue;
      if (!running && rules[k].value !== v) pending.add(k);
      rules[k] = { ...rules[k], value: v };
    }
    const { common, other } = gamerules.describe(rules);
    const mark = (r) => ({ ...r, pending: pending.has(r.key) });
    return { available: true, running, common: common.map(mark), other: other.map(mark) };
  }

  /**
   * 규칙 바꾸기. 앱에서 정한 값으로 기억해 두고 켜질 때마다 다시 맞춘다.
   * 켜져 있으면 gamerule 명령으로 바로 적용한다.
   * @param {{[key: string]: boolean|number}} changes 파일에 적힌 규칙 이름 → 값
   */
  setGameRules(id, changes) {
    const server = Servers.get(id);
    const saved = world.readGameRules(path.join(this.dir(id), server.levelName || 'world'));
    if (!saved) throw new Error('월드가 아직 없음 — 서버를 한 번 켠 뒤 설정 가능');
    const running = this.accepting(id);
    const desired = desiredRules(server);
    const labels = [];
    const { common, other } = gamerules.describe(saved.rules);
    const labelOf = new Map([...common, ...other].map((r) => [r.key, r.label]));
    for (const [key, raw] of Object.entries(changes || {})) {
      const rule = saved.rules[key];
      if (!rule) continue;
      const value = rule.kind === 'bool' ? !!raw : Math.trunc(Number(raw));
      if (rule.kind === 'int' && !Number.isFinite(value)) continue;
      const cmd = gamerules.command(key, value);
      desired[key] = value;
      if (running) this.worldCommand(id, cmd);
      labels.push(labelOf.get(key) || key);
    }
    Servers.update(id, rulesPatch(desired));
    if (!running && labels.length) this.log(id, `게임 규칙 저장 (${labels.join(', ')}) — 서버가 꺼져 있어 다음 실행 때 적용`, 'app');
    return { running, changed: labels };
  }

  // ---------- 삭제 ----------
  async remove(id, { keepBackups = false } = {}) {
    const i = this.inst(id);
    if (i.proc) await this.stop(id);
    this.closeConsoleLog(id);
    // 그 자리에서 가져온 서버는 앱 목록에서만 뺀다 (원래 폴더는 사용자 것)
    if (!Servers.get(id) || !Servers.get(id).externalDir) fs.rmSync(this.dir(id), { recursive: true, force: true });
    if (!keepBackups) fs.rmSync(paths.serverBackups(id), { recursive: true, force: true });
    Servers.remove(id);
    this.instances.delete(id);
    this.emit('removed', { serverId: id });
  }

  // ---------- 기존 서버 가져오기 ----------
  /**
   * 앱 밖에서 만든 서버 폴더를 목록에 추가한다.
   * @param {object} o { path, mode: 'copy'(앱 폴더로 복사) | 'inplace'(그 자리에서 사용), name, memoryMb, optimize, eula }
   */
  async importExisting(o, onProgress = () => {}) {
    const src = path.resolve(o.path || '');
    const det = await serverImport.detect(src);
    if (det.problems.length) throw new Error(det.problems.join(' · '));
    const inplace = o.mode === 'inplace';
    const inside = (a, b) => {
      const r = path.relative(b, a);
      return !r || (!r.startsWith('..') && !path.isAbsolute(r));
    };
    if (inside(src, paths.dataRoot())) throw new Error('앱 데이터 폴더 안의 서버는 가져올 수 없음');
    const same = Servers.all().find((s) => s.externalDir && (inside(src, s.externalDir) || inside(s.externalDir, src)));
    if (same) throw new Error(`이미 "${same.name}" 서버로 추가된 폴더`);
    if (!det.eula && !o.eula) throw new Error('EULA 동의 필요');

    const id = crypto.randomUUID();
    const dir = inplace ? src : paths.serverDir(id);
    try {
      onProgress({ text: '필요한 Java 버전 확인 중', percent: 0 });
      const javaMajor = await versions.requiredJava(det.version);
      await java.ensure(javaMajor, onProgress);
      if (!inplace) await serverImport.copyTree(src, dir, onProgress);
      if (det.type === 'forge' && !forge.launchArgs(dir, det.version, det.build)) throw new Error('Forge 실행 파일을 찾지 못함');
      if (!det.eula) fs.writeFileSync(path.join(dir, 'eula.txt'), `# https://aka.ms/MinecraftEULA 에 동의함 (MCES)\neula=true\n`);

      const memoryMb = Number(o.memoryMb) || det.memoryMb || system.specs().recommendedMb;
      const server = {
        id,
        name: (o.name || '').trim() || det.name,
        type: det.type,
        version: det.version,
        build: det.build || null,
        loaderVersion: null,
        javaMajor,
        memoryMb,
        port: det.port,
        optimize: o.optimize !== false,
        // 원래 쓰던 Paper 설정 파일은 건드리지 않는다
        optimizedApplied: true,
        levelName: det.levelName,
        jarFile: det.jarFile || null,
        externalDir: inplace ? src : null,
        imported: { flavor: det.flavor, from: src, mode: inplace ? 'inplace' : 'copy', at: Date.now() },
        addons: [],
        backup: { ...DEFAULT_BACKUP },
        network: { mode: 'tunnel', address: null },
        createdAt: Date.now(),
      };
      Servers.save(server);
      onProgress({ text: '완료', percent: 1 });
      this.emitServer(id);
      return this.get(id);
    } catch (e) {
      if (!inplace) fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  // ---------- 추가 기능 (플러그인 / 모드 / 데이터팩) ----------
  /** kind: 하이브리드 서버에서 'plugin' | 'mod' (다른 서버는 무시) */
  async installAddon(id, projectId, onProgress = () => {}, kind = null) {
    const server = Servers.get(id);
    const view = modrinth.asKind(server, kind);
    const result = await modrinth.install(view, this.dir(id), projectId, onProgress);
    if (server.type === 'hybrid') for (const a of result.installed) a.kind = view.hybridKind;
    Servers.update(id, (s) => {
      const byId = new Map((s.addons || []).map((a) => [addonKey(a), a]));
      for (const a of result.installed) {
        const old = byId.get(addonKey(a));
        if (old && old.fileName !== a.fileName) modrinth.removeFile(modrinth.asKind(s, old.kind), this.dir(id), old.fileName);
        byId.set(addonKey(a), old ? { ...a, dependencyOf: old.dependencyOf } : a);
      }
      return { ...s, addons: [...byId.values()] };
    });
    this.emitServer(id);
    return { ...result, needsRestart: this.inst(id).status !== 'stopped' };
  }

  async installByName(id, name, onProgress, kind = null) {
    const server = Servers.get(id);
    const view = modrinth.asKind(server, kind);
    const hit = await modrinth.installByName(view, this.dir(id), name, onProgress);
    if (server.type === 'hybrid') for (const a of hit.installed) a.kind = view.hybridKind;
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
    const list = [];
    // 하이브리드는 plugins/ 와 mods/ 를 모두 본다
    for (const kind of modrinth.kindsOf(server)) {
      const view = modrinth.asKind(server, kind);
      const folder = path.join(dir, modrinth.addonFolder(view));
      const locate = (fileName) => {
        const on = path.join(folder, fileName);
        return fs.existsSync(on) ? on : fs.existsSync(`${on}.disabled`) ? `${on}.disabled` : null;
      };
      const items = [...(view.addons || []), ...modrinth.scanFolder(view, dir)];
      for (const a of items) {
        if (kind) a.kind = kind;
        // Modrinth 로 받은 파일도 안의 이름을 읽어야 의존성 이름(예: EssentialsX → "Essentials")과 맞춰 볼 수 있다
        if (!a.meta) {
          const file = locate(a.fileName);
          a.meta = file ? addonMeta.forServer(await addonMeta.inspect(file), view.type) : { kind: null, error: '파일 없음' };
          if (!a.projectId && a.meta.name) a.title = a.meta.name;
          if (a.meta.version && !a.versionNumber) a.versionNumber = a.meta.version;
        }
        if (!a.projectId) a.compat = addonMeta.compat(a.meta, view.type, server.version);
      }
      list.push(...items);
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
    const base0 = Servers.get(id);
    const dir = this.dir(id);
    const ext = base0.type === 'vanilla' ? /\.zip$/i : /\.jar$/i;
    const added = [];
    const rejected = [];
    for (const src of files) {
      const base = path.basename(src);
      if (!ext.test(base)) {
        rejected.push({ file: base, reason: base0.type === 'vanilla' ? '데이터팩(.zip)만 가능' : '.jar 파일만 가능' });
        continue;
      }
      const raw = await addonMeta.inspect(src);
      // 하이브리드: 파일 안 정보로 플러그인인지 Forge 모드인지 정해 알맞은 폴더에 넣는다 (여러 로더용 jar 도 고려)
      const has = (k) => raw.kind === k || !!(raw.variants && raw.variants[k]);
      let kind = null;
      const meta = raw;
      if (base0.type === 'hybrid') {
        if (has('plugin')) kind = 'plugin';
        else if (has('forge')) kind = 'mod';
        else {
          rejected.push({ file: base, reason: meta.kind ? `${meta.kind === 'fabric' ? 'Fabric' : meta.kind === 'neoforge' ? 'NeoForge' : meta.kind} 파일 — 하이브리드(Forge) 서버에서 사용 불가` : '플러그인·Forge 모드 파일 아님' });
          continue;
        }
      }
      const server = modrinth.asKind(base0, kind);
      Object.assign(meta, addonMeta.forServer(raw, server.type));
      const folder = path.join(dir, modrinth.addonFolder(server));
      fs.mkdirSync(folder, { recursive: true });
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
      if (kind) record.kind = kind;
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
      const c = addonMeta.compat(a.meta, modrinth.asKind(server, a.kind).type, targetVersion);
      const item = { title: a.title, fileName: a.fileName, reason: c.reason };
      if (c.status === 'ok') out.compatible.push(item);
      else if (c.status === 'bad') out.incompatible.push(item);
      else out.unknown.push(item);
    }
    return out;
  }

  /** 파일이 든 종류(하이브리드: plugins/ 또는 mods/)의 보기 */
  viewForFile(server, fileName) {
    if (server.type !== 'hybrid') return server;
    const rec = (server.addons || []).find((a) => a.fileName === fileName);
    if (rec) return modrinth.asKind(server, rec.kind);
    const inMods = ['', '.disabled'].some((x) => fs.existsSync(path.join(this.dir(server.id), 'mods', fileName + x)));
    return modrinth.asKind(server, inMods ? 'mod' : 'plugin');
  }

  setAddonEnabled(id, fileName, enabled) {
    const server = Servers.get(id);
    modrinth.setEnabled(this.viewForFile(server, fileName), this.dir(id), fileName, enabled);
    Servers.update(id, (s) => ({ ...s, addons: (s.addons || []).map((a) => (a.fileName === fileName ? { ...a, enabled } : a)) }));
    this.emitServer(id);
  }

  removeAddon(id, fileName) {
    const server = Servers.get(id);
    modrinth.removeFile(this.viewForFile(server, fileName), this.dir(id), fileName);
    Servers.update(id, (s) => ({ ...s, addons: (s.addons || []).filter((a) => a.fileName !== fileName) }));
    this.emitServer(id);
  }

  async disablePluginByName(id, name) {
    const server = Servers.get(id);
    const file = await modrinth.findPluginFileByName(modrinth.asKind(server, 'plugin'), this.dir(id), name);
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
    let count = 0;
    for (const kind of modrinth.kindsOf(server)) {
      const { updates } = await modrinth.checkCompatibility(modrinth.asKind(server, kind), server.version);
      for (const u of updates) await this.installAddon(id, u.addon.projectId, () => {}, kind);
      count += updates.length;
    }
    return count;
  }

  /** 종류별 호환성 검사를 합친다 (하이브리드) */
  async compatAll(server, gameVersion) {
    const out = { compatible: [], incompatible: [], updates: [] };
    for (const kind of modrinth.kindsOf(server)) {
      const r = await modrinth.checkCompatibility(modrinth.asKind(server, kind), gameVersion);
      out.compatible.push(...r.compatible);
      out.incompatible.push(...r.incompatible);
      out.updates.push(...r.updates.map((u) => ({ ...u, kind })));
    }
    return out;
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
      compat = await this.compatAll(server, target);
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
    // 가져온 서버(Spigot 등 다른 jar 이름)도 업데이트 뒤에는 앱이 받은 server.jar 로 켠다
    Servers.update(id, { version: targetVersion, build: jar.build || null, loaderVersion: jar.loader || server.loaderVersion, javaMajor, jarFile: null });

    // 추가 기능: 새 버전에 맞는 파일로 교체, 맞는 게 없으면 비활성화
    if (versionChanged && (server.addons || []).length) {
      const updated = Servers.get(id);
      const { incompatible, updates } = await this.compatAll({ ...updated, version: server.version }, targetVersion);
      for (const u of updates) {
        onProgress({ text: `${u.addon.title} 새 버전으로 교체 중`, percent: 0 });
        try { await this.installAddon(id, u.addon.projectId, () => {}, u.kind); } catch { /* 다음 */ }
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

module.exports = { lastErrorLine, explainExit, findCrashReport, ServerManager, RE };
