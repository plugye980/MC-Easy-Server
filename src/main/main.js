'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, nativeTheme } = require('electron');

const paths = require('./paths');
const system = require('./system');
const versions = require('./versions');
const java = require('./java');
const modrinth = require('./modrinth');
const reach = require('./reachability');
const upnp = require('./upnp');
const { Servers, Settings } = require('./store');
const serverImport = require('./server-import');
const { ServerManager } = require('./server-manager');
const { Tunnel } = require('./tunnel');

let win = null;
let manager = null;
let tunnel = null;
let quitting = false;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  const settings = Settings.get();
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 680,
    backgroundColor: settings.theme === 'dark' ? '#212429' : '#fbfeff',
    title: 'MCES',
    icon: path.join(__dirname, '..', 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 안전한 종료: 서버가 켜져 있으면 저장 후 정지한 다음 닫는다
  win.on('close', (e) => {
    if (quitting || !manager.anyRunning()) return;
    e.preventDefault();
    safeQuit();
  });
}

async function safeQuit() {
  if (quitting) return;
  quitting = true;
  send('app:closing', { message: '서버 저장 후 종료 중…' });
  try {
    await manager.stopAll();
  } finally {
    tunnel.stop();
    app.exit(0);
  }
}

/** ipcMain.handle 래퍼: 오류를 {error} 로 돌려 렌더러가 쉬운 말로 보여줄 수 있게 한다. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      console.error(channel, e);
      return { ok: false, error: e.message || String(e) };
    }
  });
}

function progressTo(key) {
  return (p) => send('progress', { key, ...p });
}

function registerIpc() {
  // 시스템 · 사전 점검
  handle('system:specs', () => system.specs());
  handle('system:dataRoot', () => paths.dataRoot());
  handle('versions:list', (type) => versions.listVersions(type));
  handle('java:check', async (mc) => {
    const major = await versions.requiredJava(mc);
    const found = await java.detect(major);
    return { major, found };
  });
  handle('java:installed', () => java.listInstalled());
  handle('java:install', (major) => java.install(major, progressTo(`java-${major}`)));

  // 서버
  handle('servers:list', () => manager.list());
  handle('servers:create', (opts, key) => manager.create(opts, progressTo(key || 'create')));
  // 기존 서버 가져오기: 폴더를 골라 알아본 정보를 먼저 보여준다
  handle('servers:pickImport', async () => {
    const r = await dialog.showOpenDialog(win, { title: '서버 폴더 선택 (server.properties 가 있는 폴더)', properties: ['openDirectory'] });
    if (r.canceled) return null;
    return serverImport.detect(r.filePaths[0]);
  });
  handle('servers:inspectImport', (dir) => serverImport.detect(dir));
  handle('servers:import', (opts, key) => manager.importExisting(opts, progressTo(key || 'import')));
  handle('server:start', (id) => manager.start(id));
  handle('server:stop', (id) => manager.stop(id));
  handle('server:restart', (id) => manager.restart(id));
  handle('server:remove', (id, opts) => manager.remove(id, opts));
  handle('server:command', (id, cmd) => manager.command(id, cmd));
  handle('server:console', (id) => manager.consoleLines(id));
  handle('server:history', (id) => manager.history(id));
  handle('server:settings', (id, patch) => manager.updateSettings(id, patch));
  handle('server:gameRules', (id) => manager.gameRules(id));
  handle('server:setGameRules', (id, changes) => manager.setGameRules(id, changes));
  handle('server:openFolder', (id) => shell.openPath(manager.dir(id)));
  handle('server:openLogs', (id) => {
    const dir = path.join(manager.dir(id), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  handle('server:checkUpdate', (id, v) => manager.checkUpdate(id, v));
  handle('server:applyUpdate', (id, v) => manager.applyUpdate(id, v, progressTo(`update-${id}`)));

  // 접속자
  handle('players:lists', (id) => manager.playerLists(id));
  handle('players:action', (id, action, name) => manager.playerAction(id, action, name));

  // 추가 기능
  handle('addons:search', (id, q, opts = {}) => modrinth.search(modrinth.asKind(Servers.get(id), opts.kind), q, opts));
  handle('addons:list', (id) => manager.addons(id));
  // 파일에서 직접 추가: 경로가 없으면 파일 선택 창을 연다 (끌어다 놓기는 경로를 넘긴다)
  handle('addons:importFiles', async (id, filePaths) => {
    let files = Array.isArray(filePaths) ? filePaths.filter((f) => typeof f === 'string' && f) : null;
    if (!files) {
      const server = Servers.get(id);
      const datapack = server.type === 'vanilla';
      const r = await dialog.showOpenDialog(win, {
        title: datapack ? '데이터팩 파일 선택' : server.type === 'paper' ? '플러그인 파일 선택' : server.type === 'hybrid' ? '플러그인·모드 파일 선택' : '모드 파일 선택',
        properties: ['openFile', 'multiSelections'],
        filters: [datapack ? { name: '데이터팩', extensions: ['zip'] } : { name: server.type === 'paper' ? '플러그인' : server.type === 'hybrid' ? '플러그인·Forge 모드' : server.type === 'forge' ? 'Forge 모드' : 'Fabric 모드', extensions: ['jar'] }],
      });
      if (r.canceled) return null;
      files = r.filePaths;
    }
    return manager.importFiles(id, files);
  });
  handle('addons:installByName', (id, name, kind) => manager.installByName(id, name, progressTo(`addon-${id}`), kind));
  handle('addons:install', (id, projectId, kind) => manager.installAddon(id, projectId, progressTo(`addon-${id}`), kind));
  handle('addons:toggle', (id, fileName, enabled) => manager.setAddonEnabled(id, fileName, enabled));
  handle('addons:remove', (id, fileName) => manager.removeAddon(id, fileName));
  handle('addons:update', (id) => manager.updateAddons(id));
  handle('addons:exportModsZip', async (id) => {
    const server = Servers.get(id);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '접속용 mods.zip 저장',
      defaultPath: 'mods.zip',
      filters: [{ name: 'zip', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return null;
    // 폴더에 직접 넣은 모드 중 접속하는 쪽에도 필요한 것도 넣는다
    const extra = (await manager.addons(id))
      .filter((a) => a.manual && a.enabled && a.meta && ['fabric', 'forge'].includes(a.meta.kind) && a.meta.environment !== 'server')
      .map((a) => a.fileName);
    const r = await modrinth.exportModsZip(modrinth.asKind(server, 'mod'), manager.dir(id), filePath, extra);
    shell.showItemInFolder(filePath);
    return r;
  });

  // 맵(월드)
  const pickWorld = async (kind) => {
    const r = await dialog.showOpenDialog(win, kind === 'zip'
      ? { title: '맵 zip 선택', properties: ['openFile'], filters: [{ name: '맵 압축 파일', extensions: ['zip'] }] }
      : { title: '맵 폴더 선택 (level.dat 가 있는 폴더)', properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  };
  handle('world:info', (id) => manager.worldInfo(id));
  // 만들기 화면: 맵을 고르고 정보(이름·저장 버전)를 미리 보여준다
  handle('world:pick', async (kind, version) => {
    const src = await pickWorld(kind);
    if (!src) return null;
    const info = await manager.inspectWorldSource(null, src);
    const newer = !!(info.version && version && /^\d/.test(info.version) && versions.compareVersions(info.version, version) > 0);
    return { path: src, ...info, newer };
  });
  handle('world:import', async (id, kind) => {
    const src = await pickWorld(kind);
    if (!src) return null;
    const info = await manager.inspectWorldSource(id, src);
    return { path: src, ...info };
  });
  handle('world:importConfirm', (id, src) => manager.importWorld(id, src));
  handle('world:regenerate', (id, w) => manager.regenerateWorld(id, w));

  // 백업
  handle('backups:list', (id) => manager.listBackups(id));
  handle('backups:create', (id) => manager.backupNow(id, 'manual'));
  handle('backups:restore', (id, file) => manager.restoreBackup(id, file));
  handle('backups:delete', (id, file) => manager.deleteBackup(id, file));

  // 네트워크
  handle('tunnel:state', () => tunnel.publicState());
  handle('tunnel:start', async (id) => {
    const server = Servers.get(id);
    const address = await tunnel.start(server, progressTo(`tunnel-${id}`));
    if (address) manager.updateSettings(id, { network: { mode: 'tunnel', address } });
    return address;
  });
  handle('tunnel:stop', () => tunnel.stop());
  // 초기화: 저장된 연결과 함께 각 서버에 기록된 터널 주소도 지운다 (UPnP 주소는 그대로)
  handle('tunnel:reset', () => {
    tunnel.reset();
    for (const s of Servers.all()) {
      if (s.network && s.network.mode !== 'upnp' && s.network.address) manager.updateSettings(s.id, { network: { mode: 'tunnel', address: null } });
    }
    return true;
  });
  handle('tunnel:setAddress', (id, address) => {
    tunnel.setAddress(id, address);
    return manager.updateSettings(id, { network: { address } });
  });
  handle('upnp:open', async (id) => {
    const server = Servers.get(id);
    const r = await upnp.openPort(server.port, `MCES - ${server.name}`);
    manager.updateSettings(id, { network: { mode: 'upnp', address: r.address } });
    return r;
  });
  handle('upnp:close', async (id) => {
    const server = Servers.get(id);
    await upnp.closePort(server.port);
    return manager.updateSettings(id, { network: { mode: 'tunnel' } });
  });
  handle('reach:check', async (id) => {
    const server = Servers.get(id);
    const local = await reach.ping('127.0.0.1', server.port, 4000);
    const address = server.network && server.network.address;
    const external = address ? await reach.externalCheck(address) : { online: false, error: 'no-address' };
    return { local, external, address, checkedAt: Date.now() };
  });

  // 오류 안내의 해결 버튼
  handle('alert:action', async (id, action, payload = {}) => {
    const server = Servers.get(id);
    switch (action) {
      case 'change-port': {
        const taken = Servers.all().filter((s) => s.id !== id).map((s) => s.port);
        const port = await reach.findFreePort(server.port + 1, taken);
        manager.updateSettings(id, { port });
        await manager.start(id);
        return `포트 ${port}번으로 변경`;
      }
      case 'lower-memory': {
        const mb = Math.min(system.specs().recommendedMb, server.memoryMb - 512);
        manager.updateSettings(id, { memoryMb: Math.max(1024, mb) });
        await manager.start(id);
        return `메모리 ${(Math.max(1024, mb) / 1024).toFixed(1)}GB로 변경`;
      }
      case 'raise-memory': {
        const max = system.specs().maxMb;
        const mb = Math.min(max, server.memoryMb + 1024);
        manager.updateSettings(id, { memoryMb: mb });
        return `메모리 ${(mb / 1024).toFixed(1)}GB로 변경 — 재시작 시 적용`;
      }
      case 'reset-tick-rate': {
        // /tick rate 는 월드에 남을 수 있으므로 켜진 뒤 명령으로 되돌린다
        if (manager.get(id).status === 'running') {
          manager.command(id, 'tick rate 20');
          return '틱 속도 20으로 되돌림';
        }
        manager.queueCommand(id, 'tickRate', 'tick rate 20');
        await manager.start(id);
        return '켜진 뒤 틱 속도 20으로 되돌림';
      }
      case 'lower-view': {
        const cur = manager.get(id).settings;
        const view = Math.max(4, cur.viewDistance - 2);
        manager.updateSettings(id, { viewDistance: view, simulationDistance: Math.min(cur.simulationDistance, view) });
        return `시야 거리 ${view}칸으로 변경 — 재시작 시 적용`;
      }
      case 'fix-java': {
        const need = payload.need ? versions.normalizeJavaFeature(payload.need) : await versions.requiredJava(server.version);
        await java.ensure(need, progressTo(`java-${need}`));
        Servers.update(id, { javaMajor: need });
        await manager.start(id);
        return `Java ${need}로 재시작`;
      }
      case 'disable-optimize': {
        manager.updateSettings(id, { optimize: false });
        await manager.start(id);
        return '최적화 옵션 끄고 재시작 (설정 탭에서 변경 가능)';
      }
      case 'accept-eula': {
        fs.writeFileSync(path.join(manager.dir(id), 'eula.txt'), 'eula=true\n');
        await manager.start(id);
        return 'EULA 동의 후 재시작';
      }
      case 'disable-plugin': {
        let file = payload.file;
        if (file) manager.setAddonEnabled(id, file, false);
        else file = await manager.disablePluginByName(id, payload.name);
        return `${file} 비활성화 — 재시작 시 적용`;
      }
      case 'disable-mod': {
        const file = await manager.disableModById(id, payload.modId);
        return `${file} 비활성화`;
      }
      case 'install-deps': {
        const done = [];
        for (const name of payload.names || []) {
          const r = await manager.installByName(id, name, progressTo(`addon-${id}`), payload.kind);
          done.push(...r.installed.map((a) => a.title));
        }
        return `${done.join(', ')} 설치 — 재시작 시 적용`;
      }
      default:
        return null;
    }
  });

  // 앱
  handle('app:settings', () => Settings.get());
  handle('app:setSettings', (patch) => {
    const s = Settings.set(patch);
    if (patch.theme) nativeTheme.themeSource = patch.theme;
    return s;
  });
  handle('app:openExternal', (url) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
  });
  handle('app:copy', (text) => clipboard.writeText(String(text)));
}

function wireEvents() {
  manager.on('server', (s) => send('server:update', s));
  manager.on('console', (e) => send('server:console', e));
  manager.on('metrics', (e) => send('server:metrics', e));
  manager.on('alert', (e) => e && e.title && send('server:alert', e));
  manager.on('notice', (e) => send('app:notice', e));
  manager.on('backup', (e) => send('backups:changed', e));
  manager.on('removed', (e) => send('server:removed', e));
  manager.on('players-changed', (e) => send('players:changed', e));
  manager.on('progress', (e) => send('progress', { key: `start-${e.serverId}`, ...e }));
  // 터널 자동 연결: 서버가 켜지면 앱 안에서 playit 에이전트를 띄우고 주소를 받아온다
  manager.on('ready', async ({ serverId }) => {
    const s = Servers.get(serverId);
    if (!s || !s.network || s.network.mode !== 'tunnel' || Settings.get().autoTunnel === false) return;
    try {
      const address = await tunnel.start(s);
      if (address) manager.updateSettings(serverId, { network: { mode: 'tunnel', address } });
    } catch (e) {
      send('app:notice', { severity: 'error', title: '터널 연결 실패', message: e.message });
    }
  });
  tunnel.on('state', (s) => send('tunnel:state', s));
  tunnel.on('open-url', (url) => shell.openExternal(url));
  // 브라우저에서 승인하면 앱 창을 다시 앞으로 가져온다
  tunnel.on('claimed', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('app:notice', { severity: 'info', title: 'playit 연결 승인 완료', message: '터널을 만드는 중' });
  });
}

const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    paths.init(app);
    nativeTheme.themeSource = Settings.get().theme || 'light';
    manager = new ServerManager();
    tunnel = new Tunnel();
    // 저장된 터널 주소 복원
    for (const s of Servers.all()) if (s.network && s.network.address && s.network.mode === 'tunnel') tunnel.setAddress(s.id, s.network.address);
    registerIpc();
    wireEvents();
    createWindow();
  });

  app.on('before-quit', (e) => {
    if (!quitting && manager && manager.anyRunning()) {
      e.preventDefault();
      safeQuit();
    }
  });

  // 앱이 어떤 경로로 끝나든 터널 에이전트가 남지 않게 한다
  app.on('will-quit', () => {
    if (tunnel) tunnel.stop();
  });

  app.on('window-all-closed', () => {
    if (!manager || !manager.anyRunning()) app.quit();
  });
}
