'use strict';
// Modrinth 검색 · 원클릭 설치 · 의존성 자동 설치 · 호환성 확인 · 접속용 mods.zip 내보내기
const fs = require('fs');
const path = require('path');
const yazl = require('yazl');
const { getJson, request, download, fileHash } = require('./http');

const API = 'https://api.modrinth.com/v2';

/** 서버 종류별로 Modrinth에서 받아들일 로더 */
function loadersFor(type) {
  if (type === 'paper') return ['paper', 'spigot', 'bukkit'];
  if (type === 'fabric') return ['fabric'];
  if (type === 'forge') return ['forge'];
  return ['datapack'];
}

/** 추가 기능이 들어갈 폴더 (서버 폴더 기준 상대 경로) */
function addonFolder(server) {
  if (server.type === 'paper') return 'plugins';
  if (server.type === 'fabric' || server.type === 'forge') return 'mods';
  return path.join(server.levelName || 'world', 'datapacks');
}

function searchFacets(server) {
  const facets = [loadersFor(server.type).map((l) => `categories:${l}`), [`versions:${server.version}`]];
  if (server.type === 'fabric' || server.type === 'forge') {
    facets.push(['project_type:mod']);
    // 서버에서 돌지 않는 클라이언트 전용 모드는 뺀다
    facets.push(['server_side:required', 'server_side:optional']);
  }
  if (server.type === 'vanilla') facets.push(['project_type:datapack']);
  return facets;
}

const SORTS = ['relevance', 'downloads', 'follows', 'newest', 'updated'];

/** index: relevance(관련도) · downloads(다운로드순) · updated(최근 업데이트) · newest(새로 올라온 순) */
async function search(server, query, { offset = 0, limit = 20, index } = {}) {
  // 검색어가 없으면 관련도 정렬이 의미 없으므로 다운로드순을 기본으로
  const sort = SORTS.includes(index) ? index : query ? 'relevance' : 'downloads';
  const params = new URLSearchParams({
    query: query || '',
    facets: JSON.stringify(searchFacets(server)),
    index: sort,
    offset: String(offset),
    limit: String(limit),
  });
  const data = await getJson(`${API}/search?${params}`);
  const installed = new Set((server.addons || []).map((a) => a.projectId));
  return {
    total: data.total_hits,
    offset: data.offset,
    limit: data.limit,
    sort,
    hits: data.hits.map((h) => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      iconUrl: h.icon_url,
      clientSide: h.client_side,
      serverSide: h.server_side,
      installed: installed.has(h.project_id),
    })),
  };
}

async function project(idOrSlug) {
  return getJson(`${API}/project/${encodeURIComponent(idOrSlug)}`);
}

/** 현재 서버 버전·로더에 맞는 가장 최신 버전(정식 우선) */
async function compatibleVersion(server, projectId, gameVersion = server.version) {
  const params = new URLSearchParams({
    loaders: JSON.stringify(loadersFor(server.type)),
    game_versions: JSON.stringify([gameVersion]),
  });
  const versions = await getJson(`${API}/project/${encodeURIComponent(projectId)}/version?${params}`);
  if (!versions.length) return null;
  return versions.find((v) => v.version_type === 'release') || versions[0];
}

function primaryFile(version) {
  return version.files.find((f) => f.primary) || version.files[0];
}

/**
 * 프로젝트를 설치하고, 필요한(required) 의존성을 재귀적으로 같이 설치한다.
 * @returns {Promise<{installed: object[], skipped: {title:string, reason:string}[]}>}
 */
