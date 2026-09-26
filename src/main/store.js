'use strict';
// 서버 목록과 앱 설정 저장 (data/servers.json, data/settings.json)
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function file(name) {
  return path.join(paths.dataRoot(), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  const f = file(name);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, f);
}

const Servers = {
  all() {
    return readJson('servers.json', []);
  },
  get(id) {
    return this.all().find((s) => s.id === id) || null;
  },
  save(server) {
    const list = this.all();
    const i = list.findIndex((s) => s.id === server.id);
    if (i >= 0) list[i] = server;
    else list.push(server);
    writeJson('servers.json', list);
    return server;
  },
  update(id, patch) {
    const s = this.get(id);
    if (!s) throw new Error('서버 없음');
    const next = typeof patch === 'function' ? patch(s) : { ...s, ...patch };
    return this.save(next);
  },
  remove(id) {
    writeJson('servers.json', this.all().filter((s) => s.id !== id));
  },
};

const Settings = {
  get() {
    return { theme: 'dark', ...readJson('settings.json', {}) };
  },
  set(patch) {
    const next = { ...this.get(), ...patch };
    writeJson('settings.json', next);
    return next;
  },
};

module.exports = { Servers, Settings };
