'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');
const cause = require('../src/main/crash-cause');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-cause-'));
function zipBuf(files) {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(files)) z.addBuffer(Buffer.isBuffer(c) ? c : Buffer.from(c), n);
    z.end();
    const chunks = [];
    z.outputStream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// 실제 오류(NeoForge 1.21.1 + Sodium): 호출 위치에 모드 클래스가 없고 원인 줄만 있다
const TRACE = `Exception in thread "main" java.lang.reflect.InvocationTargetException
	at MC-BOOTSTRAP/cpw.mods.modlauncher@11.0.5/cpw.mods.modlauncher.BootstrapLaunchConsumer.accept(BootstrapLaunchConsumer.java:26)
	at cpw.mods.bootstraplauncher@2.0.2/cpw.mods.bootstraplauncher.BootstrapLauncher.main(BootstrapLauncher.java:69)
Caused by: java.lang.ClassNotFoundException: org.lwjgl.Version
	at java.base/jdk.internal.loader.BuiltinClassLoader.loadClass(Unknown Source)
	at cpw.mods.securejarhandler/cpw.mods.cl.ModuleClassLoader.loadClass(ModuleClassLoader.java:216)
	... 26 more`.split('\n');

test('화면 전용 코드를 찾다 멈춘 서버: 원인 모드 찾기 (jar 안에 묶인 jar 까지)', async () => {
  const mods = path.join(tmp, 'mods');
  fs.mkdirSync(mods);
  const service = await zipBuf({ 'net/sodiumlike/checks/PreLaunchChecks.class': Buffer.from('\xca\xfe\xba\xbe..org/lwjgl/Version..', 'latin1') });
  fs.writeFileSync(path.join(mods, 'sodiumlike-0.6.jar'), await zipBuf({ 'META-INF/jarjar/sodiumlike-service.jar': service, 'net/sodiumlike/Mod.class': 'x' }));
  fs.writeFileSync(path.join(mods, 'other-1.0.jar'), await zipBuf({ 'com/other/Gui.class': 'org/lwjgl/glfw/GLFW' }));
  fs.writeFileSync(path.join(mods, 'readme.txt'), 'x');

  assert.strictEqual(cause.missingClientClass(TRACE), 'org.lwjgl.Version');
  assert.deepStrictEqual(cause.frameClasses(TRACE), []);
  assert.deepStrictEqual(await cause.findClientOnlyCause(TRACE, mods), { file: 'sodiumlike-0.6.jar', missing: 'org.lwjgl.Version', how: 'reference' });

  // 호출 위치에 모드 클래스가 있으면 그 클래스를 담은 jar
  const framed = TRACE.slice();
  framed.splice(1, 0, '\tat TRANSFORMER/sodiumlike_service@0.6/net.sodiumlike.checks.PreLaunchChecks.check(PreLaunchChecks.java:40)');
  assert.deepStrictEqual(await cause.findClientOnlyCause(framed, mods), { file: 'sodiumlike-0.6.jar', missing: 'org.lwjgl.Version', how: 'frame' });

  // 같은 코드를 부르는 jar 가 둘이면 하나로 좁히지 못한다
  fs.writeFileSync(path.join(mods, 'third-1.0.jar'), await zipBuf({ 'a/B.class': 'org/lwjgl/Version' }));
  assert.strictEqual(await cause.findClientOnlyCause(TRACE, mods), null);

  // 화면 코드가 아닌 클래스가 빠진 오류는 보지 않는다
  assert.strictEqual(await cause.findClientOnlyCause(['Caused by: java.lang.ClassNotFoundException: com.example.Missing'], mods), null);
  assert.strictEqual(cause.missingClientClass(['Attempted to load class net/minecraft/client/gui/screens/Screen for invalid dist DEDICATED_SERVER']), 'net.minecraft.client.gui.screens.Screen');
});