async function install(server, serverDir, projectId, onProgress = () => {}, ctx = null) {
  const top = !ctx;
  ctx = ctx || { installed: [], skipped: [], visiting: new Set((server.addons || []).map((a) => a.projectId)) };
  if (ctx.visiting.has(projectId) && !top) return ctx;
  ctx.visiting.add(projectId);

  const [meta, version] = await Promise.all([project(projectId), compatibleVersion(server, projectId)]);
  if (!version) {
    const reason = `${server.version} ${{ fabric: 'Fabric', forge: 'Forge', paper: 'Paper' }[server.type] || ''} 버전 없음`;
    if (top) throw new Error(`"${meta.title}": 현재 서버와 맞는 파일 없음 (${reason.trim()})`);
    ctx.skipped.push({ title: meta.title, reason });
    return ctx;
  }

  // 의존성 먼저
  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== 'required') continue;
    let depProject = dep.project_id;
    if (!depProject && dep.version_id) {
      try {
        depProject = (await getJson(`${API}/version/${dep.version_id}`)).project_id;
      } catch { /* 무시 */ }
    }
    if (!depProject || ctx.visiting.has(depProject)) continue;
    try {
      await install(server, serverDir, depProject, onProgress, ctx);
    } catch (e) {
      ctx.skipped.push({ title: depProject, reason: e.message });
    }
  }

  const file = primaryFile(version);
  const folder = path.join(serverDir, addonFolder(server));
  const dest = path.join(folder, file.filename);
  onProgress({ text: `${meta.title} 설치 중`, percent: 0 });
  await download(file.url, dest, {
    sha512: file.hashes.sha512,
    onProgress: ({ received, total }) => onProgress({ text: `${meta.title} 설치 중`, percent: total ? received / total : 0 }),
  });
  const addon = {
    projectId: meta.id,
    slug: meta.slug,
    title: meta.title,
    iconUrl: meta.icon_url,
    clientSide: meta.client_side,
    serverSide: meta.server_side,
    versionId: version.id,
    versionNumber: version.version_number,
    gameVersions: version.game_versions,
    fileName: file.filename,
    url: file.url,
    size: file.size,
    sha1: file.hashes.sha1,
    sha512: file.hashes.sha512,
    enabled: true,
    dependencyOf: top ? null : 'auto',
    installedAt: Date.now(),
  };
  ctx.installed.push(addon);
  return ctx;
}

/** 이름으로 찾아 설치 (로그에서 "Vault가 필요해요" 같은 경우) */
async function installByName(server, serverDir, name, onProgress) {
  const { hits } = await search(server, name, { limit: 10 });
  if (!hits.length) throw new Error(`Modrinth에서 "${name}" 찾기 실패`);
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = hits.find((h) => norm(h.title) === norm(name) || norm(h.slug) === norm(name)) || hits[0];
  return install(server, serverDir, hit.projectId, onProgress);
}

/**
 * 설치된 파일들이 목표 게임 버전에서 쓸 수 있는 버전을 갖고 있는지 한 번에 확인한다.
 * @returns {Promise<{compatible: object[], incompatible: object[], updates: object[]}>}
 */
