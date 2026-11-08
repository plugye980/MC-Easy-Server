'use strict';
// NeoForge 모드 서버
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-neo-'));
process.env.MC_EASY_DATA = path.join(tmp, 'data');
const paths = require('../src/main/paths');
paths.init(null);
const versions = require('../src/main/versions');
const forge = require('../src/main/forge');
const modrinth = require('../src/main/modrinth');
const meta = require('../src/main/addon-meta');
const serverImport = require('../src/main/server-import');

function jar(out, files) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(files)) z.addBuffer(Buffer.from(c), n);
    z.end();
    z.outputStream.pipe(fs.createWriteStream(out)).on('close', () => resolve(out));
  });
}

test('NeoForge 버전 → 마인크래프트 버전, 버전별 빌드 고르기', () => {
  assert.strictEqual(versions.neoforgeMc('21.1.77'), '1.21.1');
  assert.strictEqual(versions.neoforgeMc('21.0.167'), '1.21');
  assert.strictEqual(versions.neoforgeMc('20.4.237'), '1.20.4');
  assert.strictEqual(versions.neoforgeMc('26.1.0.3-beta'), '26.1');
  assert.strictEqual(versions.neoforgeMc('26.1.2.5'), '26.1.2');
  const xml = '<metadata><versioning><versions><version>21.1.70</version><version>21.1.77</version><version>21.1.80-beta</version><version>21.4.5-beta</version></versions></versioning></metadata>';
  const legacy = '<version>1.20.1-47.1.99</version><version>1.20.1-47.1.106</version>';
  const b = versions.neoforgeBuilds(xml, legacy);
  // 정식이 있으면 정식 중 최신, 없으면 베타
  assert.deepStrictEqual(b.get('1.21.1'), { mc: '1.21.1', version: '21.1.77', artifact: 'neoforge', stable: true });
  assert.strictEqual(b.get('1.21.4').stable, false);
  assert.deepStrictEqual(b.get('1.20.1'), { mc: '1.20.1', version: '1.20.1-47.1.106', artifact: 'forge', stable: true });
});

test('NeoForge 실행 인자 파일 찾기 (새 이름 · 1.20.1 예전 이름)', () => {
  const d = path.join(tmp, 'launch');
  fs.mkdirSync(path.join(d, 'libraries/net/neoforged/neoforge/21.1.77'), { recursive: true });
  fs.writeFileSync(path.join(d, 'libraries/net/neoforged/neoforge/21.1.77/win_args.txt'), '');
  assert.deepStrictEqual(forge.loaderLaunchArgs('neoforge', d, '1.21.1', '21.1.77', 'win32'), ['@libraries/net/neoforged/neoforge/21.1.77/win_args.txt']);
  fs.mkdirSync(path.join(d, 'libraries/net/neoforged/forge/1.20.1-47.1.106'), { recursive: true });
  fs.writeFileSync(path.join(d, 'libraries/net/neoforged/forge/1.20.1-47.1.106/unix_args.txt'), '');
  assert.deepStrictEqual(forge.loaderLaunchArgs('neoforge', d, '1.20.1', '1.20.1-47.1.106', 'linux'), ['@libraries/net/neoforged/forge/1.20.1-47.1.106/unix_args.txt']);
  assert.strictEqual(forge.loaderLaunchArgs('neoforge', d, '1.21.4', '21.4.1', 'linux'), null);
});

test('Modrinth 필터: NeoForge 1.20.1 은 Forge 모드도, 그 뒤 버전은 NeoForge 만', () => {
  assert.deepStrictEqual(modrinth.loadersFor('neoforge', '1.20.1'), ['neoforge', 'forge']);
  assert.deepStrictEqual(modrinth.loadersFor('neoforge', '1.21.1'), ['neoforge']);
  assert.strictEqual(modrinth.addonFolder({ type: 'neoforge' }), 'mods');
  const f = modrinth.searchFacets({ type: 'neoforge', version: '1.21.1' });
  assert.deepStrictEqual(f[0], ['categories:neoforge']);
  assert.ok(f.some((x) => x.includes('project_type:mod')));
});

test('NeoForge 서버의 파일 호환 판단', async () => {
  const neo = await jar(path.join(tmp, 'neo.jar'), { 'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="x"\n[[dependencies.x]]\nmodId="minecraft"\ntype="required"\nversionRange="[1.21.1,1.22)"\n' });
  const forgeOnly = await jar(path.join(tmp, 'forge.jar'), { 'META-INF/mods.toml': '[[mods]]\nmodId="y"\n[[dependencies.y]]\nmodId="minecraft"\nmandatory=true\nversionRange="[1.20.1,1.20.2)"\n' });
  const multi = await jar(path.join(tmp, 'multi.jar'), { 'fabric.mod.json': '{"id":"z","depends":{"minecraft":">=1.17"}}', 'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="z"\n' });
  assert.strictEqual(meta.compat(await meta.inspect(neo), 'neoforge', '1.21.1').status, 'ok');
  assert.strictEqual(meta.compat(await meta.inspect(neo), 'neoforge', '1.20.4').status, 'bad');
  assert.strictEqual(meta.compat(await meta.inspect(forgeOnly), 'neoforge', '1.20.1').status, 'ok');
  assert.match(meta.compat(await meta.inspect(forgeOnly), 'neoforge', '1.21.1').reason, /1\.20\.1 에서만/);
  // 여러 로더용 jar 는 NeoForge 정보로
  const m = await meta.inspect(multi);
  assert.strictEqual(meta.forServer(m, 'neoforge').kind, 'neoforge');
  assert.notStrictEqual(meta.compat(m, 'neoforge', '1.21.1').status, 'bad');
  assert.match(meta.compat(await meta.inspect(neo), 'forge', '1.21.1').reason, /NeoForge 전용/);
});

test('기존 NeoForge 서버 폴더 가져오기', async () => {
  const d = path.join(tmp, 'neoserver');
  fs.mkdirSync(path.join(d, 'libraries/net/neoforged/neoforge/21.1.77'), { recursive: true });
  fs.writeFileSync(path.join(d, 'server.properties'), 'server-port=25565\n');
  await jar(path.join(d, 'mods', 'a.jar'), { 'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="a"\n' });
  const det = await serverImport.detect(d);
  assert.deepStrictEqual(det.problems, []);
  assert.strictEqual(det.type, 'neoforge');
  assert.strictEqual(det.version, '1.21.1');
  assert.strictEqual(det.build, '21.1.77');
  assert.strictEqual(det.addonCount, 1);

  const l = path.join(tmp, 'neolegacy');
  fs.mkdirSync(path.join(l, 'libraries/net/neoforged/forge/1.20.1-47.1.106'), { recursive: true });
  fs.writeFileSync(path.join(l, 'server.properties'), '');
  const dl = await serverImport.detect(l);
  assert.strictEqual(dl.type, 'neoforge');
  assert.strictEqual(dl.version, '1.20.1');
  assert.strictEqual(dl.build, '1.20.1-47.1.106');
});
