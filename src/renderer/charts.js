'use strict';
/* 그래프 — SCRF 테마
   - 면적 그래프: 꺼진 바닥 위의 가로 눈금, 옅은 코발트 면과 코발트 선, 지금 값 점, 한도는 금색 선 하나
   - 원호 게이지: 270° 눈금 홈 위에 코발트 호, 가운데 고정폭 숫자. 발광·색수차는 쓰지 않는다(평소 화면은 조용하게) */
(function () {
  const { svg } = window.UI;
  let uid = 0;

  function smoothPath(pts) {
    if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : '';
    let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const cx = (x0 + x1) / 2;
      d += ` C${cx.toFixed(1)},${y0.toFixed(1)} ${cx.toFixed(1)},${y1.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
    }
    return d;
  }

  /** 측정값을 구간 평균으로 줄여 능선을 매끈하게 (웹 프리뷰처럼 굵직한 굴곡만 남긴다) */
  function bucket(vals, n) {
    if (vals.length <= n) return vals;
    const out = [];
    for (let b = 0; b < n; b++) {
      const from = Math.floor((b * vals.length) / n);
      const to = Math.max(from + 1, Math.floor(((b + 1) * vals.length) / n));
      const part = vals.slice(from, to);
      out.push(part.reduce((a, v) => a + v, 0) / part.length);
    }
    // 마지막 점은 지금 값 그대로
    out[out.length - 1] = vals[vals.length - 1];
    return out;
  }

  const stop = (offset, color, opacity) => svg('stop', { offset, 'stop-color': color, 'stop-opacity': opacity });

  /**
   * 면적 그래프 — SCRF 어법: 옅은 코발트 면 + 코발트 선 + 지금 값 점, 할당 한도는 금색 선 하나
   * @param {{max:number, min?:number, tag?:string, axis?:(n:number)=>[string,string]}} o
   *   axis: 점 개수를 받아 [왼쪽 눈금, 가운데 눈금] 글자를 돌려준다
   */
  function ridge(o) {
    const id = `r${++uid}`;
    let W = 820;
    let H = 300;
    const root = svg('svg', { class: 'c-area', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
    const defs = svg(
      'defs',
      {},
      svg('linearGradient', { id: `${id}-face`, x1: 0, y1: 0, x2: 0, y2: 1 }, stop('0%', 'var(--accent)', 0.2), stop('100%', 'var(--accent)', 0)),
      svg('linearGradient', { id: `${id}-line`, x1: 0, y1: 0, x2: 1, y2: 0 }, stop('0%', 'var(--scrf-gray-2)'), stop('55%', 'var(--scrf-cobalt-light)'), stop('100%', 'var(--accent)')),
    );
    const P = (cls, attrs = {}) => svg('path', { class: cls, fill: 'none', ...attrs });
    const grid = P('v-grid');
    const ceil = P('v-ceil');
    const face = P('face', { fill: `url(#${id}-face)` });
    const line = P('ridge', { stroke: `url(#${id}-line)` });
    const now = svg('circle', { class: 'v-now', r: 4 });
    const tag = svg('text', { class: 'v-tag' });
    tag.textContent = o.tag || '';
    const axisL = svg('text', { class: 'v-axis' });
    const axisM = svg('text', { class: 'v-axis', 'text-anchor': 'middle' });
    const axisR = svg('text', { class: 'v-axis', 'text-anchor': 'end' });
    axisR.textContent = '지금';
    root.append(defs, grid, ceil, face, line, now, tag, axisL, axisM, axisR);

    let last = [];
    root.update = (values) => {
      last = values;
      const box = root.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        W = box.width;
        H = box.height;
        root.setAttribute('viewBox', `0 0 ${W} ${H}`);
      }
      const top = 34;
      const bottom = H - 34;
      tag.setAttribute('x', 16);
      tag.setAttribute('y', 22);
      axisL.setAttribute('x', 16);
      axisL.setAttribute('y', H - 12);
      axisM.setAttribute('x', W / 2);
      axisM.setAttribute('y', H - 12);
      axisR.setAttribute('x', W - 16);
      axisR.setAttribute('y', H - 12);
      // 가로 눈금 네 줄 (한도 · 3/4 · 1/2 · 1/4)
      let gd = '';
      for (const f of [0.25, 0.5, 0.75, 1]) {
        const y = (bottom - (bottom - top) * f).toFixed(1);
        gd += `M0,${y} L${W},${y} `;
      }
      grid.setAttribute('d', gd);
      ceil.setAttribute('d', `M0,${top} L${W},${top}`);

      let vals = values.filter((v) => v !== null && v !== undefined);
      if (vals.length === 1) vals = [vals[0], vals[0]]; // 첫 측정값 하나만 있어도 평평한 선
      vals = bucket(vals, Math.max(8, Math.min(40, Math.round(W / 24))));
      const [aL, aM] = o.axis ? o.axis(values.length) : ['', ''];
      axisL.textContent = vals.length ? aL : '';
      axisM.textContent = vals.length ? aM : '';
      axisR.style.display = vals.length ? '' : 'none';
      if (vals.length < 2) {
        for (const p of [face, line]) p.setAttribute('d', '');
        now.style.display = 'none';
        return;
      }
      const min = o.min ?? 0;
      const max = Math.max(o.max || 0, ...vals) || 1;
      const pts = vals.map((v, i) => [(i / (vals.length - 1)) * W, bottom - ((v - min) / (max - min)) * (bottom - top)]);
      const d = smoothPath(pts);
      face.setAttribute('d', `${d} L${W},${H} L0,${H} Z`);
      line.setAttribute('d', d);
      const [lx, ly] = pts[pts.length - 1];
      now.style.display = '';
      now.setAttribute('cx', (lx - 5).toFixed(1));
      now.setAttribute('cy', ly.toFixed(1));
    };
    if (window.ResizeObserver) new ResizeObserver(() => root.update(last)).observe(root);
    return root;
  }

  /**
   * 270° 원호 게이지
   * @param {{max:number, label:string}} o
   * update(value, text, level) — level: 'good'|'warn'|'bad'
   */
  function gauge(o) {
    const arc = 'M 31.82 108.18 A 54 54 0 1 1 108.18 108.18';
    const root = svg('svg', { class: 'gauge-svg', viewBox: '0 0 140 140', role: 'img' });
    const value = svg('path', { class: 'value', d: arc, pathLength: 100 });
    const num = svg('text', { class: 'g-num', x: 70, y: 78, 'text-anchor': 'middle' });
    const unit = svg('text', { class: 'g-unit', x: 70, y: 100, 'text-anchor': 'middle' });
    root.append(
      svg('path', { class: 'track', d: arc, pathLength: 100 }),
      svg('path', { class: 'ticks', d: arc, pathLength: 100 }),
      value,
      num,
      unit,
    );
    const caption = document.createElement('figcaption');
    caption.textContent = o.label;
    const fig = document.createElement('figure');
    fig.className = 'gauge';
    fig.append(root, caption);
    fig.update = (v, text, level = 'good', unitText = '') => {
      if (v === null || v === undefined || Number.isNaN(v)) {
        value.style.strokeDasharray = '0 100';
        value.style.opacity = '0';
        num.textContent = '–';
        unit.textContent = '';
        fig.dataset.level = 'off';
        return;
      }
      const pct = Math.max(0, Math.min(100, (v / o.max) * 100));
      value.style.opacity = '1';
      value.style.strokeDasharray = `${pct.toFixed(2)} 100`;
      num.textContent = text;
      unit.textContent = unitText;
      fig.dataset.level = level;
    };
    fig.update(null);
    return fig;
  }

  window.Charts = { ridge, gauge };
})();
