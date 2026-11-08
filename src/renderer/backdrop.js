'use strict';
/* 배경 — SCRF 삼각 타일 벽 (정적)
   - 한 변 120px 정삼각형. 화면 가운데에 꼭짓점 하나가 오게 놓는다.
   - 칸 상태: 켜짐(+44 튀어나옴) / 대기(평평) / 꺼짐(−28 들어감)
   - 높이 z인 점은 가운데에서 z × 0.0022만큼 바깥으로 퍼지고 위로 z × 0.36 들린다.
   - 빛은 위(살짝 왼쪽). 높이가 다른 변에만 옆면이 생긴다.
   움직이지 않는다: 창 크기나 테마가 바뀔 때만 다시 그린다. */
(function () {
  const S = 120;
  const RH = (S * Math.sqrt(3)) / 2;
  const ON = 44;
  const OFF = -28;
  const QUIET_TOP = 110;

  /* MCES 배치 — 화면 모서리 기준(창 크기가 바뀌어도 같은 모양).
     row: 아래에서 몇째 줄, k: 오른쪽 끝에서 반 칸 단위로 몇째.
     위쪽은 서버 이름·버튼이 놓이고 왼쪽은 서버 목록이 덮으므로 비워 두고,
     오른쪽 아래에만 켜진 계단과 그 옆의 꺼진 홈을 둔다. */
  const LAYOUT = [
    // 켜진 계단
    ...[0, 1, 2, 3, 4, 5].map((k) => ({ row: 0, k, z: ON })),
    ...[0, 1, 2].map((k) => ({ row: 1, k, z: ON })),
    // 계단 옆으로 꺼진 홈
    ...[6, 7, 8, 9, 10].map((k) => ({ row: 0, k, z: OFF })),
    ...[3, 4, 5, 6].map((k) => ({ row: 1, k, z: OFF })),
  ];

  const canvas = document.createElement('canvas');
  canvas.className = 'backdrop';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');

  const mod2 = (n) => ((n % 2) + 2) % 2;
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = W / 2;
    const cy = H / 2;
    // 꼭짓점 (row 0, k 0) 이 화면 가운데
    const proj = (x, y, z) => {
      const f = 1 + z * 0.0022;
      return [cx + (x - cx) * f, cy + (y - cy) * f - z * 0.36];
    };
    const r0 = -Math.ceil(cy / RH) - 1;
    const r1 = Math.ceil((H - cy) / RH) + 1;
    const k0 = -Math.ceil(cx / (S / 2)) - 2;
    const k1 = Math.ceil((W - cx) / (S / 2)) + 2;

    // 칸의 세 꼭짓점 (평면 좌표)
    const cell = (r, k) => {
      const x = cx + (k * S) / 2;
      const yT = cy + r * RH;
      const yB = yT + RH;
      return mod2(k + r) === 0
        ? [[x, yT], [x + S / 2, yB], [x - S / 2, yB]] // 위를 향한 칸
        : [[x - S / 2, yT], [x + S / 2, yT], [x, yB]]; // 아래를 향한 칸
    };

    // 화면 안에 완전히 들어오는 줄·칸만 배치 기준으로 센다
    const lastFull = (() => {
      for (let r = r1; r >= r0; r--) if (cy + (r + 1) * RH <= H + 1) return r;
      return r1;
    })();
    const rightK = (r) => {
      for (let k = k1; k >= k0; k--) {
        const pts = cell(r, k);
        if (Math.max(...pts.map((p) => p[0])) <= W + 1) return k;
      }
      return k1;
    };
    const heights = new Map();
    const key = (r, k) => `${r},${k}`;
    for (const t of LAYOUT) {
      const r = lastFull - t.row;
      const k = rightK(r) - t.k;
      heights.set(key(r, k), t.z);
    }
    const hOf = (r, k) => heights.get(key(r, k)) || 0;

    // 이웃: 왼쪽, 오른쪽, 그리고 밑변 쪽
    const edges = (r, k) => {
      const [a, b, c] = cell(r, k);
      const up = mod2(k + r) === 0;
      return up
        ? [
            { p: [a, c], n: [r, k - 1] },
            { p: [a, b], n: [r, k + 1] },
            { p: [b, c], n: [r + 1, k] },
          ]
        : [
            { p: [a, c], n: [r, k - 1] },
            { p: [b, c], n: [r, k + 1] },
            { p: [a, b], n: [r - 1, k] },
          ];
    };

    // 바탕
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, css('--paper-top'));
    g.addColorStop(0.55, css('--paper-mid'));
    g.addColorStop(1, css('--paper-bottom'));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const floor = css('--tile-floor');
    const topA = css('--tile-top-a');
    const topB = css('--tile-top-b');
    const dark = css('--tile-wall-dark').split(',').map(Number);
    const lit = css('--tile-wall-lit').split(',').map(Number);
    const gridLine = css('--grid-line');
    const edgeLit = css('--tile-edge-lit');

    const cells = [];
    for (let r = r0; r <= r1; r++) for (let k = k0; k <= k1; k++) cells.push([r, k, hOf(r, k)]);
    // 낮은 칸부터 — 높은 칸의 윗면이 등지는 옆면을 덮는다
    cells.sort((A, B) => A[2] - B[2] || A[0] - B[0]);

    const poly = (pts) => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.closePath();
    };

    for (const [r, k, z] of cells) {
      // 옆면: 이웃이 더 낮은 변에만, 높이 차이만큼
      for (const e of edges(r, k)) {
        const zn = hOf(e.n[0], e.n[1]);
        if (zn >= z) continue;
        const [p, q] = e.p;
        const quad = [proj(p[0], p[1], zn), proj(q[0], q[1], zn), proj(q[0], q[1], z), proj(p[0], p[1], z)];
        // 옆면이 바라보는 방향: 칸 중심에서 변 쪽으로
        const [a, b, c] = cell(r, k);
        const mx = (p[0] + q[0]) / 2 - (a[0] + b[0] + c[0]) / 3;
        const my = (p[1] + q[1]) / 2 - (a[1] + b[1] + c[1]) / 3;
        const len = Math.hypot(mx, my) || 1;
        // 빛은 위·살짝 왼쪽. 아래를 보는 면은 어둡게, 위를 보는 면은 밝게
        const t = Math.max(0, Math.min(1, 0.5 - (my / len) * 0.5 - (mx / len) * 0.12));
        const col = dark.map((d, i) => Math.round(d + (lit[i] - d) * t));
        poly(quad);
        ctx.fillStyle = `rgb(${col.join(',')})`;
        ctx.fill();
      }
      // 윗면
      const pts = cell(r, k).map(([x, y]) => proj(x, y, z));
      poly(pts);
      if (z > 0) {
        const ys = pts.map((p) => p[1]);
        const tg = ctx.createLinearGradient(0, Math.min(...ys), 0, Math.max(...ys));
        tg.addColorStop(0, topA);
        tg.addColorStop(1, topB);
        ctx.fillStyle = tg;
        ctx.fill();
      } else if (z < 0) {
        ctx.fillStyle = floor;
        ctx.fill();
      }
      ctx.strokeStyle = gridLine;
      ctx.lineWidth = 0.8;
      ctx.stroke();
      // 켜진 칸 윗면의 위쪽 모서리에 흰 빛 1px
      if (z > 0) {
        const sorted = [...pts].sort((A, B) => A[1] - B[1]);
        ctx.beginPath();
        ctx.moveTo(sorted[0][0], sorted[0][1]);
        ctx.lineTo(sorted[1][0], sorted[1][1]);
        ctx.strokeStyle = edgeLit;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // 꼭짓점 X자 — 둘레 칸이 모두 대기(평평)인 꼭짓점에만, 팔은 자기 칸 안쪽으로
    const flatVertex = new Map();
    for (const [r, k, z] of cells) {
      for (const [x, y] of cell(r, k)) {
        const vk = `${Math.round(x)},${Math.round(y)}`;
        flatVertex.set(vk, (flatVertex.get(vk) ?? true) && z === 0);
      }
    }
    const arm = 10 / Math.SQRT2;
    const xs = [];
    for (const [vk, flat] of flatVertex) {
      if (!flat) continue;
      const [x, y] = vk.split(',').map(Number);
      if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
      // 맨 위 띠(서버 이름·코드 줄)에는 글자와 겹치지 않게 X자를 두지 않는다
      if (y < QUIET_TOP) continue;
      xs.push([x, y]);
    }
    const drawX = (w, color) => {
      ctx.beginPath();
      for (const [x, y] of xs) {
        ctx.moveTo(x - arm, y - arm);
        ctx.lineTo(x + arm, y + arm);
        ctx.moveTo(x + arm, y - arm);
        ctx.lineTo(x - arm, y + arm);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.lineCap = 'round';
      ctx.stroke();
    };
    drawX(4.5, css('--grid-x-glow'));
    drawX(1.1, css('--grid-x'));

    // 가장자리만 어둡게 (비네트) — 가운데는 깨끗하게
    const v = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.45, cx, cy, Math.hypot(cx, cy));
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, css('--vignette'));
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  let pending = 0;
  const schedule = () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(draw);
  };
  window.addEventListener('resize', schedule);
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  schedule();
})();
