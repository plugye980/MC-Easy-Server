'use strict';
// 모든 데이터(서버, Java 런타임, 백업, 터널 에이전트)는 시스템이 아니라 앱 폴더 안에 만든다.
const fs = require('fs');
const path = require('path');

let root = null;

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveRoot(app) {
  if (process.env.MC_EASY_DATA) return process.env.MC_EASY_DATA;
  const candidates = [];
  // 포터블 exe는 실행 파일이 있는 폴더 옆에 둔다.
  if (process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'MCEasyData'));
  if (app && app.isPackaged) candidates.push(path.join(path.dirname(app.getPath('exe')), 'data'));
  else candidates.push(path.join(__dirname, '..', '..', 'data'));
  // 앱 폴더에 쓸 수 없는 경우(예: Program Files)에만 사용자 폴더로 물러난다.
  if (app) candidates.push(path.join(app.getPath('userData'), 'data'));
  for (const c of candidates) if (canWrite(c)) return c;
  return candidates[candidates.length - 1];
}

function init(app) {
  root = resolveRoot(app);
  for (const d of [servers(), runtimes(), backups(), tools(), cache()]) fs.mkdirSync(d, { recursive: true });
  return root;
}

const dataRoot = () => root || (root = resolveRoot(null));
const servers = () => path.join(dataRoot(), 'servers');
const runtimes = () => path.join(dataRoot(), 'runtimes');
const backups = () => path.join(dataRoot(), 'backups');
const tools = () => path.join(dataRoot(), 'tools');
const cache = () => path.join(dataRoot(), 'cache');
const serverDir = (id) => path.join(servers(), id);
const serverBackups = (id) => path.join(backups(), id);

module.exports = { init, dataRoot, servers, runtimes, backups, tools, cache, serverDir, serverBackups };
