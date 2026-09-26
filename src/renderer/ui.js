'use strict';
/* 작은 DOM 도우미와 조작 요소들. 문자열은 전부 textContent로 넣는다(외부 데이터 안전). */

function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className += ` ${v}`;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    // CSS 변수는 표현 속성이 아니라 style 로 넣어야 확실히 풀린다
    if (typeof v === 'string' && v.includes('var(')) el.style.setProperty(k, v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c) el.appendChild(c);
  return el;
}

const $ = (sel, root = document) => root.querySelector(sel);

// ---------- 형식 ----------
const fmt = {
  gb(mb) {
    return `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)}GB`;
  },
  bytes(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
    return `${(n / 1024 ** 3).toFixed(2)}GB`;
  },
  num(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  },
  date(ms) {
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
  time(ms) {
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },
  uptime(ms) {
    const s = Math.floor(ms / 1000);
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    return hh ? `${hh}시간 ${mm}분` : `${mm}분`;
  },
};

// ---------- 조작 요소 ----------
/** 올라온 버튼. kind: 'primary' | 'danger' | 'ghost' */
function button(label, onClick, { kind, icon, disabled, title, small, class: cls } = {}) {
  const b = h(`button.btn${kind ? `.btn-${kind}` : ''}${small ? '.btn-sm' : ''}`, { type: 'button', disabled, title, onclick: onClick, class: cls }, icon ? h('span.ico', null, icon) : null, label ? h('span.txt', null, label) : null);
  return b;
}

/** 분할 선택: 바탕이 올라오고 고른 칸만 내려간다. */
function seg(options, value, onChange, { name } = {}) {
  const wrap = h('div.seg', { role: 'radiogroup', 'aria-label': name });
  const render = (v) => {
    wrap.replaceChildren(
      ...options.map((o) =>
        h(
          `button.seg-item${o.value === v ? '.on' : ''}`,
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(o.value === v),
            disabled: o.disabled,
            title: o.hint,
            onclick: () => {
              render(o.value);
              onChange(o.value);
            },
          },
          h('span.txt', null, o.label),
          o.sub ? h('span.seg-sub', null, o.sub) : null,
        ),
      ),
    );
  };
  render(value);
  wrap.setValue = render;
  return wrap;
}

function toggle(checked, onChange, { label } = {}) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
  return h('label.switch', null, input, h('span.track', null, h('span.knob')), label ? h('span.txt', null, label) : null);
}

function checkbox(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
  return h('label.check', null, input, h('span.box'), h('span.txt', null, label));
}

/** 슬라이더: 레일 홈 + 포인트 색 손잡이. format 으로 값 표시 */
function slider({ min, max, step = 1, value, onInput, format = (v) => v, marks }) {
  const out = h('span.slider-val.num', null, format(value));
  const input = h('input.range', {
    type: 'range',
    min,
    max,
    step,
    value,
    oninput: (e) => {
      const v = Number(e.target.value);
      out.textContent = format(v);
      paint();
      onInput(v);
    },
  });
  const paint = () => {
    const p = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty('--p', `${p}%`);
  };
  paint();
  const wrap = h('div.slider', null, input, out);
  if (marks) {
    wrap.appendChild(
      h(
        'div.slider-marks',
        null,
        marks.map((m) => h('span.mark', { style: { left: `${((m.value - min) / (max - min)) * 100}%` }, title: m.label }, h('i'), h('em', null, m.label))),
      ),
    );
  }
  wrap.set = (v) => {
    input.value = v;
    out.textContent = format(v);
    paint();
  };
  return wrap;
}

function select(options, value, onChange) {
  return h(
    'div.select',
    null,
    h(
      'select',
      { onchange: (e) => onChange(e.target.value) },
      options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
    ),
  );
}

function input(value, onInput, attrs = {}) {
  return h('input.field', { value: value ?? '', oninput: (e) => onInput(e.target.value), ...attrs });
}

/** 설정 한 줄: 제목 + 설명 + 조작 요소 */
function row(title, desc, control) {
  return h('div.row', null, h('div.row-label', null, h('div.row-title', null, title), desc ? h('div.row-desc', null, desc) : null), h('div.row-control', null, control));
}

function dot(state) {
  return h(`span.dot.dot-${state}`, { 'aria-hidden': 'true' });
}

function progressBar(p) {
  const bar = h('div.progress', null, h('div.progress-fill', { style: { width: `${Math.round((p || 0) * 100)}%` } }));
  bar.set = (x) => (bar.firstChild.style.width = `${Math.round((x || 0) * 100)}%`);
  return bar;
}

// ---------- 알림 ----------
function toast(message, { kind = 'info', timeout = 4200 } = {}) {
  const el = h(`div.toast.toast-${kind}`, null, h('span.txt', null, message));
  $('#toasts').appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 400);
  }, timeout);
}

/** 확인 창. actions: [{label, kind, value}] → 고른 value 로 resolve */
function modal({ title, body, actions }) {
  const overlay = $('#overlay');
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.hidden = true;
      overlay.replaceChildren();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);
    const card = h(
      'div.modal',
      { role: 'dialog', 'aria-modal': 'true' },
      h('h3.modal-title', null, title),
      h('div.modal-body', null, body),
      h('div.modal-actions', null, actions.map((a) => button(a.label, () => close(a.value), { kind: a.kind }))),
    );
    overlay.replaceChildren(card);
    overlay.hidden = false;
    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };
    const first = card.querySelector('.btn-primary, .btn-danger');
    if (first) first.focus();
  });
}

/** IPC 호출. 실패하면 쉬운 말로 알림을 띄우고 undefined 를, 돌려줄 값이 없는 성공은 true 를 돌려준다. */
async function call(channel, ...args) {
  const r = await window.mc.invoke(channel, ...args);
  if (!r.ok) {
    toast(r.error, { kind: 'error', timeout: 7000 });
    return undefined;
  }
  return r.data === undefined ? true : r.data;
}

window.UI = { h, svg, $, append, fmt, button, seg, toggle, checkbox, slider, select, input, row, dot, progressBar, toast, modal, call };
