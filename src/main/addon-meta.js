'use strict';
// 직접 넣은 플러그인·모드·데이터팩 파일의 정보를 파일 안에서 읽고, Modrinth 없이 호환 여부를 판단한다.
//   Paper/Bukkit: plugin.yml · paper-plugin.yml (name, version, api-version, depend)
//   Fabric:       fabric.mod.json (id, name, version, depends.minecraft, 다른 모드 의존성)
//   Forge:        META-INF/mods.toml (modId, displayName, version, dependencies.minecraft 범위) · 구버전 mcmod.info
//   데이터팩:     pack.mcmeta
const yauzl = require('yauzl');
const YAML = require('yaml');
const TOML = require('@iarna/toml');
const { compareVersions } = require('./versions');

const WANTED = [
  'plugin.yml', 'paper-plugin.yml', 'fabric.mod.json', 'quilt.mod.json', 'pack.mcmeta',
  'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'META-INF/MANIFEST.MF', 'mcmod.info',
];

/** Forge mods.toml → 모드 정보. version 이 ${file.jarVersion} 이면 MANIFEST 의 Implementation-Version */
function parseModsToml(text, manifest) {
  let t = {};
  try {
    t = TOML.parse(text);
  } catch {
    return null;
  }
  const mod = (t.mods || [])[0] || {};
  const id = mod.modId || null;
  let version = mod.version ? String(mod.version) : null;
  if (version && version.includes('${')) {
    const m = /^Implementation-Version:\s*(.+)$/m.exec(manifest || '');
    version = m ? m[1].trim() : null;
  }
  const deps = (t.dependencies && id && t.dependencies[id]) || [];
  const required = (d) => d.mandatory === true || d.type === 'required' || (d.mandatory === undefined && d.type === undefined);
  const mc = deps.find((d) => d.modId === 'minecraft');
  return {
    kind: 'forge',
    id,
    name: mod.displayName || id,
    version,
    mcRange: mc ? String(mc.versionRange || '') : null,
    depends: deps.filter((d) => required(d) && !['minecraft', 'forge', 'neoforge', 'java'].includes(d.modId)).map((d) => d.modId),
    provides: [],
  };
}

/** Maven 버전 범위: "[1.20.1,1.21)", "[1.20,)", "[1.20.1]", 여러 구간은 "[...],[...]" · 괄호 없는 값은 그 버전 이상 */
function matchesMavenRange(range, mc) {
  const r = String(range || '').trim();
  if (!r || r === '*') return true;
  if (!/[[(]/.test(r)) return compareVersions(mc, r) >= 0;
  const sets = [...r.matchAll(/([[(])([^\])]*)([\])])/g)];
  return sets.some(([, open, inner, close]) => {
    if (!inner.includes(',')) return compareVersions(mc, inner.trim()) === 0;
    const [lo, hi] = inner.split(',').map((x) => x.trim());
    if (lo && (open === '[' ? compareVersions(mc, lo) < 0 : compareVersions(mc, lo) <= 0)) return false;
    if (hi && (close === ']' ? compareVersions(mc, hi) > 0 : compareVersions(mc, hi) >= 0)) return false;
    return true;
  });
}

/** mcmod.info (1.12 이하 Forge) */
function parseMcmodInfo(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  const mod = Array.isArray(j) ? j[0] : (j.modList || [])[0];
  if (!mod) return null;
  return { kind: 'forge', id: mod.modid || null, name: mod.name || mod.modid || null, version: mod.version || null, mcRange: mod.mcversion ? `[${mod.mcversion}]` : null, depends: [], provides: [] };
}

