'use strict';
// Forge 서버 설치 · 실행 방법 찾기
//   설치: java -jar forge-<mc>-<build>-installer.jar --installServer  (라이브러리와 바닐라 서버를 받아 둔다)
//   실행: 1.17+  → java <옵션> @libraries/net/minecraftforge/forge/<mc>-<build>/<unix|win>_args.txt nogui
//         ~1.16  → java <옵션> -jar forge-<mc>-<build>.jar nogui
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * 설치 프로그램을 서버 폴더에서 실행한다.
 * @param {(line:string)=>void} onLine 설치 로그 한 줄마다
 */
function runInstaller(serverDir, javaBin, installerFile, onLine = () => {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(javaBin, ['-jar', installerFile, '--installServer'], { cwd: serverDir, windowsHide: true });
    const tail = [];
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        tail.push(l);
        if (tail.length > 20) tail.shift();
        onLine(l);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => reject(new Error(`Forge 설치 실행 실패: ${e.message}`)));
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Forge 설치 실패 (코드 ${code}) — ${tail.slice(-3).join(' / ')}`));
    });
  });
}

/** 설치가 끝난 뒤 남는 설치 파일 정리 (실패했으면 installer.log 는 남겨 둔다) */
function cleanupInstaller(serverDir, installerFile) {
  fs.rmSync(path.join(serverDir, installerFile), { force: true });
  fs.rmSync(path.join(serverDir, `${installerFile}.log`), { force: true });
  fs.rmSync(path.join(serverDir, 'installer.log'), { force: true });
}

/**
 * 설치된 Forge 를 켜는 인자 (nogui 는 붙이지 않는다). 못 찾으면 null.
 * @returns {string[]|null}
 */
function launchArgs(serverDir, mc, build, platform = process.platform) {
  const rel = `libraries/net/minecraftforge/forge/${mc}-${build}`;
  const argsFile = `${rel}/${platform === 'win32' ? 'win' : 'unix'}_args.txt`;
  if (fs.existsSync(path.join(serverDir, argsFile))) return [`@${argsFile}`];
  // 구버전: 실행 가능한 forge jar (설치 프로그램 제외). 새 버전의 -shim.jar 도 -jar 로 켤 수 있다
  const jars = fs.existsSync(serverDir) ? fs.readdirSync(serverDir).filter((f) => /^forge-.*\.jar$/i.test(f) && !/installer/i.test(f)) : [];
  const pick = jars.find((f) => f.includes(`${mc}-${build}`) && /shim/i.test(f)) || jars.find((f) => f.includes(`${mc}-${build}`)) || jars[0];
  return pick ? ['-jar', pick] : null;
}

module.exports = { runInstaller, cleanupInstaller, launchArgs };
