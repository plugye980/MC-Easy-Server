'use strict';
// 서버 종류별 버전 목록, 서버 jar 다운로드 정보, 필요한 Java 버전
const { getJson } = require('./http');

const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const PAPER_V3 = 'https://fill.papermc.io/v3/projects/paper';
const PAPER_V2 = 'https://api.papermc.io/v2/projects/paper';
const FABRIC_META = 'https://meta.fabricmc.net/v2';
const FORGE_PROMOS = 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json';
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
// 설치 방식이 지금과 같은(installer --installServer) 가장 오래된 버전
const FORGE_MIN = '1.12.2';

const TTL = 10 * 60 * 1000;
const memo = new Map();
async function cached(key, fn) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  return value;
}

/** "1.20.4" 와 "1.21" 비교. 26.1 같은 새 표기도 숫자 비교로 처리된다. */
function compareVersions(a, b) {
  const pa = String(a).split(/[.\-]/).map((x) => parseInt(x, 10));
  const pb = String(b).split(/[.\-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isNaN(pa[i]) || pa[i] === undefined ? 0 : pa[i];
    const y = Number.isNaN(pb[i]) || pb[i] === undefined ? 0 : pb[i];
    if (x !== y) return x - y;
  }
  return 0;
}

const isStableId = (id) => /^\d+(\.\d+)+$/.test(id);

/** Mojang 메타데이터를 못 받을 때 쓰는 버전→Java 규칙 */
function javaForVersionFallback(mc) {
  const major = parseInt(String(mc).split('.')[0], 10);
  if (major >= 26) return 25; // 2026년 새 표기(26.x)부터 Java 25
  if (compareVersions(mc, '1.20.5') >= 0) return 21;
  if (compareVersions(mc, '1.18') >= 0) return 17;
  if (compareVersions(mc, '1.17') >= 0) return 17; // 1.17은 16 이상, Adoptium LTS인 17 사용
  return 8;
}

/** Adoptium은 LTS 위주로 제공하므로 가장 가까운 상위 LTS로 맞춘다. */
function normalizeJavaFeature(v) {
  const lts = [8, 11, 17, 21, 25];
  return lts.find((x) => x >= v) || v;
}

async function mojangManifest() {
  return cached('mojang', () => getJson(MOJANG_MANIFEST));
}

async function mojangVersionMeta(mc) {
  const manifest = await mojangManifest();
  const entry = manifest.versions.find((v) => v.id === mc);
  if (!entry) return null;
  return cached(`mojang:${mc}`, () => getJson(entry.url));
}

async function requiredJava(mc) {
  try {
    const meta = await mojangVersionMeta(mc);
    if (meta && meta.javaVersion && meta.javaVersion.majorVersion) {
      return normalizeJavaFeature(meta.javaVersion.majorVersion);
    }
  } catch { /* 오프라인이면 규칙으로 */ }
  return normalizeJavaFeature(javaForVersionFallback(mc));
}

// ---------- 버전 목록 ----------
async function listVanilla() {
  const m = await mojangManifest();
  const versions = m.versions.filter((v) => v.type === 'release').map((v) => v.id);
  return { versions, latest: m.latest.release };
}

async function listPaper() {
  return cached('paper:list', async () => {
    try {
      const data = await getJson(PAPER_V3);
      // { versions: { "1.21": ["1.21.8", ...], ... } }
      const all = Object.values(data.versions || {}).flat();
      const versions = all.filter(isStableId).sort((a, b) => compareVersions(b, a));
      return { versions, latest: versions[0] };
    } catch {
      const data = await getJson(PAPER_V2);
      const versions = data.versions.filter(isStableId).sort((a, b) => compareVersions(b, a));
      return { versions, latest: versions[0] };
    }
  });
}

async function listFabric() {
  return cached('fabric:list', async () => {
    const games = await getJson(`${FABRIC_META}/versions/game`);
    const versions = games.filter((g) => g.stable).map((g) => g.version);
    return { versions, latest: versions[0] };
  });
}

/** promotions_slim.json → { "1.20.1-recommended": "47.3.0", "1.20.1-latest": "47.3.12", ... } */
function forgePromos(promos) {
  const out = {};
  for (const [key, build] of Object.entries(promos || {})) {
    const m = /^(.+)-(recommended|latest)$/.exec(key);
    if (!m || !isStableId(m[1]) || compareVersions(m[1], FORGE_MIN) < 0) continue;
    const e = (out[m[1]] = out[m[1]] || {});
    e[m[2]] = build;
  }
  return out;
}

/** 버전별로 추천 빌드(없으면 최신)를 고른다 */
function pickForgeBuild(promos, mc) {
  const e = forgePromos(promos)[mc];
  return e ? e.recommended || e.latest : null;
}

async function listForge() {
  return cached('forge:list', async () => {
    const data = await getJson(FORGE_PROMOS);
    const versions = Object.keys(forgePromos(data.promos)).sort((a, b) => compareVersions(b, a));
    return { versions, latest: versions[0] };
  });
}

// ---------- 하이브리드 (플러그인 + 모드): Arclight Forge 판 ----------
// GitHub 릴리스의 파일 이름: arclight-forge-<마크 버전>-<빌드>.jar
const ARCLIGHT_RELEASES = 'https://api.github.com/repos/IzzelAliz/Arclight/releases?per_page=100';
const ARCLIGHT_ASSET = /^arclight-forge-(\d+\.\d+(?:\.\d+)?)-([\w.+-]+)\.jar$/i;

/** 릴리스 목록 → 받을 수 있는 서버 jar 들 (최신 먼저) */
function arclightAssets(releases) {
  const out = [];
  for (const r of releases || []) {
    if (r.draft) continue;
    for (const a of r.assets || []) {
      const m = ARCLIGHT_ASSET.exec(a.name);
      if (!m || /sources|javadoc|-api/i.test(a.name)) continue;
      out.push({ mc: m[1], build: m[2], url: a.browser_download_url, fileName: a.name, stable: !r.prerelease, date: r.published_at || '' });
    }
  }
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

async function arclightList() {
  return cached('arclight', async () => arclightAssets(await getJson(ARCLIGHT_RELEASES, { headers: { Accept: 'application/vnd.github+json' } })));
}

async function listHybrid() {
  const assets = await arclightList();
  const versions = [...new Set(assets.map((a) => a.mc))].sort((a, b) => compareVersions(b, a));
  if (!versions.length) throw new Error('하이브리드(Arclight) 버전 목록 없음');
  const stable = versions.find((v) => assets.some((a) => a.mc === v && a.stable));
  return { versions, latest: stable || versions[0] };
}

async function hybridJar(mc) {
  const assets = (await arclightList()).filter((a) => a.mc === mc);
  const pick = assets.find((a) => a.stable) || assets[0];
  if (!pick) throw new Error(`${mc} 용 하이브리드(Arclight) 서버 없음`);
  return { url: pick.url, fileName: pick.fileName, build: pick.build };
}

async function listVersions(type) {
  if (type === 'hybrid') return listHybrid();
  if (type === 'paper') return listPaper();
  if (type === 'fabric') return listFabric();
  if (type === 'forge') return listForge();
  return listVanilla();
}

// ---------- 서버 jar ----------
async function paperBuild(mc) {
  try {
    const builds = await getJson(`${PAPER_V3}/versions/${mc}/builds`);
    const list = Array.isArray(builds) ? builds : builds.builds || [];
    list.sort((a, b) => b.id - a.id);
    const pick = list.find((b) => String(b.channel).toUpperCase() === 'STABLE') || list[0];
    if (!pick) throw new Error('no builds');
    const dl = pick.downloads['server:default'] || Object.values(pick.downloads)[0];
    return {
      url: dl.url,
      fileName: dl.name,
      sha256: dl.checksums && dl.checksums.sha256,
      build: pick.id,
      channel: pick.channel,
    };
  } catch {
    const data = await getJson(`${PAPER_V2}/versions/${mc}/builds`);
    const list = [...data.builds].reverse();
    const pick = list.find((b) => b.channel === 'default') || list[0];
    const app = pick.downloads.application;
    return {
      url: `${PAPER_V2}/versions/${mc}/builds/${pick.build}/downloads/${app.name}`,
      fileName: app.name,
      sha256: app.sha256,
      build: pick.build,
      channel: pick.channel,
    };
  }
}

async function fabricJar(mc) {
  const loaders = await getJson(`${FABRIC_META}/versions/loader/${mc}`);
  const loader = (loaders.find((l) => l.loader.stable) || loaders[0]).loader.version;
  const installers = await getJson(`${FABRIC_META}/versions/installer`);
  const installer = (installers.find((i) => i.stable) || installers[0]).version;
  return {
    url: `${FABRIC_META}/versions/loader/${mc}/${loader}/${installer}/server/jar`,
    fileName: `fabric-server-mc.${mc}-loader.${loader}-launcher.${installer}.jar`,
    loader,
    build: loader,
  };
}

/** Forge 는 서버 jar 대신 설치 프로그램을 받아 --installServer 로 설치한다 */
async function forgeInstaller(mc) {
  const data = await cached('forge:promos', () => getJson(FORGE_PROMOS));
  const build = pickForgeBuild(data.promos, mc);
  if (!build) throw new Error(`${mc} 용 Forge 없음`);
  const full = `${mc}-${build}`;
  return {
    installer: true,
    url: `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`,
    fileName: `forge-${full}-installer.jar`,
    loader: build,
    build,
  };
}

async function vanillaJar(mc) {
  const meta = await mojangVersionMeta(mc);
  if (!meta || !meta.downloads || !meta.downloads.server) {
    throw new Error(`${mc} 버전은 공식 서버 파일 없음`);
  }
  return { url: meta.downloads.server.url, fileName: `minecraft_server.${mc}.jar`, sha1: meta.downloads.server.sha1, build: mc };
}

async function serverJar(type, mc) {
  if (type === 'hybrid') return hybridJar(mc);
  if (type === 'paper') return paperBuild(mc);
  if (type === 'fabric') return fabricJar(mc);
  if (type === 'forge') return forgeInstaller(mc);
  return vanillaJar(mc);
}

module.exports = {
  arclightAssets,
  forgePromos,
  pickForgeBuild,
  compareVersions,
  javaForVersionFallback,
  normalizeJavaFeature,
  requiredJava,
  listVersions,
  serverJar,
};
