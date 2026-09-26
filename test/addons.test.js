'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-addon-'));
process.env.MC_EASY_DATA = tmp;
const paths = require('../src/main/paths');
paths.init(null);
const meta = require('../src/main/addon-meta');
const { Servers } = require('../src/main/store');
const { ServerManager } = require('../src/main/server-manager');

/** 테스트용 jar 만들기 */
function jar(name, files) {
  const out = path.join(tmp, name);
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(files)) z.addBuffer(Buffer.from(c), n);
    z.end();
    z.outputStream.pipe(fs.createWriteStream(out)).on('close', () => resolve(out));
  });
}

test('Fabric 버전 범위', () => {
  const m = meta.matchesRange;
  assert.ok(m('~1.21', '1.21.4'));
  assert.ok(!m('~1.21', '1.22'));
  assert.ok(m('>=1.21.1 <1.21.4', '1.21.3'));
  assert.ok(!m('>=1.21.1 <1.21.4', '1.21.4'));
  assert.ok(m('1.21.x', '1.21.8'));
  assert.ok(!m('1.21.x', '1.20.6'));
  assert.ok(m(['1.20.1', '1.21.1'], '1.21.1'));
  assert.ok(m('*', '1.8'));
  assert.ok(m('>= 1.21', '1.21'));
  assert.ok(m('>=1.21.2-alpha.24.33.a', '1.21.4'));
  assert.ok(!m('1.21.1', '1.21.2'));
});

test('jar 안의 정보로 플러그인·모드 인식과 호환성 판단', async () => {
  const plugin = await jar('WorldEditLike.jar', { 'plugin.yml': 'name: WorldEditLike\nversion: 7.3.0\napi-version: "1.21"\ndepend: [Vault]\nsoftdepend: [Essentials]\n' });
  const p = await meta.inspect(plugin);
  assert.deepStrictEqual([p.kind, p.name, p.version, p.apiVersion], ['plugin', 'WorldEditLike', '7.3.0', '1.21']);
  assert.deepStrictEqual(p.depends, ['Vault']);
  assert.strictEqual(meta.compat(p, 'paper', '1.21.4').status, 'ok');
  const old = meta.compat(p, 'paper', '1.20.6');
  assert.strictEqual(old.status, 'bad');
  assert.match(old.reason, /1\.21 이상 필요/);
  assert.ok(meta.compat(p, 'fabric', '1.21.4').wrongType);

  const paperPlugin = await jar('PaperOnly.jar', { 'paper-plugin.yml': 'name: PaperOnly\nversion: 1\napi-version: "1.21"\ndependencies:\n  server:\n    LuckPerms:\n      required: true\n    Optional:\n      required: false\n' });
  assert.deepStrictEqual((await meta.inspect(paperPlugin)).depends, ['LuckPerms']);

  const mod = await jar('coolmod.jar', { 'fabric.mod.json': JSON.stringify({ id: 'coolmod', name: 'Cool Mod', version: '2.0', environment: '*', depends: { fabricloader: '>=0.15', minecraft: '~1.21', 'fabric-api': '*', 'fabric-lifecycle-events-v1': '*', cloth: '*' } }) });
  const m = await meta.inspect(mod);
  assert.deepStrictEqual([m.kind, m.id, m.name], ['fabric', 'coolmod', 'Cool Mod']);
  assert.strictEqual(meta.compat(m, 'fabric', '1.21.4').status, 'ok');
  assert.strictEqual(meta.compat(m, 'fabric', '1.20.1').status, 'bad');
  assert.ok(meta.compat(m, 'paper', '1.21.4').wrongType);
  // Fabric API 가 있으면 fabric-* 모듈 의존성은 충족, cloth 는 빠짐
  assert.deepStrictEqual(meta.missingDependencies(m, [{ slug: 'fabric-api', title: 'Fabric API' }, { meta: m }]), ['cloth']);

  const notZip = path.join(tmp, 'readme.jar');
  fs.writeFileSync(notZip, 'hello');
  assert.strictEqual((await meta.inspect(notZip)).kind, null);
});

test('파일에서 추가 → 목록 · 호환성 · 빠진 의존성 · 업데이트 경고 · 끄기/삭제', async () => {
  const id = 'srv-addons';
  fs.mkdirSync(paths.serverDir(id), { recursive: true });
  Servers.save({ id, name: 't', type: 'paper', version: '1.21.4', javaMajor: 21, memoryMb: 1024, port: 25980, levelName: 'world', addons: [], backup: {}, network: {} });
  const m = new ServerManager();
  const good = await jar('Good.jar', { 'plugin.yml': 'name: Good\nversion: 1.0\napi-version: "1.21"\ndepend: [Vault]\n' });
  const newer = await jar('Future.jar', { 'plugin.yml': 'name: Future\nversion: 1.0\napi-version: "1.22"\n' });
  const mod = await jar('amod.jar', { 'fabric.mod.json': JSON.stringify({ id: 'amod', version: '1', depends: { minecraft: '1.21.4' } }) });
  const txt = path.join(tmp, 'notes.txt');
  fs.writeFileSync(txt, 'x');

  const r = await m.importFiles(id, [good, newer, mod, txt]);
  assert.deepStrictEqual(r.added.map((a) => [a.title, a.enabled]), [['Good', true], ['Future', false]]);
  assert.deepStrictEqual(r.rejected.map((x) => x.file), ['amod.jar', 'notes.txt']);
  // 버전이 안 맞는 파일은 꺼진 상태(.disabled)로 들어간다
  assert.ok(fs.existsSync(path.join(paths.serverDir(id), 'plugins', 'Future.jar.disabled')));

  // 폴더에 직접 넣은 파일도 인식한다
  fs.copyFileSync(await jar('Vault.jar', { 'plugin.yml': 'name: Vault\nversion: 1.7\napi-version: "1.13"\n' }), path.join(paths.serverDir(id), 'plugins', 'Vault.jar'));
  let list = await m.addons(id);
  const byTitle = Object.fromEntries(list.map((a) => [a.title, a]));
  assert.strictEqual(byTitle.Good.compat.status, 'ok');
  assert.deepStrictEqual(byTitle.Good.missing, []); // Vault 가 폴더에 있어 충족
  assert.strictEqual(byTitle.Vault.manual, true);
  assert.strictEqual(byTitle.Future.compat.status, 'bad');

  m.setAddonEnabled(id, 'Vault.jar', false);
  list = await m.addons(id);
  assert.deepStrictEqual(list.find((a) => a.title === 'Good').missing, ['Vault']);

  // 업데이트 전 검사: 파일 정보로 판단한 호환성이 들어간다 (Modrinth 에 없는 파일)
  const fc = await m.fileCompat(id, '1.20.6');
  assert.deepStrictEqual(fc.incompatible.map((a) => a.title), ['Good']);

  m.removeAddon(id, 'Good.jar');
  assert.ok(!fs.existsSync(path.join(paths.serverDir(id), 'plugins', 'Good.jar')));
  assert.ok(!(await m.addons(id)).some((a) => a.title === 'Good'));
});
