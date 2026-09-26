'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-forge-'));
process.env.MC_EASY_DATA = tmp;
const paths = require('../src/main/paths');
paths.init(null);
const versions = require('../src/main/versions');
const forge = require('../src/main/forge');
const meta = require('../src/main/addon-meta');
const modrinth = require('../src/main/modrinth');
const { ErrorTranslator } = require('../src/main/errors');

let hasJdk = false;
try {
  execFileSync('javac', ['-version'], { stdio: 'ignore' });
  hasJdk = true;
} catch { /* JDK 없으면 실제 JVM 테스트는 건너뜀 */ }

test('Forge 버전 목록: 버전별 추천 빌드(없으면 최신), 1.12.2 미만 제외', () => {
  const promos = { '1.20.1-recommended': '47.3.0', '1.20.1-latest': '47.3.12', '1.21.1-latest': '52.0.16', '1.7.10-recommended': '10.13.4.1614', '1.20.1-foo': 'x' };
  assert.deepStrictEqual(Object.keys(versions.forgePromos(promos)).sort(), ['1.20.1', '1.21.1']);
  assert.strictEqual(versions.pickForgeBuild(promos, '1.20.1'), '47.3.0');
  assert.strictEqual(versions.pickForgeBuild(promos, '1.21.1'), '52.0.16');
  assert.strictEqual(versions.pickForgeBuild(promos, '1.19.2'), null);
});

test('Forge 실행 인자: 1.17+ 는 @args 파일, 구버전은 forge jar', () => {
  const modern = fs.mkdtempSync(path.join(tmp, 'modern-'));
  fs.mkdirSync(path.join(modern, 'libraries/net/minecraftforge/forge/1.20.1-47.3.0'), { recursive: true });
  fs.writeFileSync(path.join(modern, 'libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt'), 'x');
  fs.writeFileSync(path.join(modern, 'libraries/net/minecraftforge/forge/1.20.1-47.3.0/win_args.txt'), 'x');
  assert.deepStrictEqual(forge.launchArgs(modern, '1.20.1', '47.3.0', 'linux'), ['@libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt']);
  assert.deepStrictEqual(forge.launchArgs(modern, '1.20.1', '47.3.0', 'win32'), ['@libraries/net/minecraftforge/forge/1.20.1-47.3.0/win_args.txt']);
  const old = fs.mkdtempSync(path.join(tmp, 'old-'));
  fs.writeFileSync(path.join(old, 'forge-1.16.5-36.2.39-installer.jar'), 'x');
  fs.writeFileSync(path.join(old, 'forge-1.16.5-36.2.39.jar'), 'x');
  assert.deepStrictEqual(forge.launchArgs(old, '1.16.5', '36.2.39'), ['-jar', 'forge-1.16.5-36.2.39.jar']);
  assert.strictEqual(forge.launchArgs(fs.mkdtempSync(path.join(tmp, 'none-')), '1.20.1', '47.3.0'), null);
});

test('Forge 모드 정보(mods.toml)와 버전 범위', async () => {
  const yazl = require('yazl');
  const jar = path.join(tmp, 'create.jar');
  const toml = `modLoader="javafml"
loaderVersion="[47,)"
license="MIT"
[[mods]]
modId="create"
version="\${file.jarVersion}"
displayName="Create"
[[dependencies.create]]
    modId="forge"
    mandatory=true
    versionRange="[47.1.3,)"
[[dependencies.create]]
    modId="minecraft"
    mandatory=true
    versionRange="[1.20.1,1.20.2)"
[[dependencies.create]]
    modId="flywheel"
    mandatory=true
    versionRange="[0.6.10,)"
[[dependencies.create]]
    modId="jei"
    mandatory=false
    versionRange="*"
`;
  await new Promise((res) => {
    const z = new yazl.ZipFile();
    z.addBuffer(Buffer.from(toml), 'META-INF/mods.toml');
    z.addBuffer(Buffer.from('Manifest-Version: 1.0\nImplementation-Version: 0.5.1.f\n'), 'META-INF/MANIFEST.MF');
    z.end();
    z.outputStream.pipe(fs.createWriteStream(jar)).on('close', res);
  });
  const m = await meta.inspect(jar);
  assert.deepStrictEqual([m.kind, m.id, m.name, m.version, m.mcRange], ['forge', 'create', 'Create', '0.5.1.f', '[1.20.1,1.20.2)']);
  assert.deepStrictEqual(m.depends, ['flywheel']);
  assert.strictEqual(meta.compat(m, 'forge', '1.20.1').status, 'ok');
  assert.match(meta.compat(m, 'forge', '1.21.1').reason, /1\.20\.1,1\.20\.2/);
  assert.ok(meta.compat(m, 'fabric', '1.20.1').wrongType);
  assert.ok(meta.compat(m, 'paper', '1.20.1').wrongType);
  assert.ok(meta.compat({ kind: 'fabric' }, 'forge', '1.20.1').wrongType);

  const r = meta.matchesMavenRange;
  assert.ok(r('[1.20,)', '1.21.4'));
  assert.ok(!r('[1.20,1.21)', '1.21'));
  assert.ok(r('[1.20,1.21]', '1.21'));
  assert.ok(r('[1.20.1]', '1.20.1') && !r('[1.20.1]', '1.20.2'));
  assert.ok(r('[1.19.2],[1.20.1,1.20.2)', '1.20.1'));
  assert.ok(r('*', '1.8'));
});

