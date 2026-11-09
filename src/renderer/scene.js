'use strict';
/* 배경 장면 — SCRF 메인 시스템 시작 화면(PR-SCRF start.js)의 렌더러를 그대로 옮긴 것
   - 삼각 그리드, 칸 하나 = 삼각기둥 (켜짐 +44 / 대기 / 꺼짐 −28), 옆면·그림자·구멍 그늘
   - 투영: 높이 z인 점은 가운데에서 z·0.0022 퍼지고 위로 z·0.36 들린다. 마우스에 따라 방향이 살짝 바뀐다
   - 공간에 새긴 UI: 위쪽 꺼진 띠의 바닥면에 단말 문구를 곡면으로 붙인다
   - 빛 번짐(1/4 크기에서 흐려 반쯤 겹침), 화면 가장자리 렌즈(R·G·B를 서로 다른 배율로 벌리는 색수차 + 블러)
   구동(로딩) 연출은 아직 넣지 않는다 — 처음부터 다 켜진 화면.
   바뀐 게 있을 때(마우스 이동, 창 크기, 테마, 띠 문구)만 다시 그린다. */
(function () {
  const root = document.documentElement;

  /* ════════════ 마우스 — 틸트 감도는 낮게, 천천히 따라간다 ════════════ */
  const target = { x: 0, y: 0 };
  const cur = { x: 0, y: 0 };
  window.addEventListener('pointermove', (e) => {
    target.x = (e.clientX / innerWidth) * 2 - 1;
    target.y = (e.clientY / innerHeight) * 2 - 1;
  });
  document.addEventListener('pointerleave', () => {
    target.x = 0;
    target.y = 0;
  });

  /* ════════════ 그리드 ════════════
     정삼각형 한 변 S, 행 높이 TH. 화면 가운데에 꼭짓점 하나.
     타일 d(r,k): 아래를 향한 삼각형 / u(r,k): 위를 향한 삼각형 */
  const S = 120;
  const TH = (S * Math.sqrt(3)) / 2;
  const R3 = Math.sqrt(3);
  const canvas = document.createElement('canvas');
  canvas.className = 'tiles';
  const ctx = canvas.getContext('2d', { alpha: false });
  /* 장면은 기준 화면(가로 2560) 크기로 그린 뒤 창에 맞게 줄인다 — 창이 작아도 같은 구도가 나오도록.
     W·H는 장면 좌표(줄이기 전), D는 장면 좌표 → 캔버스 픽셀 배율 */
  const REF_W = 2560;
  let W = 0;
  let H = 0;
  let x0 = 0;
  let y0 = 0;
  let dpr = 1;
  let k = 1;
  let D = 1;

  function resize() {
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    k = Math.max(0.6, Math.min(1, innerWidth / REF_W));
    D = dpr * k;
    W = innerWidth / k;
    H = innerHeight / k;
    canvas.width = Math.round(innerWidth * dpr);
    canvas.height = Math.round(innerHeight * dpr);
    x0 = W / 2;
    y0 = H / 2;
  }

  const mod2 = (n) => ((n % 2) + 2) % 2;
  const ox = (r) => (mod2(r) ? S / 2 : 0);
  function tri(r, k, t) {
    const yt = y0 + r * TH;
    const yb = yt + TH;
    const o = x0 + ox(r);
    if (t === 'd') return [[o + k * S, yt], [o + (k + 1) * S, yt], [o + S / 2 + k * S, yb]];
    return [[o + S / 2 + (k - 1) * S, yb], [o + S / 2 + k * S, yb], [o + k * S, yt]];
  }
  function inside(p, a, b, c) {
    const s = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
    const d1 = s(p, a, b);
    const d2 = s(p, b, c);
    const d3 = s(p, c, a);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  }
  function tileAt(x, y) {
    const r = Math.floor((y - y0) / TH);
    const kk = Math.floor((x - x0 - ox(r)) / S);
    for (let k = kk - 1; k <= kk + 1; k++) {
      for (const t of ['d', 'u']) {
        const T = tri(r, k, t);
        if (inside([x, y], T[0], T[1], T[2])) return { r, k, t, key: `${r},${k},${t}` };
      }
    }
    return null;
  }
  // 반 칸 단위 열 c → 타일
  function fromC(r, c) {
    const d = c - mod2(r);
    return mod2(d) === 0 ? { k: d / 2, t: 'u' } : { k: (d - 1) / 2, t: 'd' };
  }

  /* ════════════ 타일 상태 ════════════ */
  const ON = 44;
  const OFF = -28;
  let tiles = {};

  /* ════════════ MCES 배치 ════════════
     화면 모서리 기준(창 크기가 달라도 같은 모양). 줄은 맨 윗줄(T)·맨 아랫줄(B)에서, 열은 왼쪽(L)·오른쪽(R) 끝에서 반 칸 단위로 센다.
     - 둘째 줄: 왼쪽 끝 몇 칸을 뺀 나머지가 길게 꺼진 띠 — 이 바닥면에 단말 문구를 새긴다
     - 왼쪽 위: 띠 왼쪽 끝에서 아래로 내려오는 켜진 계단 (로고가 이 위에 선다)
     - 오른쪽: 띠 오른쪽 끝에서 오른쪽 아래로 내려가는 켜진 사선, 맨 윗줄 가운데쯤 켜진 조각
     - 왼쪽 아래 켜진 사선 묶음, 오른쪽 아래 작은 켜진 조각 둘 */
  const SCALE = 1.04; // .world 의 scale 과 같게
  const BAND_FROM_LEFT = 7;
  // 묶음: 줄 기준(T/B) · 열 기준(L/R) · 짝(par) · [줄 차이, 열 시작, 열 끝(null = 오른쪽 끝까지), 상태]
  // 묶음을 옮길 때 삼각형 방향이 뒤집히지 않도록, 기준 칸 (줄 + 열)의 짝이 par 와 다르면 열을 한 칸 민다.
  const LAYOUT = [
    { row: 'T', side: 'L', par: 1, cells: [
      [1, BAND_FROM_LEFT, null, -1], // 꺼진 띠 (오른쪽 끝까지)
      [1, -3, BAND_FROM_LEFT - 1, 1], // 띠 왼쪽 — 켜진 계단
      [2, -3, BAND_FROM_LEFT - 1, 1],
      [3, -3, BAND_FROM_LEFT - 2, 1],
    ] },
    { row: 'T', side: 'R', par: 0, cells: [
      [1, -2, 3, 1], // 띠 오른쪽 끝
      [2, -5, -2, 1], // 오른쪽 아래로 내려가는 사선
      [3, -4, -1, 1],
      [0, -14, -12, 1], // 맨 윗줄 가운데쯤 조각
    ] },
    { row: 'B', side: 'L', par: 0, cells: [
      [-2, -3, 4, 1], // 왼쪽 아래 사선 묶음
      [-1, -3, 5, 1],
      [0, -3, 6, 1],
    ] },
    { row: 'B', side: 'R', par: 1, cells: [
      [-2, -4, 3, 1], // 오른쪽 아래 조각
      [0, -4, -3, 1],
    ] },
  ];
  let rows = { top: 0, bottom: 0 };
  let cols = { left: 0, right: 0 };
  let bandLeft = 0;
  let bandRight = 0;
  function layout() {
    const xl = W / 2 - W / 2 / SCALE;
    const xr = W / 2 + W / 2 / SCALE;
    const yt = H / 2 - H / 2 / SCALE;
    const yb = H / 2 + H / 2 / SCALE;
    rows = { top: Math.floor((yt - y0) / TH), bottom: Math.floor((yb - y0) / TH) };
    // 맨 윗줄·맨 아랫줄이 절반도 안 보이면 한 줄 안쪽을 기준으로 삼는다
    if (y0 + (rows.top + 1) * TH - yt < TH * 0.5) rows.top += 1;
    if (yb - (y0 + rows.bottom * TH) < TH * 0.5) rows.bottom -= 1;
    cols = { left: Math.floor((xl - x0) / (S / 2)), right: Math.floor((xr - x0) / (S / 2)) };
    // 띠의 왼쪽·오른쪽 끝 (글자 자리를 정할 때 쓴다)
    bandLeft = cols.left + (mod2(rows.top + cols.left) !== 1 ? -1 : 0) + BAND_FROM_LEFT;
    bandRight = cols.right + (mod2(rows.top + cols.right) !== 0 ? 1 : 0) + LAYOUT[1].cells[0][1];
    tiles = layoutMap(curLayout);
  }

  /* 서버 페이지 배치 — 위쪽 띠와 왼쪽 계단(로고 자리)은 그대로 두고, 나머지는 서버마다 다르게(서버 id로 정한 난수).
     켜짐·꺼짐 칸은 육각형(꼭짓점 하나를 둘러싼 6칸) 단위로만 놓는다. 육각형끼리 변으로 붙인 덩어리는 바깥 모서리가
     120°·240°뿐이라 외톨이 삼각형이나 톱니 같은 뾰족한 모양이 생기지 않는다.
     육각형 중심은 ((h + 3r) / 2) mod 3 = 0 인 꼭짓점 (h: 반 칸 단위 가로 자리) — 모든 칸이 정확히 한 육각형에 속한다. */
  const HEX_NB = [[3, 1], [-3, -1], [0, 2], [0, -2], [-3, 1], [3, -1]];
  function seeded(str) {
    let h = 2166136261;
    for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return () => {
      h = Math.imul(h ^ (h >>> 15), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return ((h ^= h >>> 16) >>> 0) / 4294967296;
    };
  }
  const hexCells = (hc, rc) => [rc - 1, rc].flatMap((r) => [hc - 1, hc, hc + 1].map((c) => [r, c]));
  function randomHexes(out, seed) {
    const rnd = seeded(seed || 'server');
    const keyOf = (r, c) => {
      const f = fromC(r, c);
      return `${r},${f.k},${f.t}`;
    };
    const hMin = cols.left - 2;
    const hMax = cols.right + 2;
    const rMin = rows.top + 3;
    const rMax = rows.bottom + 1;
    const centers = [];
    for (let rc = rMin; rc <= rMax; rc++) {
      for (let hc = hMin; hc <= hMax; hc++) if (mod2(hc - rc) === 0 && ((((hc + 3 * rc) / 2) % 3) + 3) % 3 === 0) centers.push([hc, rc]);
    }
    const used = new Set();
    const id = (h, r) => `${h},${r}`;
    // 이미 다른 칸(띠·계단)이 있거나 위쪽 띠에 닿는 육각형은 쓰지 않는다
    const free = (h, r) => r >= rMin && r <= rMax && h >= hMin && h <= hMax && !used.has(id(h, r)) && hexCells(h, r).every(([rr, cc]) => !out[keyOf(rr, cc)]);
    const near = (h, r) => HEX_NB.some(([dh, dr]) => used.has(id(h + dh, r + dr)));
    const blobs = 5 + Math.floor(rnd() * 3);
    for (let n = 0, tries = 0; n < blobs && tries < 200; tries++) {
      const [h0, r0] = centers[Math.floor(rnd() * centers.length)] || [];
      if (h0 === undefined || !free(h0, r0) || near(h0, r0)) continue;
      const st = rnd() < 0.55 ? 1 : -1;
      const blob = [[h0, r0]];
      used.add(id(h0, r0));
      const size = 1 + Math.floor(rnd() * 4);
      for (let g = 0; g < size * 4 && blob.length < size; g++) {
        const [bh, br] = blob[Math.floor(rnd() * blob.length)];
        const [dh, dr] = HEX_NB[Math.floor(rnd() * 6)];
        const nh = bh + dh;
        const nr = br + dr;
        // 다른 덩어리와는 붙지 않게
        if (!free(nh, nr) || HEX_NB.some(([ah, ar]) => used.has(id(nh + ah, nr + ar)) && !blob.some(([x, y]) => x === nh + ah && y === nr + ar))) continue;
        blob.push([nh, nr]);
        used.add(id(nh, nr));
      }
      for (const [hh, rr] of blob) {
        for (const [r, c] of hexCells(hh, rr)) {
          const f = fromC(r, c);
          out[`${r},${f.k},${f.t}`] = { r, k: f.k, t: f.t, z: st > 0 ? ON : OFF };
        }
      }
      n++;
    }
  }
  let curLayout = 'home';
  let curSeed = '';
  function layoutMap(name) {
    const out = {};
    const put = (r, c, st) => {
      const f = fromC(r, c);
      out[`${r},${f.k},${f.t}`] = { r, k: f.k, t: f.t, z: st > 0 ? ON : OFF };
    };
    const groups = name === 'server' ? LAYOUT.slice(0, 1) : LAYOUT;
    for (const grp of groups) {
      const rA = grp.row === 'T' ? rows.top : rows.bottom;
      let cA = grp.side === 'L' ? cols.left : cols.right;
      if (mod2(rA + cA) !== grp.par) cA += grp.side === 'L' ? -1 : 1;
      for (const [dr, c0, c1, st] of grp.cells) {
        const r = rA + dr;
        const to = c1 === null ? cols.right + 3 : cA + c1;
        for (let c = cA + c0; c <= to; c++) put(r, c, st);
      }
    }
    if (name === 'server') randomHexes(out, curSeed);
    return out;
  }

  /* ════════════ 투영 ════════════ */
  const KP = 0.0022;
  function project(p, z) {
    const cx = W / 2;
    const cy = H / 2;
    const f = 1 + z * KP;
    const oxp = -0.06 - cur.x * 0.06;
    const oyp = -0.36 - cur.y * 0.06;
    return [cx + (p[0] - cx) * f + z * oxp, cy + (p[1] - cy) * f + z * oyp];
  }
  // 화면 좌표 → 장면(.world scale) 바깥에서 본 좌표
  const toScreen = (p) => [innerWidth / 2 + (p[0] * k - innerWidth / 2) * SCALE, innerHeight / 2 + (p[1] * k - innerHeight / 2) * SCALE];

  /* ════════════ 색 — 테마 토큰에서 읽는다. 빛은 위에서(살짝 왼쪽) ════════════ */
  let P = {};
  function readPalette() {
    const cs = getComputedStyle(root);
    const v = (n) => cs.getPropertyValue(n).trim();
    const nums = (n) => v(n).split(',').map(Number);
    P = {
      paper: [v('--paper-top'), v('--paper-mid'), v('--paper-bottom')],
      floor: v('--tile-floor'),
      wallDark: nums('--tile-wall-dark'),
      wallLit: nums('--tile-wall-lit'),
      topA: v('--tile-top-a'),
      topB: v('--tile-top-b'),
      grid: v('--grid-line'),
      edge: v('--tile-edge'),
      wallLine: v('--tile-wall-line'),
      lip: v('--tile-edge-lit'),
      xGlow: v('--grid-x-glow'),
      x: v('--grid-x'),
      shadow: v('--tile-shadow'),
      holeShade: v('--tile-hole-shade'),
      tick: v('--tile-tick'),
      ink: v('--ink'),
      ink2: v('--ink-2'),
      faint: v('--faint'),
      accent: v('--accent'),
      gold: v('--gold'),
      bad: v('--bad'),
      chip: v('--band-chip'),
    };
    _pg = null;
  }
  const LIGHT = [-0.26, -0.966];
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  function wallColor(n) {
    const k = n[0] * LIGHT[0] + n[1] * LIGHT[1]; // -1 아래를 봄 ~ 1 위를 봄
    return rgb(mix(P.wallDark, P.wallLit, (k + 1) / 2));
  }
  function outward(a, b, cen) {
    let nx = b[1] - a[1];
    let ny = -(b[0] - a[0]);
    const L = Math.hypot(nx, ny);
    nx /= L;
    ny /= L;
    const mx = (a[0] + b[0]) / 2 - cen[0];
    const my = (a[1] + b[1]) / 2 - cen[1];
    if (nx * mx + ny * my < 0) {
      nx = -nx;
      ny = -ny;
    }
    return [nx, ny];
  }
  function poly(pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }
  const centroid = (T) => [(T[0][0] + T[1][0] + T[2][0]) / 3, (T[0][1] + T[1][1] + T[2][1]) / 3];

  /* ════════════ 삼각기둥 ════════════
     옆면은 이웃 타일과 높이가 다른 변에만 생기고, 높이 차이만큼만 보인다. */
  function neighbors(tile) {
    if (tile.nb) return tile.nb;
    const T = tri(tile.r, tile.k, tile.t);
    const cen = centroid(T);
    tile.nb = [0, 1, 2].map((i) => {
      const a = T[i];
      const b = T[(i + 1) % 3];
      const n = outward(a, b, cen);
      const info = tileAt((a[0] + b[0]) / 2 + n[0] * 6, (a[1] + b[1]) / 2 + n[1] * 6);
      return info ? info.key : null;
    });
    return tile.nb;
  }
  const zOf = (key) => (key && tiles[key] ? tiles[key].z : 0);

  function collectWalls(list) {
    const walls = [];
    for (const tile of list) {
      const T = (tile.T = tri(tile.r, tile.k, tile.t));
      const cen = centroid(T);
      const nb = neighbors(tile);
      tile.edgeLow = [];
      tile.edgeHigh = [];
      for (let i = 0; i < 3; i++) {
        const a = T[i];
        const b = T[(i + 1) % 3];
        const n = outward(a, b, cen);
        const zb = zOf(nb[i]);
        const za = tile.z;
        const other = nb[i] && tiles[nb[i]];
        tile.edgeLow[i] = zb < za - 0.01;
        tile.edgeHigh[i] = zb > za + 0.01;
        if (za > zb + 0.01) walls.push({ a, b, lo: zb, hi: za, n });
        // 이웃이 대기(0)이고 이 타일이 더 낮으면, 벽은 이웃 쪽 몫이므로 여기서 대신 만든다
        else if (za < zb - 0.01 && !other) walls.push({ a, b, lo: za, hi: zb, n: [-n[0], -n[1]] });
      }
    }
    // 보이는 면만 남긴다
    return walls.filter((w) => {
      const m = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2];
      const p = project(m, w.lo);
      const q = project(m, w.hi);
      return (q[0] - p[0]) * w.n[0] + (q[1] - p[1]) * w.n[1] < 0;
    });
  }
  const wallQuad = (w, lo, hi) => [project(w.a, lo), project(w.b, lo), project(w.b, hi), project(w.a, hi)];
  function addTri(Pt) {
    ctx.moveTo(Pt[0][0], Pt[0][1]);
    ctx.lineTo(Pt[1][0], Pt[1][1]);
    ctx.lineTo(Pt[2][0], Pt[2][1]);
    ctx.closePath();
  }
  function unionAt(list, z) {
    ctx.beginPath();
    for (const t of list) addTri(z == null ? t.T.map((p) => project(p, t.z)) : t.T);
  }
  // X자 번짐: 넓고 옅은 선 위에 가는 선을 한 번 더
  function strokeX(g) {
    g.lineWidth = 4.5;
    g.strokeStyle = P.xGlow;
    g.stroke();
    g.lineWidth = 1.4;
    g.strokeStyle = P.x;
    g.stroke();
  }
  function xMarks(list) {
    const A = 10;
    const dx = Math.cos(Math.PI / 3) * A;
    const dy = Math.sin(Math.PI / 3) * A;
    for (const t of list) {
      const Pt = t.T.map((p) => project(p, t.z));
      const c = centroid(Pt);
      const Q2 = Pt.map((p) => {
        const vx = p[0] - c[0];
        const vy = p[1] - c[1];
        const L = Math.hypot(vx, vy) || 1;
        return [p[0] + (vx / L) * 2.5, p[1] + (vy / L) * 2.5];
      });
      ctx.save();
      ctx.beginPath();
      addTri(Q2);
      ctx.clip();
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const q of Pt) {
        ctx.moveTo(q[0] - dx, q[1] - dy);
        ctx.lineTo(q[0] + dx, q[1] + dy);
        ctx.moveTo(q[0] + dx, q[1] - dy);
        ctx.lineTo(q[0] - dx, q[1] + dy);
      }
      strokeX(ctx);
      ctx.restore();
    }
  }
  function topEdges(list, lip) {
    for (const t of list) {
      const Pt = t.T.map((p) => project(p, t.z));
      const cP = centroid(Pt);
      for (let i = 0; i < 3; i++) {
        const a = Pt[i];
        const b = Pt[(i + 1) % 3];
        const boundary = t.edgeLow[i] || t.edgeHigh[i];
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.lineWidth = boundary ? 1 : 0.8;
        ctx.strokeStyle = boundary ? P.edge : P.grid;
        ctx.stroke();
        if (lip && t.edgeLow[i] && outward(a, b, cP)[1] < -0.3) {
          // 위쪽 모서리에 맺히는 빛
          ctx.beginPath();
          ctx.moveTo(a[0], a[1] + 0.6);
          ctx.lineTo(b[0], b[1] + 0.6);
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = P.lip;
          ctx.stroke();
        }
      }
    }
  }

  /* ── 꺼진 타일들: 표면에 뚫린 구멍 안에 바닥과 벽 ── */
  function drawSunkenPass(sunk, walls) {
    if (!sunk.length) return;
    ctx.save();
    unionAt(sunk, 0);
    ctx.clip();
    unionAt(sunk);
    ctx.fillStyle = P.floor;
    ctx.fill();
    topEdges(sunk, false);
    xMarks(sunk);
    for (const w of walls) {
      if (w.lo >= 0) continue;
      poly(wallQuad(w, w.lo, Math.min(0, w.hi)));
      ctx.fillStyle = wallColor(w.n);
      ctx.fill();
    }
    // 띠 바닥면의 단말 문구 — 구멍 안에만 보인다
    blitBand(band, y0 + (rows.top + 1) * TH, 1);
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.drawImage(cache.holeShade, 0, 0, W, H);
    ctx.restore();
    // 구멍 아래쪽 테두리는 빛을 받는다
    ctx.lineWidth = 1;
    ctx.strokeStyle = P.lip;
    ctx.beginPath();
    for (const w of walls) {
      if (w.lo < 0 && w.hi >= 0 && w.n[1] < -0.3) {
        ctx.moveTo(w.a[0], w.a[1] + 0.5);
        ctx.lineTo(w.b[0], w.b[1] + 0.5);
      }
    }
    ctx.stroke();
  }

  /* ── 켜진 타일들: 그림자 → 옆면 → 윗면 ── */
  function drawRaisedPass(up, walls) {
    if (!up.length) return;
    ctx.drawImage(cache.shadow, 0, 0, W, H);
    walls
      .filter((w) => w.hi > 0)
      .sort((p, q) => p.a[1] + p.b[1] - (q.a[1] + q.b[1]))
      .forEach((w) => {
        poly(wallQuad(w, Math.max(0, w.lo), w.hi));
        ctx.fillStyle = wallColor(w.n);
        ctx.fill();
        ctx.lineWidth = 0.6;
        ctx.strokeStyle = P.wallLine;
        ctx.stroke();
      });
    unionAt(up);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, P.topA);
    g.addColorStop(1, P.topB);
    ctx.fillStyle = g;
    ctx.fill();
    topEdges(up, true);
    xMarks(up);
  }

  /* ════════════ 미리 그려 두는 것들 ════════════ */
  const Q = 0.25;
  const cache = { ground: document.createElement('canvas'), shadow: document.createElement('canvas'), holeShade: document.createElement('canvas') };
  const bloomCv = document.createElement('canvas');
  const bctx = bloomCv.getContext('2d');
  const gTri = (g, Pt) => {
    g.moveTo(Pt[0][0], Pt[0][1]);
    g.lineTo(Pt[1][0], Pt[1][1]);
    g.lineTo(Pt[2][0], Pt[2][1]);
    g.closePath();
  };
  function drawGrid(g) {
    const rMin = Math.floor(-y0 / TH) - 1;
    const rMax = Math.ceil((H - y0) / TH) + 1;
    g.lineWidth = 0.8;
    g.strokeStyle = P.grid;
    g.beginPath();
    for (let r = rMin; r <= rMax; r++) {
      const y = y0 + r * TH;
      g.moveTo(0, y);
      g.lineTo(W, y);
    }
    const span = Math.ceil((W + H) / S) + 2;
    for (let k = -span; k <= span; k++) {
      const bx = x0 + k * S;
      g.moveTo(bx + (-20 - y0) / R3, -20);
      g.lineTo(bx + (H + 20 - y0) / R3, H + 20);
      g.moveTo(bx - (-20 - y0) / R3, -20);
      g.lineTo(bx - (H + 20 - y0) / R3, H + 20);
    }
    g.stroke();
    const A = 10;
    const dx = Math.cos(Math.PI / 3) * A;
    const dy = Math.sin(Math.PI / 3) * A;
    g.lineCap = 'round';
    g.beginPath();
    for (let rr = rMin; rr <= rMax; rr++) {
      const yy = y0 + rr * TH;
      const o = x0 + ox(rr);
      const kMin = Math.floor(-o / S) - 1;
      const kMax = Math.ceil((W - o) / S) + 1;
      for (let kk = kMin; kk <= kMax; kk++) {
        const xx = o + kk * S;
        g.moveTo(xx - dx, yy - dy);
        g.lineTo(xx + dx, yy + dy);
        g.moveTo(xx + dx, yy - dy);
        g.lineTo(xx - dx, yy + dy);
      }
    }
    strokeX(g);
  }
  function buildCache() {
    const list = Object.values(tiles);
    for (const t of list) t.T = tri(t.r, t.k, t.t);
    const up = list.filter((t) => t.z > 0.5);
    const dn = list.filter((t) => t.z < -0.5);

    // 바닥 그리드 (켜진·꺼진 칸 자리는 뺀다)
    let c = cache.ground;
    c.width = canvas.width;
    c.height = canvas.height;
    let g = c.getContext('2d');
    g.setTransform(D, 0, 0, D, 0, 0);
    g.save();
    g.beginPath();
    g.rect(-50, -50, W + 100, H + 100);
    for (const t of up.concat(dn)) gTri(g, t.T);
    g.clip('evenodd');
    drawGrid(g);
    g.restore();

    // 켜진 칸의 그림자 — 1/4 크기에서 흐린 뒤 키워서 쓴다
    c = cache.shadow;
    c.width = Math.ceil(W * Q);
    c.height = Math.ceil(H * Q);
    g = c.getContext('2d');
    g.setTransform(Q, 0, 0, Q, 0, 0);
    g.filter = `blur(${14 * Q}px)`;
    g.beginPath();
    for (const t of up) {
      const a = Math.min(1.4, t.z / ON);
      gTri(g, t.T.map((p) => [p[0] + 4 * a, p[1] + 16 * a]));
    }
    g.fillStyle = P.shadow;
    g.fill();

    // 구멍 위쪽 가장자리의 그늘
    c = cache.holeShade;
    c.width = Math.ceil(W * Q);
    c.height = Math.ceil(H * Q);
    g = c.getContext('2d');
    g.setTransform(Q, 0, 0, Q, 0, 0);
    g.filter = `blur(${5 * Q}px)`;
    g.lineWidth = 10;
    g.strokeStyle = P.holeShade;
    g.beginPath();
    for (const t of dn) {
      const nb = neighbors(t);
      for (let i = 0; i < 3; i++) {
        if (nb[i] && tiles[nb[i]] && tiles[nb[i]].z < -0.5) continue;
        const a = t.T[i];
        const b = t.T[(i + 1) % 3];
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
      }
    }
    g.stroke();

    bloomCv.width = Math.ceil(innerWidth * Q);
    bloomCv.height = Math.ceil(innerHeight * Q);
    band.dirty = true;
    brand.dirty = true;
  }

  /* ════════════ 공간에 새긴 UI — 위쪽 꺼진 띠의 바닥면 ════════════
     글자를 화면에 띄우지 않고 띠 바닥에 그린 뒤, 보는 사람을 감싸는 곡면처럼 살짝 휘어 붙인다. */
  const UI_FONT = '"Pretendard Variable", Pretendard, "Noto Sans CJK KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  const MONO = 'ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, "D2Coding", "DejaVu Sans Mono", monospace';
  function text(g, str, x, y, size, opt = {}) {
    g.font = `${opt.weight || 400} ${size / k}px ${opt.mono ? MONO : UI_FONT}`;
    g.textAlign = opt.align || 'left';
    g.textBaseline = 'middle';
    g.fillStyle = opt.color || P.ink;
    try {
      g.letterSpacing = `${(opt.track || 0) / k}px`;
    } catch {
      /* 오래된 엔진 */
    }
    g.fillText(str, x, y);
    try {
      g.letterSpacing = '0px';
    } catch {
      /* 오래된 엔진 */
    }
    return g.measureText(str).width;
  }
  function wifi(g, x, y, c) {
    const u = 1 / k;
    g.strokeStyle = c;
    g.lineWidth = 1.4 * u;
    g.lineCap = 'round';
    for (const r of [8, 5, 2]) {
      g.beginPath();
      g.arc(x, y + 4 * u, r * u, Math.PI * 1.25, Math.PI * 1.75);
      g.stroke();
    }
  }
  const PAD = 80;
  const band = { cv: document.createElement('canvas'), dirty: true, info: null, paint: () => paintBand() };
  // 로고 정보 (띠 바닥 왼쪽 끝에 그린다)
  const brand = { cv: document.createElement('canvas'), dirty: true, info: null, key: '', paint: () => paintBrand() };
  /* 로고는 왼쪽 위 켜진 계단 윗면에 붙인다(높이 ON). 투영으로 바깥·위로 밀리는 만큼을 되짚어,
     화면에서는 띠 높이 가운데 · 왼쪽에서 4.6% 자리에 오게 한다. 곡률은 위쪽 띠와 같다. */
  function paintBrand() {
    const w = W + PAD * 2;
    brand.cv.width = Math.ceil(w * D);
    brand.cv.height = Math.ceil(TH * D);
    const g = brand.cv.getContext('2d');
    g.setTransform(D, 0, 0, D, 0, 0);
    g.clearRect(0, 0, w, TH);
    const info = brand.info || {};
    const u = 1 / k;
    const f = 1 + ON * KP;
    const yTop = y0 + (rows.top + 1) * TH;
    const wantX = W * 0.046;
    const wantY = yTop + TH / 2;
    const x = W / 2 + (wantX - W / 2 + ON * 0.06) / f;
    const t = (2 * ((x + PAD) / w) - 1) ** 2;
    const yScene = H / 2 + (wantY - BEND * t - H / 2 + ON * 0.36) / f;
    // 띠 그림의 위쪽을 로고 가운데가 그림 가운데에 오도록 내린다
    brand.yTop = yScene - TH / 2;
    const cy = TH / 2;
    const size = 50 * u;
    drawBrandMark(g, PAD + x, cy - size / 2, size, info.type);
    const tx = PAD + x + size + 18 * u;
    text(g, 'MCES', tx, cy - 8 * u, 30, { weight: 800, track: 12.6, color: P.ink });
    text(g, `SERVER TERMINAL · ${info.device || '0x0000'}`, tx, cy + 18 * u, 10, { mono: true, track: 2.2, color: P.ink2 });
    brand.dirty = false;
  }
  function drawBrandMark(g, x, y, size, type) {
    g.save();
    g.translate(x, y);
    const m = size / 56;
    g.scale(m, m);
    g.translate(-32, -32);
    g.shadowColor = 'rgba(77, 107, 255, 0.55)';
    g.shadowBlur = 10;
    const gg = g.createLinearGradient(32, 32, 88, 88);
    gg.addColorStop(0, '#1530e6');
    gg.addColorStop(0.42, '#2a4dff');
    gg.addColorStop(0.7, '#5b78ff');
    gg.addColorStop(1, '#8f98ad');
    g.fillStyle = gg;
    g.beginPath();
    g.roundRect(32, 32, 56, 56, 4);
    g.fill();
    g.shadowBlur = 0;
    g.globalAlpha = 0.35;
    g.fillStyle = '#d6e2f0';
    g.beginPath();
    g.moveTo(66, 32);
    g.lineTo(72, 32);
    g.lineTo(56, 88);
    g.lineTo(50, 88);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    for (const pc of markPieces(type || 'paper')) {
      g.beginPath();
      if (pc.circle) g.arc(pc.circle[0], pc.circle[1], pc.circle[2], 0, Math.PI * 2);
      else g.roundRect(pc.rect[0], pc.rect[1], pc.rect[2], pc.rect[3], 1);
      g.fill();
    }
    g.restore();
  }
  // 띠 바닥이 시작하는 x (왼쪽 켜진 계단 바로 오른쪽)
  function bandStartX() {
    const r = rows.top + 1;
    const f = fromC(r, bandLeft);
    const T = tri(r, f.k, f.t);
    return Math.max(...T.map((p) => p[0]));
  }
  function paintBand() {
    const w = W + PAD * 2;
    band.cv.width = Math.ceil(w * D);
    band.cv.height = Math.ceil(TH * D);
    const g = band.cv.getContext('2d');
    g.setTransform(D, 0, 0, D, 0, 0);
    g.clearRect(0, 0, w, TH);
    const info = band.info || {};
    const u = 1 / k; // 띠 안의 간격은 실제 픽셀 기준
    // 꺼진 띠는 바닥이 가운데 쪽으로 밀려 위쪽 일부가 벽에 가린다 — 보이는 바닥의 가운데에 글자를 둔다
    const yt = y0 + (rows.top + 1) * TH;
    const seen = project([W / 2, yt], OFF)[1];
    const vis = yt + TH - seen;
    const cy = Math.max(18 * u, vis / 2 / (1 + OFF * KP));
    // 오른쪽: 코드와 PC 사양 — 띠 오른쪽 끝(켜진 사선이 시작하는 곳) 앞에서 끝낸다
    const re = fromC(rows.top + 1, bandRight);
    const reX = Math.min(...tri(rows.top + 1, re.k, re.t).map((q) => q[0]));
    const rx = PAD + Math.min(W * 0.86, reX - 150 * u);
    text(g, info.code || 'MC.ES', rx, cy - 7 * u, 15, { weight: 800, align: 'right' });
    g.fillStyle = P.gold;
    g.fillRect(rx - g.measureText(info.code || 'MC.ES').width - 14 * u, cy - 13 * u, 2 * u, 12 * u);
    text(g, info.right || '', rx, cy + 10 * u, 10, { align: 'right', color: P.ink2, mono: true });
    band.dirty = false;
  }
  const BEND = 22;
  const SHRINK = 0.16;
  const STRIPS = 48;
  function bandPoint(yTop, sign, x, y, z = OFF) {
    const w = W + PAD * 2;
    const u = x / w;
    const t = (2 * u - 1) * (2 * u - 1);
    const p = project([x - PAD, yTop + y], z);
    const m = project([x - PAD, yTop + TH / 2], z);
    const mid = m[1] + sign * BEND * t;
    return [p[0], mid + (p[1] - m[1]) * (1 - SHRINK * t)];
  }
  function blitBand(b, yTop, sign, z = OFF) {
    if (b.dirty) b.paint();
    const w = W + PAD * 2;
    const sw = w / STRIPS;
    ctx.save();
    for (let i = 0; i < STRIPS; i++) {
      const xa = i * sw;
      const xb = xa + sw;
      const o = bandPoint(yTop, sign, xa, 0, z);
      const u = bandPoint(yTop, sign, xb, 0, z);
      const v = bandPoint(yTop, sign, xa, TH, z);
      ctx.setTransform((D * (u[0] - o[0])) / sw, (D * (u[1] - o[1])) / sw, (D * (v[0] - o[0])) / TH, (D * (v[1] - o[1])) / TH, D * o[0], D * o[1]);
      ctx.drawImage(b.cv, xa * D, 0, (sw + 1) * D, TH * D, 0, 0, sw + 1, TH);
    }
    ctx.restore();
  }

  let _pg = null;
  let _pgH = 0;
  function paperGrad() {
    if (_pg && _pgH === H) return _pg;
    _pg = ctx.createLinearGradient(0, 0, 0, H);
    _pgH = H;
    _pg.addColorStop(0, P.paper[0]);
    _pg.addColorStop(0.55, P.paper[1]);
    _pg.addColorStop(1, P.paper[2]);
    return _pg;
  }

  /* ════════════ 빛 번짐 — 1/4 크기 사본을 흐려 반쯤 겹친다 ════════════ */
  const small = document.createElement('canvas');
  const sctx = small.getContext('2d');
  function bloom() {
    small.width = bloomCv.width;
    small.height = bloomCv.height;
    sctx.drawImage(canvas, 0, 0, small.width, small.height);
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, bloomCv.width, bloomCv.height);
    bctx.filter = 'blur(4.5px) brightness(1.08) saturate(1.15)';
    bctx.drawImage(small, 0, 0);
    bctx.filter = 'none';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = P.bloom;
    ctx.drawImage(bloomCv, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  /* ════════════ 화면 가장자리 렌즈: 색수차 + 블러 ════════════
     1/4 크기 사본에서 R·G·B를 렌즈처럼 서로 다른 배율로 벌리고(가장자리일수록 많이),
     살짝 흐린 뒤 가장자리 띠에만 덮어 그린다. */
  const qcv = () => {
    const c = document.createElement('canvas');
    return { c, g: c.getContext('2d') };
  };
  const fx = { src: qcv(), r: qcv(), gr: qcv(), b: qcv(), out: qcv(), mask: qcv() };
  function sizeFx() {
    const w = Math.ceil(innerWidth * Q);
    const h = Math.ceil(innerHeight * Q);
    for (const key of Object.keys(fx)) {
      fx[key].c.width = w;
      fx[key].c.height = h;
    }
  }
  function channel(d, color) {
    const g = d.g;
    const w = d.c.width;
    const h = d.c.height;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, w, h);
    g.drawImage(fx.src.c, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
  }
  function edgeFX() {
    const w = fx.src.c.width;
    const h = fx.src.c.height;
    const sg = fx.src.g;
    sg.clearRect(0, 0, w, h);
    sctx.drawImage(canvas, 0, 0, w, h);
    sg.filter = 'blur(0.9px)';
    sg.drawImage(small, 0, 0);
    sg.filter = 'none';
    channel(fx.r, '#ff0000');
    channel(fx.gr, '#00ff00');
    channel(fx.b, '#0000ff');
    // 렌즈 중심은 마우스 반대쪽으로 조금. R은 바깥으로, B는 안쪽으로
    const cx = w * (0.5 - cur.x * 0.025);
    const cy = h * (0.5 - cur.y * 0.025);
    const ks = 0.01 + 0.004 * (Math.abs(cur.x) + Math.abs(cur.y));
    const og = fx.out.g;
    og.globalCompositeOperation = 'source-over';
    og.clearRect(0, 0, w, h);
    og.globalCompositeOperation = 'lighter';
    for (const [d, s] of [[fx.r, 1 + ks], [fx.gr, 1], [fx.b, 1 - ks]]) {
      og.setTransform(s, 0, 0, s, cx * (1 - s), cy * (1 - s));
      og.drawImage(d.c, 0, 0);
    }
    og.setTransform(1, 0, 0, 1, 0, 0);
    // 가장자리 띠 모양의 가림판 — 가운데는 비고 끝으로 갈수록 찬다
    const mg = fx.mask.g;
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, w, h);
    mg.setTransform(1, 0, 0, h / w, 0, 0);
    const rg = mg.createRadialGradient(cx, (cy * w) / h, 0, cx, (cy * w) / h, w * 0.66);
    rg.addColorStop(0, 'rgba(0,0,0,0)');
    rg.addColorStop(0.58, 'rgba(0,0,0,0)');
    rg.addColorStop(0.74, 'rgba(0,0,0,0.35)');
    rg.addColorStop(0.88, 'rgba(0,0,0,0.8)');
    rg.addColorStop(1, 'rgba(0,0,0,1)');
    mg.fillStyle = rg;
    mg.fillRect(0, 0, w, w);
    mg.setTransform(1, 0, 0, 1, 0, 0);
    og.globalCompositeOperation = 'destination-in';
    og.drawImage(fx.mask.c, 0, 0);
    og.globalCompositeOperation = 'source-over';
    // 가장자리 색을 진하게 (작은 사본에서만)
    sg.clearRect(0, 0, w, h);
    sg.filter = 'saturate(2.1) brightness(1.03)';
    sg.drawImage(fx.out.c, 0, 0);
    sg.filter = 'none';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(fx.src.c, 0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  /* ════════════ 화면 배치 정보 — DOM 판이 띠 아래에서 시작하도록 ════════════ */
  function publishGeometry() {
    const bandTop = toScreen([0, y0 + (rows.top + 1) * TH])[1];
    const bandBottom = toScreen([0, y0 + (rows.top + 2) * TH])[1];
    root.style.setProperty('--band-top', `${bandTop.toFixed(1)}px`);
    root.style.setProperty('--band-bottom', `${bandBottom.toFixed(1)}px`);
    root.style.setProperty('--band-start', `${toScreen([bandStartX(), 0])[0].toFixed(1)}px`);
  }

  /* ════════════ 패널 점등 · 소등 ════════════
     SCRF 구동 순서를 그대로 옮긴 것. 화면 전체가 패널 칸으로 되어 있고, 칸마다 검은 덮개가 걷히며(또는 덮이며) 켜진다.
     - 불규칙한 묶음: 흩뿌린 씨앗 점 중 가장 가까운 것에 칸을 붙인다. 같은 묶음은 함께 켜지고 함께 깜빡인다
     - 오류 있음(faulty): 묶음 일부가 색이 갈라지거나 엉뚱한 자리를 비춘 채로 켜지고, 화면이 툭 어두워지거나 가로로 찢어진다
     - 오류 없음(clean): 깜빡임 없이 한 번에 */
  const OFF_FILL = '#04060a';
  const DARK_LINE = 'rgba(120, 150, 180, 0.13)';
  function hash(a, b, c) {
    let h = (a * 73856093) ^ (b * 19349663) ^ (c * 83492791);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }
  let groupCache = {};
  const SLICES = [45, 45, 70, 130, 130]; // 빠른 깜빡임과 느린 깜빡임이 섞인다
  function groupOf(r, kk, j, c) {
    const key = `${r},${kk},${j}`;
    if (groupCache[key]) return groupCache[key];
    const G = S * 1.35;
    const gi = Math.floor(c[0] / G);
    const gj = Math.floor(c[1] / G);
    let best = null;
    let bd = 1e9;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const i = gi + a;
        const jj = gj + b;
        const sx = (i + 0.15 + 0.7 * hash(i, jj, 11)) * G;
        const sy = (jj + 0.15 + 0.7 * hash(i, jj, 13)) * G;
        const w = 0.55 + 0.9 * hash(i, jj, 17);
        const d = Math.hypot(c[0] - sx, c[1] - sy) / w;
        if (d < bd) {
          bd = d;
          best = [i, jj];
        }
      }
    }
    const solo = hash(r, kk, j + 40) < 0.14;
    const id = solo ? [r * 131 + 7, kk * 71 + j] : best;
    const fr = hash(id[0], id[1], 61);
    const g = {
      seed: id[0] * 977 + id[1] * 31 + (solo ? 5 : 0),
      h: hash(id[0], id[1], solo ? 9 : 5),
      slice: SLICES[Math.floor(hash(id[0], id[1], 23) * SLICES.length)],
      fault: fr < 0.12 ? 'ca' : fr < 0.24 ? 'shift' : null,
    };
    groupCache[key] = g;
    return g;
  }
  // 칸 하나의 점등 — [검은 덮개, 흰 번쩍임]
  function tileLight(u, seed, t, slice, clean) {
    if (u <= 0) return [1, 0];
    if (u >= 1) return [0, 0];
    if (clean) {
      const e = 1 - Math.pow(1 - u, 3);
      return [1 - e, u < 0.5 ? 0.22 * Math.sin((u / 0.5) * Math.PI) : 0];
    }
    const b = Math.floor(t / slice);
    const r = hash(seed, b, 31);
    const r2 = hash(seed, b, 57);
    if (u < 0.55) {
      if (r < 0.42) return [0.96, 0];
      if (r < 0.66) return [0.55, r2 < 0.2 ? 0.25 : 0];
      return [0.12 + 0.12 * r2, r2 > 0.82 ? 0.5 : 0.08];
    }
    if (u < 0.82) {
      if (r < 0.14) return [0.75, 0];
      return [0.06, r2 > 0.9 ? 0.3 : 0];
    }
    return [0.06 * (1 - (u - 0.82) / 0.18), 0];
  }
  // 칸 하나의 소등 — 잠깐 밝아졌다가 덮인다
  function tileDark(u) {
    if (u <= 0) return [0, 0];
    if (u >= 1) return [1, 0];
    if (u < 0.22) return [0, 0.3 * Math.sin((u / 0.22) * Math.PI)];
    const e = (u - 0.22) / 0.78;
    return [1 - Math.pow(1 - e, 2), 0];
  }
  function convexHull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [];
    const up = [];
    for (const q of p) {
      while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
      lo.push(q);
    }
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[i];
      while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
      up.push(q);
    }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  // 잘못 켜지는 패널에 쓸 깨끗한 화면 사본 — 원래 크기 1장, 색 갈라짐용 1/4 크기 채널 3장
  const snap = document.createElement('canvas');
  const snapG = snap.getContext('2d');
  const chans = [qcv(), qcv(), qcv()];
  const chanColor = ['#ff0000', '#00ff00', '#0000ff'];
  function takeSnap() {
    if (snap.width !== canvas.width || snap.height !== canvas.height) {
      snap.width = canvas.width;
      snap.height = canvas.height;
    }
    snapG.drawImage(canvas, 0, 0);
    const w = Math.ceil(innerWidth * Q);
    const h = Math.ceil(innerHeight * Q);
    chans.forEach((d, i) => {
      if (d.c.width !== w || d.c.height !== h) {
        d.c.width = w;
        d.c.height = h;
      }
      const g = d.g;
      g.globalCompositeOperation = 'source-over';
      g.filter = 'blur(1.5px)';
      g.drawImage(canvas, 0, 0, w, h);
      g.filter = 'none';
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = chanColor[i];
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'source-over';
    });
  }
  // 색 번짐 줄무늬 — 신호가 갈라진 화면처럼 무지개빛 가로 줄 (한 번만 만든다)
  const streak = (() => {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 256;
    const g = c.getContext('2d');
    const cols2 = ['#ff2a4a', '#ffb02a', '#36ff6a', '#2ad6ff', '#4a5cff', '#d22aff'];
    g.fillStyle = '#06080e';
    g.fillRect(0, 0, 256, 256);
    g.filter = 'blur(4px)';
    for (let i = 0; i < 26; i++) {
      g.globalAlpha = 0.35 + 0.5 * hash(i, 3, 9);
      g.fillStyle = cols2[i % cols2.length];
      g.fillRect(-20 + hash(i, 1, 2) * 60, hash(i, 4, 5) * 256, 120 + hash(i, 6, 7) * 200, 3 + hash(i, 8, 9) * 12);
    }
    return c;
  })();
  function drawFault(f) {
    const c = centroid(f.shape);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(f.shape[0][0], f.shape[0][1]);
    for (let i = 1; i < f.shape.length; i++) ctx.lineTo(f.shape[i][0], f.shape[i][1]);
    ctx.closePath();
    ctx.clip();
    if (f.type === 'shift') {
      // 자기 자리가 아닌 화면을, 배율도 틀린 채로 비춘다
      const dx = (hash(f.seed, f.fb, 81) - 0.5) * S * 2.2;
      const dy = (hash(f.seed, f.fb, 83) - 0.5) * S * 1.4;
      const z = 1.5 + hash(f.seed, f.fb, 89) * 1.3;
      ctx.translate(c[0], c[1]);
      ctx.scale(z, z);
      ctx.translate(-c[0] + dx, -c[1] + dy);
      ctx.drawImage(snap, 0, 0, W, H);
      ctx.setTransform(D, 0, 0, D, 0, 0);
      ctx.fillStyle = 'rgba(24, 44, 120, 0.38)';
      ctx.fillRect(0, 0, W, H);
      const ly = c[1] + (hash(f.seed, f.fb, 91) - 0.5) * S * 0.6;
      ctx.fillStyle = 'rgba(160, 230, 255, 0.85)';
      ctx.fillRect(0, ly, W, 1.5);
    } else {
      // 색이 갈라진 채로 켜진다 — 채널이 크게 밀리고, 무지개빛 가로 줄이 번진다
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const d = (14 + 30 * hash(f.seed, f.fb, 85)) * dpr;
      const v = (hash(f.seed, f.fb, 87) - 0.5) * 16 * dpr;
      ctx.drawImage(streak, 0, hash(f.seed, f.fb, 93) * 120, 256, 136, 0, 0, canvas.width, canvas.height);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.26;
      ctx.drawImage(chans[0].c, -d, v, canvas.width, canvas.height);
      ctx.drawImage(chans[1].c, d * 0.3, 0, canvas.width, canvas.height);
      ctx.drawImage(chans[2].c, d, -v, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }
  // 그리드 선만 (X자 없이) — 꺼진 화면에서 쓴다
  function gridLines(g, color) {
    const rMin = Math.floor(-y0 / TH) - 1;
    const rMax = Math.ceil((H - y0) / TH) + 1;
    g.lineWidth = 1;
    g.strokeStyle = color;
    g.beginPath();
    for (let r = rMin; r <= rMax; r++) {
      const y = y0 + r * TH;
      g.moveTo(0, y);
      g.lineTo(W, y);
    }
    const span = Math.ceil((W + H) / S) + 2;
    for (let kk = -span; kk <= span; kk++) {
      const bx = x0 + kk * S;
      g.moveTo(bx + (-20 - y0) / R3, -20);
      g.lineTo(bx + (H + 20 - y0) / R3, H + 20);
      g.moveTo(bx - (-20 - y0) / R3, -20);
      g.lineTo(bx - (H + 20 - y0) / R3, H + 20);
    }
    g.stroke();
  }

  /* ════════════ 패널 디스플레이 — 구동 로그 ════════════
     꺼져 있는 패널 몇 장이 작은 화면으로 켜져 글자를 띄운다. 칸 모양 그대로 잘라 그린다. */
  const MONO_F = MONO;
  let logScreen = { tiles: [], keys: {}, cells: [], box: [0, 0, 0, 0] };
  function screenFrom(rs, c0, c1) {
    const sc = { tiles: [], keys: {}, cells: [], box: null };
    const xs = [];
    const ys = [];
    for (const r of rs) {
      for (let c = c0; c <= c1; c++) {
        const f = fromC(r, c);
        const T = tri(r, f.k, f.t);
        sc.tiles.push(T);
        sc.keys[`${r},${f.k},${f.t}`] = true;
        sc.cells.push({ T, r, k: f.k, j: f.t === 'u' ? 1 : 0 });
        for (const p of T) {
          xs.push(p[0]);
          ys.push(p[1]);
        }
      }
    }
    sc.box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    return sc;
  }
  function buildScreens() {
    const rb = rows.bottom;
    const cl = cols.left + 9;
    logScreen = screenFrom([rb - 2, rb - 1], cl, cl + Math.max(10, Math.ceil(560 / (S / 2))));
  }
  const LOG_COLORS = { '': '#d9e4f0', 'is-dim': 'rgba(170, 186, 204, 0.55)', 'is-warn': '#e6b45a', 'is-done': '#8fa8ff', 'is-live': '#d9e4f0' };
  const logCv = document.createElement('canvas');
  const lg = logCv.getContext('2d');
  const logTint = [document.createElement('canvas'), document.createElement('canvas')];
  function tintOf(i, color) {
    const c = logTint[i];
    const g = c.getContext('2d');
    if (c.width !== logCv.width || c.height !== logCv.height) {
      c.width = logCv.width;
      c.height = logCv.height;
    }
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(logCv, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }
  let logLines = [];
  let logFx = {};
  const rnd = (a, b) => a + Math.random() * (b - a);
  function faultLook() {
    return Math.random() < 0.5 ? { type: 'ca', d: rnd(2.5, 11) } : { type: 'shift', dx: rnd(-0.5, 0.5) * S, dy: Math.round(rnd(-2, 2)) * 17 + rnd(-3, 3) };
  }
  // 로그 칸의 글리치 — 안 걸림 / 어긋난 채 유지 / 복구 시도 중. 끝나기 전에 반드시 복구
  function buildLogFx(sp) {
    logFx = {};
    if (sp.clean) return;
    const quiet = Math.random() < 0.2;
    const pStuck = rnd(0.08, 0.25);
    const pRetry = rnd(0.12, 0.32);
    for (const cell of logScreen.cells) {
      if (quiet) continue;
      const r = Math.random();
      const key = `${cell.r},${cell.k},${cell.j}`;
      const on = rnd(sp.start * 0.6, sp.logDone - 900);
      const fix = sp.logDone - rnd(0, 500);
      if (fix <= on + 200) continue;
      if (r < pStuck) logFx[key] = { kind: 'stuck', on, fix, v: faultLook() };
      else if (r < pStuck + pRetry) {
        const mean = rnd(70, 420);
        const seq = [];
        let tt = on;
        while (tt < fix) {
          const len = Math.max(35, mean * -Math.log(1 - Math.random() * 0.98));
          const q = Math.random();
          seq.push({ until: Math.min(fix, tt + len), v: q < 0.25 ? null : q < 0.38 ? { type: 'off' } : faultLook() });
          tt += len;
        }
        logFx[key] = { kind: 'retry', on, fix, seq };
      }
    }
  }
  function logFxAt(cell, t) {
    const fx2 = logFx[`${cell.r},${cell.k},${cell.j}`];
    if (!fx2 || t < fx2.on || t >= fx2.fix) return null;
    if (fx2.kind === 'stuck') return fx2.v;
    for (const s2 of fx2.seq) if (t < s2.until) return s2.v;
    return null;
  }
  function drawLogText(sc, t, alpha) {
    if (alpha <= 0.01) return;
    const u = 1 / k;
    const bx = sc.box;
    const bw = bx[2] - bx[0];
    const bh = bx[3] - bx[1];
    const lh = 17 * u;
    const cw = Math.ceil(bw * D);
    const chh = Math.ceil(bh * D);
    if (logCv.width !== cw || logCv.height !== chh) {
      logCv.width = cw;
      logCv.height = chh;
    }
    lg.setTransform(D, 0, 0, D, 0, 0);
    lg.clearRect(0, 0, bw, bh);
    // 왼쪽 변이 비스듬하니, 글자는 칸 하나만큼 안쪽에서 시작한다
    const x = S * 0.75;
    const y = 18 * u;
    lg.font = `400 ${12 * u}px ${MONO_F}`;
    lg.textAlign = 'left';
    lg.textBaseline = 'middle';
    lg.shadowColor = 'rgba(120, 180, 255, 0.55)';
    lg.shadowBlur = 5;
    const lines = logLines.slice(-Math.floor((bh - 20 * u) / lh));
    lines.forEach((ln, i) => {
      lg.fillStyle = LOG_COLORS[ln.cls || ''];
      let txt = ln.text;
      if (ln.cls === 'is-live' && Math.floor(performance.now() / 450) % 2 === 0) txt += '▌';
      lg.fillText(txt, x, y + i * lh);
    });
    lg.shadowBlur = 0;
    lg.globalCompositeOperation = 'destination-out';
    lg.fillStyle = 'rgba(0,0,0,0.35)';
    for (let yy = 0; yy < bh; yy += 3 * u) lg.fillRect(0, yy, bw, u);
    lg.globalCompositeOperation = 'source-over';
    let red = null;
    let blue = null;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const cell of sc.cells) {
      const v = logFxAt(cell, t);
      const st = v ? v.type : 'ok';
      if (st === 'off') continue;
      ctx.save();
      ctx.beginPath();
      addTri(cell.T);
      ctx.clip();
      if (st === 'shift') ctx.drawImage(logCv, bx[0] + v.dx, bx[1] + v.dy, bw, bh);
      else if (st === 'ca') {
        red = red || tintOf(0, '#ff3050');
        blue = blue || tintOf(1, '#30a8ff');
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(red, bx[0] - v.d, bx[1], bw, bh);
        ctx.drawImage(blue, bx[0] + v.d, bx[1] + 1, bw, bh);
        ctx.globalAlpha *= 0.55;
        ctx.drawImage(logCv, bx[0], bx[1], bw, bh);
      } else ctx.drawImage(logCv, bx[0], bx[1], bw, bh);
      ctx.restore();
    }
    ctx.restore();
  }
  // 구동 로그 — DOS 창처럼. 오류 문구는 매번 조금씩 다르게
  const hex4 = () => `0X${(0x8000 + ((Math.random() * 0x7fff) | 0)).toString(16).toUpperCase()}`;
  const hexId = () => `0x${(0x100 + ((Math.random() * 0xeff) | 0)).toString(16).toUpperCase()}`;
  const pick = (list) => list[(Math.random() * list.length) | 0];
  const WARNS = [
    () => `[WARN] panel ${hexId()} signal split   — retry`,
    () => `[WARN] panel ${hexId()} misaligned     — remap`,
    () => `[WARN] panel ${hexId()} no response    — reboot`,
    () => `[WARN] sync drift +${2 + ((Math.random() * 40) | 0)}ms     — resync`,
    () => `[ERR ] frame ${hexId()} checksum fail — drop`,
    () => `[WARN] chroma bus ${pick(['R', 'G', 'B'])} offset   — calibrate`,
  ];
  let logTimers = [];
  function log(text, cls) {
    const ln = { text, cls: cls || '' };
    logLines.push(ln);
    if (logLines.length > 40) logLines.shift();
    return ln;
  }
  function runLog(sp) {
    logTimers.forEach(clearTimeout);
    logTimers = [];
    logLines = [];
    log('C:\\MCES> link --host CORE --port 0x3F7A');
    const conn = log('Connecting to CORE', 'is-live');
    let dots = 0;
    const dotTimer = setInterval(() => {
      dots = (dots + 1) % 4;
      conn.text = `Connecting to CORE${'.'.repeat(dots)}`;
    }, 320);
    const span = sp.last + sp.dur - sp.start;
    const plan = [
      [sp.start * 0.3, '[ OK ] link layer            port 0x3F7A'],
      [sp.start * 0.55, '[ OK ] handshake             MCES/ORN'],
      [sp.start * 0.8, '[ .. ] panel matrix          powering'],
    ];
    const nd = sp.clean ? 3 : 6;
    for (let i = 0; i < nd; i++) plan.push([sp.start + span * (0.08 + (0.8 * i) / nd), 'dump']);
    if (!sp.clean) {
      const nw = 1 + ((Math.random() * 3) | 0);
      const used = {};
      for (let w = 0; w < nw; w++) {
        let f;
        do f = (Math.random() * WARNS.length) | 0;
        while (used[f]);
        used[f] = 1;
        plan.push([sp.start + span * (0.15 + 0.6 * Math.random()), WARNS[f](), 'is-warn']);
      }
    } else plan.push([sp.start + span * 0.5, '[ OK ] panel matrix          0 faults']);
    plan.push([sp.logDone - 400, '[ OK ] panel matrix          aligned']);
    plan.push([sp.logDone, 'done']);
    for (const it of plan) {
      logTimers.push(
        setTimeout(() => {
          if (it[1] === 'dump') return log([hex4(), hex4(), hex4(), hex4(), hex4(), hex4()].join(' '), 'is-dim');
          if (it[1] === 'done') {
            clearInterval(dotTimer);
            conn.text = 'Connecting to CORE... OK';
            conn.cls = '';
            log('[DONE] connection established  — CORE online', 'is-done');
            log('C:\\MCES> _');
            return null;
          }
          return log(it[1], it[2]);
        }, it[0]),
      );
    }
    logTimers.push(setTimeout(() => clearInterval(dotTimer), sp.logOff + 100));
  }

  /* ── 전원 상태: on(켜짐) / boot·up(켜지는 중) / down(꺼지는 중) / off(꺼짐, 로딩 화면) ── */
  const power = { phase: 'off', t0: 0, spec: null };
  function setPower(phase, spec) {
    power.phase = phase;
    power.t0 = performance.now();
    power.spec = spec;
    dirty = true;
  }
  function drawCover(now) {
    const sp = power.spec;
    const t = now - power.t0;
    if (sp.faults && t > sp.start) takeSnap();
    const rMin = Math.floor(-y0 / TH) - 2;
    const rMax = Math.ceil((H - y0) / TH) + 2;
    const diag = Math.hypot(W / 2, H / 2);
    const faults = [];
    const black = new Path2D();
    const half = new Path2D();
    const dim = new Path2D();
    const flash = new Path2D();
    const flash2 = new Path2D();
    const addPath = (path, shape) => {
      path.moveTo(shape[0][0], shape[0][1]);
      for (let i = 1; i < shape.length; i++) path.lineTo(shape[i][0], shape[i][1]);
      path.closePath();
    };
    for (let r = rMin; r <= rMax; r++) {
      const o = x0 + ox(r);
      const kMin = Math.floor(-o / S) - 2;
      const kMax = Math.ceil((W - o) / S) + 2;
      for (let kk = kMin; kk <= kMax; kk++) {
        for (let j = 0; j < 2; j++) {
          const tt = j ? 'u' : 'd';
          const T = tri(r, kk, tt);
          const c = centroid(T);
          const dist = Math.min(1, Math.hypot(c[0] - W / 2, c[1] - H / 2) / diag);
          const grp = groupOf(r, kk, j, c);
          let start = sp.start + (grp.h * 0.65 + (sp.dir === 'on' ? dist : 1 - dist) * 0.35) * (sp.last - sp.start);
          if (sp.log && logScreen.keys[`${r},${kk},${tt}`]) start = sp.logOff; // 로그를 띄운 패널은 로그가 끝난 뒤에 켜진다
          const ut = (t - start) / sp.dur;
          let L = sp.dir === 'on' ? tileLight(ut, grp.seed, t, grp.slice, !sp.faults) : tileDark(ut);
          let fault = null;
          if (sp.faults && grp.fault && ut > 0.12 && ut < 0.92) {
            const fb = Math.floor(t / 160);
            const fq = hash(grp.seed, fb, 77);
            if (fq < 0.22) L = [1, 0];
            else if (fq < 0.88) fault = { type: grp.fault, fb, seed: grp.seed };
          }
          if (!fault && L[0] <= 0.01 && L[1] <= 0.01) continue;
          const tile = tiles[`${r},${kk},${tt}`];
          let shape = T;
          if (tile && tile.z > 0) shape = convexHull(T.concat(T.map((p) => project(p, tile.z))));
          if (fault) {
            fault.shape = shape;
            faults.push(fault);
            continue;
          }
          const path = L[0] > 0.9 ? black : L[0] > 0.4 ? half : L[0] > 0.1 ? dim : null;
          if (path) addPath(path, shape);
          const fp = L[1] > 0.35 ? flash : L[1] > 0.05 ? flash2 : null;
          if (fp) addPath(fp, shape);
        }
      }
    }
    ctx.fillStyle = 'rgba(4, 6, 10, 0.97)';
    ctx.fill(black);
    ctx.fillStyle = 'rgba(4, 6, 10, 0.55)';
    ctx.fill(half);
    ctx.fillStyle = 'rgba(4, 6, 10, 0.18)';
    ctx.fill(dim);
    ctx.fillStyle = 'rgba(225, 242, 255, 0.32)';
    ctx.fill(flash);
    ctx.fillStyle = 'rgba(225, 242, 255, 0.18)';
    ctx.fill(flash2);
    faults.forEach(drawFault);
    ctx.setTransform(D, 0, 0, D, 0, 0);
    if (sp.log && t < sp.logOff) drawLogText(logScreen, t, Math.min(1, t / 200) * Math.min(1, (sp.logOff - t) / 250));
    // 아직 꺼져 있는 칸 위로도 그리드 선이 남아 있게
    const lineA = sp.dir === 'on' ? 1 - Math.max(0, Math.min(1, (t - sp.start) / (sp.last + sp.dur - sp.start))) : Math.max(0, Math.min(1, (t - sp.start) / (sp.last + sp.dur - sp.start)));
    if (lineA > 0.01) {
      ctx.globalAlpha = lineA;
      gridLines(ctx, DARK_LINE);
      ctx.globalAlpha = 1;
    }
    if (!sp.faults) return;
    // 화면 전체의 흔들림: 밝기가 툭 떨어지는 순간과, 가로로 찢어져 밀리는 줄
    const b = Math.floor(t / 160);
    const u = Math.min(1, t / (sp.last + sp.dur));
    if (hash(b, 1, 2) < 0.1 * (1 - u)) {
      ctx.fillStyle = `rgba(4, 6, 10, ${(0.15 + 0.2 * hash(b, 2, 3)).toFixed(2)})`;
      ctx.fillRect(0, 0, W, H);
    }
    const tears = hash(b, 4, 5) < 0.3 * (1 - u * 0.8) ? 1 + Math.floor(hash(b, 6, 7) * 2) : 0;
    for (let n = 0; n < tears; n++) {
      const ty = hash(b, n, 8) * innerHeight;
      const th = 6 + hash(b, n, 9) * 38;
      const dx = (hash(b, n, 10) - 0.5) * 60;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(canvas, 0, ty * dpr, canvas.width, th * dpr, dx * dpr, ty * dpr, canvas.width, th * dpr);
      ctx.restore();
    }
  }
  // 구동 시간표 (SCRF clean / long 값)
  function bootSpec(faulty) {
    const p = faulty ? { start: 1700, last: 4000, dur: 1500 } : { start: 700, last: 2100, dur: 700 };
    const bootEnd = p.last + p.dur;
    const logDone = bootEnd - 300;
    const logOff = logDone + (faulty ? 900 : 600);
    return { dir: 'on', faults: faulty, clean: !faulty, log: true, ...p, logDone, logOff, end: logOff + p.dur, uiAt: Math.max(bootEnd, logOff) + 200 };
  }

  /* ════════════ 로딩 화면 — 꺼진 패널 화면에 띄운다 ════════════
     (첨부된 천궁 로더를 SCRF 테마로 옮긴 것: 신성 기하학 고리 · 떠오르는 빛 알갱이 · 가로지르는 빛의 띠 ·
      파인 원판과 네 모서리 눈금 · 원 궤도 안의 삼각형 로고 · 상태 문구와 진행 막대)
     금색 선은 코발트로, 금색은 점과 짧은 표식에만. 바탕은 꺼진 화면색. */
  // 로딩 화면 색 — 밝게는 흰 화면, 어둡게는 꺼진 화면
  const LP_DARK = {
    bg: '#04060a', grid: 'rgba(120, 150, 180, 0.13)', scan: 'rgba(0, 0, 0, 0.22)', halo: [40, 70, 255, 0.2],
    geo: 'rgba(143, 168, 255, 0.9)', geoFaint: 'rgba(143, 168, 255, 0.4)', numeral: 'rgba(217, 228, 240, 0.7)', node: '#04060a',
    floor: [4, 6, 10], waveGlow: 'rgba(91, 120, 255, 0.8)', discA: '#0b111c', discB: '#03050a', discLine: 'rgba(143, 168, 255, 0.18)',
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
  /* ════════════ 배경 재정렬 (PR-SCRF transitionTo) ════════════
     패널이 가운데에서 바깥으로, 불규칙한 묶음으로 새 높이로 바뀐다. 크게 바뀌는 칸(꺼짐↔켜짐)은 한 번 대기를 거친다. */
  const TR_SPAN = 2200;
  const TR_DUR = 650;
  const easeIO = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
  const tr = { live: false, t0: 0, end: 0, done: null };
  function transitionTo(name, seed, lead = 0) {
    curLayout = name;
    curSeed = seed || '';
    const want = layoutMap(name);
    for (const key of Object.keys(want)) if (!tiles[key]) tiles[key] = { ...want[key], z: 0 };
    const diag = Math.hypot(W / 2, H / 2);
    let last = 0;
    for (const key of Object.keys(tiles)) {
      const t = tiles[key];
      const c = centroid(tri(t.r, t.k, t.t));
      t.from = t.z;
      t.to = want[key] ? want[key].z : 0;
      const grp = groupOf(t.r, t.k, t.t === 'u' ? 1 : 0, c);
      const dist = Math.min(1, Math.hypot(c[0] - W / 2, c[1] - H / 2) / diag);
      t.delay = t.from === t.to ? 0 : lead + (dist * 0.55 + grp.h * 0.45) * TR_SPAN;
      t.dur = TR_DUR;
      t.via0 = (t.from > 0 && t.to < 0) || (t.from < 0 && t.to > 0);
      if (t.from !== t.to) last = Math.max(last, t.delay + t.dur);
    }
    tr.live = true;
    tr.t0 = performance.now();
    tr.end = last + 120;
    dirty = true;
    return new Promise((res) => (tr.done = res));
  }
  function stepTransition(now) {
    const tt = now - tr.t0;
    for (const key of Object.keys(tiles)) {
      const t = tiles[key];
      if (t.from === undefined) continue;
      const p = Math.max(0, Math.min(1, (tt - t.delay) / t.dur));
      const e = easeIO(p);
      t.z = t.via0 ? (e < 0.5 ? t.from * (1 - e * 2) : t.to * (e * 2 - 1)) : t.from + (t.to - t.from) * e;
      if (p >= 1 && t.to === 0) delete tiles[key];
    }
    buildCache();
    if (tt > tr.end) {
      tr.live = false;
      for (const t of Object.values(tiles)) delete t.from;
      const cb = tr.done;
      tr.done = null;
      if (cb) cb();
    }
  }

  /* ════════════ 패널 화면 전환 — 꺼지지 않고, 칸마다 채널이 바뀌듯 로딩 화면으로 넘어간다 ════════════ */
  const ldSnap = document.createElement('canvas');
  const ldSnapG = ldSnap.getContext('2d');
  const sw = { dir: 'in', t0: 0, span: 1100, dur: 420, done: null };
  const shapeOf = (r, kk, tt, T) => {
    const tile = tiles[`${r},${kk},${tt}`];
    return tile && tile.z > 0 ? convexHull(T.concat(T.map((p) => project(p, tile.z)))) : T;
  };
  const addShape = (path, shape) => {
    path.moveTo(shape[0][0], shape[0][1]);
    for (let i = 1; i < shape.length; i++) path.lineTo(shape[i][0], shape[i][1]);
    path.closePath();
  };
  function eachCell(fn) {
    const rMin = Math.floor(-y0 / TH) - 2;
    const rMax = Math.ceil((H - y0) / TH) + 2;
    for (let r = rMin; r <= rMax; r++) {
      const o = x0 + ox(r);
      const kMin = Math.floor(-o / S) - 2;
      const kMax = Math.ceil((W - o) / S) + 2;
      for (let kk = kMin; kk <= kMax; kk++) for (let j = 0; j < 2; j++) fn(r, kk, j ? 'u' : 'd', j);
    }
  }
  function compositeSwitch(now) {
    const t = now - sw.t0;
    const diag = Math.hypot(W / 2, H / 2);
    const bins = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const levels = [1, 0.72, 0.42, 0.16];
    const flash = new Path2D();
    eachCell((r, kk, tt, j) => {
      const T = tri(r, kk, tt);
      const c = centroid(T);
      const dist = Math.min(1, Math.hypot(c[0] - W / 2, c[1] - H / 2) / diag);
      const grp = groupOf(r, kk, j, c);
      const u = (t - (dist * 0.55 + grp.h * 0.45) * sw.span) / sw.dur;
      const e = easeIO(clamp01(u));
      const a = sw.dir === 'in' ? e : 1 - e;
      const shape = shapeOf(r, kk, tt, T);
      if (a > 0.05) addShape(bins[a > 0.9 ? 0 : a > 0.6 ? 1 : a > 0.3 ? 2 : 3], shape);
      if (u > 0.25 && u < 0.7) addShape(flash, shape);
    });
    bins.forEach((path, i) => {
      ctx.save();
      ctx.clip(path);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = levels[i];
      ctx.drawImage(ldSnap, 0, 0);
      ctx.restore();
    });
    ctx.fillStyle = 'rgba(225, 242, 255, 0.22)';
    ctx.fill(flash);
    if (t > sw.span + sw.dur + 40) {
      power.phase = sw.dir === 'in' ? 'off' : 'on';
      const cb = sw.done;
      sw.done = null;
      if (cb) cb();
    }
  }

  /* ════════════ 새로 고침 — 누른 자리에서 충격파가 퍼지며, 지나간 칸이 새 화면으로 바뀐다 (테마 전환) ════════════ */
  const oldSnap = document.createElement('canvas');
  const oldSnapG = oldSnap.getContext('2d');
  const wave = { on: false, t0: 0, o: [0, 0], v: 2.2, done: null };
  /* 패널 하나하나가 새로 고쳐진다: 누른 자리에서 가까운 칸부터(묶음마다 조금씩 어긋나게) 잠깐 밝아졌다가 새 색으로 바뀐다.
     칸 모양(평면 삼각형)으로 나누므로 화면이 정확히 칸 단위로 바뀐다. */
  function drawRefresh(now) {
    const t = now - wave.t0;
    const bins = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const levels = [1, 0.72, 0.42, 0.16];
    const flash = new Path2D();
    let pending = false;
    eachCell((r, kk, tt, j) => {
      const T = tri(r, kk, tt);
      const c = centroid(T);
      const delay = Math.hypot(c[0] - wave.o[0], c[1] - wave.o[1]) / wave.v + groupOf(r, kk, j, c).h * 260;
      const u = (t - delay) / 380;
      if (u < 1) pending = true;
      const a = 1 - easeIO(clamp01(u)); // 옛 화면이 남은 정도
      if (a > 0.05) addShape(bins[a > 0.9 ? 0 : a > 0.6 ? 1 : a > 0.3 ? 2 : 3], T);
      if (u > 0.15 && u < 0.6) addShape(flash, T);
    });
    bins.forEach((path, i) => {
      ctx.save();
      ctx.setTransform(D, 0, 0, D, 0, 0);
      ctx.clip(path);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = levels[i];
      ctx.drawImage(oldSnap, 0, 0);
      ctx.restore();
    });
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.fillStyle = root.dataset.theme === 'dark' ? 'rgba(143, 168, 255, 0.16)' : 'rgba(255, 255, 255, 0.5)';
    ctx.fill(flash);
    if (!pending) {
      wave.on = false;
      const cb = wave.done;
      wave.done = null;
      if (cb) cb();
    }
  }

  // 꺼진 화면 — 패널 사이 이음매, 그 위에 로딩 화면, 옅은 주사선
  function drawOff(now) {
    const lp = LP();
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.fillStyle = lp.bg || paperGrad();
    ctx.fillRect(0, 0, W, H);
    if (LD.on) drawLoader(now);
    ctx.setTransform(D, 0, 0, D, 0, 0);
    gridLines(ctx, lp.grid);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = lp.scan;
    for (let y = 0; y < canvas.height; y += 3 * dpr) ctx.fillRect(0, y, canvas.width, dpr);
  }

  /* ════════════ 매 프레임 — 바뀐 게 있을 때만 다시 그린다 ════════════ */
  let dirty = true;
  let lastX = 99;
  let lastY = 99;
  function repaint() {
    readPalette();
    P.bloom = parseFloat(getComputedStyle(root).getPropertyValue('--scene-bloom')) || 0.5;
    buildCache();
    band.dirty = true;
    brand.dirty = true;
    dirty = true;
  }
  function rebuild() {
    resize();
    readPalette();
    P.bloom = parseFloat(getComputedStyle(root).getPropertyValue('--scene-bloom')) || 0.5;
    layout();
    groupCache = {};
    buildCache();
    sizeFx();
    buildScreens();
    publishGeometry();
    dirty = true;
  }
  function frame() {
    requestAnimationFrame(frame);
    const ddx = target.x - cur.x;
    const ddy = target.y - cur.y;
    if (Math.abs(ddx) + Math.abs(ddy) > 0.0006) {
      cur.x += ddx * 0.05;
      cur.y += ddy * 0.05;
    } else {
      cur.x = target.x;
      cur.y = target.y;
    }
    if (Math.abs(cur.x - lastX) + Math.abs(cur.y - lastY) > 0.0004) {
      lastX = cur.x;
      lastY = cur.y;
      dirty = true;
      root.style.setProperty('--px', cur.x.toFixed(4));
      root.style.setProperty('--py', cur.y.toFixed(4));
    }
    const now = performance.now();
    const animating = power.phase !== 'on' || tr.live || wave.on || LD.on;
    if (!dirty && !animating) return;
    dirty = false;
    if (tr.live) stepTransition(now);
    if ((power.phase === 'boot' || power.phase === 'up') && now - power.t0 > power.spec.end + 50) power.phase = 'on';
    if (power.phase === 'down' && now - power.t0 > power.spec.last + power.spec.dur + 60) {
      power.phase = 'black';
      if (power.spec.done) power.spec.done();
    }
    if (power.phase === 'black') {
      ctx.setTransform(D, 0, 0, D, 0, 0);
      ctx.fillStyle = OFF_FILL;
      ctx.fillRect(0, 0, W, H);
      gridLines(ctx, DARK_LINE);
      return;
    }
    if (power.phase === 'off') {
      drawOff(now);
      edgeFX();
      return;
    }
    if (power.phase === 'switch') {
      // 로딩 화면을 먼저 그려 사본으로 두고, 배경 위에 칸마다 덮는다
      drawOff(now);
      if (ldSnap.width !== canvas.width || ldSnap.height !== canvas.height) {
        ldSnap.width = canvas.width;
        ldSnap.height = canvas.height;
      }
      ldSnapG.drawImage(canvas, 0, 0);
    }
    drawScene();
    ctx.setTransform(D, 0, 0, D, 0, 0);
    if (power.phase === 'boot' || power.phase === 'up' || power.phase === 'down') drawCover(now);
    if (power.phase === 'switch') compositeSwitch(now);
    edgeFX();
    if (power.phase === 'on') drawBrandOnScene();
    if (wave.on) drawRefresh(now);
  }
  function drawBrandOnScene() {
    if (brand.dirty) paintBrand();
    blitBand(brand, brand.yTop, 1, ON);
    ctx.setTransform(D, 0, 0, D, 0, 0);
  }
  function drawScene() {
    const sunk = [];
    const raised = [];
    for (const t of Object.values(tiles)) {
      if (t.z < 0) sunk.push(t);
      else if (t.z > 0) raised.push(t);
    }
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.fillStyle = paperGrad();
    ctx.fillRect(0, 0, W, H);
    const walls = collectWalls(sunk.concat(raised));
    drawSunkenPass(sunk, walls);
    ctx.setTransform(D, 0, 0, D, 0, 0);
    ctx.drawImage(cache.ground, 0, 0, W, H);
    drawRaisedPass(raised, walls);
    // 구동·전환 중에는 패널과 함께 덮이도록 여기서, 다 켜진 뒤에는 렌즈를 거치지 않게 맨 위에 그린다
    if (power.phase !== 'on') drawBrandOnScene();
    bloom();
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
    document.querySelector('.world').appendChild(canvas);
    const gr = document.querySelector('.grain');
    if (gr) grain(gr);
    rebuild();
    let pending = 0;
    window.addEventListener('resize', () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(rebuild);
    });
    new MutationObserver(repaint).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        band.dirty = true;
        brand.dirty = true;
        dirty = true;
      });
    }
    requestAnimationFrame(frame);
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.Scene = {
    /** 왼쪽 위 로고: { type, device } */
    setBrand(info) {
      const key = JSON.stringify(info);
      if (key === brand.key) return;
      brand.key = key;
      brand.info = info;
      brand.dirty = true;
      dirty = true;
    },
    /** 띠 바닥면 문구: { code, right } */
    setBand(info) {
      const key = JSON.stringify(info);
      if (key === band.key) return;
      band.key = key;
      band.info = info;
      band.dirty = true;
      dirty = true;
    },
    /** 처음 켤 때: 검은 화면에서 패널이 켜진다. faulty = 오류 있음. UI를 띄울 때가 되면 끝난다 */
    boot(faulty) {
      const sp = bootSpec(faulty);
      buildLogFx(sp);
      runLog(sp);
      setPower('boot', sp);
      return wait(sp.uiAt);
    },
    /** 종료 — 패널이 가장자리부터 차례로 꺼지고 검은 화면이 된다 */
    shutdown() {
      return new Promise((res) => {
        setPower('down', { dir: 'off', faults: false, start: 0, last: 1100, dur: 500, done: () => setTimeout(res, 350) });
      });
    },
    /** 배경 재정렬 — 화면을 바꿀 때 */
    arrange(name, seed) {
      return transitionTo(name, seed);
    },
    /** 칸마다 채널이 바뀌듯 로딩 화면으로 넘어간다. 다 넘어가면 로딩 화면 조작 손잡이를 돌려준다 */
    toLoader(opts) {
      const handle = this.loader(opts);
      sw.dir = 'in';
      sw.t0 = performance.now();
      power.phase = 'switch';
      dirty = true;
      return new Promise((res) => (sw.done = () => res(handle)));
    },
    /** 로딩 화면에서 새 배치의 배경으로 칸마다 넘어온다 */
    fromLoader(name, seed) {
      curLayout = name;
      curSeed = seed || '';
      tiles = layoutMap(name);
      buildCache();
      sw.dir = 'out';
      sw.t0 = performance.now();
      power.phase = 'switch';
      dirty = true;
      return new Promise((res) => {
        sw.done = () => {
          LD.on = false;
          res();
        };
      });
    },
    /** 새로 고침 — (clientX, clientY)에서 충격파가 퍼지며 지나간 칸이 새 화면으로. apply()가 화면을 바꾼다 */
    refresh(clientX, clientY, apply) {
      if (oldSnap.width !== canvas.width || oldSnap.height !== canvas.height) {
        oldSnap.width = canvas.width;
        oldSnap.height = canvas.height;
      }
      oldSnapG.drawImage(canvas, 0, 0);
      const cxw = innerWidth / 2 + (clientX - innerWidth / 2) / SCALE;
      const cyw = innerHeight / 2 + (clientY - innerHeight / 2) / SCALE;
      apply();
      repaint();
      wave.o = [cxw / k, cyw / k];
      wave.t0 = performance.now();
      wave.on = true;
      dirty = true;
      return new Promise((res) => (wave.done = res));
    },
    /** 꺼진 패널 화면에 로딩 화면을 띄운다 */
    loader(opts) {
      Object.assign(LD, { on: true, t0: performance.now(), cap: opts.cap || 'MCES', status: opts.status || '불러오는 중', task: opts.task || '', taskAt: performance.now(), target: 0, shown: 0, doneAt: 0, mark: opts.mark || 'paper', lastEvt: performance.now(), finishing: false, lastFrame: 0 });
      dirty = true;
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
