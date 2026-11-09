'use strict';
// 서버가 화면(접속하는 쪽) 전용 코드를 찾다 멈췄을 때, 그 코드를 부른 모드 파일을 찾는다.
//   예) Sodium(NeoForge)은 jar 안에 묶인 시작 전 점검 코드가 서버에서도 먼저 돌며 org.lwjgl.Version 을 찾다 멈춘다.
// 1) 오류 줄의 호출 위치(at …)에서 로더·마인크래프트가 아닌 첫 클래스를 담은 jar
// 2) 없으면 빠진 클래스 이름을 안에 적어 둔 jar (jar 안에 묶인 jar 까지)
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');

/** 서버에는 없는 화면 쪽 코드 */
const CLIENT_CLASS = /^(?:org\.lwjgl|net\.minecraft\.client|com\.mojang\.blaze3d)\./;
/** 원인으로 보지 않는 곳 (자바 · 로더 · 마인크래프트 · 흔한 라이브러리) */
const FRAMEWORK = /^(?:java|javax|jdk|sun|com\.sun|cpw\.mods|net\.neoforged|net\.minecraftforge|net\.minecraft|com\.mojang|org\.spongepowered|org\.objectweb|net\.fabricmc|org\.quiltmc|org\.lwjgl|org\.apache|com\.google|io\.netty|org\.slf4j|joptsimple|it\.unimi|kotlin|kotlinx|scala|org\.jetbrains|com\.electronwill|net\.jodah|org\.openjdk)\./;

/** 오류 줄에서 서버에 없는 화면 쪽 클래스 이름 */
function missingClientClass(lines) {
  for (const l of lines) {
    let m = /(?:ClassNotFoundException|NoClassDefFoundError):\s*([\w$./]+)/.exec(l);
    if (m) {
      const c = m[1].replace(/\//g, '.');
      if (CLIENT_CLASS.test(c)) return c;
    }
    m = /Attempted to load class ([\w$./]+) for invalid dist/i.exec(l);
    if (m) return m[1].replace(/\//g, '.');
  }
  return null;
}

/** 호출 위치 줄(at …)의 클래스들 — 로더·마인크래프트는 뺀다. "at MC-BOOTSTRAP/모듈@1.0/a.b.C.m(…)" 꼴도 읽는다 */
function frameClasses(lines) {
  const out = [];
  for (const l of lines) {
    const m = /^\s*at\s+(?:[^\s(]*\/)?([\w$.]+)\.[\w$<>]+\(/.exec(l);
    if (!m || FRAMEWORK.test(`${m[1]}.`) || out.includes(m[1])) continue;
    out.push(m[1]);
  }
  return out;
}

function openZip(src) {
  return new Promise((resolve, reject) => {
    const cb = (err, zip) => (err ? reject(err) : resolve(zip));
    if (Buffer.isBuffer(src)) yauzl.fromBuffer(src, { lazyEntries: true }, cb);
    else yauzl.open(src, { lazyEntries: true, autoClose: true }, cb);
  });
}
function readEntry(zip, entry) {
  return new Promise((resolve, reject) =>
    zip.openReadStream(entry, (err, s) => {
      if (err) return reject(err);
      const chunks = [];
      s.on('data', (c) => chunks.push(c));
      s.on('end', () => resolve(Buffer.concat(chunks)));
      s.on('error', reject);
    }),
  );
}

/**
 * jar 의 항목을 하나씩 본다. nested 면 안에 묶인 jar 도. visit(name, read) 가 true 를 돌려주면 그만 본다.
 * @returns {Promise<boolean>} 찾았는지
 */
async function walkJar(src, visit, nested = false, depth = 0) {
  const zip = await openZip(src);
  return new Promise((resolve, reject) => {
    let found = false;
    zip.on('entry', async (e) => {
      try {
        if (e.fileName.endsWith('.jar')) {
          if (nested && depth < 2 && (await walkJar(await readEntry(zip, e), visit, nested, depth + 1))) found = true;
        } else if (await visit(e.fileName, () => readEntry(zip, e))) found = true;
      } catch {
        /* 깨진 항목은 건너뛴다 */
      }
      if (found) {
        zip.close();
        resolve(true);
      } else zip.readEntry();
    });
    zip.on('end', () => resolve(found));
    zip.on('error', reject);
    zip.readEntry();
  });
}

/** jar 마다 test 를 몇 개씩 동시에 돌려 true 인 jar 이름들. enough 개를 찾거나 늦으면 그만 */
async function pick(jars, modsDir, test, { limit = 4, enough = 1, late = () => false } = {}) {
  const hits = [];
  let next = 0;
  const worker = async () => {
    while (next < jars.length && hits.length < enough && !late()) {
      const f = jars[next++];
      try {
        if (await test(path.join(modsDir, f))) hits.push(f);
      } catch {
        /* 열리지 않는 jar */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jars.length) }, worker));
  return late() ? null : hits;
}

const jarsIn = (modsDir) => {
  try {
    return fs.readdirSync(modsDir).filter((f) => /\.jar$/i.test(f)).sort();
  } catch {
    return [];
  }
};

/**
 * 원인 모드 찾기
 * @param {string[]} lines 이번 실행의 콘솔 줄
 * @param {string} modsDir 서버의 mods 폴더
 * @param {{deadline?: number}} [opt] 이 시각(ms)이 지나면 그만 찾는다
 * @returns {Promise<null|{file:string, missing:string, how:'frame'|'reference'}>}
 */
async function findClientOnlyCause(lines, modsDir, opt = {}) {
  const missing = missingClientClass(lines);
  if (!missing) return null;
  const jars = jarsIn(modsDir);
  const late = () => !!opt.deadline && Date.now() > opt.deadline;

  // 1) 호출 위치의 클래스 파일을 담은 jar — 겉 jar 의 목록만 먼저(빠르다), 없으면 안에 묶인 jar 까지
  const frames = new Set(frameClasses(lines).map((c) => `${c.replace(/\./g, '/')}.class`));
  if (frames.size) {
    for (const nested of [false, true]) {
      const hits = await pick(jars, modsDir, (file) => walkJar(file, (name) => frames.has(name), nested), { limit: nested ? 4 : 8, late });
      if (!hits) return null;
      if (hits.length) return { file: hits[0], missing, how: 'frame' };
    }
  }
  // 2) 빠진 클래스 이름을 안에 적어 둔 jar — 딱 하나일 때만 (여럿이면 어느 것인지 알 수 없다)
  const needles = [Buffer.from(missing.replace(/\./g, '/')), Buffer.from(missing)];
  const refers = (file) =>
    walkJar(
      file,
      async (name, read) => {
        if (!name.endsWith('.class')) return false;
        const buf = await read();
        return needles.some((n) => buf.includes(n));
      },
      true,
    );
  const hits = await pick(jars, modsDir, refers, { limit: 4, enough: 2, late });
  return hits && hits.length === 1 ? { file: hits[0], missing, how: 'reference' } : null;
}

module.exports = { findClientOnlyCause, missingClientClass, frameClasses };
