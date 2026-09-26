'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const yazl = require('yazl');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-world-'));
process.env.MC_EASY_DATA = tmp;
const paths = require('../src/main/paths');
paths.init(null);
const world = require('../src/main/world');
const props = require('../src/main/properties');
const { Servers } = require('../src/main/store');
const { ServerManager } = require('../src/main/server-manager');

/** 최소한의 level.dat (gzip NBT): Data{ LevelName, DataVersion, Version{ Name } } */
function levelDat(name, version) {
  const s = (str) => { const b = Buffer.from(str, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  const tag = (type, name, payload) => Buffer.concat([Buffer.from([type]), s(name), payload]);
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
  const end = Buffer.from([0]);
  const versionTag = tag(10, 'Version', Buffer.concat([tag(8, 'Name', s(version)), tag(3, 'Id', i32(3955)), end]));
  const data = tag(10, 'Data', Buffer.concat([tag(8, 'LevelName', s(name)), tag(3, 'DataVersion', i32(3955)), tag(9, 'ServerBrands', Buffer.concat([Buffer.from([8]), i32(1), s('vanilla')])), versionTag, end]));
  return zlib.gzipSync(tag(10, '', Buffer.concat([data, end])));
}

function makeSave(dir, name, version) {
  fs.mkdirSync(path.join(dir, 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'level.dat'), levelDat(name, version));
  fs.writeFileSync(path.join(dir, 'region', 'r.0.0.mca'), 'x');
  fs.writeFileSync(path.join(dir, 'session.lock'), 'lock');
  return dir;
}

test('월드 유형 값은 버전에 맞춘다', () => {
  assert.strictEqual(world.levelTypeValue('flat', '1.21.4'), 'minecraft:flat');
  assert.strictEqual(world.levelTypeValue('large_biomes', '1.18.2'), 'largeBiomes');
  assert.strictEqual(world.levelTypeFromValue('minecraft:amplified'), 'amplified');
});

test('커스텀 평지: 평원 · 물 50칸 → generator-settings, server.properties 왕복', () => {
  const w = { type: 'flat', seed: '', structures: false, flat: { biome: 'plains', layers: [{ block: 'bedrock', height: 1 }, { block: 'water', height: 50 }] } };
  const p = world.toProperties(w, '1.21.4');
  assert.strictEqual(p['level-type'], 'minecraft:flat');
  const g = JSON.parse(p['generator-settings']);
  assert.deepStrictEqual(g.layers, [{ block: 'minecraft:bedrock', height: 1 }, { block: 'minecraft:water', height: 50 }]);
  assert.strictEqual(g.biome, 'minecraft:plains');
  assert.deepStrictEqual(g.structure_overrides, []);
  // server.properties 에 썼다 읽어도(':' 이스케이프) 그대로
  const text = props.merge('', p);
  assert.match(text, /generator-settings=\{"layers"\\:/);
  const back = world.fromProperties(props.parse(text));
  assert.strictEqual(back.type, 'flat');
  assert.deepStrictEqual(back.flat.layers, [{ block: 'bedrock', height: 1 }, { block: 'water', height: 50 }]);
  assert.strictEqual(back.structures, false);

  assert.throws(() => world.validateFlat({ layers: [] }), /1개 이상/);
  assert.throws(() => world.validateFlat({ layers: [{ block: 'stone', height: 400 }] }), /최대 384칸/);
  assert.throws(() => world.validateFlat({ layers: [{ block: 'stone"}', height: 1 }] }), /잘못된 블록/);
});

test('level.dat 에서 맵 이름·저장 버전 읽기', () => {
  const r = world.readNbtVersion(levelDat('내 야생', '1.21.4'));
  assert.deepStrictEqual([r.levelName, r.version, r.dataVersion], ['내 야생', '1.21.4', 3955]);
});

test('다른 맵 가져오기 (폴더 · zip) · 새 설정으로 다시 만들기', async () => {
  const id = 'srv-world';
  const dir = paths.serverDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.properties'), 'level-name=world\n');
  Servers.save({ id, name: 't', type: 'paper', version: '1.21.4', javaMajor: 21, memoryMb: 1024, port: 25960, levelName: 'world', addons: [], backup: {}, network: {} });
  makeSave(path.join(dir, 'world'), 'old', '1.21.4');
  fs.mkdirSync(path.join(dir, 'world_nether'), { recursive: true });
  const m = new ServerManager();

  // 폴더: 저장 폴더를 고르면 기존 월드는 백업 후 교체, session.lock 은 빼고
  const save = makeSave(path.join(tmp, 'saves', 'My World'), '내 야생', '1.21.4');
  const info = await m.inspectWorldSource(id, save);
  assert.deepStrictEqual([info.name, info.version, info.newer], ['내 야생', '1.21.4', false]);
  const r = await m.importWorld(id, save);
  assert.strictEqual(r.name, '내 야생');
  assert.ok(fs.existsSync(path.join(dir, 'world', 'region', 'r.0.0.mca')));
  assert.ok(!fs.existsSync(path.join(dir, 'world', 'session.lock')));
  assert.ok(!fs.existsSync(path.join(dir, 'world_nether')));
  assert.ok(m.listBackups(id).some((b) => b.reason === 'before-import'));

  // zip: 한 단계 안쪽 폴더에 level.dat 가 있어도 찾는다. 서버보다 새 버전이면 경고
  const zipSrc = makeSave(path.join(tmp, 'zipsrc', 'Newer'), '새 맵', '1.21.9');
  const zipFile = path.join(tmp, 'newer.zip');
  await new Promise((res) => {
    const z = new yazl.ZipFile();
    for (const f of ['level.dat', 'region/r.0.0.mca']) z.addFile(path.join(zipSrc, f), `Newer/${f}`);
    z.end();
    z.outputStream.pipe(fs.createWriteStream(zipFile)).on('close', res);
  });
  assert.strictEqual((await m.inspectWorldSource(id, zipFile)).newer, true);
  await m.importWorld(id, zipFile);
  assert.strictEqual(world.worldInfoAt(path.join(dir, 'world')).levelName, '새 맵');

  // 폴더도 zip 도 아닌 것은 거절
  const notWorld = path.join(tmp, 'empty');
  fs.mkdirSync(notWorld);
  await assert.rejects(m.importWorld(id, notWorld), /level\.dat 없음/);

  // 다시 만들기: 월드 삭제 + 설정 기록 + 백업
  const w = await m.regenerateWorld(id, { type: 'flat', seed: '42', structures: false, flat: { biome: 'plains', layers: [{ block: 'bedrock', height: 1 }, { block: 'water', height: 50 }] } });
  assert.strictEqual(w.type, 'flat');
  assert.strictEqual(w.seed, '42');
  assert.ok(!fs.existsSync(path.join(dir, 'world')));
  assert.ok(m.listBackups(id).some((b) => b.reason === 'before-reset'));
});
