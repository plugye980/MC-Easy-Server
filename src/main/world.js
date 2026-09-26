'use strict';
// 맵(월드) 설정: 월드 유형, 커스텀 평지 레이어, 시드, 구조물 / 다른 맵 가져오기
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const extractZip = require('extract-zip');
const paths = require('./paths');
const { compareVersions } = require('./versions');

const TYPES = ['normal', 'flat', 'large_biomes', 'amplified'];

/** server.properties 의 level-type 값. 1.19 부터 네임스페이스가 붙는다 */
function levelTypeValue(type, mc) {
  const t = TYPES.includes(type) ? type : 'normal';
  if (compareVersions(mc, '1.19') >= 0) return `minecraft:${t}`;
  return { normal: 'default', flat: 'flat', large_biomes: 'largeBiomes', amplified: 'amplified' }[t];
}

function levelTypeFromValue(v) {
  const s = String(v || '').toLowerCase().replace('minecraft:', '');
  if (s === 'flat') return 'flat';
  if (s === 'largebiomes' || s === 'large_biomes') return 'large_biomes';
  if (s === 'amplified') return 'amplified';
  return 'normal';
}

const ns = (id) => (String(id).includes(':') ? String(id) : `minecraft:${id}`);
const MAX_HEIGHT = 384; // 1.18+ 월드 높이 (-64 ~ 320)

/** 평지 레이어 검사: 아래층부터, 높이 합이 월드 높이를 넘지 않게 */
function validateFlat(flat) {
  const layers = (flat && flat.layers) || [];
  if (!layers.length) throw new Error('평지 레이어 1개 이상 필요');
  let total = 0;
  for (const l of layers) {
    const hgt = Math.floor(Number(l.height));
    if (!l.block || !/^[a-z0-9_:.-]+$/.test(String(l.block))) throw new Error(`잘못된 블록 이름: ${l.block}`);
    if (!(hgt >= 1)) throw new Error('레이어 높이는 1 이상');
    total += hgt;
  }
  if (total > MAX_HEIGHT) throw new Error(`레이어 전체 높이 ${total}칸 — 최대 ${MAX_HEIGHT}칸`);
  return total;
}

/** 평지 generator-settings JSON */
function flatGenerator(flat) {
  validateFlat(flat);
  return JSON.stringify({
    layers: flat.layers.map((l) => ({ block: ns(l.block), height: Math.floor(Number(l.height)) })),
    biome: ns(flat.biome || 'plains'),
    features: !!flat.features,
    lakes: false,
    structure_overrides: flat.structures ? ['minecraft:villages'] : [],
  });
}

/**
 * 월드 설정 → server.properties 값
 * @param {{type:string, seed?:string, structures?:boolean, flat?:{biome:string, layers:{block:string,height:number}[], features?:boolean}}} w
 */
function toProperties(w, mc) {
  const out = {
    'level-type': levelTypeValue(w.type, mc),
    'level-seed': w.seed || '',
    'generate-structures': w.structures !== false,
    'generator-settings': w.type === 'flat' ? flatGenerator({ ...w.flat, structures: w.structures !== false }) : '{}',
  };
  return out;
}

function fromProperties(p) {
  const w = { type: levelTypeFromValue(p['level-type']), seed: p['level-seed'] || '', structures: p['generate-structures'] !== 'false' };
  if (w.type === 'flat') {
    try {
      const g = JSON.parse(p['generator-settings'] || '{}');
      if (Array.isArray(g.layers)) {
        w.flat = { biome: String(g.biome || 'minecraft:plains').replace('minecraft:', ''), layers: g.layers.map((l) => ({ block: String(l.block).replace('minecraft:', ''), height: l.height })) };
      }
    } catch { /* 기본 평지 */ }
  }
  return w;
}

