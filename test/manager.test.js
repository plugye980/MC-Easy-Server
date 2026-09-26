'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mceasy-mgr-'));
process.env.MC_EASY_DATA = tmp;
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

test('설정 저장: 켜져 있으면 난이도·게임 모드·화이트리스트는 명령어로 바로, 꺼져 있으면 난이도는 다음 실행 때', { skip: process.platform === 'win32' }, async () => {
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
  assert.strictEqual(Servers.get(id).pendingCommands.difficulty, 'difficulty hard');
  const lines = [];
  m.on('console', (c) => lines.push(c.line));
  await m.start(id);
  await until(() => m.get(id).status === 'running');
  await until(() => lines.includes('> difficulty hard'));
  assert.strictEqual(Servers.get(id).pendingCommands, undefined);

  // 켜진 상태: 명령어로 바로, 나머지는 재시작 후
  r = m.updateSettings(id, { difficulty: 'peaceful', gamemode: 'creative', maxPlayers: 5, whitelist: false });
  assert.deepStrictEqual(r.applied.now, ['난이도', '게임 모드']);
  assert.deepStrictEqual(r.applied.restart, ['최대 인원']);
  assert.ok(lines.includes('> difficulty peaceful'));
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
