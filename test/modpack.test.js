'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const yazl = require('yazl');
const modpack = require('../src/main/modpack');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-pack-'));

function zip(name, files) {
  const out = path.join(tmp, name);
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(files)) z.addBuffer(Buffer.isBuffer(c) ? c : Buffer.from(c), n);
    z.end();
    z.outputStream.pipe(fs.createWriteStream(out)).on('close', () => resolve(out));
  });
}
const zipBuffer = async (name, files) => fs.readFileSync(await zip(name, files));

test('CurseForge 모드팩 manifest 읽기', async () => {
  const file = await zip('cf.zip', {
    'manifest.json': JSON.stringify({
      manifestType: 'minecraftModpack',
      name: 'Test Pack',
      version: '1.0.3',
      minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
      files: [{ projectID: 238222, fileID: 4712345, required: true }, { projectID: 1, fileID: 2, required: false }],
      overrides: 'overrides',
    }),
    'modlist.html': '<ul></ul>',
    'overrides/config/a.toml': 'x=1',
    'overrides/kubejs/server_scripts/a.js': '//',
  });
  const pack = await modpack.read(file);
  assert.strictEqual(pack.format, 'curseforge');
  assert.strictEqual(pack.name, 'Test Pack');
  assert.strictEqual(pack.mc, '1.20.1');
  assert.deepStrictEqual(pack.loader, { type: 'forge', version: '47.2.0' });
  assert.deepStrictEqual(pack.files, [{ projectID: 238222, fileID: 4712345 }]); // 선택 항목은 빼고
  assert.strictEqual(modpack.CF_DOWNLOAD(238222, 4712345), 'https://www.curseforge.com/api/v1/mods/238222/files/4712345/download');
  assert.deepStrictEqual(modpack.checkFit(pack, { type: 'forge', version: '1.20.1' }), []);
  assert.strictEqual(modpack.checkFit(pack, { type: 'fabric', version: '1.21.1' }).length, 2);
  assert.strictEqual(await modpack.read(await zip('plain.zip', { 'readme.txt': 'hi' })), null);
});

test('Modrinth 모드팩 설치: 모드 받기 · overrides · 화면 전용 모드 끄기', async () => {
  const serverMod = await zipBuffer('server-mod.jar', { 'fabric.mod.json': JSON.stringify({ id: 'lithiumlike', version: '1', environment: '*' }) });
  const clientMod = await zipBuffer('client-mod.jar', { 'fabric.mod.json': JSON.stringify({ id: 'shiny', version: '1', environment: 'client' }) });
  const knownClient = await zipBuffer('sodium.jar', { 'fabric.mod.json': JSON.stringify({ id: 'sodium', version: '1', environment: '*' }) });
  const srv = http.createServer((req, res) => {
    const body = { '/a.jar': serverMod, '/b.jar': clientMod, '/c.jar': knownClient }[req.url];
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const file = await zip('pack.mrpack', {
      'modrinth.index.json': JSON.stringify({
        formatVersion: 1,
        name: 'MR Pack',
        versionId: '2.0',
        dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' },
        files: [
          { path: 'mods/lithiumlike.jar', downloads: [`${base}/a.jar`], env: { client: 'required', server: 'required' } },
          { path: 'mods/shiny.jar', downloads: [`${base}/b.jar`] },
          { path: 'mods/sodium.jar', downloads: [`${base}/c.jar`] },
          { path: 'mods/clientonly.jar', downloads: [`${base}/missing.jar`], env: { client: 'required', server: 'unsupported' } },
          { path: 'mods/gone.jar', downloads: [`${base}/missing.jar`] },
        ],
      }),
      'overrides/config/x.json': '{}',
      'server-overrides/server-only.txt': 'ok',
    });
    const dir = path.join(tmp, 'server');
    fs.mkdirSync(dir);
    const steps = [];
    const r = await modpack.install(file, dir, { type: 'fabric', version: '1.21.1' }, (p) => steps.push(p.percent));
    assert.strictEqual(r.name, 'MR Pack');
    assert.strictEqual(r.mods, 1);
    assert.deepStrictEqual(r.disabled.sort(), ['shiny.jar', 'sodium.jar']);
    assert.strictEqual(r.failed.length, 1); // gone.jar (clientonly.jar 는 받지 않는다)
    assert.deepStrictEqual(r.warnings, []);
    assert.ok(fs.existsSync(path.join(dir, 'mods/lithiumlike.jar')));
    assert.ok(fs.existsSync(path.join(dir, 'mods/shiny.jar.disabled')));
    assert.ok(!fs.existsSync(path.join(dir, 'mods/clientonly.jar')));
    assert.ok(fs.existsSync(path.join(dir, 'config/x.json')));
    assert.ok(fs.existsSync(path.join(dir, 'server-only.txt')));
    assert.strictEqual(steps[steps.length - 1], 1);
  } finally {
    srv.close();
  }
});
