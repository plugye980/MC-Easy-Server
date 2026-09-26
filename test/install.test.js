'use strict';
// Modrinth 설치: 최신 파일이 서버에서 못 돌면 이전 버전으로 내려가는지 (API는 가짜)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yazl = require('yazl');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mces-inst-'));
const http = require('../src/main/http');

const cls = (major) => Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, major]);
const jarBuf = (files) =>
  new Promise((resolve) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(files)) z.addBuffer(Buffer.from(c), n);
    z.end();
    const chunks = [];
    z.outputStream.on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks)));
  });

test('최신 파일이 안 맞으면 맞는 이전 버전을 설치', async () => {
  const files = {
    'p-3.jar': await jarBuf({ 'plugin.yml': 'name: P\nversion: 3\napi-version: "26.1"\n', 'P.class': cls(69) }),
    'p-2.jar': await jarBuf({ 'plugin.yml': 'name: P\nversion: 2\napi-version: "1.21"\n', 'P.class': cls(69) }),
    'p-1.jar': await jarBuf({ 'plugin.yml': 'name: P\nversion: 1\napi-version: "1.21"\n', 'P.class': cls(65) }),
  };
  const ver = (n, date) => ({
    id: `v${n}`,
    version_number: String(n),
    version_type: 'release',
    date_published: date,
    game_versions: ['1.21.11'],
    dependencies: [],
    files: [{ primary: true, filename: `p-${n}.jar`, url: `mem://p-${n}.jar`, size: 1, hashes: { sha1: 'x', sha512: null } }],
  });
  http.getJson = async (url) => {
    if (/\/project\/p\/version/.test(url)) return [ver(1, '2025-01-01'), ver(3, '2026-06-01'), ver(2, '2026-01-01')];
    if (/\/project\/p$/.test(url)) return { id: 'p', slug: 'p', title: 'P' };
    throw new Error(url);
  };
  http.download = async (url, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, files[url.slice(6)]);
  };
  delete require.cache[require.resolve('../src/main/modrinth')];
  const modrinth = require('../src/main/modrinth');
  const server = { type: 'paper', version: '1.21.11', javaMajor: 21, addons: [] };
  const r = await modrinth.install(server, tmp, 'p');
  assert.strictEqual(r.installed[0].versionNumber, '1');
  assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'plugins')), ['p-1.jar']);

  // 전부 안 맞으면 이유와 함께 실패, 임시 파일은 남기지 않는다
  await assert.rejects(modrinth.install({ ...server, javaMajor: 17 }, path.join(tmp, 'b'), 'p'), /Java \d+ 필요/);
  assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'b', 'plugins')), []);
});

test('이름으로 설치: 파일 속 이름이 다르면 지우고 다음 후보 (Essentials → EssentialsX)', async () => {
  const files = {
    'c.jar': await jarBuf({ 'plugin.yml': 'name: EssentialsC\nversion: 1\napi-version: "1.21"\n' }),
    'x.jar': await jarBuf({ 'plugin.yml': 'name: Essentials\nversion: 2.21\napi-version: "1.21"\n' }),
  };
  const ver = (p) => [{ id: `v-${p}`, version_number: '1', version_type: 'release', date_published: '2026-01-01', game_versions: ['1.21.11'], dependencies: [], files: [{ primary: true, filename: `${p}.jar`, url: `mem://${p}.jar`, size: 1, hashes: { sha1: p, sha512: null } }] }];
  const http = require('../src/main/http');
  http.getJson = async (url) => {
    if (url.includes('/search?')) {
      return {
        total_hits: 2, offset: 0, limit: 10,
        hits: [
          { project_id: 'c', slug: 'essentialsc', title: 'EssentialsC', downloads: 900 },
          { project_id: 'x', slug: 'essentialsx', title: 'EssentialsX', downloads: 500 },
        ],
      };
    }
    let m;
    if ((m = /\/project\/(\w)\/version/.exec(url))) return ver(m[1]);
    if ((m = /\/project\/(\w)$/.exec(url))) return { id: m[1], slug: m[1], title: m[1] };
    throw new Error(url);
  };
  http.download = async (url, dest) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, files[url.slice(6)]);
  };
  delete require.cache[require.resolve('../src/main/modrinth')];
  const modrinth = require('../src/main/modrinth');
  const dir = path.join(tmp, 'ess');
  const r = await modrinth.installByName({ type: 'paper', version: '1.21.11', javaMajor: 21, addons: [] }, dir, 'Essentials');
  assert.strictEqual(r.installed[0].projectId, 'x');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'plugins')), ['x.jar']);
});

test('설치된 파일 속 이름으로 의존성 충족 판단', () => {
  const meta = require('../src/main/addon-meta');
  const chat = { kind: 'plugin', name: 'EssentialsChat', depends: ['Essentials'] };
  // Modrinth 제목은 EssentialsX 지만 파일 속 이름은 Essentials
  const all = [{ title: 'EssentialsX', slug: 'essentialsx', meta: { kind: 'plugin', name: 'Essentials' } }, { meta: chat }];
  assert.deepStrictEqual(meta.missingDependencies(chat, all), []);
});
