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
  await until(() => m.get(id).players.length === 1);
  assert.strictEqual(m.get(id).players[0].name, 'Steve');
  assert.strictEqual(m.get(id).players[0].uuid, '069a79f4-44e9-4726-a5be-fca90e38aaf5');
  await until(() => m.get(id).metrics.tps === 19.5);
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
