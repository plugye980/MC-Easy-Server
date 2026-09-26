'use strict';
// 앱 밖에서 만든 서버 폴더(Paper · Spigot · Bukkit · Purpur · Fabric · Forge · 바닐라)를 알아본다.
const fs = require('fs');
const path = require('path');
const props = require('./properties');
const world = require('./world');
const { readEntries } = require('./addon-meta');
const { compareVersions } = require('./versions');

const MC_VERSION = /^\d+\.\d+(?:\.\d+)?$/;

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const countJars = (dir) => listDir(dir).filter((e) => e.isFile() && /\.jar$/i.test(e.name)).length;

/** 실행 스크립트(start.bat 등)나 Forge 의 user_jvm_args.txt 에서 -Xmx 값을 읽는다 */
function memoryFromScripts(dir) {
  const files = listDir(dir)
    .filter((e) => e.isFile() && (/\.(bat|cmd|sh|command|ps1)$/i.test(e.name) || e.name === 'user_jvm_args.txt'))
    .map((e) => e.name);
  for (const f of files) {
    const m = /-Xmx(\d+)([gGmM])/.exec(readText(path.join(dir, f)) || '');
    if (m) return { memoryMb: Number(m[1]) * (/g/i.test(m[2]) ? 1024 : 1), from: f };
  }
  return null;
}

/** 마지막 실행 로그의 "Starting minecraft server version 1.21.1" */
function versionFromLog(dir) {
  const m = /Starting minecraft server version (\S+)/.exec(readText(path.join(dir, 'logs', 'latest.log')) || '');
  return m && MC_VERSION.test(m[1]) ? m[1] : null;
}

/** 서버 jar 한 개를 살펴 종류와 버전을 짐작한다 */
async function inspectJar(file) {
  let entries = {};
  try {
    entries = await readEntries(file, ['version.json', 'META-INF/MANIFEST.MF', 'install_profile.json']);
  } catch {
    return null;
  }
  const name = path.basename(file).toLowerCase();
  const manifest = entries['META-INF/MANIFEST.MF'] || '';
  const main = (/^Main-Class:\s*(\S+)/m.exec(manifest) || [])[1] || '';
  let version = null;
  if (entries['version.json']) {
    try {
      const v = JSON.parse(entries['version.json']);
      version = [v.id, v.name].find((x) => x && MC_VERSION.test(String(x).split(' ')[0])) || null;
      if (version) version = String(version).split(' ')[0];
    } catch { /* 무시 */ }
  }
  const fromName = /(?:^|[-_])(\d+\.\d+(?:\.\d+)?)(?:[-_.]|$)/.exec(name);
  const build = /(?:paper|purpur|folia)-\d+\.\d+(?:\.\d+)?-(\d+)\.jar$/.exec(name);
  if (entries['install_profile.json'] || /installer/.test(name)) return { kind: 'installer' };
  let flavor = null;
  if (/paperclip/i.test(main) || /^paper|^purpur|^folia|^pufferfish/.test(name)) {
    flavor = /purpur/.test(name) ? 'Purpur' : /folia/.test(name) ? 'Folia' : /pufferfish/.test(name) ? 'Pufferfish' : 'Paper';
  } else if (/org\.bukkit\.craftbukkit/.test(main) || /^spigot|^craftbukkit|^bukkit/.test(name)) {
    flavor = /craftbukkit|^bukkit/.test(name) ? 'CraftBukkit' : 'Spigot';
  } else if (/net\.fabricmc/.test(main) || /fabric/.test(name)) {
    flavor = 'Fabric';
  } else if (/net\.minecraft\.(server|bundler)/.test(main) || /^minecraft_server|^server\.jar$/.test(name)) {
    flavor = 'Vanilla';
  } else if (/minecraftforge|cpw\.mods/.test(main) || /forge/.test(name)) {
    flavor = 'Forge';
  }
  if (!flavor) return null;
  return { kind: 'server', flavor, version: version || (fromName ? fromName[1] : null), build: build ? build[1] : null };
}

const TYPE_OF = { Paper: 'paper', Purpur: 'paper', Folia: 'paper', Pufferfish: 'paper', Spigot: 'paper', CraftBukkit: 'paper', Fabric: 'fabric', Forge: 'forge', Vanilla: 'vanilla' };

/**
 * 폴더를 살펴 가져올 수 있는지와 알아낸 정보를 돌려준다.
 * problems 가 있으면 가져올 수 없고, warnings 는 알려만 준다.
 */
