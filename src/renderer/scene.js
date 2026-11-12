'use strict';
/* 배경 — 흰 삼각 그리드 공간 (첨부된 white-grid 형식)
   - 바탕: 푸른 기가 아주 살짝 섞인 흰색 (어둡게: 부드러운 남색 검정)
   - 삼각 그리드: 선은 연하게, 꼭짓점의 X자만 진하게, 선 자체에 빛 번짐
   - 천천히 떠도는 빛 덩어리
   - 렌즈(배경에만): 맨 가장자리의 옅은 색수차 → 블러, 그 위로 전체 빛 번짐. 비네트·낟알은 화면 맨 위 렌즈 층
   - 마우스에 따라 배경만 아주 조금 기운다 (판과 글자는 그대로)
   로딩 화면(서버를 만들 때)만 캔버스에 그려 배경 위로 부드럽게 겹친다.
   창이 뒤로 가면 떠도는 빛을 멈춰 게임과 서버에 그래픽 자원을 양보한다. */
(function () {
  const root = document.documentElement;
  const SVG = 'http://www.w3.org/2000/svg';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ════════════ 배경 만들기 ════════════ */
  const DEFS = `
<svg class="bg-defs" width="0" height="0" aria-hidden="true" focusable="false">
  <defs>
    <filter id="lensCA" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
      <feOffset in="r" dx="-2" dy="0" result="r1" data-ca="r" />
      <feMerge result="r2"><feMergeNode in="r" /><feMergeNode in="r1" /></feMerge>
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
      <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
      <feOffset in="b" dx="2" dy="0" result="b1" data-ca="b" />
      <feMerge result="b2"><feMergeNode in="b" /><feMergeNode in="b1" /></feMerge>
      <feBlend in="r2" in2="g" mode="screen" result="rg" />
      <feBlend in="rg" in2="b2" mode="screen" result="split" />
      <feColorMatrix in="split" type="saturate" values="1.4" result="vivid" />
      <feComponentTransfer in="vivid">
        <feFuncR type="linear" slope="1.06" intercept="0.02" />
        <feFuncG type="linear" slope="1.06" intercept="0.02" />
        <feFuncB type="linear" slope="1.06" intercept="0.02" />
      </feComponentTransfer>
    </filter>
    <pattern id="tri" width="120" height="207.846" patternUnits="userSpaceOnUse">
      <path class="tri-line" d="M0 0H120M0 103.92H120M0 0L120 207.85M120 0L0 207.85" />
      <path class="tri-x" d="M-5.00 -8.66L5.00 8.66M5.00 -8.66L-5.00 8.66M115.00 -8.66L125.00 8.66M125.00 -8.66L115.00 8.66M55.00 95.26L65.00 112.58M65.00 95.26L55.00 112.58M-5.00 199.19L5.00 216.51M5.00 199.19L-5.00 216.51M115.00 199.19L125.00 216.51M125.00 199.19L115.00 216.51" />
    </pattern>
    <filter id="lineGlow" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="g1" />
      <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="g2" />
      <feMerge><feMergeNode in="g2" /><feMergeNode in="g1" /><feMergeNode in="SourceGraphic" /></feMerge>
    </filter>
  </defs>
</svg>`;
  const ca = {};
  function build() {
    document.body.insertAdjacentHTML('afterbegin', DEFS);
    for (const n of document.querySelectorAll('[data-ca]')) ca[n.getAttribute('data-ca')] = n;
    const world = document.querySelector('.world');
    world.innerHTML = `
      <div class="bg-paper"></div>
      <svg class="bg-grid" xmlns="${SVG}"><rect x="-120" y="-120" width="120%" height="120%" fill="url(#tri)" /></svg>
      <div class="bg-leak bg-leak-a"></div>
      <div class="bg-leak bg-leak-b"></div>
      <div class="bg-leak bg-leak-c"></div>`;
  }

  /* ════════════ 마우스 — 부드럽게 따라간다. 멈추면 계산도 멈춘다 ════════════ */
  const target = { x: 0, y: 0 };
  const cur = { x: 0, y: 0 };
  let moving = false;
  function follow() {
    cur.x += (target.x - cur.x) * 0.04;
    cur.y += (target.y - cur.y) * 0.04;
    const settled = Math.abs(target.x - cur.x) + Math.abs(target.y - cur.y) < 0.0005;
    if (settled) {
      cur.x = target.x;
      cur.y = target.y;
    }
    root.style.setProperty('--px', cur.x.toFixed(4));
    root.style.setProperty('--py', cur.y.toFixed(4));
    // 가장자리 색수차: 기운 쪽으로 더 벌어진다
    if (ca.r) {
      const amt = 2 + Math.abs(cur.x) * 0.8 + Math.abs(cur.y) * 0.4;
      ca.r.setAttribute('dx', (-amt - cur.x * 0.5).toFixed(2));
      ca.r.setAttribute('dy', (-cur.y * 0.5).toFixed(2));
      ca.b.setAttribute('dx', (amt - cur.x * 0.5).toFixed(2));
      ca.b.setAttribute('dy', (cur.y * 0.5).toFixed(2));
    }
    if (settled) moving = false;
    else requestAnimationFrame(follow);
  }
  const kick = () => {
    if (moving) return;
    moving = true;
    requestAnimationFrame(follow);
  };
  window.addEventListener('pointermove', (e) => {
    target.x = (e.clientX / innerWidth) * 2 - 1;
    target.y = (e.clientY / innerHeight) * 2 - 1;
    kick();
  });
  document.addEventListener('pointerleave', () => {
    target.x = 0;
    target.y = 0;
    kick();
  });

  /* ════════════ 창이 뒤로 가면 떠도는 빛을 멈춘다 ════════════ */
  const idle = () => root.classList.toggle('is-idle', document.hidden || !document.hasFocus());
  window.addEventListener('blur', idle);
  window.addEventListener('focus', idle);
  document.addEventListener('visibilitychange', idle);

  /* ════════════ 위쪽 머리글 — 왼쪽 로고, 오른쪽 앱 버전과 PC 사양 ════════════ */
  const head = { brand: null, band: null, brandKey: '', bandKey: '', brandInfo: null, bandInfo: null };
  function markEl(type) {
    const t = ['paper', 'forge', 'neoforge', 'fabric', 'vanilla', 'hybrid'].includes(type) ? type : 'paper';
    const quad = t === 'forge' || t === 'neoforge' || t === 'fabric';
    const core = quad ? '<span class="mark-core"><i></i><i></i><i></i><i></i></span>' : t === 'hybrid' ? '<span class="mark-core"><i></i><i></i><i></i></span>' : '<span class="mark-core"></span>';
    // 모드 서버(Forge · NeoForge · Fabric)는 모두 네 칸 모양
    return `<span class="mark mark-${quad ? 'fabric' : t} brand-mark" aria-hidden="true">${core}</span>`;
  }
  function buildHead() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    bar.innerHTML = '<div class="brand"></div><div class="band-info"><b class="band-code"></b><span class="band-right"></span></div>';
    head.brand = bar.querySelector('.brand');
    head.band = bar.querySelector('.band-info');
    // 머리글보다 먼저 들어온 문구가 있으면 지금 그린다
    if (head.brandInfo) window.Scene.setBrand(head.brandInfo);
    if (head.bandInfo) window.Scene.setBand(head.bandInfo);
  }
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /* ════════════ 로딩 화면 캔버스 ════════════ */
  const canvas = document.createElement('canvas');
  canvas.className = 'loader-cv';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  const REF_W = 2560;
  let W = 0;
  let H = 0;
  let k = 1;
  let D = 1;
  let dpr = 1;
  function resize() {
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    k = Math.max(0.6, Math.min(1, innerWidth / REF_W));
    D = dpr * k;
    W = innerWidth / k;
    H = innerHeight / k;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
  }
  const qcv = () => {
    const c = document.createElement('canvas');
    return { c, g: c.getContext('2d') };
  };
  const UI_FONT = '"Pretendard Variable", Pretendard, "Noto Sans CJK KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  const MONO_F = 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, "D2Coding", "DejaVu Sans Mono", monospace';

  /* ════════════ 로딩 화면 — 꺼진 패널 화면에 띄운다 ════════════
     (첨부된 천궁 로더를 SCRF 테마로 옮긴 것: 신성 기하학 고리 · 떠오르는 빛 알갱이 · 가로지르는 빛의 띠 ·
      파인 원판과 네 모서리 눈금 · 원 궤도 안의 삼각형 로고 · 상태 문구와 진행 막대)
     금색 선은 코발트로, 금색은 점과 짧은 표식에만. 바탕은 꺼진 화면색. */
  // 로딩 화면 색 — 밝게는 흰 화면, 어둡게는 꺼진 화면
  const LP_DARK = {
    bg: '#04060a', grid: 'rgba(120, 150, 180, 0.13)', scan: 'rgba(0, 0, 0, 0.22)', halo: [40, 70, 255, 0.2],
    geo: 'rgba(143, 168, 255, 0.9)', geoFaint: 'rgba(143, 168, 255, 0.4)', numeral: 'rgba(217, 228, 240, 0.7)', node: '#04060a',
    floor: [12, 16, 24], waveGlow: 'rgba(91, 120, 255, 0.8)', discA: '#161d2a', discB: '#0c1119', discLine: 'rgba(143, 168, 255, 0.18)',
    cap: 'rgba(170, 186, 204, 0.7)', status: '#e8eef8', statusGlow: 'rgba(120, 180, 255, 0.6)', task: 'rgba(170, 186, 204, 0.85)',
    rail: 'rgba(120, 150, 180, 0.22)', mote: '#f0d69a', gold: '#e2b45a', geoAlpha: 0.6,
  };
  const LP_LIGHT = {
    bg: null, grid: 'rgba(157, 176, 194, 0.3)', scan: 'rgba(27, 34, 48, 0.025)', halo: [31, 60, 255, 0.1],
    geo: 'rgba(31, 60, 255, 0.55)', geoFaint: 'rgba(31, 60, 255, 0.22)', numeral: 'rgba(27, 34, 48, 0.42)', node: '#f7fafe',
    floor: [243, 247, 252], waveGlow: 'rgba(31, 60, 255, 0.35)', discA: '#ffffff', discB: '#e6edf6', discLine: 'rgba(31, 60, 255, 0.16)',
    cap: '#6a7486', status: '#1b2230', statusGlow: 'rgba(0, 0, 0, 0)', task: '#4b5566',
    rail: 'rgba(27, 34, 48, 0.12)', mote: '#c49a3c', gold: '#c49a3c', geoAlpha: 0.75,
  };
  const LP = () => (root.dataset.theme === 'dark' ? LP_DARK : LP_LIGHT);
  const LD = { on: false, t0: 0, cap: '', status: '', task: '', taskAt: 0, target: 0, shown: 0, doneAt: 0 };
  const ease = (x) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const NUM = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
  const geoCv = qcv();
  const motes = (() => {
    let s0 = 7;
    const R = () => {
      s0 = (s0 * 16807) % 2147483647;
      return s0 / 2147483647;
    };
    const out = [];
    for (let z = 0; z < 34; z++) out.push({ x: R(), y: 0.3 + R() * 0.65, s: 1.5 + R() * 2.5, t: (7 + R() * 9) * 1000, dl: -R() * 12000 });
    return out;
  })();
  const polar = (r, deg) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [r * Math.cos(a), r * Math.sin(a)];
  };
  // 경로를 진행도만큼만 긋는다 (점 목록, 닫힘 여부)
  function partial(g, pts, p, closed) {
    const P2 = closed ? pts.concat([pts[0]]) : pts;
    let total = 0;
    for (let i = 1; i < P2.length; i++) total += Math.hypot(P2[i][0] - P2[i - 1][0], P2[i][1] - P2[i - 1][1]);
    let left = total * p;
    g.moveTo(P2[0][0], P2[0][1]);
    for (let i = 1; i < P2.length && left > 0; i++) {
      const seg = Math.hypot(P2[i][0] - P2[i - 1][0], P2[i][1] - P2[i - 1][1]);
      const f = Math.min(1, left / seg);
      g.lineTo(P2[i - 1][0] + (P2[i][0] - P2[i - 1][0]) * f, P2[i - 1][1] + (P2[i][1] - P2[i - 1][1]) * f);
      left -= seg;
    }
  }
  function drawGeo(t, cx, cy, alpha) {
    const u = 1 / k;
    const size = Math.min(1.5 * Math.min(innerWidth, innerHeight), 1320) * u; // 장면 좌표
    const s = size / 1000;
    const g = geoCv.g;
    if (geoCv.c.width !== canvas.width || geoCv.c.height !== canvas.height) {
      geoCv.c.width = canvas.width;
      geoCv.c.height = canvas.height;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, geoCv.c.width, geoCv.c.height);
    g.setTransform(D * s, 0, 0, D * s, D * cx, D * cy);
    g.lineWidth = u / s;
    const lp = LP();
    const main = lp.geo;
    const faint = lp.geoFaint;
    const pr = (gd) => ease((t - gd * 1000) / 2600);
    const ring = (r, gd, col, cxo = 0, cyo = 0) => {
      const p = pr(gd);
      if (p <= 0) return;
      g.beginPath();
      g.arc(cxo, cyo, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      g.strokeStyle = col;
      g.stroke();
    };
    // 바깥 고리 — 12궁 마디와 눈금
    ring(470, 0.1, main);
    ring(452, 0.25, faint);
    ring(372, 0.4, main);
    g.beginPath();
    for (let i = 0; i < 72; i++) {
      const p1 = polar(452, i * 5);
      const p2 = polar(i % 6 === 0 ? 432 : 442, i * 5);
      g.moveTo(p1[0], p1[1]);
      g.lineTo(p2[0], p2[1]);
    }
    g.strokeStyle = faint;
    g.stroke();
    g.font = `600 ${22}px ${MONO_F}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let j = 0; j < 12; j++) {
      const n = polar(470, j * 30 + 15);
      const tp = polar(408, j * 30 + 15);
      g.beginPath();
      g.arc(n[0], n[1], j % 3 === 0 ? 11 : 6, 0, Math.PI * 2);
      g.fillStyle = lp.node;
      g.fill();
      g.strokeStyle = j % 3 === 0 ? lp.gold : main;
      g.stroke();
      g.fillStyle = lp.numeral;
      g.fillText(NUM[j], tp[0], tp[1]);
    }
    // 안쪽 — 육각성, 생명의 씨앗, 살
    const triPts = (r, rot) => [0, 120, 240].map((d) => polar(r, d + rot));
    for (const [rot, gd] of [[0, 0.6], [180, 0.75]]) {
      const p = pr(gd);
      if (p <= 0) continue;
      g.beginPath();
      partial(g, triPts(372, rot), p, true);
      g.strokeStyle = main;
      g.stroke();
    }
    ring(220, 0.9, main);
    ring(110, 1, main);
    for (let q = 0; q < 6; q++) {
      const c = polar(110, q * 60);
      ring(110, 1.05 + q * 0.08, faint, c[0], c[1]);
    }
    g.beginPath();
    for (let m = 0; m < 12; m++) {
      const q1 = polar(220, m * 30);
      const q2 = polar(372, m * 30);
      g.moveTo(q1[0], q1[1]);
      g.lineTo(q2[0], q2[1]);
    }
    g.strokeStyle = faint;
    g.stroke();
    // 가운데만 보이게 — 바깥으로 갈수록 사라진다
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-in';
    const R0 = 0.269 * size * D;
    const R1 = 0.495 * size * D;
    const rg = g.createRadialGradient(D * cx, D * cy, R0, D * cx, D * cy, R1);
    rg.addColorStop(0, 'rgba(0,0,0,1)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, geoCv.c.width, geoCv.c.height);
    g.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = alpha * lp.geoAlpha;
    ctx.drawImage(geoCv.c, 0, 0);
    ctx.restore();
  }
  function strand(t, amp, phase, lift, top, h) {
    const pts = [];
    const N = 90;
    const mid = top + h / 2 + lift;
    for (let i = 0; i <= N; i++) {
      const uu = i / N;
      const y = mid + amp * Math.sin(uu * Math.PI * 2 * 0.9 + t * 0.0009 + phase) + amp * 0.42 * Math.sin(uu * Math.PI * 2 * 2.1 - t * 0.0013 + phase * 1.7) + amp * 0.16 * Math.sin(uu * Math.PI * 2 * 4.3 + t * 0.002);
      pts.push([uu * W, y]);
    }
    return pts;
  }
  function strokePts(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }
  function waveGrad(a) {
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, 'rgba(91, 120, 255, 0)');
    g.addColorStop(0.18, `rgba(91, 120, 255, ${a})`);
    g.addColorStop(0.5, `rgba(185, 193, 207, ${a})`);
    g.addColorStop(0.82, `rgba(226, 180, 90, ${a})`);
    g.addColorStop(1, 'rgba(226, 180, 90, 0)');
    return g;
  }
  // 표시 조각 — 120 칸 안, 가운데(60, 60), 궤도 반지름 40
  const sq = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const arcPts = (cx2, cy2, r, a0, a1) => {
    const out = [];
    for (let i = 0; i <= 16; i++) {
      const a = a0 + ((a1 - a0) * i) / 16;
      out.push([cx2 + r * Math.cos(a), cy2 + r * Math.sin(a)]);
    }
    return out;
  };
  function markPieces(type) {
    const cs = 56 * 0.62;
    const c0 = 60 - cs / 2;
    const gap = cs * 0.14;
    const half = (cs - gap) / 2;
    if (type === 'vanilla') return [{ circle: [60, 60, cs / 2] }];
    if (type === 'hybrid') return [{ rect: [c0, c0, half, cs] }, { rect: [c0 + half + gap, c0, half, half] }, { rect: [c0 + half + gap, c0 + half + gap, half, half] }];
    if (type === 'forge' || type === 'neoforge' || type === 'fabric' || type === 'mod') {
      return [[0, 0], [1, 0], [0, 1], [1, 1]].map(([i, j]) => ({ rect: [c0 + i * (half + gap), c0 + j * (half + gap), half, half] }));
    }
    return [{ rect: [c0, c0, cs, cs] }];
  }
  function drawLoader(now) {
    const u = 1 / k;
    const lp = LP();
    const t = now - LD.t0;
    const done = LD.doneAt ? now - LD.doneAt : -1;
    const inA = clamp01(t / 450);
    const outBg = done < 0 ? 1 : 1 - clamp01(done / 600);
    const outCopy = done < 0 ? 1 : 1 - clamp01(done / 400);
    const gone = done < 0 ? 0 : clamp01((done - 520) / 700);
    const cx = W / 2;
    const cy = H * 0.44;
    const panel = Math.min(240, innerWidth * 0.58) * u;
    // 진행 막대는 받은 진행을 따라가되 한 번에 뛰지 않는다. 진행 소식이 한동안 없으면 92%까지 아주 천천히 차오른다
    const dt = Math.min(80, now - (LD.lastFrame || now));
    LD.lastFrame = now;
    if (!LD.finishing && now - LD.lastEvt > 700 && LD.target < 92) LD.target = Math.min(92, LD.target + (dt * 0.0035 * (100 - LD.target)) / 10);
    const gap = LD.target - LD.shown;
    if (gap > 0) LD.shown += Math.min(gap, Math.max(gap * dt * 0.004, dt * 0.012), dt * 0.06);

    // 바탕: 가운데 빛, 신성 기하학, 떠오르는 빛 알갱이, 아래로 가라앉는 바닥
    const bgA = inA * outBg;
    if (bgA > 0) {
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, 0.42 * Math.max(W, H));
      const [hr, hg, hb, ha] = lp.halo;
      halo.addColorStop(0, `rgba(${hr}, ${hg}, ${hb}, ${ha * bgA})`);
      halo.addColorStop(1, `rgba(${hr}, ${hg}, ${hb}, 0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, W, H);
      drawGeo(t, cx, cy, bgA);
      ctx.save();
      ctx.shadowColor = 'rgba(226, 180, 90, 0.8)';
      ctx.shadowBlur = 6;
      for (const m of motes) {
        const ph = (((now + m.dl) % m.t) + m.t) % m.t / m.t;
        const a = ph < 0.15 ? (ph / 0.15) * 0.9 : ph < 0.7 ? 0.9 - ((ph - 0.15) / 0.55) * 0.4 : 0.5 * (1 - (ph - 0.7) / 0.3);
        ctx.globalAlpha = a * bgA;
        ctx.fillStyle = lp.mote;
        ctx.beginPath();
        ctx.arc(m.x * W, m.y * H - ph * 0.26 * H, (m.s * u) / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      const fl = ctx.createLinearGradient(0, H * 0.48, 0, H);
      fl.addColorStop(0, `rgba(${lp.floor.join(', ')}, 0)`);
      fl.addColorStop(0.62, `rgba(${lp.floor.join(', ')}, 1)`);
      ctx.fillStyle = fl;
      ctx.fillRect(0, H * 0.48, W, H * 0.52);
    }

    // 빛의 띠 — 화면을 가로지르는 두 가닥
    const waveA = clamp01((t - 350) / 1000) * outCopy;
    if (waveA > 0) {
      const wh = 0.4 * H;
      const amp = Math.min(wh * 0.1, 26 * u);
      const mainS = strand(now, amp, 0, 6 * u, cy - wh / 2, wh);
      ctx.save();
      ctx.globalAlpha = waveA;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      strokePts(strand(now * 0.8, amp * 0.8, 2.2, -10 * u, cy - wh / 2, wh));
      ctx.strokeStyle = waveGrad(0.45);
      ctx.lineWidth = 1.2 * u;
      ctx.stroke();
      strokePts(mainS);
      ctx.strokeStyle = waveGrad(0.12);
      ctx.lineWidth = 18 * u;
      ctx.stroke();
      strokePts(mainS);
      ctx.strokeStyle = waveGrad(0.95);
      ctx.lineWidth = 2.4 * u;
      ctx.shadowColor = lp.waveGlow;
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.restore();
    }

    // 파인 원판과 네 모서리 눈금
    const pA = ease((t - 200) / 900) * outCopy;
    if (pA > 0) {
      const sc = 0.94 + 0.06 * pA;
      const r = (panel / 2) * sc;
      ctx.save();
      ctx.globalAlpha = pA;
      const pg = ctx.createRadialGradient(cx, cy - r * 0.2, r * 0.2, cx, cy, r);
      pg.addColorStop(0, lp.discA);
      pg.addColorStop(1, lp.discB);
      ctx.fillStyle = pg;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = lp.discLine;
      ctx.lineWidth = u;
      ctx.stroke();
      ctx.fillStyle = lp.gold;
      ctx.shadowColor = 'rgba(226, 180, 90, 0.8)';
      ctx.shadowBlur = 6;
      const e = panel / 2 + 16 * u;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const bx = cx + sx * e - (sx < 0 ? 0 : 8 * u);
        const by = cy + sy * e - (sy < 0 ? 0 : 10 * u);
        ctx.fillRect(bx, by, 2 * u, 10 * u);
        ctx.fillRect(bx + 5 * u, by, 2 * u, 10 * u);
      }
      ctx.restore();
    }

    // 로고 — 원 궤도 안의 삼각형. 조각마다 글리치하며 그려진다
    const lt = t - 260;
    const logoA = 1 - gone;
    if (lt > 0 && logoA > 0) {
      const size = panel * 0.66;
      const s = size / 120;
      ctx.save();
      ctx.globalAlpha = logoA;
      ctx.translate(cx - size / 2, cy - size / 2 - gone * 8 * u);
      ctx.translate(size / 2, size / 2);
      ctx.scale(s * (1 - 0.06 * gone), s * (1 - 0.06 * gone));
      ctx.translate(-60, -60);
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(91, 120, 255, 0.9)';
      ctx.shadowBlur = 8;
      const op = ease((lt - 50) / 1200);
      if (op > 0) {
        ctx.beginPath();
        ctx.arc(60, 60, 47, -Math.PI / 2, -Math.PI / 2 + op * Math.PI * 2);
        ctx.strokeStyle = lp.gold;
        ctx.lineWidth = 2.8;
        ctx.shadowColor = 'rgba(226, 180, 90, 0.7)';
        ctx.stroke();
      }
      // MCES 표시 그대로 — 코발트 유리 네모가 들어서고, 안의 흰 종류 모양(플러그인 네모 · 모드 네 칸 · 바닐라 원 · 하이브리드)이 조각마다 글리치하며 켜진다
      const bp = ease((lt - 250) / 500);
      if (bp > 0) {
        ctx.save();
        ctx.globalAlpha = logoA * bp;
        ctx.translate(60, 60);
        ctx.scale(0.9 + 0.1 * bp, 0.9 + 0.1 * bp);
        ctx.translate(-60, -60);
        ctx.shadowColor = 'rgba(77, 107, 255, 0.6)';
        ctx.shadowBlur = 14;
        const gg = ctx.createLinearGradient(32, 32, 88, 88);
        gg.addColorStop(0, '#1530e6');
        gg.addColorStop(0.42, '#2a4dff');
        gg.addColorStop(0.7, '#5b78ff');
        gg.addColorStop(1, '#8f98ad');
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.roundRect(32, 32, 56, 56, 4);
        ctx.fill();
        ctx.shadowBlur = 0;
        // 유리 조각 한 줄기
        ctx.globalAlpha = logoA * bp * 0.35;
        ctx.fillStyle = '#d6e2f0';
        ctx.beginPath();
        ctx.moveTo(66, 32);
        ctx.lineTo(72, 32);
        ctx.lineTo(56, 88);
        ctx.lineTo(50, 88);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      markPieces(LD.mark).forEach((pc, i) => {
        const st = lt - (650 + i * 260);
        if (st <= 0) return;
        const gp = st / 550;
        const jx = gp < 0.12 ? -4 : gp < 0.24 ? 3 : gp < 0.36 ? -2 : 0;
        const ga = gp < 0.12 ? 0.25 : gp < 0.24 ? 1 : gp < 0.36 ? 0.35 : gp < 0.58 ? 1 : gp < 0.66 ? 0.55 : 1;
        ctx.save();
        ctx.globalAlpha = logoA * ga;
        ctx.translate(jx, 0);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        if (pc.circle) ctx.arc(pc.circle[0], pc.circle[1], pc.circle[2], 0, Math.PI * 2);
        else ctx.roundRect(pc.rect[0], pc.rect[1], pc.rect[2], pc.rect[3], 1);
        ctx.fill();
        ctx.restore();
      });
      ctx.restore();
    }

    // 문구 — 캡션, 상태와 점, 지금 하는 일, 진행 막대
    const cA = ease((t - 450) / 600) * outCopy;
    if (cA > 0) {
      const top = cy + panel / 2 + (38 + 6 * (1 - cA)) * u;
      ctx.save();
      ctx.globalAlpha = cA;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const set = (w, sz, f) => {
        ctx.font = `${w} ${sz * u}px ${f}`;
      };
      set(400, 11, MONO_F);
      try {
        ctx.letterSpacing = `${4.6 * u}px`;
      } catch {
        /* 오래된 엔진 */
      }
      ctx.fillStyle = lp.cap;
      ctx.fillText(LD.cap, cx, top);
      try {
        ctx.letterSpacing = '0px';
      } catch {
        /* 오래된 엔진 */
      }
      set(600, 17, UI_FONT);
      ctx.fillStyle = lp.status;
      ctx.shadowColor = lp.statusGlow;
      ctx.shadowBlur = 8;
      const dots = '.'.repeat((Math.floor(now / 420) % 3) + 1);
      const sw = ctx.measureText(LD.status).width;
      ctx.fillText(LD.status, cx, top + 30 * u);
      ctx.textAlign = 'left';
      ctx.fillText(dots, cx + sw / 2 + 2 * u, top + 30 * u);
      ctx.shadowBlur = 0;
      // 지금 하는 일 — 바뀔 때 아래에서 살짝 올라온다
      const sa = ease((now - LD.taskAt) / 320);
      set(400, 12, UI_FONT);
      ctx.textAlign = 'center';
      const tw = ctx.measureText(LD.task).width;
      const ty = top + (58 + 4 * (1 - sa)) * u;
      ctx.globalAlpha = cA * sa;
      ctx.fillStyle = lp.task;
      ctx.fillText(LD.task, cx + 11 * u, ty);
      ctx.save();
      ctx.translate(cx - tw / 2 - 9 * u, ty);
      ctx.rotate(Math.PI / 4);
      ctx.strokeStyle = lp.gold;
      ctx.lineWidth = 1.2 * u;
      ctx.strokeRect(-4.5 * u, -4.5 * u, 9 * u, 9 * u);
      ctx.restore();
      ctx.globalAlpha = cA;
      // 진행 막대 — 3px, 숫자 없이
      const rw = Math.min(220, innerWidth * 0.52) * u;
      const ry = top + 84 * u;
      const rx = cx - rw / 2;
      ctx.fillStyle = lp.rail;
      ctx.fillRect(rx, ry - 1.5 * u, rw, 3 * u);
      const fg = ctx.createLinearGradient(rx, 0, rx + rw, 0);
      fg.addColorStop(0, '#2a4dff');
      fg.addColorStop(1, '#8fa8ff');
      ctx.fillStyle = fg;
      ctx.fillRect(rx, ry - 1.5 * u, (rw * LD.shown) / 100, 3 * u);
      ctx.restore();
    }
  }

  /* ════════════ 로딩 화면 그리기 — 켜져 있는 동안만 ════════════ */
  let ldLoop = false;
  function ldFrame(now) {
    if (!LD.on) {
      ldLoop = false;
      return;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(D, 0, 0, D, 0, 0);
    // 배경 그리드를 옅게 덮는 바탕 (로딩 화면이 잘 보이게)
    const cs = getComputedStyle(root);
    ctx.fillStyle = cs.getPropertyValue('--bg-white').trim() || '#fbfdff';
    ctx.globalAlpha = 0.82;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    drawLoader(now);
    requestAnimationFrame(ldFrame);
  }
  function startLoaderLoop() {
    if (ldLoop) return;
    ldLoop = true;
    requestAnimationFrame(ldFrame);
  }

  /* ════════════ 낟알: 작은 노이즈 그림을 한 번 만들어 깔아 둔다 ════════════ */
  function grain(el) {
    const n = document.createElement('canvas');
    n.width = n.height = 160;
    const g = n.getContext('2d');
    const img = g.createImageData(160, 160);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = 0;
      d[i + 3] = Math.random() * 150;
    }
    g.putImageData(img, 0, 0);
    el.style.backgroundImage = `url(${n.toDataURL()})`;
  }

  function mount() {
    build();
    buildHead();
    document.querySelector('.stage').after(canvas);
    const gr = document.querySelector('.grain');
    if (gr) grain(gr);
    resize();
    window.addEventListener('resize', resize);
    idle();
  }

  window.Scene = {
    /** 왼쪽 위 로고: { type, device } */
    setBrand(info) {
      head.brandInfo = info;
      const key = JSON.stringify(info);
      if (!head.brand || key === head.brandKey) return;
      head.brandKey = key;
      head.brand.innerHTML = `${markEl(info.type)}<span class="brand-text"><b class="brand-word">MCES</b><span class="brand-sub">SERVER TERMINAL${info.device ? ` · ${esc(info.device)}` : ''}</span></span>`;
    },
    /** 오른쪽 위 문구: { code, right } */
    setBand(info) {
      head.bandInfo = info;
      const key = JSON.stringify(info);
      if (!head.band || key === head.bandKey) return;
      head.bandKey = key;
      head.band.querySelector('.band-code').textContent = info.code || '';
      head.band.querySelector('.band-right').textContent = info.right || '';
    },
    /** 처음 켤 때: 배경이 떠오른다. UI를 띄울 때가 되면 끝난다 */
    async boot() {
      void document.body.offsetWidth;
      root.classList.add('bg-on');
      await wait(500);
    },
    /** 종료 — 화면이 천천히 어두워진다 */
    async shutdown() {
      root.classList.add('is-shutdown');
      await wait(900);
    },
    /** 로딩 화면을 배경 위로 부드럽게 띄운다. 다 뜨면 로딩 화면 조작 손잡이를 돌려준다 */
    async toLoader(opts) {
      const handle = this.loader(opts);
      canvas.classList.add('is-on');
      await wait(450);
      return handle;
    },
    /** 로딩 화면을 걷는다 */
    async fromLoader() {
      canvas.classList.remove('is-on');
      await wait(450);
      LD.on = false;
    },
    /** 로딩 화면 상태 */
    loader(opts) {
      Object.assign(LD, { on: true, t0: performance.now(), cap: opts.cap || 'MCES', status: opts.status || '불러오는 중', task: opts.task || '', taskAt: performance.now(), target: 0, shown: 0, doneAt: 0, mark: opts.mark || 'paper', lastEvt: performance.now(), finishing: false, lastFrame: 0 });
      startLoaderLoop();
      return {
        progress(frac, task) {
          LD.lastEvt = performance.now();
          if (typeof frac === 'number') LD.target = Math.max(LD.target, Math.max(0, Math.min(1, frac)) * 100);
          if (task && task !== LD.task) {
            LD.task = task;
            LD.taskAt = performance.now();
          }
        },
        status(text) {
          LD.status = text;
        },
        /** 로고만 남기고 빠진 뒤 로고도 사라진다 */
        async finish() {
          LD.target = 100;
          LD.finishing = true;
          // 막대가 끝까지 차오른 뒤에 끝낸다
          for (let i = 0; i < 80 && LD.shown < 99.5; i++) await wait(50);
          await wait(260);
          LD.doneAt = performance.now();
          await wait(1250);
        },
      };
    },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
