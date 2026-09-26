'use strict';
// 렌더러에 노출하는 안전한 API. 모든 호출은 {ok, data | error} 를 돌려준다.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const EVENTS = [
  'server:update',
  'server:console',
  'server:metrics',
  'server:alert',
  'server:removed',
  'players:changed',
  'backups:changed',
  'tunnel:state',
  'progress',
  'app:notice',
  'app:closing',
];

contextBridge.exposeInMainWorld('mc', {
  invoke,
  on(channel, fn) {
    if (!EVENTS.includes(channel)) throw new Error(`unknown event ${channel}`);
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
