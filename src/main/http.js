'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const pkg = require('../../package.json');
// PaperMC(Fill v3)와 Modrinth는 식별 가능한 User-Agent를 요구한다.
const USER_AGENT = `mc-easy-server/${pkg.version} (github.com/plugye980/MC-Easy-Server)`;

async function request(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
    signal: opts.signal || AbortSignal.timeout(opts.timeout || 20000),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} — ${url}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function getJson(url, opts) {
  const res = await request(url, opts);
  return res.json();
}

async function getText(url, opts) {
  const res = await request(url, opts);
  return res.text();
}

/**
 * 파일을 받으면서 진행률을 알리고, 해시가 주어지면 검증한다.
 * @param {string} url
 * @param {string} dest
 * @param {{onProgress?:(p:{received:number,total:number})=>void, sha1?:string, sha256?:string, sha512?:string}} opts
 */
async function download(url, dest, opts = {}) {
  // 받는 도중 연결이 멈추면(데이터가 한동안 안 오면) 끊고 다시 시도한다 — 영원히 기다리지 않게
  const tries = opts.retries === undefined ? 3 : opts.retries + 1;
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await downloadOnce(url, dest, opts);
    } catch (e) {
      last = e;
      if (e.hashMismatch || (e.status && e.status < 500 && e.status !== 429)) throw e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

async function downloadOnce(url, dest, opts) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stallMs = opts.stallMs || 45000;
  const ctl = new AbortController();
  let stalled = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctl.abort();
    }, stallMs);
  };
  arm();
  const signal = AbortSignal.any ? AbortSignal.any([ctl.signal, AbortSignal.timeout(opts.timeout || 10 * 60 * 1000)]) : ctl.signal;
  const tmp = `${dest}.part`;
  try {
    const res = await request(url, { signal });
    const total = Number(res.headers.get('content-length')) || 0;
    const algo = opts.sha512 ? 'sha512' : opts.sha256 ? 'sha256' : opts.sha1 ? 'sha1' : null;
    const hash = algo ? crypto.createHash(algo) : null;
    let received = 0;
    let lastAt = 0;
    const body = Readable.fromWeb(res.body);
    body.on('data', (chunk) => {
      arm();
      received += chunk.length;
      if (hash) hash.update(chunk);
      const now = Date.now();
      if (opts.onProgress && (now - lastAt > 120 || received === total)) {
        lastAt = now;
        opts.onProgress({ received, total });
      }
    });
    await pipeline(body, fs.createWriteStream(tmp));
    if (hash) {
      const digest = hash.digest('hex');
      const expected = String(opts[algo]).toLowerCase();
      if (digest !== expected) {
        fs.rmSync(tmp, { force: true });
        const err = new Error(`다운로드 파일 손상 (${path.basename(dest)} 해시 불일치) — 다시 시도`);
        err.hashMismatch = true;
        throw err;
      }
    }
    fs.renameSync(tmp, dest);
    if (opts.onProgress) opts.onProgress({ received, total: total || received });
    return dest;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (stalled) throw new Error(`다운로드가 ${Math.round(stallMs / 1000)}초 동안 멈춤 — ${new URL(url).host} 연결 확인 (${path.basename(dest)})`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function fileHash(file, algo) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

module.exports = { USER_AGENT, request, getJson, getText, download, fileHash };
