'use strict';
// 모드팩을 기존 모드 서버에 넣는다.
//   CurseForge 모드팩 zip: manifest.json (minecraft.version, modLoaders, files[{projectID, fileID, required}]) + overrides/
//   Modrinth 모드팩 .mrpack: modrinth.index.json (dependencies, files[{path, downloads, hashes, env}]) + overrides/ · server-overrides/
// 모드 파일은 받아서 mods/ 에, overrides 안의 config·kubejs 등은 서버 폴더에 그대로 푼다.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');
const { request } = require('./http');

const CF_DOWNLOAD = (projectID, fileID) => `https://www.curseforge.com/api/v1/mods/${projectID}/files/${fileID}/download`;

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip))));
}

/** zip 안의 항목 목록과 읽기 함수 */
async function listZip(file) {
  const zip = await openZip(file);
  const entries = [];
  await new Promise((resolve, reject) => {
    zip.on('entry', (e) => {
      entries.push(e);
      zip.readEntry();
    });
    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
  const stream = (entry) => new Promise((resolve, reject) => zip.openReadStream(entry, (err, s) => (err ? reject(err) : resolve(s))));
  const text = async (entry) => {
    const chunks = [];
    for await (const c of await stream(entry)) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  };
  return { entries, stream, text, close: () => zip.close() };
}

/** 로더 이름: "forge-47.2.0" / "neoforge-21.1.80" / "fabric-0.16.9" → { type, version } */
function parseLoader(id) {
  const m = /^(forge|neoforge|fabric|quilt)-(.+)$/i.exec(String(id || ''));
  return m ? { type: m[1].toLowerCase(), version: m[2] } : null;
}

/**
 * 모드팩인지 보고 정보를 읽는다. 모드팩이 아니면 null.
 * @returns {Promise<null|{format:'curseforge'|'modrinth', name:string, version:string|null, mc:string|null, loader:{type:string,version:string}|null, files:object[], overrideDirs:string[]}>}
 */
async function read(file) {
  let z;
  try {
    z = await listZip(file);
  } catch {
    return null;
  }
  try {
    const byName = new Map(z.entries.map((e) => [e.fileName, e]));
    if (byName.has('manifest.json')) {
      let m;
      try {
        m = JSON.parse(await z.text(byName.get('manifest.json')));
      } catch {
        return null;
      }
      if (m.manifestType && m.manifestType !== 'minecraftModpack') return null;
      if (!m.minecraft || !Array.isArray(m.files)) return null;
      const loaders = m.minecraft.modLoaders || [];
      const primary = loaders.find((l) => l.primary) || loaders[0];
      return {
        format: 'curseforge',
        name: m.name || path.basename(file, path.extname(file)),
        version: m.version || null,
        mc: m.minecraft.version || null,
        loader: primary ? parseLoader(primary.id) : null,
        files: m.files.filter((f) => f.required !== false).map((f) => ({ projectID: f.projectID, fileID: f.fileID })),
        overrideDirs: [m.overrides || 'overrides'],
      };
    }
    if (byName.has('modrinth.index.json')) {
      let m;
      try {
        m = JSON.parse(await z.text(byName.get('modrinth.index.json')));
      } catch {
        return null;
      }
      const deps = m.dependencies || {};
      const type = ['neoforge', 'forge', 'fabric-loader', 'quilt-loader'].find((k) => deps[k]);
      return {
        format: 'modrinth',
        name: m.name || path.basename(file, path.extname(file)),
        version: m.versionId || null,
        mc: deps.minecraft || null,
        loader: type ? { type: type.replace('-loader', ''), version: deps[type] } : null,
        // 서버에서 쓰지 않는 파일(env.server: unsupported)은 받지 않는다
        files: (m.files || [])
          .filter((f) => !(f.env && f.env.server === 'unsupported'))
          .map((f) => ({ path: f.path, url: (f.downloads || [])[0], sha1: f.hashes && f.hashes.sha1, sha512: f.hashes && f.hashes.sha512 })),
        overrideDirs: ['overrides', 'server-overrides'],
      };
    }
    return null;
  } finally {
    z.close();
  }
}

/** 서버 폴더 밖으로 나가는 경로(../ 등)는 막는다 */
function safeJoin(root, rel) {
  const dest = path.resolve(root, rel);
  const base = path.resolve(root);
  if (dest !== base && !dest.startsWith(base + path.sep)) return null;
  return dest;
}

/** overrides 폴더를 서버 폴더에 푼다. 푼 파일 수 */
async function extractOverrides(file, dirs, serverDir) {
  const z = await listZip(file);
  let count = 0;
  try {
    for (const e of z.entries) {
      const prefix = dirs.find((d) => e.fileName.startsWith(`${d}/`));
      if (!prefix || e.fileName.endsWith('/')) continue;
      const rel = e.fileName.slice(prefix.length + 1);
      if (!rel) continue;
      const dest = safeJoin(serverDir, rel);
      if (!dest) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(await z.stream(e), fs.createWriteStream(dest));
      count++;
    }
  } finally {
    z.close();
  }
  return count;
}

/** 받아서 저장. 파일 이름은 받은 주소(CurseForge 는 다른 주소로 넘겨준다)의 끝에서 */
async function fetchTo(url, folder, fixedName) {
  const res = await request(url, { timeout: 5 * 60 * 1000 });
  const name = fixedName || decodeURIComponent(path.basename(new URL(res.url).pathname));
  if (!name || !/\.(jar|zip)$/i.test(name)) throw new Error('모드 파일이 아님');
  const dest = safeJoin(folder, name);
  if (!dest) throw new Error('잘못된 파일 이름');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  return dest;
}

/** 모드팩과 서버가 맞는지 — 안 맞으면 경고 문구 */
function checkFit(pack, server) {
  const warnings = [];
  const serverLoader = server.type === 'hybrid' ? 'forge' : server.type;
  if (pack.loader && pack.loader.type !== serverLoader && !(pack.loader.type === 'quilt' && serverLoader === 'fabric')) {
    warnings.push(`모드팩 로더는 ${pack.loader.type}, 이 서버는 ${server.type} — 모드가 돌지 않을 수 있음`);
  }
  if (pack.mc && pack.mc !== server.version) warnings.push(`모드팩은 마인크래프트 ${pack.mc}, 이 서버는 ${server.version}`);
  return warnings;
}

/**
 * 모드팩을 서버에 넣는다.
 * @param {string} file 모드팩 파일
 * @param {string} serverDir 서버 폴더
 * @param {object} server 서버 정보 (type, version)
 * @param {(p:{text:string, percent:number})=>void} [onProgress]
 */
async function install(file, serverDir, server, onProgress = () => {}) {
  const pack = await read(file);
  if (!pack) throw new Error('모드팩 정보(manifest.json · modrinth.index.json) 없음');
  const warnings = checkFit(pack, server);
  const modsDir = path.join(serverDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  onProgress({ text: `${pack.name} 설정 파일 푸는 중`, percent: 0.02 });
  const overrides = await extractOverrides(file, pack.overrideDirs, serverDir);

  const total = pack.files.length;
  let done = 0;
  const failed = [];
  const installed = [];
  const queue = pack.files.slice();
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      try {
        const dest =
          pack.format === 'curseforge'
            ? await fetchTo(module.exports.cfDownload(f.projectID, f.fileID), modsDir)
            : await fetchTo(f.url, path.dirname(safeJoin(serverDir, f.path) || modsDir), path.basename(f.path));
        installed.push(dest);
      } catch (e) {
        failed.push(pack.format === 'curseforge' ? `프로젝트 ${f.projectID} · 파일 ${f.fileID} (${e.message})` : `${f.path} (${e.message})`);
      }
      done++;
      onProgress({ text: `${pack.name} 모드 받는 중 (${done}/${total})`, percent: 0.05 + 0.85 * (done / Math.max(1, total)) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, total) }, worker));

  // CurseForge 목록에는 리소스팩·셰이더·데이터팩(zip)도 섞여 있고 넣을 폴더가 적혀 있지 않다.
  // mods/ 에 두면 모드로 잘못 읽힌다 — 데이터팩은 월드의 datapacks/ 로, 서버가 쓰지 않는 리소스팩·셰이더는 건너뛴다
  onProgress({ text: '데이터팩·리소스팩 나누는 중', percent: 0.95 });
  let datapacks = 0;
  let skipped = 0;
  const levelName = (() => {
    try {
      const m = /^level-name=(.*)$/m.exec(fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8'));
      return (m && m[1].trim()) || 'world';
    } catch {
      return 'world';
    }
  })();
  for (const dest of installed.slice()) {
    if (!/\.zip$/i.test(dest) || path.dirname(dest) !== modsDir) continue;
    let names = [];
    try {
      const z = await listZip(dest);
      names = z.entries.map((e) => e.fileName);
      z.close();
    } catch { /* 깨진 zip 은 건너뛴다 */ }
    installed.splice(installed.indexOf(dest), 1);
    if (names.some((n) => n.startsWith('data/')) && names.includes('pack.mcmeta')) {
      const dp = safeJoin(serverDir, path.join(levelName, 'datapacks'));
      fs.mkdirSync(dp, { recursive: true });
      fs.renameSync(dest, path.join(dp, path.basename(dest)));
      datapacks++;
    } else {
      fs.rmSync(dest, { force: true });
      skipped++;
    }
  }
  onProgress({ text: `${pack.name} 설치 완료`, percent: 1 });
  return { name: pack.name, version: pack.version, format: pack.format, mods: installed.length, datapacks, skipped, failed, overrides, warnings };
}

// cfDownload 는 시험에서 바꿔 끼울 수 있게 내보낸다
module.exports = { read, install, parseLoader, checkFit, CF_DOWNLOAD, cfDownload: CF_DOWNLOAD };
