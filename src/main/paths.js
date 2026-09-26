'use strict';
// 모든 데이터(서버, Java 런타임, 백업, 터널 에이전트)는 한 폴더 안에 모은다.
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

// 설치판 데이터 위치. 설치 폴더 안에 두면 설치 프로그램이 업데이트·제거 때 폴더째 지우므로 밖에 둔다.
// build/installer.nsh 의 위치와 같아야 한다.
function installedRoot(app) {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'MCES', 'data');
  return path.join(app.getPath('userData'), 'data');
}

const hasEntries = (dir) => {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
};

/** 예전 설치판은 실행 파일 옆 data/ 를 썼다. 새 위치가 비어 있으면 옮겨 온다. */
function migrateLegacy(from, to) {
  if (!hasEntries(from) || hasEntries(to)) return;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) fs.rmdirSync(to);
    fs.renameSync(from, to);
  } catch {
    try {
      fs.cpSync(from, to, { recursive: true });
    } catch {}
  }
}

function resolveRoot(app) {
  if (process.env.MC_EASY_DATA) return process.env.MC_EASY_DATA;
  const candidates = [];
  // 포터블 exe는 실행 파일이 있는 폴더 옆에 둔다. exe만 바꿔 끼우면 그대로 유지된다.
  if (process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'MCEasyData'));
  else if (app && app.isPackaged) {
    const target = installedRoot(app);
    migrateLegacy(path.join(path.dirname(app.getPath('exe')), 'data'), target);
    candidates.push(target);
  } else candidates.push(path.join(__dirname, '..', '..', 'data'));
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

module.exports = { migrateLegacy, init, dataRoot, servers, runtimes, backups, tools, cache, serverDir, serverBackups };