// ---------- level.dat (NBT) 에서 저장된 마인크래프트 버전 읽기 ----------
function readNbtVersion(buf) {
  let data = buf;
  try {
    data = zlib.gunzipSync(buf);
  } catch { /* 압축 안 된 NBT */ }
  let pos = 0;
  const u8 = () => data[pos++];
  const i16 = () => { const v = data.readInt16BE(pos); pos += 2; return v; };
  const i32 = () => { const v = data.readInt32BE(pos); pos += 4; return v; };
  const str = () => { const n = data.readUInt16BE(pos); pos += 2; const s = data.toString('utf8', pos, pos + n); pos += n; return s; };
  const found = {};
  // 태그 본문을 읽거나 건너뛴다. trail 은 지금까지의 이름 경로
  const payload = (type, trail) => {
    switch (type) {
      case 1: return u8();
      case 2: return i16();
      case 3: return i32();
      case 4: pos += 8; return null;
      case 5: pos += 4; return null;
      case 6: pos += 8; return null;
      case 7: pos += i32(); return null;
      case 8: return str();
      case 9: {
        const t = u8();
        const n = i32();
        for (let i = 0; i < n; i++) payload(t, trail);
        return null;
      }
      case 10: {
        for (;;) {
          const t = u8();
          if (t === 0) return null;
          const name = str();
          const v = payload(t, `${trail}/${name}`);
          const key = `${trail}/${name}`;
          if (key === '/Data/Version/Name' || key === '/Data/DataVersion' || key === '/Data/LevelName') found[key] = v;
        }
      }
      case 11: pos += i32() * 4; return null;
      case 12: pos += i32() * 8; return null;
      default: throw new Error(`NBT tag ${type}`);
    }
  };
  const root = u8();
  if (root !== 10) throw new Error('level.dat 형식 아님');
  str();
  payload(10, '');
  return { version: found['/Data/Version/Name'] || null, dataVersion: found['/Data/DataVersion'] || null, levelName: found['/Data/LevelName'] || null };
}

// ---------- NBT 전체 읽기 (게임 규칙용) ----------
/** NBT 를 {t: 태그 종류, v: 값} 트리로 읽는다. 압축 여부는 자동 판단 */
function parseNbt(buf) {
  let data = buf;
  try {
    data = zlib.gunzipSync(buf);
  } catch { /* 압축 안 된 NBT */ }
  let pos = 0;
  const str = () => {
    const n = data.readUInt16BE(pos);
    pos += 2;
    const s = data.toString('utf8', pos, pos + n);
    pos += n;
    return s;
  };
  const payload = (t) => {
    switch (t) {
      case 1: { const v = data.readInt8(pos); pos += 1; return v; }
      case 2: { const v = data.readInt16BE(pos); pos += 2; return v; }
      case 3: { const v = data.readInt32BE(pos); pos += 4; return v; }
      case 4: { const v = Number(data.readBigInt64BE(pos)); pos += 8; return v; }
      case 5: { const v = data.readFloatBE(pos); pos += 4; return v; }
      case 6: { const v = data.readDoubleBE(pos); pos += 8; return v; }
      case 7: { const n = data.readInt32BE(pos); pos += 4 + n; return null; }
      case 8: return str();
      case 9: {
        const et = data[pos++];
        const n = data.readInt32BE(pos);
        pos += 4;
        const out = [];
        for (let i = 0; i < n; i++) out.push({ t: et, v: payload(et) });
        return out;
      }
      case 10: {
        const out = {};
        for (;;) {
          const ct = data[pos++];
          if (ct === 0) return out;
          const name = str();
          out[name] = { t: ct, v: payload(ct) };
        }
      }
      case 11: { const n = data.readInt32BE(pos); pos += 4 + n * 4; return null; }
      case 12: { const n = data.readInt32BE(pos); pos += 4 + n * 8; return null; }
      default: throw new Error(`NBT tag ${t}`);
    }
  };
  const t = data[pos++];
  if (t !== 10) throw new Error('NBT 형식 아님');
  str();
  return { t: 10, v: payload(10) };
}

/** 트리에서 이름이 GameRules / game_rules 인 묶음을 찾는다 */
function findRules(node, depth = 0) {
  if (!node || node.t !== 10 || depth > 4) return null;
  for (const [k, c] of Object.entries(node.v)) {
    if (c.t === 10 && /^(minecraft:)?game_?rules$/i.test(k)) return c;
  }
  for (const c of Object.values(node.v)) {
    const r = findRules(c, depth + 1);
    if (r) return r;
  }
  return null;
}

/**
 * 월드에 저장된 게임 규칙. 버전마다 이름(keepInventory / keep_inventory)과 저장 방식이 달라서
 * 파일에 적힌 이름과 값을 그대로 돌려준다. 월드가 없으면 null.
 * @returns {{rules: {[key: string]: {value: boolean|number, kind: 'bool'|'int'}}, mtime: number} | null}
 */
