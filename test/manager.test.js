'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mceasy-mgr-'));
process.env.MC_EASY_DATA = tmp;
process.env.MCES_READY_PROBE_MS = '2000'; // 준비 확인 보조를 빨리
const paths = require('../src/main/paths');
paths.init(null);

// 가짜 java: 인자를 무시하고 가짜 서버를 실행한다
const bin = path.join(tmp, 'runtimes', 'java-21', 'bin');
fs.mkdirSync(bin, { recursive: true });
const fake = path.join(__dirname, 'fixtures', 'fake-server.js');
fs.writeFileSync(path.join(bin, 'java'), `#!/bin/sh\nexec "${process.execPath}" "${fake}"\n`, { mode: 0o755 });

const { Servers } = require('../src/main/store');
const { ServerManager } = require('../src/main/server-manager');

const until = (fn, ms = 5000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timeout'));
      setTimeout(tick, 30);
    };
    tick();
  });

test('켜기 → 준비 → 접속자/TPS → 백업 → 저장 후 정지', { skip: process.platform === 'win32' }, async () => {
  const id = 'srv-1';
  fs.mkdirSync(paths.serverDir(id), { recursive: true });
  fs.writeFileSync(path.join(paths.serverDir(id), 'server.properties'), 'server-port=25999\nmax-players=20\n');
  Servers.save({ id, name: '테스트', type: 'paper', version: '1.21.1', javaMajor: 21, memoryMb: 1024, port: 25999, optimize: true, optimizedApplied: false, levelName: 'world', addons: [], backup: { enabled: true, intervalMin: 30, keep: 5, onStop: true }, network: { mode: 'tunnel', address: null } });

  const m = new ServerManager();
  const alerts = [];
  const backups = [];
  const consoleLines = [];
  m.on('alert', (a) => alerts.push(a));
  m.on('backup', (b) => backups.push(b));
  m.on('console', (c) => consoleLines.push(c.line));

  await m.start(id);
  await until(() => m.get(id).status === 'running');
  // 칭호가 붙은 입장 문구/로그인 줄로 바로 잡히고, 채팅 속 문구는 무시한다
  const seen = new Set();
  m.on('server', (x) => x.players.forEach((p) => seen.add(p.name)));
  await until(() => seen.has('Alex'));
  assert.ok(!seen.has('Bob'));
  await until(() => m.get(id).players.length === 1);
  assert.strictEqual(m.get(id).players[0].name, 'Steve');
  assert.strictEqual(m.get(id).players[0].uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  await until(() => m.get(id).metrics.tps === 19.5);
  // 메모리는 프로세스 크기가 아니라 GC 로그의 실제 힙 사용량
  await until(() => m.get(id).metrics.memoryMb === 200);
  // 에이전트를 서버 폴더에 두고 -javaagent 로 넘긴다
  assert.ok(fs.existsSync(path.join(paths.serverDir(id), 'mces-agent.jar')));
  assert.ok(consoleLines.some((l) => l.includes('-javaagent:mces-agent.jar=logs/mces-heap.txt')));
  assert.ok(m.get(id).metrics.cpu <= 100);
  // 앱이 보낸 tps 폴링 응답은 콘솔에 보이지 않는다
  assert.ok(!consoleLines.some((l) => l.includes('TPS from last')));

  const b = await m.backupNow(id, 'manual');
  assert.ok(fs.existsSync(b.file));

  m.playerAction(id, 'kick', 'Steve');
  await until(() => consoleLines.some((l) => l.includes('Kicked Steve')));
  assert.throws(() => m.playerAction(id, 'kick', 'bad name; stop'));

  await m.stop(id);
  assert.strictEqual(m.get(id).status, 'stopped');
  assert.ok(m.anyRunning() === false);
  await until(() => backups.some((x) => x.backup && x.backup.reason === 'stop'));
  assert.strictEqual(alerts.filter((a) => a.severity === 'error').length, 0);
});

test('시작 중 조용히 꺼지면 원인 안내 (출력 없음 · Java 충돌 기록)', { skip: process.platform === 'win32' }, async () => {
  const id = 'srv-quiet';
  fs.mkdirSync(paths.serverDir(id), { recursive: true });
  fs.writeFileSync(path.join(paths.serverDir(id), 'server.properties'), 'server-port=25998\n');
  Servers.save({ id, name: 'q', type: 'paper', version: '1.21.1', javaMajor: 21, memoryMb: 1024, port: 25998, optimize: false, levelName: 'world', addons: [], backup: { enabled: false, keep: 5, onStop: false }, network: { mode: 'tunnel', address: null } });
  const m = new ServerManager();
  const alerts = [];
  const lines = [];
  m.on('alert', (a) => alerts.push(a));
  m.on('console', (c) => lines.push(c.line));
  try {
    process.env.MCES_FAKE_MODE = 'quiet';
    await m.start(id);
    await until(() => alerts.length === 1);
    assert.strictEqual(alerts[0].title, '서버 시작 중 종료');
    assert.match(alerts[0].message, /출력 없이 종료 \(코드 3\)/);

    process.env.MCES_FAKE_MODE = 'crash';
    await m.start(id);
    await until(() => alerts.length === 2);
    assert.match(alerts[1].message, /Java가 충돌로 종료/);
    // 줄바꿈 없는 마지막 출력도 콘솔에 남는다
    assert.ok(lines.some((l) => l.includes('last words without newline')));
    assert.ok(lines.some((l) => l.includes('EXCEPTION_ACCESS_VIOLATION')));
  } finally {
    delete process.env.MCES_FAKE_MODE;
  }
});

test('설정 저장: 켜져 있으면 난이도·게임 모드·화이트리스트는 명령어로 바로, 난이도는 켤 때마다 모든 월드에', { skip: process.platform === 'win32' }, async () => {
  const id = 'srv-settings';
  const dir = paths.serverDir(id);
  fs.mkdirSync(dir, { recursive: true });
  // 예전 서버처럼 숫자로 적힌 난이도
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25997\ndifficulty=2\ngamemode=0\nmax-players=20\n');
  Servers.save({ id, name: 's', type: 'paper', version: '1.21.1', javaMajor: 21, memoryMb: 1024, port: 25997, optimize: false, levelName: 'world', addons: [], backup: { enabled: false, keep: 5, onStop: false }, network: { mode: 'tunnel', address: null } });
  const m = new ServerManager();
  assert.strictEqual(m.get(id).settings.difficulty, 'normal');
  assert.strictEqual(m.get(id).settings.gamemode, 'survival');

  // 꺼진 상태: 저장 + 다음 실행 때 difficulty 명령
  let r = m.updateSettings(id, { difficulty: 'hard' });
  assert.strictEqual(r.applied.running, false);
  const lines = [];
  m.on('console', (c) => lines.push(c.line));
  await m.start(id);
  await until(() => m.get(id).status === 'running');
  // 켜질 때마다 모든 월드에 난이도를 맞춘다 (Paper 는 월드마다 따로 저장)
  await until(() => lines.includes('> execute in minecraft:overworld run difficulty hard'));

  // 켜진 상태: 명령어로 바로, 나머지는 재시작 후
  r = m.updateSettings(id, { difficulty: 'peaceful', gamemode: 'creative', maxPlayers: 5, whitelist: false });
  assert.deepStrictEqual(r.applied.now, ['난이도', '게임 모드']);
  assert.deepStrictEqual(r.applied.restart, ['최대 인원']);
  assert.ok(lines.includes('> execute in minecraft:overworld run difficulty peaceful'));
  assert.ok(lines.includes('> defaultgamemode creative'));
  const p = fs.readFileSync(path.join(dir, 'server.properties'), 'utf8');
  assert.match(p, /difficulty=peaceful/);
  assert.match(p, /max-players=5/);
  await m.stop(id);
});

test('높은 /tick rate 입력 시 경고', { skip: process.platform === 'win32' }, async () => {
  const id = 'srv-tick';
  fs.mkdirSync(paths.serverDir(id), { recursive: true });
  fs.writeFileSync(path.join(paths.serverDir(id), 'server.properties'), 'server-port=25995\n');
  Servers.save({ id, name: 't', type: 'vanilla', version: '26.3', javaMajor: 21, memoryMb: 1024, port: 25995, optimize: false, levelName: 'world', addons: [], backup: { enabled: false, keep: 5, onStop: false }, network: { mode: 'tunnel', address: null } });
  const m = new ServerManager();
  const alerts = [];
  m.on('alert', (a) => alerts.push(a));
  await m.start(id);
  await until(() => m.get(id).status === 'running');
  m.command(id, '/tick rate 20');
  assert.strictEqual(alerts.length, 0);
  m.command(id, '/tick rate 10000');
  assert.strictEqual(alerts[0].title, '틱 속도가 매우 높음');
  m.queueCommand(id, 'tickRate', 'tick rate 20');
  assert.strictEqual(Servers.get(id).pendingCommands.tickRate, 'tick rate 20');
  await m.stop(id);
});

test('설정 명령이 거부되거나 대답이 없으면 알림 · Forge 는 JLine 끄고 실행', { skip: process.platform === 'win32' }, async () => {
  const id = 'srv-reply';
  fs.mkdirSync(paths.serverDir(id), { recursive: true });
  fs.writeFileSync(path.join(paths.serverDir(id), 'server.properties'), 'server-port=25994\ndifficulty=easy\n');
  Servers.save({ id, name: 'f', type: 'vanilla', version: '1.20.1', javaMajor: 21, memoryMb: 1024, port: 25994, optimize: false, levelName: 'world', addons: [], backup: { enabled: false, keep: 5, onStop: false }, network: { mode: 'tunnel', address: null } });
  const m = new ServerManager();
  const alerts = [];
  const lines = [];
  m.on('alert', (a) => alerts.push(a));
  m.on('console', (c) => lines.push(c.line));
  try {
    // 정상: 켤 때 보내는 난이도 명령에 대답이 오면 알림 없음
    await m.start(id);
    await until(() => m.get(id).status === 'running');
    await until(() => lines.some((l) => l.includes('The difficulty has been set to easy')));
    await new Promise((r) => setTimeout(r, 600));
    assert.strictEqual(alerts.length, 0);
    await m.stop(id);

    process.env.MCES_FAKE_CONSOLE = 'reject';
    await m.start(id);
    await until(() => alerts.some((a) => a.title === '서버가 설정 명령을 거부함'));
    assert.match(alerts.find((a) => a.title === '서버가 설정 명령을 거부함').message, /difficulty easy → Unknown or incomplete command/);
    await m.stop(id);

    process.env.MCES_FAKE_CONSOLE = 'silent';
    await m.start(id);
    await until(() => alerts.some((a) => a.title === '서버가 설정 명령에 대답하지 않음'), 9000);
    await m.stop(id);
  } finally {
    delete process.env.MCES_FAKE_CONSOLE;
  }
  // Forge 실행 인자에는 -Dterminal.jline=false (실행 줄은 콘솔 첫 줄에 남는다)
  Servers.update(id, { type: 'forge', build: '47.3.0' });
  const forgeDir = path.join(paths.serverDir(id), 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.3.0');
  fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(path.join(forgeDir, 'unix_args.txt'), '-cp x Main');
  fs.writeFileSync(path.join(forgeDir, 'win_args.txt'), '-cp x Main');
  lines.length = 0;
  await m.start(id);
  await until(() => m.get(id).status === 'running');
  assert.ok(lines[0].includes('-Dterminal.jline=false'));
  await m.stop(id);
});

test('준비 완료 줄을 놓쳐도 list 대답으로 켜짐 처리 · 켜지는 중에도 설정 명령 전송', { skip: process.platform === 'win32' }, async () => {
  const id = 'srv-nodone';
  fs.mkdirSync(paths.serverDir(id), { recursive: true });
  fs.writeFileSync(path.join(paths.serverDir(id), 'server.properties'), 'server-port=25993\ndifficulty=easy\n');
  Servers.save({ id, name: 'n', type: 'forge', version: '1.20.1', build: '47.3.0', javaMajor: 21, memoryMb: 1024, port: 25993, optimize: false, levelName: 'world', addons: [], backup: { enabled: false, keep: 5, onStop: false }, network: { mode: 'tunnel', address: null } });
  const forgeDir = path.join(paths.serverDir(id), 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.3.0');
  fs.mkdirSync(forgeDir, { recursive: true });
  fs.writeFileSync(path.join(forgeDir, 'unix_args.txt'), '-cp x Main');
  const m = new ServerManager();
  const lines = [];
  m.on('console', (c) => lines.push(c.line));
  process.env.MCES_FAKE_MODE = 'nodone';
  try {
    await m.start(id);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(m.get(id).status, 'starting');
    // 켜지는 중: 명령은 바로 보낸다 (서버가 준비되면 처리)
    const r = m.updateSettings(id, { difficulty: 'hard' });
    assert.strictEqual(r.applied.running, true);
    assert.ok(lines.includes('> difficulty hard'));
    await until(() => m.get(id).status === 'running', 8000);
    await m.stop(id);
  } finally {
    delete process.env.MCES_FAKE_MODE;
  }
  // 꺼진 상태에서 저장하면 콘솔에 안내 줄
  m.updateSettings(id, { difficulty: 'normal' });
  assert.ok(lines.some((l) => l.includes('다음 실행 때 적용')));
});

test('콘솔 기록은 파일에도 남아 앱을 다시 켜도 보인다', { skip: process.platform === 'win32' }, async () => {
  const id = 'srv-log';
  fs.mkdirSync(paths.serverDir(id), { recursive: true });
  fs.writeFileSync(path.join(paths.serverDir(id), 'server.properties'), 'server-port=25991\n');
  Servers.save({ id, name: 'l', type: 'paper', version: '1.21.1', javaMajor: 21, memoryMb: 1024, port: 25991, optimize: false, levelName: 'world', addons: [], backup: { enabled: false, keep: 5, onStop: false }, network: { mode: 'tunnel', address: null } });
  const m = new ServerManager();
  await m.start(id);
  await until(() => m.get(id).status === 'running');
  m.command(id, 'say hi');
  await m.stop(id);
  const file = path.join(paths.serverDir(id), 'logs', 'mces-console.log');
  assert.match(fs.readFileSync(file, 'utf8'), /Done \(1\.234s\)/);

  // 앱을 다시 켠 것처럼 새 관리자: 메모리는 비었지만 파일에서 불러온다
  const m2 = new ServerManager();
  const lines = m2.consoleLines(id);
  assert.match(lines[0].line, /지난 실행 기록/);
  assert.ok(lines.some((l) => /Starting minecraft server/.test(l.line) && l.kind === 'out'));
  assert.ok(lines.some((l) => l.line === '> say hi' && l.kind === 'cmd'));
  assert.ok(lines.some((l) => /■ 서버 종료/.test(l.line) && l.kind === 'app'));

  // 다시 켜면 직전 기록은 prev 로 옮기고 새 파일에 이어 쓴다
  await m2.start(id);
  await until(() => m2.get(id).status === 'running');
  await m2.stop(id);
  assert.match(fs.readFileSync(path.join(paths.serverDir(id), 'logs', 'mces-console.prev.log'), 'utf8'), /\[MCES:cmd\] > say hi/);
  assert.ok(!/say hi/.test(fs.readFileSync(file, 'utf8')));
  // 화면에는 지난 기록과 이번 기록이 이어서 보인다
  assert.ok(m2.consoleLines(id).some((l) => l.line === '> say hi'));
});
