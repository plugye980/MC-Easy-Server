'use strict';
// 월드 백업(zip) · 복원 · 오래된 백업 정리
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const yazl = require('yazl');
const extractZip = require('extract-zip');
const paths = require('./paths');

/** 서버 폴더 안의 월드 폴더들 (world, world_nether, world_the_end 등 level.dat가 있는 폴더) */
function worldDirs(serverDir, levelName = 'world') {
  if (!fs.existsSync(serverDir)) return [];
  return fs
    .readdirSync(serverDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === levelName || e.name.startsWith(`${levelName}_`)))
    .filter((e) => fs.existsSync(path.join(serverDir, e.name, 'level.dat')) || e.name !== levelName)
    .map((e) => e.name);
}

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.posix.join(base, e.name);
    if (e.isDirectory()) walk(full, rel, out);
    else if (e.isFile() && e.name !== 'session.lock') out.push({ full, rel });
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function create(serverId, serverDir, levelName, reason = 'manual') {
  const dirs = worldDirs(serverDir, levelName);
  if (!dirs.length) throw new Error('백업할 월드 없음 — 서버를 한 번 실행해 월드를 만든 뒤 가능');
  const outDir = paths.serverBackups(serverId);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${stamp()}_${reason}.zip`);
  const entries = [];
  for (const d of dirs) walk(path.join(serverDir, d), d, entries);
  await new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.on('error', reject);
    for (const e of entries) {
      // 파일을 하나씩 순서대로 열어 스트리밍한다(큰 월드도 메모리를 적게 쓴다).
      // 서버가 켜져 있으면 save-off 상태라 파일이 바뀌지 않는다.
      zip.addReadStreamLazy(e.rel, (cb) => {
        // 그 사이 사라진 파일은 빈 내용으로 남긴다
        cb(null, fs.existsSync(e.full) ? fs.createReadStream(e.full) : Readable.from([]));
      });
    }
    zip.end();
    zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
  });
  return describe(file);
}

function describe(file) {
  const st = fs.statSync(file);
  const name = path.basename(file);
  const m = /_(manual|auto|stop|before-restore|before-update)\.zip$/.exec(name);
  return { file, name, size: st.size, createdAt: st.mtimeMs, reason: m ? m[1] : 'manual' };
}

function list(serverId) {
  const dir = paths.serverBackups(serverId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => describe(path.join(dir, f)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 자동 백업은 keep 개수만 남긴다 (수동 백업은 지우지 않는다). */
function prune(serverId, keep) {
  const autos = list(serverId).filter((b) => b.reason === 'auto' || b.reason === 'stop');
  for (const b of autos.slice(keep)) fs.rmSync(b.file, { force: true });
}

async function restore(serverId, serverDir, levelName, file) {
  const safeDir = paths.serverBackups(serverId);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(safeDir) + path.sep)) throw new Error('이 앱의 백업 파일만 복원 가능');
  // 되돌릴 수 있도록 현재 월드를 먼저 백업
  if (worldDirs(serverDir, levelName).length) await create(serverId, serverDir, levelName, 'before-restore');
  for (const d of worldDirs(serverDir, levelName)) fs.rmSync(path.join(serverDir, d), { recursive: true, force: true });
  await extractZip(resolved, { dir: path.resolve(serverDir) });
}

function remove(serverId, file) {
  const safeDir = path.resolve(paths.serverBackups(serverId));
  const resolved = path.resolve(file);
  if (resolved.startsWith(safeDir + path.sep)) fs.rmSync(resolved, { force: true });
}

module.exports = { create, list, prune, restore, remove, worldDirs };
