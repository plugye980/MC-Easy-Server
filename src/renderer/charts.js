'use strict';
/* 그래프: 능선(같은 경로를 면 → 그늘 → 빛 → 선 순서로 네 번), 원호 게이지(홈 세 겹 + 발광 호) */
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

  /**
   * 능선 그래프
   * @param {{width:number,height:number,max:number,min?:number,tag?:string}} o
   */
  function ridge(o) {
    const id = `r${++uid}`;
    let W = o.width;
    let H = o.height;
    const pad = { t: 14, b: 10 };
    // 선 굵기가 늘어나지 않도록 viewBox를 실제 픽셀 크기에 맞춘다
    const root = svg('svg', { class: 'ridge', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
    const defs = svg(
      'defs',
      {},
      svg('linearGradient', { id: `${id}-face`, x1: 0, y1: 0, x2: 0, y2: 1 }, svg('stop', { offset: '0%', 'stop-color': 'var(--face-a)' }), svg('stop', { offset: '100%', 'stop-color': 'var(--face-b)' })),
      svg(
        'linearGradient',
        { id: `${id}-line`, x1: 0, y1: 0, x2: 1, y2: 0 },
        svg('stop', { offset: '0%', 'stop-color': 'var(--r1)' }),
        svg('stop', { offset: '55%', 'stop-color': 'var(--r2)' }),
        svg('stop', { offset: '100%', 'stop-color': 'var(--r3)' }),
      ),
      svg(
        'linearGradient',
        { id: `${id}-node`, x1: 0, y1: 0, x2: 1, y2: 0 },
        svg('stop', { offset: '0%', 'stop-color': 'var(--d1)' }),
        svg('stop', { offset: '55%', 'stop-color': 'var(--d2)' }),
        svg('stop', { offset: '100%', 'stop-color': 'var(--d3)' }),
      ),
    );
    const face = svg('path', { fill: `url(#${id}-face)` });
    const shade = svg('path', { fill: 'none', stroke: 'var(--ridge-shade)', 'stroke-width': 8, transform: 'translate(2 6)', filter: 'url(#f-shade)', 'stroke-linecap': 'round' });
    const lit = svg('path', { fill: 'none', stroke: 'var(--ridge-lit)', 'stroke-width': 1.8, transform: 'translate(0 -1.7)', 'stroke-linecap': 'round' });
    const line = svg('path', { fill: 'none', stroke: `url(#${id}-line)`, 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    const nodes = svg('path', { fill: 'none', stroke: `url(#${id}-node)`, 'stroke-width': 2.4, 'stroke-dasharray': '1.5 46', 'stroke-linecap': 'round' });
    const tag = svg('text', { class: 'ridge-tag', x: 14 });
    tag.textContent = o.tag || '';
    root.append(defs, tag, face, shade, lit, line, nodes);

    let last = [];
    root.update = (values) => {
      last = values;
      const box = root.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        W = box.width;
        H = box.height;
        root.setAttribute('viewBox', `0 0 ${W} ${H}`);
      }
      tag.setAttribute('y', 50);
      const vals = values.map((v) => (v === null || v === undefined ? null : v));
      const clean = vals.filter((v) => v !== null);
      if (clean.length < 2) {
        for (const p of [face, shade, lit, line, nodes]) p.setAttribute('d', '');
        return;
      }
      const min = o.min ?? 0;
      const max = Math.max(o.max || 0, ...clean) || 1;
      const n = Math.max(vals.length, 2);
      const pts = [];
      vals.forEach((v, i) => {
        if (v === null) return;
        const x = (i / (n - 1)) * W;
        const y = pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
        pts.push([x, y]);
      });
      const d = smoothPath(pts);
      face.setAttribute('d', `${d} L${pts[pts.length - 1][0]},${H} L${pts[0][0]},${H} Z`);
      for (const p of [shade, lit, line, nodes]) p.setAttribute('d', d);
    };
    if (window.ResizeObserver) new ResizeObserver(() => root.update(last)).observe(root);
    return root;
  }

  /** 반원 게이지: 홈(빛 → 그늘 → 바닥) 위에 발광 호 */
  function gauge({ size = 180, max = 20 }) {
    const W = size;
    const H = size * 0.62;
    const r = size * 0.4;
    const cx = W / 2;
    const cy = H - 8;
    const arc = (t) => {
      const a = Math.PI * (1 - t);
      return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
    };
    const path = (t) => {
      const [x0, y0] = arc(0);
      const [x1, y1] = arc(Math.max(0.0001, Math.min(1, t)));
      return `M${x0},${y0} A${r},${r} 0 0 1 ${x1},${y1}`;
    };
    const full = path(1);
    const root = svg('svg', { class: 'gauge', viewBox: `0 0 ${W} ${H}` });
    const trackLit = svg('path', { d: full, fill: 'none', stroke: 'var(--hi-strong)', 'stroke-width': 9, transform: 'translate(0 2.4)', 'stroke-linecap': 'round' });
    const trackShade = svg('path', { d: full, fill: 'none', stroke: 'var(--lo-strong)', 'stroke-width': 9, transform: 'translate(0 -2.2)', filter: 'url(#f-soft)', 'stroke-linecap': 'round' });
    const track = svg('path', { d: full, fill: 'none', stroke: 'var(--groove)', 'stroke-width': 7, 'stroke-linecap': 'round' });
    const value = svg('path', { class: 'gauge-value', fill: 'none', 'stroke-width': 5, 'stroke-linecap': 'round' });
    root.append(trackLit, trackShade, track, value);
    root.update = (v) => {
      if (v === null || v === undefined) {
        value.setAttribute('d', '');
        return;
      }
      const t = v / max;
      value.setAttribute('d', path(t));
      value.dataset.level = v >= 18 ? 'good' : v >= 14 ? 'mid' : 'bad';
    };
    return root;
  }

  /** 표 안의 작은 능선(면 + 끝선의 빛 + 그늘) */
  function spark(values, { width = 90, height = 26 } = {}) {
    const root = svg('svg', { class: 'spark', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' });
    const clean = values.filter((v) => v !== null && v !== undefined);
    if (clean.length < 2) return root;
    const max = Math.max(...clean) || 1;
    const min = Math.min(...clean);
    const pts = clean.map((v, i) => [(i / (clean.length - 1)) * width, 3 + (1 - (v - min) / (max - min || 1)) * (height - 6)]);
    const d = smoothPath(pts);
    root.append(
      svg('path', { d: `${d} L${width},${height} L0,${height} Z`, fill: 'var(--tier-2)' }),
      svg('path', { d, fill: 'none', stroke: 'var(--ridge-shade)', 'stroke-width': 4, opacity: 0.5, transform: 'translate(1 3)', filter: 'url(#f-shade-sm)' }),
      svg('path', { d, fill: 'none', stroke: 'var(--ridge-lit)', 'stroke-width': 1.1, opacity: 0.3, transform: 'translate(0 -1.4)' }),
      svg('path', { d, fill: 'none', stroke: 'var(--spark-line)', 'stroke-width': 1.4 }),
    );
    return root;
  }

  window.Charts = { ridge, gauge, spark };
})();
