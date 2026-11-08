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
    const out = {};
    for (const grp of LAYOUT) {
      const rA = grp.row === 'T' ? rows.top : rows.bottom;
      let cA = grp.side === 'L' ? cols.left : cols.right;
      if (mod2(rA + cA) !== grp.par) cA += grp.side === 'L' ? -1 : 1;
      for (const [dr, c0, c1, st] of grp.cells) {
        const r = rA + dr;
        const to = c1 === null ? cols.right + 3 : cA + c1;
        for (let c = cA + c0; c <= to; c++) {
          const f = fromC(r, c);
          out[`${r},${f.k},${f.t}`] = { r, k: f.k, t: f.t, z: st > 0 ? ON : OFF };
        }
      }
    }
    // 띠의 왼쪽·오른쪽 끝 (글자 자리를 정할 때 쓴다)
    bandLeft = cols.left + (mod2(rows.top + cols.left) !== 1 ? -1 : 0) + BAND_FROM_LEFT;
    bandRight = cols.right + (mod2(rows.top + cols.right) !== 0 ? 1 : 0) + LAYOUT[1].cells[0][1];
    tiles = out;
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
    for (const t of up) gTri(g, t.T.map((p) => [p[0] + 4, p[1] + 16]));
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
  const band = { cv: document.createElement('canvas'), dirty: true, info: null };
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
    const cy = Math.max(18 * u, (yt + TH - seen) / 2 / (1 + OFF * KP));
    // 왼쪽: 단말 상태 원 · 경로 문구 · 터널 신호
    const x = PAD + Math.max(W * 0.19, bandStartX() + 36 * u);
    const okState = info.ok !== false;
    g.beginPath();
    g.arc(x + 16 * u, cy, 16 * u, 0, Math.PI * 2);
    g.fillStyle = okState ? P.chip : P.bad;
    g.fill();
    g.strokeStyle = '#fff';
    g.lineWidth = 1.8 * u;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    if (okState) {
      g.moveTo(x + 9.5 * u, cy + 0.5 * u);
      g.lineTo(x + 14.5 * u, cy + 5.5 * u);
      g.lineTo(x + 23 * u, cy - 5 * u);
    } else {
      g.moveTo(x + 11 * u, cy - 5 * u);
      g.lineTo(x + 21 * u, cy + 5 * u);
      g.moveTo(x + 21 * u, cy - 5 * u);
      g.lineTo(x + 11 * u, cy + 5 * u);
    }
    g.stroke();
    const tw = Math.max(text(g, info.tag || '[MCES ROUTE]', x + 44 * u, cy - 7 * u, 11, { weight: 600, track: 0.5 }), text(g, info.line || '', x + 44 * u, cy + 8 * u, 11, { color: okState ? P.ink2 : P.bad }));
    wifi(g, x + (44 + 18) * u + tw, cy - 3 * u, info.link ? P.ink : P.faint);
    // 오른쪽: 코드와 PC 사양 — 띠 오른쪽 끝(켜진 사선이 시작하는 곳) 앞에서 끝낸다
    const re = fromC(rows.top + 1, bandRight);
    const reX = Math.min(...tri(rows.top + 1, re.k, re.t).map((q) => q[0]));
    const rx = PAD + Math.min(W * 0.86, reX - 150 * u);
    text(g, info.code || 'MC.ES', rx, cy - 7 * u, 15, { weight: 800, align: 'right' });
    g.fillStyle = P.gold;
    g.fillRect(rx - g.measureText(info.code || 'MC.ES').width - 14 * u, cy - 13 * u, 2 * u, 12 * u);
    text(g, info.right || '', rx, cy + 10 * u, 10, { align: 'right', color: P.ink2, mono: true });
    // 가운데: 메인 시스템 표식 — 워드마크와 금색 마름모. 왼쪽·오른쪽 글자 사이에 자리가 있을 때만
    const leftEnd = x + (44 + 40) * u + tw;
    g.font = `400 ${10 / k}px ${MONO}`;
    const rightStart = rx - Math.max(g.measureText(info.right || '').width, 120 * u);
    const cx = (leftEnd + rightStart) / 2;
    if (rightStart - leftEnd > 240 * u) {
      text(g, 'SCRF', cx, cy - 6 * u, 17, { weight: 800, align: 'center', track: 6 });
      text(g, 'SECTOR A · MCES', cx, cy + 11 * u, 9, { mono: true, align: 'center', color: P.ink2, track: 2 });
      g.fillStyle = P.gold;
      g.strokeStyle = P.gold;
      g.lineWidth = u;
      for (const sd of [-1, 1]) {
        const gx = cx + sd * 46 * u;
        g.beginPath();
        g.moveTo(gx, cy - 10 * u);
        g.lineTo(gx + 3.5 * u, cy - 6.5 * u);
        g.lineTo(gx, cy - 3 * u);
        g.lineTo(gx - 3.5 * u, cy - 6.5 * u);
        g.closePath();
        g.fill();
        g.beginPath();
        g.moveTo(gx + sd * 8 * u, cy - 6.5 * u);
        g.lineTo(gx + sd * 30 * u, cy - 6.5 * u);
        g.stroke();
      }
    }
    band.dirty = false;
  }
  const BEND = 22;
  const SHRINK = 0.16;
  const STRIPS = 48;
  function bandPoint(yTop, sign, x, y) {
    const w = W + PAD * 2;
    const u = x / w;
    const t = (2 * u - 1) * (2 * u - 1);
    const p = project([x - PAD, yTop + y], OFF);
    const m = project([x - PAD, yTop + TH / 2], OFF);
    const mid = m[1] + sign * BEND * t;
    return [p[0], mid + (p[1] - m[1]) * (1 - SHRINK * t)];
  }
  function blitBand(b, yTop, sign) {
    if (b.dirty) paintBand();
    const w = W + PAD * 2;
    const sw = w / STRIPS;
    ctx.save();
    for (let i = 0; i < STRIPS; i++) {
      const xa = i * sw;
      const xb = xa + sw;
      const o = bandPoint(yTop, sign, xa, 0);
      const u = bandPoint(yTop, sign, xb, 0);
      const v = bandPoint(yTop, sign, xa, TH);
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

  /* ════════════ 매 프레임 — 바뀐 게 있을 때만 다시 그린다 ════════════ */
  let dirty = true;
  let lastX = 99;
  let lastY = 99;
  function rebuild() {
    resize();
    readPalette();
    P.bloom = parseFloat(getComputedStyle(root).getPropertyValue('--scene-bloom')) || 0.5;
    layout();
    buildCache();
    sizeFx();
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
    if (!dirty) return;
    dirty = false;
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
    bloom();
    edgeFX();
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
    new MutationObserver(rebuild).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => {
        band.dirty = true;
        dirty = true;
      });
    }
    requestAnimationFrame(frame);
  }

  window.Scene = {
    /** 띠 바닥면 문구: { ok, tag, line, link, code, right } */
    setBand(info) {
      const key = JSON.stringify(info);
      if (key === band.key) return;
      band.key = key;
      band.info = info;
      band.dirty = true;
      dirty = true;
    },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