test('Forge 서버: Modrinth 필터 · mods 폴더 · 의존성 오류 안내', () => {
  assert.deepStrictEqual(modrinth.searchFacets({ type: 'forge', version: '1.20.1' })[0], ['categories:forge']);
  assert.strictEqual(modrinth.addonFolder({ type: 'forge' }), 'mods');
  const a = new ErrorTranslator().check("\tMod ID: 'flywheel', Requested by: 'create', Expected range: '[0.6.10,)', Actual version: '[MISSING]'");
  assert.strictEqual(a.kind, 'forge-missing-dep');
  assert.deepStrictEqual(a.actions[0].payload, { names: ['flywheel'] });
  assert.deepStrictEqual(a.actions[1].payload, { modId: 'create' });
});

test('Forge 서버 만들기 → 설치 프로그램 실행 → @args 로 켜기 → 저장 후 정지 (실제 JVM)', { skip: !hasJdk || process.platform === 'win32' }, async () => {
  // 가짜 Forge 설치 프로그램 빌드
  const build = fs.mkdtempSync(path.join(tmp, 'build-'));
  execFileSync('javac', ['-d', build, path.join(__dirname, 'fixtures', 'forge', 'FakeForge.java')], { stdio: 'ignore' });
  fs.writeFileSync(path.join(build, 'm.txt'), 'Main-Class: FakeForge\n');
  const installer = path.join(tmp, 'forge-1.20.1-47.3.0-installer.jar');
  execFileSync('jar', ['cfm', installer, path.join(build, 'm.txt'), '-C', build, '.'], { stdio: 'ignore' });

  // 설치 프로그램을 내려받을 로컬 서버
  const srv = http.createServer((req, res) => fs.createReadStream(installer).pipe(res));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/forge-1.20.1-47.3.0-installer.jar`;

  // 네트워크가 필요한 부분만 바꿔 끼운다
  const java = require('../src/main/java');
  versions.requiredJava = async () => 21;
  versions.serverJar = async () => ({ installer: true, url, fileName: 'forge-1.20.1-47.3.0-installer.jar', build: '47.3.0', loader: '47.3.0' });
  java.ensure = async () => ({ bin: 'java', major: 21 });

  const { ServerManager } = require('../src/main/server-manager');
  const m = new ServerManager();
  const steps = [];
  const s = await m.create({ type: 'forge', version: '1.20.1', eula: true, optimize: false, memoryMb: 512, settings: { port: 25940 } }, (p) => steps.push(p.text));
  srv.close();
  const dir = paths.serverDir(s.id);
  assert.strictEqual(s.type, 'forge');
  assert.strictEqual(s.loaderVersion, '47.3.0');
  assert.ok(steps.some((t) => /Forge 설치 중/.test(t)));
  assert.ok(!fs.existsSync(path.join(dir, 'forge-1.20.1-47.3.0-installer.jar')), '설치 프로그램은 정리');
  assert.ok(fs.existsSync(path.join(dir, 'libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt')));

  const lines = [];
  m.on('console', (c) => lines.push(c.line));
  await m.start(s.id);
  const t0 = Date.now();
  while (m.get(s.id).status !== 'running' && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(m.get(s.id).status, 'running');
  assert.ok(lines.some((l) => l.includes('@libraries/net/minecraftforge/forge/1.20.1-47.3.0/unix_args.txt')));
  await m.stop(s.id);
  assert.strictEqual(m.get(s.id).status, 'stopped');
});