/** zip(jar) 안에서 필요한 파일만 문자열로 읽는다 */
function readEntries(file, names = WANTED) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(err);
      const out = {};
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry) => {
        if (!names.includes(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            out[entry.fileName] = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function asList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  return [String(v)];
}

/** 파일 정보를 읽는다. 알 수 없는 파일이면 kind: null */
async function inspect(file) {
  let entries;
  try {
    entries = await readEntries(file);
  } catch {
    return { kind: null, error: '압축 파일(jar/zip)이 아님' };
  }
  const paper = entries['paper-plugin.yml'];
  const bukkit = entries['plugin.yml'];
  if (paper || bukkit) {
    let y = {};
    try {
      y = YAML.parse(paper || bukkit) || {};
    } catch { /* 잘못된 yml */ }
    let depends = asList(y.depend);
    // paper-plugin.yml: dependencies.server.<이름>.required
    const server = y.dependencies && (y.dependencies.server || y.dependencies);
    if (server && typeof server === 'object' && !Array.isArray(server)) {
      for (const [name, opt] of Object.entries(server)) if (!opt || opt.required !== false) depends.push(name);
    } else if (Array.isArray(y.dependencies)) {
      for (const d of y.dependencies) if (d && d.name && d.required !== false) depends.push(d.name);
    }
    depends = [...new Set(depends)];
    return {
      kind: 'plugin',
      id: y.name ? String(y.name) : null,
      name: y.name ? String(y.name) : null,
      version: y.version !== undefined ? String(y.version) : null,
      apiVersion: y['api-version'] !== undefined ? String(y['api-version']) : null,
      depends,
      softDepends: asList(y.softdepend),
    };
  }
  const fabric = entries['fabric.mod.json'];
  if (fabric) {
    let j = {};
    try {
      j = JSON.parse(fabric);
    } catch { /* 잘못된 json */ }
    const deps = j.depends || {};
    return {
      kind: 'fabric',
      id: j.id || null,
      name: j.name || j.id || null,
      version: j.version || null,
      mcRange: deps.minecraft !== undefined ? deps.minecraft : null,
      depends: Object.keys(deps).filter((k) => !['minecraft', 'fabricloader', 'java', 'fabric-loader'].includes(k)),
      provides: Array.isArray(j.provides) ? j.provides : [],
      environment: j.environment || '*',
    };
  }
  if (entries['quilt.mod.json']) return { kind: 'quilt', name: null, depends: [] };
  if (entries['META-INF/mods.toml']) {
    const m = parseModsToml(entries['META-INF/mods.toml'], entries['META-INF/MANIFEST.MF']);
    if (m) return m;
  }
  if (entries['META-INF/neoforge.mods.toml']) {
    const m = parseModsToml(entries['META-INF/neoforge.mods.toml'], entries['META-INF/MANIFEST.MF']);
    if (m) return { ...m, kind: 'neoforge' };
  }
  if (entries['mcmod.info']) {
    const m = parseMcmodInfo(entries['mcmod.info']);
    if (m) return m;
  }
  if (entries['pack.mcmeta']) {
    let pack = {};
    try {
      pack = JSON.parse(entries['pack.mcmeta']).pack || {};
    } catch { /* 무시 */ }
    return { kind: 'datapack', name: null, packFormat: pack.pack_format || null, depends: [] };
  }
  return { kind: null, error: '플러그인·모드 정보 파일 없음' };
}

// ---------- Fabric 버전 범위 ("~1.21", ">=1.21.1 <1.21.4", "1.21.x", ["1.21", "1.21.1"]) ----------
const bare = (v) => String(v).trim().replace(/^v/i, '').split('-')[0].split('+')[0];

function predicate(p, mc) {
  p = String(p).trim();
  if (!p || p === '*' || p === 'x' || p === 'X') return true;
  const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(p);
  const op = m[1] || '';
  const raw = bare(m[2]);
  const parts = raw.split('.');
  const wild = parts.findIndex((x) => /^[xX*]$/.test(x));
  if (wild >= 0) {
    // 1.21.x → >=1.21 <1.22
    const lo = parts.slice(0, wild);
    if (!lo.length) return true;
    const hi = [...lo.slice(0, -1), String(Number(lo[lo.length - 1]) + 1)];
    return compareVersions(mc, lo.join('.')) >= 0 && compareVersions(mc, hi.join('.')) < 0;
  }
  const c = compareVersions(mc, raw);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '~': {
      // 같은 부 버전 안에서만: ~1.21.1 → >=1.21.1 <1.22
      const hi = parts.length > 1 ? `${parts[0]}.${Number(parts[1]) + 1}` : `${Number(parts[0]) + 1}`;
      return c >= 0 && compareVersions(mc, hi) < 0;
    }
    case '^': return c >= 0 && compareVersions(mc, `${Number(parts[0]) + 1}`) < 0;
    default: return c === 0;
  }
}

function matchesRange(range, mc) {
  if (range === null || range === undefined) return true;
  if (Array.isArray(range)) return range.some((r) => matchesRange(r, mc));
  const s = String(range).trim();
  if (s.includes('||')) return s.split('||').some((r) => matchesRange(r, mc));
  // "  >= 1.21" 처럼 연산자 뒤 공백을 붙인 뒤 공백으로 나눈 조건을 모두 만족해야 한다
  return s.replace(/(>=|<=|>|<|=|~|\^)\s+/g, '$1').split(/\s+/).every((p) => predicate(p, mc));
}

const rangeText = (r) => (Array.isArray(r) ? r.join(', ') : String(r));

/**
 * 서버 종류·버전에 맞는지 판단한다.
 * @returns {{status: 'ok'|'bad'|'unknown', reason: string|null}}
 */
function compat(meta, serverType, mc) {
  if (!meta || !meta.kind) return { status: 'unknown', reason: (meta && meta.error) || '정보 없음' };
  if (serverType === 'paper') {
    if (['fabric', 'quilt', 'forge', 'neoforge'].includes(meta.kind)) return { status: 'bad', reason: '모드 파일 — 플러그인 서버에서 사용 불가', wrongType: true };
    if (meta.kind !== 'plugin') return { status: 'bad', reason: '플러그인 파일 아님', wrongType: true };
    if (!meta.apiVersion) return { status: 'unknown', reason: 'API 버전 표시 없는 구형 플러그인' };
    if (compareVersions(bare(meta.apiVersion), mc) > 0) return { status: 'bad', reason: `마인크래프트 ${meta.apiVersion} 이상 필요` };
    return { status: 'ok', reason: null };
  }
  if (serverType === 'forge') {
    if (meta.kind === 'plugin') return { status: 'bad', reason: '플러그인 파일 — 모드 서버에서 사용 불가', wrongType: true };
    if (meta.kind === 'fabric' || meta.kind === 'quilt') return { status: 'bad', reason: 'Fabric 모드 — Forge 서버에서 사용 불가', wrongType: true };
    if (meta.kind === 'neoforge') return { status: 'bad', reason: 'NeoForge 전용 모드', wrongType: true };
    if (meta.kind !== 'forge') return { status: 'bad', reason: 'Forge 모드 파일 아님', wrongType: true };
    if (!meta.mcRange) return { status: 'unknown', reason: '지원 버전 표시 없음' };
    return matchesMavenRange(meta.mcRange, mc) ? { status: 'ok', reason: null } : { status: 'bad', reason: `마인크래프트 ${meta.mcRange} 전용` };
  }
  if (serverType === 'fabric') {
    if (meta.kind === 'forge' || meta.kind === 'neoforge') return { status: 'bad', reason: 'Forge 모드 — Fabric 서버에서 사용 불가', wrongType: true };
    if (meta.kind === 'plugin') return { status: 'bad', reason: '플러그인 파일 — 모드 서버에서 사용 불가', wrongType: true };
    if (meta.kind === 'quilt') return { status: 'bad', reason: 'Quilt 전용 모드', wrongType: true };
    if (meta.kind !== 'fabric') return { status: 'bad', reason: 'Fabric 모드 파일 아님', wrongType: true };
    if (meta.environment === 'client') return { status: 'bad', reason: '클라이언트 전용 모드', wrongType: true };
    if (meta.mcRange === null || meta.mcRange === undefined) return { status: 'unknown', reason: '지원 버전 표시 없음' };
    return matchesRange(meta.mcRange, mc) ? { status: 'ok', reason: null } : { status: 'bad', reason: `마인크래프트 ${rangeText(meta.mcRange)} 전용` };
  }
  if (meta.kind !== 'datapack') return { status: 'bad', reason: '데이터팩(zip) 아님', wrongType: true };
  return { status: 'unknown', reason: '데이터팩은 호환 여부 표시 없음' };
}

/**
 * 설치된 것들 사이에서 빠진 의존성을 찾는다.
 * @param {{meta: object, title?: string, slug?: string}[]} all 설치된 전부 (켜진 것만 넘긴다)
 */
function missingDependencies(meta, all) {
  if (!meta || !meta.depends || !meta.depends.length) return [];
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const have = new Set();
  let fabricApi = false;
  for (const a of all) {
    const m = a.meta || {};
    for (const k of [m.id, m.name, a.title, a.slug, ...(m.provides || [])]) if (k) have.add(norm(k));
    if (m.id === 'fabric-api' || a.slug === 'fabric-api') fabricApi = true;
  }
  return meta.depends.filter((d) => {
    // Fabric API 안에 든 모듈(fabric-*-v1 등)은 Fabric API 하나로 충족된다
    if (fabricApi && (d === 'fabric' || d.startsWith('fabric-'))) return false;
    return !have.has(norm(d));
  });
}

module.exports = { inspect, compat, matchesRange, matchesMavenRange, parseModsToml, missingDependencies, readEntries };
