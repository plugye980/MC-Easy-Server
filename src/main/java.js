'use strict';
// Java 자동 감지 · 설치. 시스템에 설치하지 않고 앱 폴더(runtimes/)에 풀어 쓴다.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const extractZip = require('extract-zip');
const tar = require('tar');
const paths = require('./paths');
const { getJson, download } = require('./http');

const exe = process.platform === 'win32' ? 'java.exe' : 'java';

function adoptiumOs() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'mac';
  return 'linux';
}
function adoptiumArch() {
  if (process.arch === 'arm64') return 'aarch64';
  if (process.arch === 'ia32') return 'x32';
  return 'x64';
}

function findJavaBinary(dir, depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) return null;
  const direct = path.join(dir, 'bin', exe);
  if (fs.existsSync(direct)) return direct;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'legal' || e.name === 'lib') continue;
    const found = findJavaBinary(path.join(dir, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

/** `java -version`의 출력(stderr)에서 주 버전을 읽는다. "1.8.0_392" → 8, "21.0.4" → 21 */
function parseJavaVersion(output) {
  const m = /version "([^"]+)"/.exec(output) || /(?:openjdk|java) (\d+[\d.]*)/i.exec(output);
  if (!m) return null;
  const v = m[1];
  if (v.startsWith('1.')) return parseInt(v.split('.')[1], 10);
  return parseInt(v, 10);
}

function probe(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stderr) return resolve(null);
      const major = parseJavaVersion(`${stderr}\n${stdout}`);
      resolve(major ? { bin, major } : null);
    });
  });
}

function runtimeDir(feature) {
  return path.join(paths.runtimes(), `java-${feature}`);
}

/** 앱 폴더에 설치된 런타임 목록 */
function listInstalled() {
  if (!fs.existsSync(paths.runtimes())) return [];
  return fs
    .readdirSync(paths.runtimes())
    .map((name) => {
      const m = /^java-(\d+)$/.exec(name);
      if (!m) return null;
      const bin = findJavaBinary(path.join(paths.runtimes(), name));
      return bin ? { major: Number(m[1]), bin, managed: true } : null;
    })
    .filter(Boolean);
}

async function systemJava() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  candidates.push(exe);
  for (const c of candidates) {
    const r = await probe(c);
    if (r) return { ...r, managed: false };
  }
  return null;
}

/**
 * 필요한 Java를 찾는다. 앱 폴더 → 시스템(주 버전이 정확히 같을 때만) 순서.
 * @returns {Promise<{major:number, bin:string, managed:boolean}|null>}
 */
async function detect(feature) {
  const own = listInstalled().find((r) => r.major === feature);
  if (own) return own;
  const sys = await systemJava();
  if (sys && sys.major === feature) return sys;
  return null;
}

async function install(feature, onProgress = () => {}) {
  const os = adoptiumOs();
  const arch = adoptiumArch();
  let assets = [];
  for (const imageType of ['jre', 'jdk']) {
    const url = `https://api.adoptium.net/v3/assets/latest/${feature}/hotspot?os=${os}&architecture=${arch}&image_type=${imageType}&vendor=eclipse`;
    try {
      assets = await getJson(url);
    } catch { assets = []; }
    if (assets.length) break;
  }
  if (!assets.length) throw new Error(`이 PC(${os}/${arch})용 Java ${feature} 없음`);
  const pkg = assets[0].binary.package;
  const archive = path.join(paths.cache(), pkg.name);
  onProgress({ stage: 'download', text: `Java ${feature} 내려받는 중`, percent: 0 });
  await download(pkg.link, archive, {
    sha256: pkg.checksum,
    onProgress: ({ received, total }) =>
      onProgress({ stage: 'download', text: `Java ${feature} 내려받는 중`, percent: total ? received / total : 0 }),
  });
  onProgress({ stage: 'extract', text: `Java ${feature} 압축 푸는 중`, percent: 1 });
  const dest = runtimeDir(feature);
  const tmp = `${dest}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  if (pkg.name.endsWith('.zip')) await extractZip(archive, { dir: tmp });
  else await tar.x({ file: archive, cwd: tmp });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
  fs.rmSync(archive, { force: true });
  const bin = findJavaBinary(dest);
  if (!bin) throw new Error('Java 압축 해제 후 실행 파일 없음');
  if (process.platform !== 'win32') fs.chmodSync(bin, 0o755);
  return { major: feature, bin, managed: true };
}

/** 있으면 그대로, 없으면 설치해서 돌려준다. */
async function ensure(feature, onProgress) {
  return (await detect(feature)) || install(feature, onProgress);
}

module.exports = { detect, ensure, install, listInstalled, systemJava, parseJavaVersion };