function readGameRules(worldDir) {
  const files = [path.join(worldDir, 'level.dat')];
  // 새 버전은 규칙을 data/ 아래 따로 둘 수 있다
  try {
    for (const f of fs.readdirSync(path.join(worldDir, 'data'))) if (/game_?rules.*\.dat$/i.test(f)) files.push(path.join(worldDir, 'data', f));
  } catch { /* 없음 */ }
  for (const file of files) {
    let tree;
    try {
      tree = parseNbt(fs.readFileSync(file));
    } catch {
      continue;
    }
    // 파일 전체가 규칙 묶음일 수도 있다 (data/…game_rules.dat 의 "data" 묶음)
    const node = findRules(tree) || (file.endsWith('level.dat') ? null : tree.v.data || null);
    if (!node || node.t !== 10) continue;
    const rules = {};
    for (const [k, c] of Object.entries(node.v)) {
      if (c.t === 8) {
        if (c.v === 'true' || c.v === 'false') rules[k] = { value: c.v === 'true', kind: 'bool' };
        else if (/^-?\d+$/.test(c.v)) rules[k] = { value: Number(c.v), kind: 'int' };
      } else if (c.t === 1) rules[k] = { value: c.v !== 0, kind: 'bool' };
      else if (c.t === 3 || c.t === 2) rules[k] = { value: c.v, kind: 'int' };
    }
    if (Object.keys(rules).length) return { rules, mtime: fs.statSync(file).mtimeMs };
  }
  return null;
}

function worldInfoAt(dir) {
  const file = path.join(dir, 'level.dat');
  if (!fs.existsSync(file)) return null;
  try {
    return readNbtVersion(fs.readFileSync(file));
  } catch {
    return { version: null };
  }
}

/** 폴더 안에서 level.dat 가 있는 월드 폴더를 찾는다 (zip 을 풀면 한두 단계 안에 들어 있는 경우가 많다) */
function findWorldRoot(dir, depth = 0) {
  if (fs.existsSync(path.join(dir, 'level.dat'))) return dir;
  if (depth >= 3) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('__MACOSX')) continue;
    const r = findWorldRoot(path.join(dir, e.name), depth + 1);
    if (r) return r;
  }
  return null;
}

/**
 * 가져올 맵을 확인한다 (폴더 또는 zip). zip 은 임시 폴더에 풀어 둔다.
 * @returns {Promise<{root:string, info:object, cleanup:()=>void}>}
 */
async function prepareSource(src) {
  if (!fs.existsSync(src)) throw new Error('선택한 파일·폴더 없음');
  let base = src;
  let cleanup = () => {};
  if (fs.statSync(src).isFile()) {
    if (!/\.zip$/i.test(src)) throw new Error('맵은 폴더 또는 .zip 만 가능');
    base = path.join(paths.cache(), `world-import-${Date.now()}`);
    fs.mkdirSync(base, { recursive: true });
    await extractZip(src, { dir: path.resolve(base) });
    cleanup = () => fs.rmSync(base, { recursive: true, force: true });
  }
  const root = findWorldRoot(base);
  if (!root) {
    cleanup();
    throw new Error('마인크래프트 맵이 아님 (level.dat 없음)');
  }
  return { root, info: worldInfoAt(root) || {}, cleanup };
}

/** 가져오기 전에 보여줄 정보: 맵 이름, 저장된 버전, 서버보다 새 버전인지 */
async function inspectSource(src, serverVersion) {
  const { root, info, cleanup } = await prepareSource(src);
  cleanup();
  const newer = !!(info.version && serverVersion && /^\d/.test(info.version) && compareVersions(info.version, serverVersion) > 0);
  return { name: info.levelName || path.basename(root), version: info.version, newer };
}

/** 서버 폴더의 월드를 가져온 맵으로 바꾼다 (기존 월드 폴더는 지운다 — 호출하는 쪽이 먼저 백업) */
async function importInto(serverDir, levelName, src) {
  const { root, info, cleanup } = await prepareSource(src);
  try {
    for (const d of [levelName, `${levelName}_nether`, `${levelName}_the_end`]) fs.rmSync(path.join(serverDir, d), { recursive: true, force: true });
    const dest = path.join(serverDir, levelName);
    fs.cpSync(root, dest, { recursive: true });
    fs.rmSync(path.join(dest, 'session.lock'), { force: true });
    return { name: info.levelName || path.basename(root), version: info.version || null };
  } finally {
    cleanup();
  }
}

function deleteWorld(serverDir, levelName) {
  for (const d of [levelName, `${levelName}_nether`, `${levelName}_the_end`]) fs.rmSync(path.join(serverDir, d), { recursive: true, force: true });
}

module.exports = { parseNbt, readGameRules, TYPES, levelTypeValue, levelTypeFromValue, validateFlat, flatGenerator, toProperties, fromProperties, readNbtVersion, worldInfoAt, inspectSource, importInto, deleteWorld, MAX_HEIGHT };