async function detect(dir) {
  const out = { path: dir, problems: [], warnings: [] };
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    out.problems.push('폴더가 아님');
    return out;
  }
  const entries = listDir(dir);
  const names = new Set(entries.map((e) => e.name));
  const jars = entries.filter((e) => e.isFile() && /\.jar$/i.test(e.name)).map((e) => e.name);
  const p = props.read(path.join(dir, 'server.properties'));
  const hasProps = names.has('server.properties');
  if (!hasProps && !jars.length) {
    out.problems.push('서버 폴더가 아님 (server.properties 와 서버 jar 없음)');
    return out;
  }

  let type = null;
  let flavor = null;
  let version = null;
  let build = null;
  let jarFile = null;

  // 먼저 서버 jar 를 살핀다. Paper 도 libraries 아래에 net/neoforged(플러그인 리매퍼) 같은 폴더를 두므로
  // 플러그인 서버 jar 가 있으면 그것이 우선이다.
  const found = [];
  for (const j of jars) {
    const info = await inspectJar(path.join(dir, j));
    if (info && info.kind === 'server') found.push({ ...info, jarFile: j });
  }
  // Fabric 실행기는 바닐라 jar 를 옆에 두므로 Fabric 을 먼저, 그 다음 플러그인 서버, 바닐라 순
  const order = ['Fabric', 'Paper', 'Purpur', 'Folia', 'Pufferfish', 'Spigot', 'CraftBukkit', 'Forge', 'Vanilla'];
  found.sort((a, b) => order.indexOf(a.flavor) - order.indexOf(b.flavor));
  const f = found[0];
  const bukkitJar = f && TYPE_OF[f.flavor] === 'paper';

  // Forge / NeoForge: 설치 때 만든 libraries 폴더로 정확한 버전을 안다 (로더 본체 폴더만 본다)
  if (!bukkitJar) {
    const lib = (...p) => path.join(dir, 'libraries', 'net', ...p);
    if (fs.existsSync(lib('neoforged', 'neoforge')) || fs.existsSync(lib('neoforged', 'forge'))) {
      out.problems.push('NeoForge 서버는 아직 지원하지 않음');
      return out;
    }
    const forgeDirs = listDir(lib('minecraftforge', 'forge')).filter((e) => e.isDirectory() && /^\d+\.\d+(?:\.\d+)?-/.test(e.name)).map((e) => e.name);
    if (forgeDirs.length) {
      const pick = forgeDirs.sort((a, b) => compareVersions(b.split('-')[0], a.split('-')[0]))[0];
      const [mc, ...rest] = pick.split('-');
      type = 'forge';
      flavor = 'Forge';
      version = mc;
      build = rest.join('-') || null;
    }
  }

  if (!type && f) {
    type = TYPE_OF[f.flavor];
    flavor = f.flavor;
    jarFile = f.jarFile;
    build = f.build;
    version = f.flavor === 'Fabric' ? (found.find((x) => x.flavor === 'Vanilla') || {}).version || null : f.version;
    if (f.flavor === 'Forge') {
      out.problems.push('예전 Forge 서버는 버전 정보를 읽을 수 없음');
      return out;
    }
  }
  if (!type) {
    // jar 를 못 알아봤지만 plugins 폴더가 있고 jar 가 하나뿐이면 Bukkit 계열로 본다
    const only = jars.filter((j) => !/installer/i.test(j));
    if (!names.has('plugins') || only.length !== 1) {
      out.problems.push('서버 jar 를 찾지 못함 (Paper · Spigot · Fabric · Forge · 바닐라 서버만 가능)');
      return out;
    }
    type = 'paper';
    jarFile = only[0];
    flavor = 'Bukkit 계열';
  }
  if (type === 'fabric' && !jarFile) jarFile = 'fabric-server-launch.jar';

  const levelName = p['level-name'] || 'world';
  const saved = world.worldInfoAt(path.join(dir, levelName));
  version = version || versionFromLog(dir) || (saved && saved.version && MC_VERSION.test(saved.version) ? saved.version : null);
  if (!version) out.problems.push('마인크래프트 버전을 알 수 없음');

  const mem = memoryFromScripts(dir);
  const eula = /^\s*eula\s*=\s*true\s*$/im.test(readText(path.join(dir, 'eula.txt')) || '');
  if (type === 'paper' && flavor !== 'Paper') out.warnings.push(`${flavor} 서버: 업데이트 버튼을 쓰면 Paper 로 바뀜`);
  if (!saved) out.warnings.push('월드 없음 — 첫 실행 때 새로 생성');

  Object.assign(out, {
    type,
    flavor,
    version,
    build,
    jarFile,
    levelName,
    port: Number(p['server-port']) || 25565,
    motd: p.motd || null,
    memoryMb: mem ? mem.memoryMb : null,
    memoryFrom: mem ? mem.from : null,
    eula,
    worldVersion: saved ? saved.version : null,
    addonCount: type === 'paper' ? countJars(path.join(dir, 'plugins')) : type === 'vanilla' ? 0 : countJars(path.join(dir, 'mods')),
    name: path.basename(dir),
  });
  return out;
}

/** 폴더를 통째로 복사한다 (진행률 표시용으로 파일 수를 센다) */
async function copyTree(src, dest, onProgress = () => {}) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of listDir(d)) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) files.push(r);
    }
  };
  walk(src, '');
  let done = 0;
  for (const r of files) {
    // 실행 중인 서버의 잠금 파일은 옮기지 않는다
    if (path.basename(r) === 'session.lock') continue;
    const to = path.join(dest, r);
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.copyFile(path.join(src, r), to);
    done++;
    if (done % 50 === 0 || done === files.length) onProgress({ text: `서버 폴더 복사 중 (${done}/${files.length})`, percent: done / files.length });
  }
}

module.exports = { detect, inspectJar, memoryFromScripts, copyTree };
