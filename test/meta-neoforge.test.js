'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const meta = require('../src/main/addon-meta');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-meta-'));
function jar(name, files) {
  const out = path.join(tmp, name);
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(files)) z.addBuffer(Buffer.from(c), n);
    z.end();
    z.outputStream.pipe(fs.createWriteStream(out)).on('close', () => resolve(out));
  });
}

test('NeoForge 1.20.2~1.20.4 모드는 mods.toml 이어도 NeoForge 모드로 본다', async () => {
  const f = await jar('neo-old.jar', {
    'META-INF/mods.toml': 'modLoader="javafml"\nloaderVersion="[1,)"\n[[mods]]\nmodId="neomod"\nversion="1.0"\n[[dependencies.neomod]]\nmodId="neoforge"\ntype="required"\nversionRange="[20.4,)"\n[[dependencies.neomod]]\nmodId="minecraft"\ntype="required"\nversionRange="[1.20.4,1.21)"\n',
    'pack.mcmeta': '{"pack":{"pack_format":15}}',
  });
  const m = await meta.inspect(f);
  assert.strictEqual(m.kind, 'neoforge');
  assert.strictEqual(meta.compat(m, 'neoforge', '1.20.4').status, 'ok');
  assert.ok(meta.compat(m, 'forge', '1.20.4').wrongType);
});

test('TOML 로 못 읽는 mods.toml 도 줄 단위로 읽고, 접속 쪽 전용 의존성은 빼고, jar 안 라이브러리는 갖춘 것으로 본다', async () => {
  const f = await jar('loose.jar', {
    // 같은 키가 두 번 — 엄격한 TOML 로는 실패한다
    'META-INF/neoforge.mods.toml': 'modLoader="javafml"\nlicense="MIT"\nlicense="MIT"\n[[mods]]\nmodId="bigmod"\nversion="2.0"\n[[mods]]\nmodId="bigmod_addon"\n[[dependencies.bigmod]]\nmodId="minecraft"\ntype="required"\nversionRange="[1.21.1,)"\n[[dependencies.bigmod]]\nmodId="jei"\ntype="required"\nside="CLIENT"\n[[dependencies.bigmod]]\nmodId="mixinextras"\ntype="required"\n[[dependencies.bigmod]]\nmodId="curios"\ntype="required"\n',
    'META-INF/jarjar/metadata.json': JSON.stringify({ jars: [{ identifier: { group: 'io.github.llamalad7', artifact: 'mixinextras-neoforge' } }] }),
    'pack.mcmeta': '{}',
  });
  const m = meta.forServer(await meta.inspect(f), 'neoforge');
  assert.strictEqual(m.kind, 'neoforge');
  assert.strictEqual(m.id, 'bigmod');
  assert.deepStrictEqual(m.depends.sort(), ['curios', 'mixinextras']);
  const self = { meta: m };
  assert.deepStrictEqual(meta.missingDependencies(m, [self]), ['curios']);
});

test('모드 정보가 없는 jar 는 데이터팩이 아니라 정보 없음으로', async () => {
  const f = await jar('lib.jar', { 'pack.mcmeta': '{}', 'a/B.class': 'x' });
  const m = await meta.inspect(f);
  assert.strictEqual(m.kind, null);
  assert.strictEqual(meta.compat(m, 'neoforge', '1.21.1').status, 'unknown');
});
