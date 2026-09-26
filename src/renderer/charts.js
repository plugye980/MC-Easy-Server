'use strict';
/* 그래프 — "형태 없는 결" 웹 프리뷰와 같은 어법
   - 면적 그래프: 한 단 낮은 판 위에 고원(plateau) 면 → 능선 그늘 → 능선 빛 → 계단 2단(면·그늘·끝선·빛) → 능선 → 마디
     면에는 아주 옅은 색수차, 판 안쪽에 큰 캡션과 시간 눈금
   - 원호 게이지: 270° 홈(빛 → 그늘 → 바닥) 위에 발광 호, 가운데 숫자 */
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
   * 면적 그래프
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
      svg('linearGradient', { id: `${id}-plateau`, x1: 0, y1: 0, x2: 0, y2: 1 }, stop('0%', 'var(--tier-1)'), stop('62%', 'var(--tier-1)'), stop('100%', 'var(--face-b)')),
      svg('linearGradient', { id: `${id}-line`, x1: 0, y1: 0, x2: 1, y2: 0 }, stop('0%', 'var(--r1)'), stop('52%', 'var(--r2)'), stop('100%', 'var(--r3)')),
      svg('linearGradient', { id: `${id}-deep`, x1: 0, y1: 0, x2: 1, y2: 0 }, stop('0%', 'var(--d1)'), stop('52%', 'var(--d2)'), stop('100%', 'var(--d3)')),
    );
    const P = (cls, attrs = {}) => svg('path', { class: cls, fill: 'none', ...attrs });
    const face = P('face', { fill: `url(#${id}-plateau)` });
    const shade = P('ridge-shade');
    const lit = P('ridge-lit');
    const steps = ['step-b', 'step-c'].map((k) => ({ face: P(`step-face ${k}`, { fill: null }), shade: P('step-shade'), edge: P('step-edge'), lit: P('step-lit') }));
    const line = P('ridge', { stroke: `url(#${id}-line)` });
    const markA = P('ridge-mark', { stroke: `url(#${id}-deep)` });
    const markB = P('ridge-mark ridge-mark-b', { stroke: `url(#${id}-deep)` });
    const tag = svg('text', { class: 'v-tag', 'text-anchor': 'end' });
    tag.textContent = o.tag || '';
    const axisL = svg('text', { class: 'v-axis' });
    const axisM = svg('text', { class: 'v-axis', 'text-anchor': 'middle' });
    root.append(defs, face, shade, lit, ...steps.flatMap((s) => [s.face, s.shade, s.edge, s.lit]), line, markA, markB, tag, axisL, axisM);
    const all = [face, shade, lit, line, markA, markB, ...steps.flatMap((s) => [s.face, s.shade, s.edge, s.lit])];

    let last = [];
    root.update = (values) => {
      last = values;
      const box = root.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        W = box.width;
        H = box.height;
        root.setAttribute('viewBox', `0 0 ${W} ${H}`);
      }
      tag.setAttribute('x', W - 18);
      tag.setAttribute('y', H - 16);
      axisL.setAttribute('x', 18);
      axisL.setAttribute('y', H - 16);
      axisM.setAttribute('x', W / 2);
      axisM.setAttribute('y', H - 16);

      let vals = values.filter((v) => v !== null && v !== undefined);
      if (vals.length === 1) vals = [vals[0], vals[0]]; // 첫 측정값 하나만 있어도 평평한 능선
      vals = bucket(vals, Math.max(6, Math.min(24, Math.round(W / 45))));
      const [aL, aM] = o.axis ? o.axis(values.length) : ['', ''];
      axisL.textContent = vals.length ? aL : '';
      axisM.textContent = vals.length ? aM : '';
      if (vals.length < 2) {
        for (const p of all) p.setAttribute('d', '');
        return;
      }
      const min = o.min ?? 0;
      const max = Math.max(o.max || 0, ...vals) || 1;
      // 위 18% ~ 아래 30% 사이에 능선을 두어 계단과 캡션이 들어갈 자리를 남긴다
      const top = H * 0.16;
      const span = H * 0.5;
      const pts = vals.map((v, i) => [(i / (vals.length - 1)) * W, top + (1 - (v - min) / (max - min)) * span]);
      const d = smoothPath(pts);
      const close = (dd, p) => `${dd} L${p[p.length - 1][0].toFixed(1)},${H} L${p[0][0].toFixed(1)},${H} Z`;
      face.setAttribute('d', close(d, pts));
      for (const p of [shade, lit, line]) p.setAttribute('d', d);

      // 계단: 능선 아래로 11~26px 사이에서 물결치듯 어긋나게 (일정한 간격은 계단, 어긋난 간격은 지형)
      const k = H / 300;
      let prev = pts.map(([x]) => [x, 0]);
      steps.forEach((s, si) => {
        const sp = pts.map(([x, y], i) => {
          const f = x / W;
          const wave = 18 + 7 * Math.sin(f * 7.3 + si * 1.7) + 4 * Math.sin(f * 17.1 + si);
          const off = (si === 0 ? 0 : prev[i][1]) + wave * k;
          return [x, y + off];
        });
        prev = sp.map(([x, y], i) => [x, y - pts[i][1]]);
        const sd = smoothPath(sp);
        s.face.setAttribute('d', close(sd, sp));
        for (const p of [s.shade, s.edge, s.lit]) p.setAttribute('d', sd);
      });

      // 마디: 곡선의 몇 구간만 같은 색 계열의 낮은 명도로 짚는다
      const len = line.getTotalLength ? line.getTotalLength() : W;
      markA.setAttribute('stroke-dasharray', `${(len * 0.2).toFixed(1)} 99999`);
      markA.setAttribute('stroke-dashoffset', (-len * 0.3).toFixed(1));
      markB.setAttribute('stroke-dasharray', `${(len * 0.12).toFixed(1)} 99999`);
      markB.setAttribute('stroke-dashoffset', (-len * 0.72).toFixed(1));
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
      svg('path', { class: 'track-lit', d: arc }),
      svg('path', { class: 'track-shade', d: arc }),
      svg('path', { class: 'track', d: arc }),
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
