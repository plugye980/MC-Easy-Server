'use strict';
// server.properties 읽기/쓰기. 사용자에게는 원본 대신 풀어 쓴 설정(friendly)만 보여준다.
const fs = require('fs');

function parse(text) {
  const map = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const i = line.search(/[=:]/);
    if (i < 0) continue;
    map[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/\\:/g, ':').replace(/\\=/g, '=');
  }
  return map;
}

/** 기존 파일의 순서·주석을 유지하며 값만 바꾸고, 없는 키는 끝에 붙인다. */
function merge(text, values) {
  const pending = { ...values };
  const lines = (text || '').split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return raw;
    const i = line.search(/[=:]/);
    if (i < 0) return raw;
    const key = line.slice(0, i).trim();
    if (!(key in pending)) return raw;
    const v = pending[key];
    delete pending[key];
    return `${key}=${escape(v)}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(pending)) lines.push(`${k}=${escape(v)}`);
  return `${lines.join('\n')}\n`;
}

function escape(v) {
  return String(v).replace(/\r?\n/g, ' ').replace(/:/g, '\\:');
}

function read(file) {
  return fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')) : {};
}

function write(file, values) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '#Minecraft server properties\n';
  fs.writeFileSync(file, merge(text, values));
}

// ---------- 풀어 쓴 설정 <-> server.properties ----------
const bool = (v) => String(v) === 'true';

function toProperties(s) {
  const out = {};
  if (s.difficulty !== undefined) out.difficulty = s.difficulty;
  if (s.gamemode !== undefined) out.gamemode = s.gamemode;
  if (s.maxPlayers !== undefined) out['max-players'] = s.maxPlayers;
  if (s.pvp !== undefined) out.pvp = !!s.pvp;
  if (s.hardcore !== undefined) out.hardcore = !!s.hardcore;
  if (s.whitelist !== undefined) {
    out['white-list'] = !!s.whitelist;
    out['enforce-whitelist'] = !!s.whitelist;
  }
  if (s.motd !== undefined) out.motd = s.motd;
  if (s.port !== undefined) out['server-port'] = s.port;
  if (s.onlineMode !== undefined) out['online-mode'] = !!s.onlineMode;
  if (s.allowFlight !== undefined) out['allow-flight'] = !!s.allowFlight;
  if (s.spawnProtection !== undefined) out['spawn-protection'] = s.spawnProtection;
  if (s.seed !== undefined) out['level-seed'] = s.seed;
  if (s.viewDistance !== undefined) out['view-distance'] = s.viewDistance;
  if (s.simulationDistance !== undefined) out['simulation-distance'] = s.simulationDistance;
  if (s.commandBlocks !== undefined) out['enable-command-block'] = !!s.commandBlocks;
  return out;
}

function fromProperties(p) {
  const num = (k, d) => (p[k] !== undefined && p[k] !== '' ? Number(p[k]) : d);
  return {
    difficulty: p.difficulty || 'easy',
    gamemode: p.gamemode || 'survival',
    maxPlayers: num('max-players', 20),
    pvp: p.pvp === undefined ? true : bool(p.pvp),
    hardcore: bool(p.hardcore),
    whitelist: bool(p['white-list']),
    motd: p.motd || 'A Minecraft Server',
    port: num('server-port', 25565),
    onlineMode: p['online-mode'] === undefined ? true : bool(p['online-mode']),
    allowFlight: bool(p['allow-flight']),
    spawnProtection: num('spawn-protection', 16),
    seed: p['level-seed'] || '',
    viewDistance: num('view-distance', 10),
    simulationDistance: num('simulation-distance', 10),
    commandBlocks: bool(p['enable-command-block']),
    levelName: p['level-name'] || 'world',
  };
}

module.exports = { parse, merge, read, write, toProperties, fromProperties };
