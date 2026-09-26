'use strict';
// 하이브리드 서버 (플러그인 + Forge 모드)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-hybrid-'));
process.env.MC_EASY_DATA = path.join(tmp, 'data');
const paths = require('../src/main/paths');
paths.init(null);
const versions = require('../src/main/versions');
const modrinth = require('../src/main/modrinth');
const serverImport = require('../src/main/server-import');
const { Servers } = require('../src/main/store');
const { ServerManager } = require('../src/main/server-manager');

function jar(out, files) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(files)) z.addBuffer(Buffer.from(c), n);
    z.end();
    z.outputStream.pipe(fs.createWriteStream(out)).on('close', () => resolve(out));
  });
}

test('Arclight 릴리스에서 Forge 판 서버 jar 고르기', () => {
  const assets = versions.arclightAssets([
    { tag_name: 'Whisper/1.0.2', prerelease: false, published_at: '2026-05-01', assets: [
      { name: 'arclight-forge-1.20.1-1.0.2.jar', browser_download_url: 'u1' },
      { name: 'arclight-neoforge-1.21.1-1.0.2.jar', browser_download_url: 'u2' },
      { name: 'arclight-forge-1.20.1-1.0.2-sources.jar', browser_download_url: 'u3' },
    ] },
    { tag_name: 'Feudal/1.0.9', prerelease: true, published_at: '2026-06-01', assets: [{ name: 'arclight-forge-1.21.1-1.0.9.jar', browser_download_url: 'u4' }] },
  ]);
  assert.deepStrictEqual(assets.map((a) => [a.mc, a.build, a.url, a.stable]), [['1.21.1', '1.0.9', 'u4', false], ['1.20.1', '1.0.2', 'u1', true]]);
});

test('플러그인·모드 보기: 하이브리드는 종류별로 Paper·Forge 처럼', () => {
  const s = { id: 'x', type: 'hybrid', version: '1.20.1', addons: [{ fileName: 'a.jar', kind: 'plugin' }, { fileName: 'b.jar', kind: 'mod' }] };
  const p = modrinth.asKind(s, 'plugin');
  const m = modrinth.asKind(s, 'mod');
  assert.strictEqual(p.type, 'paper');
  assert.strictEqual(modrinth.addonFolder(p), 'plugins');
  assert.deepStrictEqual(p.addons.map((a) => a.fileName), ['a.jar']);
  assert.strictEqual(m.type, 'forge');
  assert.strictEqual(modrinth.addonFolder(m), 'mods');
  assert.deepStrictEqual(modrinth.loadersFor(m.type), ['forge']);
  assert.deepStrictEqual(modrinth.kindsOf(s), ['plugin', 'mod']);
  // 다른 서버는 그대로
  const paper = { type: 'paper', addons: [] };
  assert.strictEqual(modrinth.asKind(paper, 'mod'), paper);
});

test('하이브리드: 파일 추가는 종류에 맞는 폴더로, 목록은 두 폴더 모두', async () => {
  const id = 'hy';
  const dir = paths.serverDir(id);
  fs.mkdirSync(dir, { recursive: true });
  Servers.save({ id, name: 'h', type: 'hybrid', version: '1.20.1', javaMajor: 17, memoryMb: 2048, port: 25992, levelName: 'world', addons: [], backup: { enabled: false, keep: 3, onStop: false }, network: { mode: 'tunnel', address: null } });
  const src = path.join(tmp, 'src');
  const plugin = await jar(path.join(src, 'Essentials.jar'), { 'plugin.yml': 'name: Essentials\nversion: 2.20\napi-version: "1.20"\n' });
  const mod = await jar(path.join(src, 'jei.jar'), { 'META-INF/mods.toml': 'modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\nmodId="jei"\nversion="15.2"\ndisplayName="JEI"\n[[dependencies.jei]]\nmodId="minecraft"\nmandatory=true\nversionRange="[1.20.1,1.20.2)"\n' });
  const fabric = await jar(path.join(src, 'sodium.jar'), { 'fabric.mod.json': '{"id":"sodium","depends":{"minecraft":"1.20.1"}}' });
  const m = new ServerManager();
  const r = await m.importFiles(id, [plugin, mod, fabric]);
  assert.deepStrictEqual(r.added.map((a) => a.fileName).sort(), ['Essentials.jar', 'jei.jar']);
  assert.match(r.rejected[0].reason, /Fabric/);
  assert.ok(fs.existsSync(path.join(dir, 'plugins', 'Essentials.jar')));
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'jei.jar')));

  // 폴더에 직접 넣은 것도 종류와 함께 보인다
  await jar(path.join(dir, 'mods', 'create.jar'), { 'META-INF/mods.toml': '[[mods]]\nmodId="create"\n' });
  const list = await m.addons(id);
  const kinds = Object.fromEntries(list.map((a) => [a.fileName, a.kind]));
  assert.deepStrictEqual(kinds, { 'Essentials.jar': 'plugin', 'jei.jar': 'mod', 'create.jar': 'mod' });
  assert.strictEqual(list.find((a) => a.fileName === 'jei.jar').compat.status, 'ok');

  // 끄기·삭제는 파일이 있는 폴더에서
  m.setAddonEnabled(id, 'jei.jar', false);
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'jei.jar.disabled')));
  m.setAddonEnabled(id, 'create.jar', false);
  assert.ok(fs.existsSync(path.join(dir, 'mods', 'create.jar.disabled')));
  m.removeAddon(id, 'Essentials.jar');
  assert.ok(!fs.existsSync(path.join(dir, 'plugins', 'Essentials.jar')));
});

test('기존 하이브리드 서버 가져오기: Mohist(Forge) 는 하이브리드, Youer(NeoForge) 는 안내', async () => {
  const md = path.join(tmp, 'mohist');
  await jar(path.join(md, 'mohist-1.20.1-812-server.jar'), { 'META-INF/MANIFEST.MF': 'Main-Class: com.mohistmc.MohistMCStart\n' });
  fs.mkdirSync(path.join(md, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.2.20'), { recursive: true });
  fs.mkdirSync(path.join(md, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(md, 'server.properties'), 'server-port=25565\n');
  const d = await serverImport.detect(md);
  assert.deepStrictEqual(d.problems, []);
  assert.strictEqual(d.type, 'hybrid');
  assert.strictEqual(d.flavor, 'Mohist');
  assert.strictEqual(d.version, '1.20.1');
  assert.strictEqual(d.jarFile, 'mohist-1.20.1-812-server.jar');
  assert.ok(d.warnings.some((w) => /Arclight 로 바뀜/.test(w)));

  const yd = path.join(tmp, 'youer');
  await jar(path.join(yd, 'youer-1.21.1-server.jar'), { 'META-INF/MANIFEST.MF': 'Main-Class: com.mohistmc.youer.Main\n' });
  fs.writeFileSync(path.join(yd, 'server.properties'), '');
  assert.match((await serverImport.detect(yd)).problems[0], /NeoForge 기반/);
});
