'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-rules-'));
process.env.MC_EASY_DATA = tmp;
const paths = require('../src/main/paths');
paths.init(null);
const bin = path.join(paths.runtimes(), 'java-21', 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'java'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fixtures', 'fake-server.js')}"\n`, { mode: 0o755 });

const world = require('../src/main/world');
const gamerules = require('../src/main/gamerules');
const { Servers } = require('../src/main/store');
const { ServerManager } = require('../src/main/server-manager');

// ---- 테스트용 NBT 쓰기 ----
const s16 = (s) => {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length);
  return Buffer.concat([l, b]);
};
function tag(type, name, payload) {
  return Buffer.concat([Buffer.from([type]), s16(name), payload]);
}
const str = (name, v) => tag(8, name, s16(v));
const byte = (name, v) => tag(1, name, Buffer.from([v]));
const int = (name, v) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(v);
  return tag(3, name, b);
};
const compound = (name, children) => tag(10, name, Buffer.concat([...children, Buffer.from([0])]));
const levelDat = (rulesTag) => zlib.gzipSync(compound('', [compound('Data', [compound('Version', [str('Name', '1.21.1')]), rulesTag])]));

test('게임 규칙 읽기: 예전 형식(문자열)과 새 형식(snake_case · 타입 값)', () => {
  const oldDir = path.join(tmp, 'old');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'level.dat'), levelDat(compound('GameRules', [str('keepInventory', 'false'), str('randomTickSpeed', '3'), str('doDaylightCycle', 'true'), str('someModRule', 'true')])));
  const o = world.readGameRules(oldDir);
  assert.deepStrictEqual(o.rules.keepInventory, { value: false, kind: 'bool' });
  assert.deepStrictEqual(o.rules.randomTickSpeed, { value: 3, kind: 'int' });
  const d = gamerules.describe(o.rules);
  assert.deepStrictEqual(d.common.map((r) => r.label), ['인벤토리 유지', '낮/밤 흐름', '작물·나무 성장 속도']);
  assert.deepStrictEqual(d.other.map((r) => r.key), ['someModRule']);

  const newDir = path.join(tmp, 'new');
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, 'level.dat'), levelDat(compound('minecraft:game_rules', [byte('minecraft:keep_inventory', 1), byte('minecraft:advance_time', 0), byte('minecraft:pvp', 1), byte('minecraft:command_blocks_work', 1), int('minecraft:random_tick_speed', 3)])));
  const n = world.readGameRules(newDir);
  const nd = gamerules.describe(n.rules);
  assert.deepStrictEqual(nd.common.map((r) => [r.key, r.value]), [['minecraft:keep_inventory', true], ['minecraft:advance_time', false], ['minecraft:random_tick_speed', 3]]);
  // PVP·커맨드 블록은 설정 화면 항목이 맡는다
  assert.deepStrictEqual(nd.other, []);
  assert.strictEqual(gamerules.command('minecraft:keep_inventory', false), 'gamerule minecraft:keep_inventory false');
  assert.throws(() => gamerules.command('x; stop', true));
});

test('규칙 바꾸기: 꺼져 있으면 다음 실행 때, 켜져 있으면 바로 · PVP 는 규칙이 있으면 규칙으로', { skip: process.platform === 'win32' }, async () => {
  const id = 'srv-rules';
  const dir = paths.serverDir(id);
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'server-port=25996\npvp=true\n');
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), levelDat(compound('GameRules', [str('keepInventory', 'false'), str('doMobSpawning', 'true'), str('pvp', 'true'), str('randomTickSpeed', '3')])));
  Servers.save({ id, name: 'r', type: 'paper', version: '1.21.9', javaMajor: 21, memoryMb: 1024, port: 25996, optimize: false, levelName: 'world', addons: [], backup: { enabled: false, keep: 5, onStop: false }, network: { mode: 'tunnel', address: null } });
  const m = new ServerManager();

  let r = m.setGameRules(id, { keepInventory: true, randomTickSpeed: '10' });
  assert.strictEqual(r.running, false);
  let g = m.gameRules(id);
  const keep = g.common.find((x) => x.key === 'keepInventory');
  assert.strictEqual(keep.value, true);
  assert.strictEqual(keep.pending, true);

  const lines = [];
  m.on('console', (c) => lines.push(c.line));
  await m.start(id);
  const t0 = Date.now();
  while (m.get(id).status !== 'running' && Date.now() - t0 < 5000) await new Promise((res) => setTimeout(res, 30));
  await new Promise((res) => setTimeout(res, 100));
  assert.ok(lines.includes('> gamerule keepInventory true'));
  assert.ok(lines.includes('> gamerule randomTickSpeed 10'));
  g = m.gameRules(id);
  assert.strictEqual(g.common.find((x) => x.key === 'keepInventory').pending, false);
  assert.strictEqual(g.common.find((x) => x.key === 'keepInventory').value, true); // 월드 저장 전에도 바꾼 값

  r = m.setGameRules(id, { doMobSpawning: false });
  assert.ok(lines.includes('> gamerule doMobSpawning false'));
  assert.deepStrictEqual(r.changed, ['몹 자연 스폰']);

  // 1.21.9 이후: PVP 는 규칙 → 켜진 서버에 바로
  const s = m.updateSettings(id, { pvp: false });
  assert.ok(lines.includes('> gamerule pvp false'));
  assert.deepStrictEqual(s.applied.now, ['PVP']);
  await m.stop(id);
});