async function checkCompatibility(server, gameVersion) {
  const addons = (server.addons || []).filter((a) => a.sha1 && a.projectId);
  if (!addons.length) return { compatible: [], incompatible: [], updates: [] };
  const res = await request(`${API}/version_files/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hashes: addons.map((a) => a.sha1),
      algorithm: 'sha1',
      loaders: loadersFor(server.type),
      game_versions: [gameVersion],
    }),
  });
  const map = await res.json();
  const compatible = [];
  const incompatible = [];
  const updates = [];
  for (const a of addons) {
    const next = map[a.sha1];
    if (!next) incompatible.push(a);
    else {
      compatible.push(a);
      if (next.id !== a.versionId) updates.push({ addon: a, versionId: next.id, versionNumber: next.version_number });
    }
  }
  return { compatible, incompatible, updates };
}

/** 폴더에 있지만 앱이 설치하지 않은 파일도 목록에 보여준다. */
/** 직접 받은 파일이 Modrinth 에 있는 파일인지 해시로 확인한다. 없으면 null */
async function lookupByHash(sha1) {
  try {
    return await getJson(`${API}/version_file/${sha1}?algorithm=sha1`);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

/** Modrinth 버전 정보로 설치 기록을 만든다 (install 과 같은 모양) */
function recordFromVersion(meta, version, file, extra = {}) {
  return {
    projectId: meta.id,
    slug: meta.slug,
    title: meta.title,
    iconUrl: meta.icon_url,
    clientSide: meta.client_side,
    serverSide: meta.server_side,
    versionId: version.id,
    versionNumber: version.version_number,
    gameVersions: version.game_versions,
    fileName: file.filename,
    url: file.url,
    size: file.size,
    sha1: file.hashes.sha1,
    sha512: file.hashes.sha512,
    enabled: true,
    dependencyOf: null,
    installedAt: Date.now(),
    ...extra,
  };
}

function scanFolder(server, serverDir) {
  const folder = path.join(serverDir, addonFolder(server));
  if (!fs.existsSync(folder)) return [];
  const known = new Set((server.addons || []).flatMap((a) => [a.fileName, `${a.fileName}.disabled`]));
  return fs
    .readdirSync(folder)
    .filter((f) => /\.(jar|zip)(\.disabled)?$/i.test(f) && !known.has(f))
    .map((f) => ({
      manual: true,
      title: f.replace(/\.(jar|zip)(\.disabled)?$/i, ''),
      fileName: f.replace(/\.disabled$/i, ''),
      enabled: !f.endsWith('.disabled'),
    }));
}

function setEnabled(server, serverDir, fileName, enabled) {
  const folder = path.join(serverDir, addonFolder(server));
  const on = path.join(folder, fileName);
  const off = `${on}.disabled`;
  if (enabled && fs.existsSync(off)) fs.renameSync(off, on);
  if (!enabled && fs.existsSync(on)) fs.renameSync(on, off);
}

function removeFile(server, serverDir, fileName) {
  const folder = path.join(serverDir, addonFolder(server));
  fs.rmSync(path.join(folder, fileName), { force: true });
  fs.rmSync(path.join(folder, `${fileName}.disabled`), { force: true });
}

/** 로그에 나온 플러그인 이름("Essentials")으로 jar 파일을 찾는다. */
async function findPluginFileByName(server, serverDir, name) {
  const byManifest = (server.addons || []).find((a) => a.title.toLowerCase() === name.toLowerCase() || a.slug === name.toLowerCase());
  if (byManifest) return byManifest.fileName;
  const folder = path.join(serverDir, addonFolder(server));
  if (!fs.existsSync(folder)) return null;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const f = fs.readdirSync(folder).find((x) => x.endsWith('.jar') && norm(x).startsWith(norm(name)));
  return f || null;
}

/**
 * 접속용 mods.zip: 접속하는 쪽도 필요한 모드 jar 를 그대로 묶는다 (압축을 풀어 .minecraft/mods 에 넣으면 끝).
 * 서버 전용 모드(클라이언트 미지원)는 뺀다.
 * @param {string[]} extraFiles 폴더에 직접 넣은 모드 중 넣을 파일 이름
 */
async function exportModsZip(server, serverDir, outFile, extraFiles = []) {
  const names = [];
  for (const a of server.addons || []) {
    if (!a.enabled || a.clientSide === 'unsupported') continue;
    if (a.meta && a.meta.environment === 'server') continue;
    names.push(a.fileName);
  }
  names.push(...extraFiles);
  const files = [...new Set(names)].filter((f) => fs.existsSync(path.join(serverDir, 'mods', f)));
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const f of files) zip.addFile(path.join(serverDir, 'mods', f), f);
    zip.end();
    zip.outputStream.pipe(fs.createWriteStream(outFile)).on('close', resolve).on('error', reject);
  });
  return { file: outFile, count: files.length, files, minecraft: server.version, loader: server.loaderVersion };
}

module.exports = {
  loadersFor,
  addonFolder,
  searchFacets,
  search,
  install,
  installByName,
  compatibleVersion,
  checkCompatibility,
  lookupByHash,
  recordFromVersion,
  project,
  scanFolder,
  setEnabled,
  removeFile,
  findPluginFileByName,
  exportModsZip,
};
