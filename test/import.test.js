'use strict';
// 앱 밖에서 만든 서버 폴더 가져오기
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-import-'));
process.env.MC_EASY_DATA = path.join(tmp, 'data');
const paths = require('../src/main/paths');
paths.init(null);

// 가짜 java (manager.test 와 같은 방식)
const bin = path.join(paths.runtimes(), 'java-21', 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'java'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(__dirname, 'fixtures', 'fake-server.js')}"\n`, { mode: 0o755 });

const serverImport = require('../src/main/server-import');
const { Servers } = require('../src/main/store');
const { ServerManager } = require('../src/main/server-manager');

function zip(out, files) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(files)) z.addBuffer(Buffer.from(c), n);
    z.end();
    z.outputStream.pipe(fs.createWriteStream(out)).on('close', () => resolve(out));
  });
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function spigotFolder(dir) {
  await zip(path.join(dir, 'spigot-1.21.1.jar'), { 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\nMain-Class: org.bukkit.craftbukkit.bootstrap.Main\n', 'version.json': '{"id":"1.21.1","name":"1.21.1"}' });
  write(path.join(dir, 'server.properties'), 'server-port=25610\nlevel-name=myworld\nmotd=old\n');
  write(path.join(dir, 'eula.txt'), 'eula=true\n');
  write(path.join(dir, 'start.bat'), 'java -Xms1G -Xmx3G -jar spigot-1.21.1.jar nogui\n');
  await zip(path.join(dir, 'plugins', 'A.jar'), { 'plugin.yml': 'name: A\nversion: 1\n' });
  await zip(path.join(dir, 'plugins', 'B.jar'), { 'plugin.yml': 'name: B\nversion: 1\n' });
  write(path.join(dir, 'myworld', 'level.dat'), 'x');
  write(path.join(dir, 'myworld', 'session.lock'), 'x');
  return dir;
}

test('폴더 알아보기: Spigot · 이름 바꾼 Paper · Forge · NeoForge · 빈 폴더', async () => {
  const sp = await serverImport.detect(await spigotFolder(path.join(tmp, 'spigot')));
  assert.deepStrictEqual(sp.problems, []);
  assert.strictEqual(sp.type, 'paper');
  assert.strictEqual(sp.flavor, 'Spigot');
  assert.strictEqual(sp.version, '1.21.1');
  assert.strictEqual(sp.jarFile, 'spigot-1.21.1.jar');
  assert.strictEqual(sp.port, 25610);
  assert.strictEqual(sp.levelName, 'myworld');
  assert.strictEqual(sp.memoryMb, 3072);
  assert.strictEqual(sp.addonCount, 2);
  assert.ok(sp.eula);
  assert.ok(sp.warnings.some((w) => /Paper 로 바뀜/.test(w)));

  // server.jar 로 이름을 바꾼 Paper: 버전은 마지막 로그에서
  const pd = path.join(tmp, 'paper');
  await zip(path.join(pd, 'server.jar'), { 'META-INF/MANIFEST.MF': 'Main-Class: io.papermc.paperclip.Main\n' });
  write(path.join(pd, 'server.properties'), 'server-port=25565\n');
  write(path.join(pd, 'logs', 'latest.log'), '[12:00:00] [Server thread/INFO]: Starting minecraft server version 1.20.4\n');
  const pp = await serverImport.detect(pd);
  assert.strictEqual(pp.flavor, 'Paper');
  assert.strictEqual(pp.version, '1.20.4');
  assert.ok(!pp.eula);

  const fd = path.join(tmp, 'forge');
  fs.mkdirSync(path.join(fd, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.3.0'), { recursive: true });
  write(path.join(fd, 'server.properties'), '');
  const ff = await serverImport.detect(fd);
  assert.strictEqual(ff.type, 'forge');
  assert.strictEqual(ff.version, '1.20.1');
  assert.strictEqual(ff.build, '47.3.0');

  const nd = path.join(tmp, 'neo');
  fs.mkdirSync(path.join(nd, 'libraries', 'net', 'neoforged'), { recursive: true });
  write(path.join(nd, 'server.properties'), '');
  assert.match((await serverImport.detect(nd)).problems[0], /NeoForge/);

  fs.mkdirSync(path.join(tmp, 'empty'));
  assert.match((await serverImport.detect(path.join(tmp, 'empty'))).problems[0], /서버 폴더가 아님/);
});

test('가져오기: 복사 · 그 자리에서 사용 · 원래 jar 로 실행 · 삭제해도 원래 폴더 유지', { skip: process.platform === 'win32' }, async () => {
  const m = new ServerManager();
  const src = await spigotFolder(path.join(tmp, 'spigot2'));

  const copied = await m.importExisting({ path: src, mode: 'copy', name: '옛 서버', memoryMb: 2048 });
  assert.strictEqual(copied.type, 'paper');
  assert.strictEqual(copied.port, 25610);
  assert.strictEqual(copied.jarFile, 'spigot-1.21.1.jar');
  const cdir = m.dir(copied.id);
  assert.strictEqual(cdir, paths.serverDir(copied.id));
  assert.ok(fs.existsSync(path.join(cdir, 'plugins', 'A.jar')));
  assert.ok(fs.existsSync(path.join(cdir, 'myworld', 'level.dat')));
  assert.ok(!fs.existsSync(path.join(cdir, 'myworld', 'session.lock')));
  // 플러그인은 폴더에서 바로 목록에 보인다
  const list = await m.addons(copied.id);
  assert.deepStrictEqual(list.map((a) => a.title).sort(), ['A', 'B']);

  // 같은 폴더를 그 자리에서 쓰기
  const inplace = await m.importExisting({ path: src, mode: 'inplace', name: '제자리' });
  assert.strictEqual(m.dir(inplace.id), path.resolve(src));
  assert.strictEqual(inplace.memoryMb, 3072); // start.bat 값
  await assert.rejects(m.importExisting({ path: src, mode: 'inplace' }), /이미/);
  await assert.rejects(m.importExisting({ path: paths.serverDir(copied.id), mode: 'inplace' }), /앱 데이터 폴더/);

  const lines = [];
  m.on('console', (c) => lines.push(c.line));
  await m.start(inplace.id);
  const t0 = Date.now();
  while (m.get(inplace.id).status !== 'running' && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 30));
  assert.ok(lines.some((l) => l.includes('-jar spigot-1.21.1.jar')));
  await m.stop(inplace.id);

  await m.remove(inplace.id);
  assert.ok(fs.existsSync(path.join(src, 'spigot-1.21.1.jar')), '원래 폴더는 남아야 함');
  await m.remove(copied.id);
  assert.ok(!fs.existsSync(cdir));
  assert.strictEqual(Servers.all().length, 0);
});
