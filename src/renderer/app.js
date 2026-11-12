'use strict';
/* MCES — 한 화면에서 서버 추가 · 관리 (Docker Desktop처럼 왼쪽 목록 + 오른쪽 상세) */
(function () {
  const { h, $, append, fmt, button, seg, toggle, checkbox, slider, select, input, row, dot, progressBar, toast, modal, call } = window.UI;
  const Charts = window.Charts;
  // replaceChildren 은 null 을 "null" 글자로 넣으므로 빈 값은 걸러낸다
  const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));

  const TYPE = {
    paper: { label: '플러그인 서버', sub: 'Paper', desc: '플러그인으로 기능 추가. 가장 가볍고 빠름', addon: '플러그인', folder: 'plugins' },
    forge: { label: '모드 서버', sub: 'Forge', desc: '모드 사용. 접속하는 쪽도 같은 모드 설치 필요', addon: '모드', folder: 'mods' },
    fabric: { label: '모드 서버', sub: 'Fabric', desc: '모드 사용. 접속하는 쪽도 같은 모드 설치 필요', addon: '모드', folder: 'mods' },
    neoforge: { label: '모드 서버', sub: 'NeoForge', desc: '모드 사용. 접속하는 쪽도 같은 모드 설치 필요', addon: '모드', folder: 'mods' },
    vanilla: { label: '바닐라 서버', sub: 'Vanilla', desc: '아무것도 넣지 않은 공식 서버', addon: '데이터팩', folder: 'datapacks' },
    hybrid: { label: '하이브리드 서버', sub: 'Arclight', desc: '플러그인과 Forge 모드를 함께 사용. 접속하는 쪽도 같은 모드 설치 필요', addon: '플러그인·모드', folder: 'plugins · mods' },
  };
  // 하이브리드 서버의 추가 기능 종류
  const ADDON_KINDS = [
    { value: 'plugin', label: '플러그인', sub: 'Paper·Spigot·Bukkit' },
    { value: 'mod', label: 'Forge 모드', sub: 'Forge' },
  ];
  const MOD_TYPES = ['forge', 'fabric', 'neoforge'];
  // 만들기 화면의 종류 카드: 모드 서버는 하나로 두고 안에서 로더(Forge 기본 · Fabric)를 고른다
  const TYPE_CARDS = [
    { key: 'paper', label: '플러그인 서버', sub: 'Paper', desc: TYPE.paper.desc },
    { key: 'mod', label: '모드 서버', sub: 'Forge · NeoForge · Fabric', desc: TYPE.forge.desc },
    { key: 'vanilla', label: '바닐라 서버', sub: 'Vanilla', desc: TYPE.vanilla.desc },
    { key: 'hybrid', label: '하이브리드 서버', sub: 'Arclight (Forge)', desc: TYPE.hybrid.desc },
  ];
  const STATUS = {
    stopped: { label: '꺼짐', dot: 'off' },
    starting: { label: '켜는 중', dot: 'busy' },
    running: { label: '켜짐', dot: 'ok' },
    stopping: { label: '저장하고 끄는 중', dot: 'busy' },
  };
  const DIFFICULTY = [
    { value: 'peaceful', label: '평화로움', hint: '몬스터 없음' },
    { value: 'easy', label: '쉬움' },
    { value: 'normal', label: '보통' },
    { value: 'hard', label: '어려움' },
  ];
  const GAMEMODE = [
    { value: 'survival', label: '서바이벌', hint: '자원을 모으며 살아남기' },
    { value: 'creative', label: '크리에이티브', hint: '무한 블록, 자유 건축' },
    { value: 'adventure', label: '모험', hint: '블록 부수기·놓기 불가' },
  ];

  const state = {
    servers: [],
    page: 'home', // home: 만들기 + 서버 목록 / server: 고른 서버 한 곳만
    selected: null, // 서버 페이지에서 보고 있는 서버 id
    tab: 'overview',
    specs: null,
    settings: { theme: 'light' },
    appInfo: { version: '', device: '' },
    tunnel: { status: 'idle', addresses: {} },
    javaInstalled: [],
    alerts: {}, // serverId -> [alert]
    consoles: {}, // serverId -> [line]
    history: {}, // serverId -> [point]
    reach: {}, // serverId -> 점검 결과
    progress: {}, // key -> {text, percent}
    addonJobs: {}, // serverId -> true (파일·모드팩을 넣는 중)
    addonFilter: {}, // serverId -> 설치된 목록 거르기 상태
    create: null,
  };
  const progressViews = new Map(); // key -> [{bar, label}]
  let live = {}; // 현재 화면의 갱신 가능한 요소들

  const server = () => state.servers.find((s) => s.id === state.selected) || null;

  /** 서버 종류 표시: 플러그인 = 네모, 모드 = 네 칸 블록, 바닐라 = 원, 하이브리드 = 네모 + 블록 */
  function typeMark(type, cls = '') {
    if (type === 'forge' || type === 'neoforge' || type === 'mod') type = 'fabric';
    // 하이브리드 = 왼쪽 네모(플러그인) + 오른쪽 블록 두 칸(모드)
    const core = type === 'fabric' ? h('span.mark-core', null, h('i'), h('i'), h('i'), h('i')) : type === 'hybrid' ? h('span.mark-core', null, h('i'), h('i'), h('i')) : h('span.mark-core');
    return h(`span.mark.mark-${TYPE[type] ? type : 'paper'}${cls}`, { 'aria-hidden': 'true' }, core);
  }

  /** 왼쪽 위 표시는 지금 보고 있는 서버(또는 만들고 있는 서버)의 종류를 따른다 */
  function brandType() {
    if (state.page === 'home' && state.createMode === 'import') {
      const d = state.importing && state.importing.det;
      return (d && d.type) || 'paper';
    }
    if (state.page === 'home') return (state.create && state.create.type) || 'paper';
    const s = server();
    return s ? s.type : 'paper';
  }

  // ---------- 시작 ----------
  async function init() {
    // 켜면 배경이 떠오르고, 그 위로 UI가 부드럽게 올라온다
    state.settings = { ...state.settings, ...((await call('app:settings')) || {}) };
    state.appInfo = (await call('app:info')) || { version: '', device: '' };
    applyTheme(state.settings.theme);
    const booting = window.Scene ? window.Scene.boot() : Promise.resolve();
    const [specs, servers, tunnel, javaInstalled] = await Promise.all([call('system:specs'), call('servers:list'), call('tunnel:state'), call('java:installed')]);
    state.specs = specs;
    state.servers = servers || [];
    state.tunnel = tunnel || state.tunnel;
    state.javaInstalled = javaInstalled || [];
    state.page = 'home';
    state.selected = null;
    subscribe();
    render();
    setInterval(autoCheck, 60 * 1000);
    await booting;
    uiIn('boot');
    setTimeout(() => root.classList.add('is-ready'), 1200);
  }

  /* ---------- 화면 전환 ----------
     UI가 아래로 내려가며 사라짐 → 새 UI가 아래에서 부드럽게 올라옴. 배경은 그대로.
     서버를 만들 때만 그 사이에 로딩 화면이 배경 위로 부드럽게 겹쳤다가 걷힌다. */
  const root = document.documentElement;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let busy = false;
  let loaderHook = null;
  function uiIn(kind = 'soft') {
    root.dataset.glitch = kind;
    root.dataset.ui = 'off';
    void document.body.offsetWidth;
    root.dataset.ui = 'in';
  }
  async function uiOut() {
    root.dataset.ui = 'out';
    await sleep(480);
    root.dataset.ui = 'off';
  }
  /** 화면 바꾸기: setup()으로 상태를 바꾸고, 배경을 재정렬한 뒤 새 UI를 띄운다 */
  async function goto(setup) {
    if (busy) return;
    busy = true;
    await uiOut();
    setup();
    render();
    uiIn('soft');
    busy = false;
  }
  /** 로딩 화면을 띄운 채 일을 한다 — 만들기 · 가져오기. 끝나면 로딩 화면을 걷고 setup으로 화면을 정한다 */
  async function runLoad({ cap, status, mark, work, progressKey }) {
    root.classList.add('is-loading');
    await uiOut();
    if (!window.Scene) return work();
    const ld = await window.Scene.toLoader({ cap, status, mark, task: '준비 중' });
    if (progressKey) loaderHook = { key: progressKey, fn: (p) => ld.progress(p.percent, p.text) };
    let result;
    // 로고가 다 그려질 시간은 항상 보장해 연출이 끊기지 않게 한다
    await Promise.all([(async () => (result = await work()))(), sleep(2300)]);
    loaderHook = null;
    await ld.finish();
    return result;
  }
  async function leaveLoader(setup) {
    setup();
    render();
    if (window.Scene) await window.Scene.fromLoader();
    root.classList.remove('is-loading');
    uiIn('soft');
  }
  /** 서버 목록에서 고르면: UI가 내려갔다가 그 서버 페이지가 올라온다 (이미 만든 서버는 로딩 없이) */
  function openServer(id) {
    if (!state.servers.find((x) => x.id === id)) return;
    goto(() => {
      state.page = 'server';
      state.selected = id;
      state.tab = 'overview';
    });
  }
  /* ESC — 서버 페이지에서는 뒤로, 메인에서는 종료 화면.
     종료: 확인 → UI가 아래로 내려가며 사라짐 → 패널 화면이 가장자리부터 차례로 꺼짐 → 앱 종료 */
  document.addEventListener('keydown', async (e) => {
    if (e.key !== 'Escape' || busy || root.dataset.ui !== 'in') return;
    if (!$('#overlay').hidden || document.querySelector('.closing')) return;
    if (state.page === 'server') return goHome();
    const running = state.servers.filter((s) => s.status !== 'stopped').length;
    const ok = await modal({
      title: 'MCES 종료',
      body: h('p', null, running ? `켜져 있는 서버 ${running}개는 저장하고 안전하게 끈 뒤 종료합니다.` : '단말을 종료합니다.'),
      actions: [{ label: '취소', value: false }, { label: '종료', value: true, kind: 'danger' }],
    });
    if (!ok) return;
    busy = true;
    root.dataset.ui = 'exit';
    await sleep(750);
    if (window.Scene) await window.Scene.shutdown();
    await call('app:quit');
  });

  /** 서버 페이지의 뒤로 나가기 → 만들기 페이지 */
  function goHome() {
    goto(() => {
      state.page = 'home';
      state.selected = null;
    });
  }

  /* 테마 바꾸기 — 테마 버튼 자리에서 배경 패널이 번지듯 새 색으로 바뀌고, UI 판은 그동안 함께 천천히 색이 섞인다.
     바뀌는 도중에 또 누르면 마지막으로 고른 테마만 기억했다가, 지금 전환이 끝난 뒤 이어서 바꾼다 */
  let themeBusy = false;
  let themeWant = null;
  async function setTheme(theme) {
    themeWant = theme;
    state.settings = { ...state.settings, theme };
    if (themeBusy) return;
    themeBusy = true;
    while (themeWant && themeWant !== root.dataset.theme) {
      const next = themeWant;
      if (!window.Scene) {
        applyTheme(next);
        break;
      }
      // 배경과 UI 색이 함께 천천히 섞인다 (styles.css 의 .theme-fade)
      root.classList.add('theme-fade');
      void document.body.offsetWidth;
      applyTheme(next);
      await sleep(950);
      root.classList.remove('theme-fade');
      if (live.updateMetrics) live.updateMetrics();
    }
    themeWant = null;
    themeBusy = false;
    // 창 제목 줄(운영체제가 그린다)은 패널이 다 바뀐 뒤에 바꾼다 — 먼저 바뀌면 어색하다
    state.settings = (await call('app:setSettings', { theme: root.dataset.theme })) || state.settings;
  }
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
  }

  function subscribe() {
    const mc = window.mc;
    mc.on('server:update', (s) => {
      const i = state.servers.findIndex((x) => x.id === s.id);
      const prev = i >= 0 ? state.servers[i] : null;
      if (i >= 0) state.servers[i] = s;
      else state.servers.push(s);
      renderSide();
      if (s.id === state.selected) {
        renderHead();
        if (state.tab === 'overview' || state.tab === 'players') renderTab();
      }
      if (prev && prev.status !== 'running' && s.status === 'running') {
        toast(`${s.name} 켜짐`, { kind: 'ok' });
        setTimeout(() => checkReach(s.id), 4000);
      }
    });
    mc.on('server:removed', ({ serverId }) => {
      state.servers = state.servers.filter((s) => s.id !== serverId);
      if (state.selected === serverId) {
        state.page = 'home';
        state.selected = null;
      }
      render();
    });
    mc.on('server:console', (e) => {
      const list = (state.consoles[e.serverId] = state.consoles[e.serverId] || []);
      list.push(e);
      if (list.length > 2000) list.shift();
      if (e.serverId === state.selected && live.console) appendConsole(live.console, e);
    });
    mc.on('server:metrics', (e) => {
      const list = (state.history[e.serverId] = state.history[e.serverId] || []);
      list.push(e.point);
      if (list.length > 180) list.shift();
      const s = state.servers.find((x) => x.id === e.serverId);
      if (s) s.metrics = { tps: e.tps, memoryMb: e.memoryMb, processMb: e.processMb, cpu: e.cpu };
      if (e.serverId === state.selected && live.updateMetrics) live.updateMetrics();
      if (e.serverId === state.selected && live.updateStats) live.updateStats();
    });
    mc.on('server:alert', (a) => {
      const list = (state.alerts[a.serverId] = state.alerts[a.serverId] || []);
      list.unshift(a);
      if (list.length > 5) list.pop();
      if (a.serverId === state.selected) renderAlerts();
      else toast(`${nameOf(a.serverId)}: ${a.title}`, { kind: a.severity === 'error' ? 'error' : 'info' });
    });
    mc.on('players:changed', ({ serverId }) => {
      if (serverId === state.selected && state.tab === 'players') renderTab();
    });
    mc.on('backups:changed', ({ serverId }) => {
      if (serverId === state.selected && state.tab === 'backups') renderTab();
    });
    mc.on('tunnel:state', (t) => {
      state.tunnel = t;
      renderBand();
      if (state.page === 'server') renderAddress();
    });
    mc.on('progress', (p) => {
      state.progress[p.key] = p;
      if (loaderHook && loaderHook.key === p.key) loaderHook.fn(p);
      for (const v of progressViews.get(p.key) || []) {
        v.bar.set(p.percent);
        if (v.label) v.label.textContent = p.text || '';
      }
    });
    mc.on('app:notice', (n) => toast(`${n.title}${n.message ? ` — ${n.message}` : ''}`, { kind: n.severity === 'error' ? 'error' : 'info', timeout: 6000 }));
    mc.on('app:closing', ({ message }) => {
      document.body.appendChild(h('div.closing', null, h('div.card.card-lg.stack', null, h('div.inline', { style: { justifyContent: 'center' } }, dot('busy'), h('h2', null, '안전하게 종료하는 중')), h('p', null, message))));
    });
  }

  const nameOf = (id) => (state.servers.find((s) => s.id === id) || {}).name || '서버';

  function trackProgress(key, bar, label) {
    const list = progressViews.get(key) || [];
    list.push({ bar, label });
    progressViews.set(key, list);
  }

  // ---------- 그리기 ----------
  function render() {
    renderMain();
    renderSide();
  }

  function renderSide() {
    renderBrand();
    const pane = $('.pane-l');
    pane.classList.toggle('is-home', state.page === 'home');
    if (state.page === 'home') {
      // 위: 만들기 버튼 (1) / 아래: 내 서버 목록 (7)
      const importing = state.createMode === 'import';
      const items = state.servers.map((s, i) =>
        h(
          'div.nav-row',
          null,
          h(
          'button.nav-item',
          { type: 'button', onclick: () => openServer(s.id) },
          h('b', null, String(i + 1).padStart(2, '0')),
          h(
            'span.nav-body',
            null,
            h('span.nav-name', null, s.name),
            h('span.nav-meta', null, dot(STATUS[s.status].dot), `${TYPE[s.type].sub} ${s.version}${s.status === 'running' ? ` · ${s.players.length}명` : ''}`),
          ),
          s.status === 'running' && s.metrics && typeof s.metrics.tps === 'number' ? h('span.nav-tps', { title: 'TPS' }, s.metrics.tps.toFixed(1)) : null,
          ),
          h('button.nav-del', { type: 'button', title: `${s.name} 삭제`, 'aria-label': `${s.name} 삭제`, disabled: s.status !== 'stopped', onclick: () => removeServer(s) }, '✕'),
        ),
      );
      put($('#side'),
        h(
          'section.home-create',
          null,
          h(
            'button.create-go',
            { type: 'button', id: 'createGo', onclick: () => live.createAction && live.createAction() },
            h('span.create-go-art'),
            h('span.create-go-code', { id: 'createGoCode' }, importing ? 'SV-NEW · IMPORT' : 'SV-NEW'),
            h('span.create-go-text', { id: 'createGoText' }, importing ? '서버 가져오기' : '서버 만들기'),
            h('span.create-go-line'),
          ),
          h('div', { id: 'eulaSlotWrap' }, eulaLine()),
        ),
        h(
          'section.home-list',
          null,
          h('div.list-head', null, h('span.pane-label', null, '내 서버'), h('span.pane-label', null, String(state.servers.length).padStart(2, '0'))),
          h('div.nav', null, items.length ? items : h('span.empty', null, '아직 만든 서버 없음')),
        ),
      );
      if (live.refreshCreate) live.refreshCreate();
      // 처음 그릴 때는 잠금 상태로 바로 둔다 (코발트에서 회색으로 넘어가는 연출은 동의를 바꿀 때만)
      const go = $('#createGo');
      if (go) {
        go.classList.add('is-fresh');
        requestAnimationFrame(() => requestAnimationFrame(() => go.classList.remove('is-fresh')));
      }
    } else {
      put($('#side'),
        h(
          'button.back',
          { type: 'button', onclick: goHome },
          h('span.back-arrow', { 'aria-hidden': 'true' }),
          h('span', null, '뒤로'),
          h('span.back-code', null, 'MCES · 만들기'),
        ),
      );
    }
    put($('#paneFoot'),
      h('span.foot-code', null, 'MCES · SERVER TERMINAL'),
      seg(
        [
          { value: 'light', label: '밝게' },
          { value: 'dark', label: '어둡게' },
        ],
        state.settings.theme,
        (theme) => setTheme(theme),
        { name: '테마' },
      ),
    );
    renderBand();
  }

  function eulaLine() {
    return live.eula
      ? h(
          'div.eula-line',
          null,
          checkbox(live.eula.get(), (v) => live.eula.set(v), '마인크래프트 이용 약관(EULA) 동의'),
          h('button.eula-read', { type: 'button', onclick: () => call('app:openExternal', 'https://aka.ms/MinecraftEULA') }, '약관 읽기'),
        )
      : null;
  }
  /** 홈 왼쪽 위 만들기 버튼만 고친다 (글자 · EULA 줄 · 눌 수 있는지) */
  function updateCreateGo() {
    const importing = state.createMode === 'import';
    const code = $('#createGoCode');
    const text = $('#createGoText');
    if (code) code.textContent = importing ? 'SV-NEW · IMPORT' : 'SV-NEW';
    if (text) text.textContent = importing ? '서버 가져오기' : '서버 만들기';
    const slot = $('#eulaSlotWrap');
    if (slot) put(slot, eulaLine());
    if (live.refreshCreate) live.refreshCreate();
    renderBrand();
  }
  /** 새로 만들기 ↔ 기존 서버 가져오기: 오른쪽 판만 흐려졌다가 새로 나온다 */
  async function switchCreateMode(v) {
    if (state.createMode === v) return;
    state.createMode = v;
    const main = $('#main');
    main.classList.add('is-swap');
    await sleep(220);
    live.eula = null;
    live.createAction = null;
    live.refreshCreate = null;
    progressViews.clear();
    put(main, renderCreate());
    updateCreateGo();
    main.classList.remove('is-swap');
  }

  /** 왼쪽 위 로고 — 지금 보고 있는 서버(또는 만들고 있는 서버)의 종류 표시를 쓴다 */
  function renderBrand() {
    if (window.Scene) window.Scene.setBrand({ type: brandType(), device: state.appInfo.device || '' });
  }

  /** 위쪽 꺼진 띠 바닥면에 새기는 코드와 PC 사양 */
  function renderBand() {
    if (!window.Scene) return;
    const specs = state.specs;
    const running = state.servers.filter((s) => s.status === 'running').length;
    const java = state.javaInstalled.length ? state.javaInstalled.map((j) => j.major).join('·') : '없음';
    const right = [`SV ${state.servers.length} · RUN ${running}`, specs ? `MEM ${specs.totalGb}GB` : null, specs ? `CPU ${specs.cpuCores}C` : null, `JAVA ${java}`].filter(Boolean).join('  ·  ');
    window.Scene.setBand({ code: `MC.ES-${state.appInfo.version || ''}`, right });
  }

  function renderMain() {
    live = {};
    progressViews.clear();
    const main = $('#main');
    root.dataset.page = state.page;
    const holder = state.page === 'server' ? $('#colB') : $('.pane-r');
    if (main.parentElement !== holder) holder.appendChild(main);
    const detail = $('#detail');
    if (state.page === 'home') {
      put(main, renderCreate());
      put(detail);
      renderSide();
      return;
    }
    const s = server();
    if (!s) {
      state.page = 'home';
      renderMain();
      return;
    }
    // 왼쪽 판: 고른 서버의 코발트 박스(이름·상태·접속 주소) → 설명 한 줄 → 상태 위젯 → 시작 줄
    live.head = h('div.srv-head');
    live.address = h('div.card-status');
    live.note = h('p.pane-note');
    live.stats = h('div.foot-now');
    live.actions = h('div.srv-actions');
    put(detail, h('div.viewport', null, h('article.srv-card', null, h('div.card-art'), live.head, live.address)), live.note, live.stats, live.actions);
    // 오른쪽 판: 번호 탭 → 오류 안내 → 내용
    live.alerts = h('div');
    live.tabs = h('div.tabs-wrap');
    live.content = h('div.main-scroll');
    put(main, live.tabs, live.alerts, live.content);
    renderHead();
    renderAlerts();
    renderAddress();
    renderTabs();
    renderTab();
    if (s.status === 'running' && !state.reach[s.id]) checkReach(s.id);
  }

  // ---------- 고른 서버: 이름 · 상태 · 켜기/끄기 · 업데이트 · 삭제 ----------
  function renderHead() {
    const s = server();
    if (!s || !live.head) return;
    const st = STATUS[s.status];
    const busy = s.status === 'starting' || s.status === 'stopping';
    const startKey = `start-${s.id}`;
    const startBar = progressBar(0);
    const startLabel = h('span.note');
    trackProgress(startKey, startBar, startLabel);
    void st;
    const go =
      s.status === 'stopped'
        ? { text: '서버 켜기', fn: () => startServer(s.id) }
        : s.status === 'running'
          ? { text: '서버 끄기', fn: () => call('server:stop', s.id) }
          : { text: s.status === 'starting' ? '켜는 중…' : '끄는 중…', fn: null };
    // 코발트 박스 위쪽(이름 칸)을 눌러도 켜고 끈다 — 아래 시작 줄과 같은 동작
    Object.assign(live.head, { onclick: go.fn, tabIndex: go.fn ? 0 : -1, title: go.fn ? `눌러서 ${go.text}` : '' });
    live.head.setAttribute('role', 'button');
    live.head.setAttribute('aria-label', go.text);
    live.head.classList.toggle('is-clickable', !!go.fn);
    live.head.dataset.hint = s.status === 'stopped' ? 'START ▸' : s.status === 'running' ? 'STOP ■' : '';
    live.head.onkeydown = (e) => {
      if (go.fn && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        go.fn();
      }
    };
    put(live.head,
      h('h1.card-title', { title: s.name }, s.name),
      h('p.card-code', null, h('span', null, `SV-${String(state.servers.indexOf(s) + 1).padStart(2, '0')}`), h('span', null, `${TYPE[s.type].sub}${s.build ? ` #${s.build}` : ''}`), h('span', null, s.version), h('span', null, `:${s.port}`)),
    );
    live.note.textContent = s.status === 'running' && s.startedAt ? `${fmt.uptime(Date.now() - s.startedAt)}째 실행 중 —` : s.status === 'starting' ? '켜는 중 —' : s.status === 'stopping' ? '저장하고 끄는 중 —' : '꺼져 있음 —';
    put(live.actions,
      s.status === 'starting' ? h('div.progress-line', null, startLabel, startBar) : null,
      h(
        `button.go${go.fn ? '' : '.is-busy'}`,
        { type: 'button', disabled: !go.fn, onclick: go.fn },
        h('span.go-text', null, go.text),
        h('span.go-key', null, s.status === 'stopped' ? 'START' : s.status === 'running' ? 'STOP' : 'WAIT'),
        h('span.go-line'),
      ),
      h(
        'div.sub-actions',
        null,
        button('다시 켜기', () => call('server:restart', s.id), { icon: '↻', small: true, kind: 'ghost', disabled: s.status !== 'running' }),
        button('업데이트', () => openUpdate(s), { icon: '⬆', small: true, kind: 'ghost', disabled: busy }),
        button('삭제', () => removeServer(s), { icon: '✕', small: true, kind: 'danger', disabled: busy }),
      ),
    );
    live.updateStats = () => {
      const cur = state.servers.find((x) => x.id === s.id) || s;
      const m = cur.metrics || {};
      const on = cur.status === 'running';
      const tps = on && typeof m.tps === 'number' ? m.tps : null;
      const heap = on && typeof m.memoryMb === 'number' ? m.memoryMb : null;
      const stat = (k, v, p, cls = '') => h(`div.stat${cls}`, null, h('span.stat-k', null, k), h('b', null, v), p === null ? null : h('i.stat-bar', null, h('i', { style: { width: `${Math.max(0, Math.min(100, p)).toFixed(1)}%` } })));
      put(live.stats,
        stat('접속', `${(cur.players || []).length} / ${cur.settings.maxPlayers}`, ((cur.players || []).length / cur.settings.maxPlayers) * 100),
        stat('TPS', tps === null ? '—' : tps.toFixed(1), tps === null ? 0 : (tps / 20) * 100, tps !== null && tps < 18 ? '.is-warn' : ''),
        stat('메모리', heap === null ? '—' : `${(heap / 1024).toFixed(1)}G`, heap === null ? 0 : (heap / cur.memoryMb) * 100),
        stat('CPU', on ? `${m.cpu || 0}%` : '—', null),
      );
    };
    live.updateStats();
  }

  async function startServer(id) {
    await call('server:start', id);
  }

  // ---------- 오류 안내 ----------
  function renderAlerts() {
    const s = server();
    if (!s || !live.alerts) return;
    const list = state.alerts[s.id] || [];
    put(live.alerts, 
      list.length
        ? h(
            'div.alerts',
            null,
            list.map((a) =>
              h(
                `div.alert.alert-${a.severity}`,
                null,
                h('span.alert-mark'),
                h('div', null, h('h3', null, a.title), h('p', null, a.message)),
                h(
                  'div.alert-actions',
                  null,
                  (a.actions || []).map((act) => button(act.label, () => runAlertAction(s.id, a, act), { small: true, kind: 'primary' })),
                  button('닫기', () => dismissAlert(s.id, a.id), { small: true, kind: 'ghost' }),
                ),
              ),
            ),
          )
        : null,
    );
  }

  function dismissAlert(serverId, alertId) {
    state.alerts[serverId] = (state.alerts[serverId] || []).filter((a) => a.id !== alertId);
    renderAlerts();
  }

  async function runAlertAction(serverId, alert, action) {
    if (action.id === 'open-tab') {
      state.tab = action.payload.tab;
      renderTabs();
      renderTab();
      return;
    }
    if (action.id === 'open-folder') {
      call('server:openFolder', serverId);
      return;
    }
    dismissAlert(serverId, alert.id);
    toast('처리하는 중…');
    const msg = await call('alert:action', serverId, action.id, action.payload || {});
    if (typeof msg === 'string') toast(msg, { kind: 'ok', timeout: 6000 });
    if (state.tab === 'addons') renderTab();
  }

  // ---------- 접속 주소 · 터널 · 접속 점검 ----------
  function currentAddress(s) {
    return (s.network && s.network.address) || state.tunnel.addresses[s.id] || null;
  }

  function renderAddress() {
    const s = server();
    if (!s || !live.address) return;
    const address = currentAddress(s);
    const t = state.tunnel;
    const r = state.reach[s.id];
    const running = s.status === 'running';
    const light = (ok, label, detail) =>
      h('span.check-item', { title: detail || '' }, dot(ok === null ? 'off' : ok ? 'ok' : 'bad'), h('span', null, label));

    let main;
    if (t.status === 'claiming' && t.claimUrl) {
      main = h(
        'div.address-main',
        null,
        h('div.address-col', null, h('span.address-label', null, 'playit.gg 계정 연결 승인 (처음 한 번)'), h('span.address-hint', null, '브라우저에서 로그인(또는 게스트) 후 "Add Agent" 클릭 → 자동 연결')),
        button('브라우저에서 열기', () => call('app:openExternal', t.claimUrl), { small: true, kind: 'primary' }),
      );
    } else if (address) {
      main = h(
        'div.address-main',
        null,
        h('div.address-col', null,
          h('span.address-label', null, s.network && s.network.mode === 'upnp' ? '공유기 주소' : '접속 주소'),
          h('span.address-text', null, address),
        ),
        button(null, async () => {
          if (await call('app:copy', address)) toast('주소 복사됨', { kind: 'ok' });
        }, { small: true, kind: 'primary', icon: '⧉', title: '주소 복사' }),
        button(null, () => editAddress(s), { small: true, kind: 'ghost', icon: '✎', title: '주소 직접 입력' }),
      );
    } else {
      const tunnelBusy = t.status === 'downloading' || t.status === 'connecting';
      const bar = progressBar(0);
      trackProgress(`tunnel-${s.id}`, bar, null);
      main = h(
        'div.address-main',
        null,
        h('div.address-col', null, h('span.address-label', null, tunnelBusy ? t.message || '터널 연결 중' : '접속 주소 없음'), tunnelBusy ? bar : h('span.address-hint', { title: t.status === 'error' ? t.message : '' }, t.status === 'error' ? t.message : '포트포워딩 없이 외부 접속')),
        button('터널 연결', () => startTunnel(s.id), { small: true, kind: 'primary', disabled: tunnelBusy }),
        button(null, () => editAddress(s), { small: true, kind: 'ghost', icon: '✎', title: '주소 직접 입력' }),
      );
    }

    put(live.address,
      main,
      h(
        'div.checks',
        null,
        light(running && r ? r.local.online : null, '서버 응답', r && r.local.online ? `응답 ${r.local.latency}ms` : ''),
        light(running && r && r.address ? r.external.online : null, '외부 접속', r && r.external.checkedBy ? `${r.external.checkedBy} 점검` : ''),
        button('점검', () => checkReach(s.id, true), { small: true, kind: 'ghost', disabled: !running, title: '외부에서 접속 가능한지 다시 확인' }),
      ),
    );
  }

  async function startTunnel(id) {
    const addr = await call('tunnel:start', id);
    if (addr && addr !== true) {
      const s = state.servers.find((x) => x.id === id);
      if (s) s.network = { ...(s.network || {}), mode: 'tunnel', address: addr };
      renderAddress();
      checkReach(id);
    } else if (addr === null || addr === true) {
      toast('터널은 켜졌지만 주소를 찾지 못함 — playit.gg 대시보드의 주소를 ✎ 버튼으로 입력', { timeout: 9000 });
    }
  }

  async function editAddress(s) {
    let value = currentAddress(s) || '';
    const choice = await modal({
      title: '접속 주소',
      body: [
        h('p', null, 'playit.gg 대시보드의 주소 또는 직접 포트포워딩한 공인 IP 주소'),
        input(value, (v) => (value = v), { placeholder: '예: example.gl.joinmc.link' }),
      ],
      actions: [
        { label: '취소', value: null },
        { label: '저장', value: 'save', kind: 'primary' },
      ],
    });
    if (choice !== 'save') return;
    const r = await call('tunnel:setAddress', s.id, value.trim() || null);
    if (r) {
      Object.assign(s, r);
      renderAddress();
      checkReach(s.id);
    }
  }

  async function checkReach(id, manual = false) {
    const s = state.servers.find((x) => x.id === id);
    if (!s || s.status !== 'running') return;
    const r = await window.mc.invoke('reach:check', id);
    if (!r.ok) return;
    state.reach[id] = r.data;
    if (id === state.selected) renderAddress();
    if (manual) {
      if (r.data.external.online) toast('외부 접속 가능', { kind: 'ok' });
      else if (!r.data.address) toast('터널 연결 또는 주소 입력 필요');
      else toast('외부 접속 불가 — 터널 상태 확인 필요', { kind: 'error' });
    }
  }

  function autoCheck() {
    for (const s of state.servers) if (s.status === 'running') checkReach(s.id);
  }

  // ---------- 탭 ----------
  function renderTabs() {
    const s = server();
    if (!s) return;
    if (state.tab === 'addons' && s.type === 'vanilla') state.tab = 'overview';
    put(live.tabs, 
      seg(
        [
          { value: 'overview', label: '개요' },
          { value: 'console', label: '콘솔' },
          { value: 'players', label: `접속자${s.players.length ? ` ${s.players.length}` : ''}` },
          s.type === 'vanilla' ? null : { value: 'addons', label: TYPE[s.type].addon },
          { value: 'backups', label: '백업' },
          { value: 'settings', label: '설정' },
        ].filter(Boolean),
        state.tab,
        (tab) => {
          state.tab = tab;
          renderTab();
        },
        { name: '서버 탭' },
      ),
    );
  }

  function renderTab() {
    const s = server();
    if (!s || !live.content) return;
    live.console = null;
    live.updateMetrics = null;
    if (state.tab === 'addons' && s.type === 'vanilla') state.tab = 'overview';
    const views = { overview: viewOverview, console: viewConsole, players: viewPlayers, addons: viewAddons, backups: viewBackups, settings: viewSettings };
    const scroll = live.content.scrollTop;
    put(live.content, views[state.tab](s));
    if (live.updateMetrics) live.updateMetrics();
    if (state.tab === 'overview' || state.tab === 'players') live.content.scrollTop = scroll;
    // 탭 이름의 접속자 수 갱신
    const playersTab = live.tabs.querySelectorAll('.seg-item .txt')[2];
    if (playersTab) playersTab.textContent = `접속자${s.players.length ? ` ${s.players.length}` : ''}`;
  }

  // 개요: TPS 게이지 · 메모리 능선 · 접속자 · 서버 정보
  function viewOverview(s) {
    const running = s.status === 'running';
    const tpsGauge = Charts.gauge({ max: 20, label: 'TPS' });
    const memGauge = Charts.gauge({ max: 100, label: '메모리' });
    const tpsNote = h('span.note');
    const cpuGauge = Charts.gauge({ max: 100, label: 'CPU' });
    // 5초 간격 측정 → 점 개수로 시간 눈금을 만든다
    const minutesAgo = (n) => Math.max(1, Math.round(((n - 1) * 5) / 60));
    const memChart = Charts.ridge({ max: s.memoryMb, tag: 'MEMORY', axis: (n) => (n > 12 ? [`${minutesAgo(n)}분 전`, `${Math.max(1, Math.round(minutesAgo(n) / 2))}분 전`] : ['방금', '']) });
    const memNote = h('span.note');

    live.updateMetrics = () => {
      const cur = state.servers.find((x) => x.id === s.id) || s;
      const m = cur.metrics || {};
      const on = cur.status === 'running';
      const tps = on && typeof m.tps === 'number' ? m.tps : null;
      // 서버가 켜져 있을 때만 상태 문구 (꺼져 있으면 비움)
      tpsNote.textContent = !on ? '' : tps === null ? '측정 중…' : tps >= 18 ? '쾌적' : tps >= 14 ? '조금 느림' : '과부하';
      tpsGauge.update(tps, tps === null ? '–' : tps.toFixed(1), tps >= 18 ? 'good' : tps >= 14 ? 'warn' : 'bad', '초당 틱');
      const heap = on && typeof m.memoryMb === 'number' ? m.memoryMb : null;
      const memPct = heap === null ? null : (heap / cur.memoryMb) * 100;
      memGauge.update(memPct, heap === null ? '–' : (heap / 1024).toFixed(1), memPct > 90 ? 'warn' : 'good', heap === null ? (on ? '측정 중' : '') : `GB / ${fmt.gb(cur.memoryMb)}`);
      cpuGauge.update(on ? m.cpu || 0 : null, on ? String(m.cpu || 0) : '–', (m.cpu || 0) > 85 ? 'warn' : 'good', '%');
      const hist = state.history[s.id] || [];
      memChart.update(hist.map((p) => p.memoryMb));
      memNote.textContent = `현재 힙 사용량 · 할당 ${fmt.gb(cur.memoryMb)} · 최근 15분${on && m.processMb ? ` · Java 예약 ${fmt.gb(m.processMb)}` : ''}`;
    };

    const players = s.players || [];
    const view = h(
      'div.grid.grid-main',
      null,
      h(
        'div.stack',
        { style: { gap: '20px' } },
        h(
          'div.card',
          null,
          h('div.card-head', null, h('h2', null, '성능'), tpsNote),
          h('div.gauges', null, tpsGauge, memGauge, cpuGauge),
        ),
        h('div.card', null, h('div.card-head', null, h('div', null, h('h2', null, '메모리 사용량'), memNote)), h('div.chart-well', null, memChart)),
      ),
      h(
        'div.stack',
        { style: { gap: '20px' } },
        h(
          'div.card',
          null,
          h('div.card-head', null, h('h2', null, '접속 중'), h('span.num.sky', null, `${players.length} / ${s.settings.maxPlayers}`)),
          players.length
            ? h('div.list', null, players.slice(0, 8).map((p) => playerRow(s, p, true)))
            : h('span.empty', null, running ? '접속자 없음' : '서버 꺼짐'),
        ),
        h(
          'div.card',
          null,
          h('div.card-head', null, h('h2', null, '서버 정보')),
          h(
            'div.list',
            null,
            info('종류', `${TYPE[s.type].label} (${TYPE[s.type].sub}${s.build ? ` #${s.build}` : ''})`),
            info('버전', s.version),
            info('Java', `Java ${s.javaMajor} · 앱 폴더에 설치`),
            info('메모리', fmt.gb(s.memoryMb)),
            info('포트', String(s.port)),
            info('시야 거리', `${s.settings.viewDistance}칸`),
            info('최적화', s.optimize ? (s.type === 'paper' ? (s.optimizedApplied ? 'Aikar 플래그 + Paper 설정 적용됨' : 'Aikar 플래그 (Paper 설정은 첫 실행 후)') : 'Aikar 플래그 적용됨') : '끔'),
            s.type === 'vanilla' ? null : info(TYPE[s.type].addon, `${(s.addons || []).length}개`),
          ),
        ),
      ),
    );
    requestAnimationFrame(() => live.updateMetrics && live.updateMetrics());
    if (running && !(state.history[s.id] || []).length) {
      call('server:history', s.id).then((hist) => {
        if (!Array.isArray(hist) || (state.history[s.id] || []).length >= hist.length) return;
        state.history[s.id] = hist.slice(-180);
        if (live.updateMetrics) live.updateMetrics();
      });
    }
    return view;
  }

  function info(label, value) {
    // 한글이 섞인 값은 본문 서체로, 숫자·코드만 고정폭으로
    return h('div.list-item', { style: { gridTemplateColumns: '1fr auto' } }, h('span.note', null, label), h(/[가-힣]/.test(value) ? 'span.txt' : 'span.num', null, value));
  }

  // 콘솔
  function viewConsole(s) {
    const box = h('div.well.console');
    for (const e of state.consoles[s.id] || []) appendConsole(box, e, false);
    let value = '';
    const field = input('', (v) => (value = v), {
      placeholder: s.status === 'running' ? '명령어 입력 (예: say 안녕, time set day)' : '서버 실행 중에만 명령어 입력 가능',
      disabled: s.status !== 'running',
      onkeydown: (e) => {
        if (e.key === 'Enter') send();
      },
    });
    const send = async () => {
      if (!value.trim()) return;
      await call('server:command', s.id, value);
      value = '';
      field.value = '';
    };
    live.console = box;
    requestAnimationFrame(() => (box.scrollTop = box.scrollHeight));
    if (!state.consoles[s.id]) {
      call('server:console', s.id).then((lines) => {
        if (!Array.isArray(lines)) return;
        state.consoles[s.id] = lines;
        put(box, );
        for (const e of lines) appendConsole(box, e, false);
        box.scrollTop = box.scrollHeight;
      });
    }
    return h(
      'div.card',
      null,
      box,
      h('div.console-input', null, field, button('보내기', send, { kind: 'primary', disabled: s.status !== 'running' })),
      h('div.inline', { style: { marginTop: '10px', justifyContent: 'space-between' } }, h('span.note', null, '콘솔 내용은 logs/mces-console.log 에도 저장 (직전 실행은 mces-console.prev.log)'), button('로그 폴더 열기', () => call('server:openLogs', s.id), { small: true, kind: 'ghost', icon: '⌂' })),
    );
  }

  function appendConsole(box, e, scroll = true) {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const kind = e.kind !== 'out' ? e.kind : /\bWARN\b/.test(e.line) ? 'warn' : /\b(ERROR|SEVERE|FATAL)\b|Exception/.test(e.line) ? 'error' : '';
    // 종류 클래스는 k- 를 붙인다 (.app 은 창 전체 배치에 쓰는 이름이라 겹치면 줄이 화면 높이만큼 커진다)
    box.appendChild(h(`div.console-line${kind ? `.k-${kind}` : ''}`, null, e.line));
    while (box.childElementCount > 2000) box.firstChild.remove();
    if (scroll && atBottom) box.scrollTop = box.scrollHeight;
  }

  // 접속자: 강퇴 · OP · 화이트리스트
  function playerRow(s, p, compact, lists) {
    const isOp = lists && lists.ops.includes(p.name);
    const inWl = lists && lists.whitelist.includes(p.name);
    return h(
      'div.list-item',
      null,
      h('img.avatar', { src: `https://mc-heads.net/avatar/${encodeURIComponent(p.uuid || p.name)}/34`, alt: '', onerror: (e) => (e.target.style.visibility = 'hidden') }),
      h('div', { style: { minWidth: 0 } }, h('div.list-title', null, h('span.txt', null, p.name), isOp ? h('span.tag.brass', null, 'OP') : null), h('div.note', null, `${fmt.uptime(Date.now() - p.joinedAt)} 전 접속`)),
      compact
        ? null
        : h(
            'div.list-actions',
            null,
            button(isOp ? 'OP 해제' : 'OP 주기', () => playerAction(s, isOp ? 'deop' : 'op', p.name), { small: true }),
            s.settings.whitelist ? button(inWl ? '화이트리스트 빼기' : '화이트리스트', () => playerAction(s, inWl ? 'whitelist-remove' : 'whitelist-add', p.name), { small: true }) : null,
            button('강퇴', () => playerAction(s, 'kick', p.name), { small: true, kind: 'danger' }),
          ),
    );
  }

  async function playerAction(s, action, name) {
    const labels = { kick: '강퇴', op: 'OP 부여', deop: 'OP 해제', 'whitelist-add': '화이트리스트 추가', 'whitelist-remove': '화이트리스트 제거', ban: '차단', pardon: '차단 해제' };
    if (action === 'kick' || action === 'ban') {
      const ok = await modal({ title: `${name} ${action === 'kick' ? '강퇴' : '차단'}`, body: h('p', null, action === 'kick' ? '서버에서 내보냄. 다시 접속은 가능' : '차단 해제 전까지 접속 불가'), actions: [{ label: '취소', value: false }, { label: action === 'kick' ? '강퇴' : '차단', value: true, kind: 'danger' }] });
      if (!ok) return;
    }
    if (await call('players:action', s.id, action, name)) toast(`${name} 님을 ${labels[action]}`, { kind: 'ok' });
  }

  function viewPlayers(s) {
    const running = s.status === 'running';
    const wrap = h('div.grid.grid-main');
    const online = h('div.card', null, h('div.card-head', null, h('div', null, h('h2', null, '지금 접속 중'), h('div.note', null, '클릭 한 번으로 강퇴 · OP · 화이트리스트')), h('span.num.sky', null, `${s.players.length}명`)));
    const side = h('div.stack', { style: { gap: '20px' } });
    wrap.append(online, side);

    call('players:lists', s.id).then((lists) => {
      lists = lists && lists !== true ? lists : { ops: [], whitelist: [], banned: [] };
      online.appendChild(s.players.length ? h('div.list', null, s.players.map((p) => playerRow(s, p, false, lists))) : h('span.empty', null, running ? '접속자 없음' : '서버 실행 시 표시'));

      let name = '';
      const nameField = input('', (v) => (name = v), { placeholder: '플레이어 이름', disabled: !running });
      append(side, [
        h(
          'div.card',
          null,
          h('div.card-head', null, h('div', null, h('h2', null, '이름으로 관리'), h('div.note', null, running ? '접속하지 않은 플레이어도 미리 추가' : '서버 실행 중에만 가능'))),
          h('div.stack', null, nameField, h('div.inline', null, button('화이트리스트 추가', () => name && playerAction(s, 'whitelist-add', name.trim()), { small: true, disabled: !running }), button('OP 주기', () => name && playerAction(s, 'op', name.trim()), { small: true, disabled: !running }), button('차단', () => name && playerAction(s, 'ban', name.trim()), { small: true, kind: 'danger', disabled: !running }))),
        ),
        nameList(s, '화이트리스트', s.settings.whitelist ? '켜짐 — 목록에 있는 사람만 접속' : '꺼짐 — 설정 탭에서 변경', lists.whitelist, 'whitelist-remove', '빼기', running),
        nameList(s, '관리자 (OP)', '명령어를 쓸 수 있는 사람', lists.ops, 'deop', 'OP 해제', running),
        lists.banned.length ? nameList(s, '차단됨', '', lists.banned, 'pardon', '차단 해제', running) : null,
      ]);
    });
    return wrap;
  }

  function nameList(s, title, desc, names, action, label, running) {
    return h(
      'div.card',
      null,
      h('div.card-head', null, h('div', null, h('h2', null, title), desc ? h('div.note', null, desc) : null), h('span.num', null, `${names.length}`)),
      names.length
        ? h('div.list', null, names.map((n) => h('div.list-item', { style: { gridTemplateColumns: '1fr auto' } }, h('span.txt', null, n), button(label, () => playerAction(s, action, n), { small: true, kind: 'ghost', disabled: !running }))))
        : h('span.empty', null, '비어 있음'),
    );
  }

  // 추가 기능: 설치됨 + Modrinth 검색 · 원클릭 설치
  /** 쪽 넘김 단추: 처음 · 현재 주변 · 끝 번호만 (예: 1 … 4 5 6 … 20) */
  function pagerButtons(cur, pages, go) {
    const nums = [...new Set([0, cur - 2, cur - 1, cur, cur + 1, cur + 2, pages - 1])].filter((n) => n >= 0 && n < pages).sort((a, b) => a - b);
    const items = [];
    nums.forEach((n, i) => {
      if (i && n - nums[i - 1] > 1) items.push(h('span.pager-gap.dim', null, '…'));
      items.push(h(`button.pager-num${n === cur ? '.on' : ''}`, { type: 'button', onclick: () => n !== cur && go(n), 'aria-current': n === cur ? 'page' : null, 'aria-label': `${n + 1}페이지` }, h('span.txt.num', null, String(n + 1))));
    });
    return [button('이전', () => go(cur - 1), { small: true, icon: '‹', disabled: cur === 0 }), h('div.pager-nums', null, items), button('다음', () => go(cur + 1), { small: true, icon: '›', disabled: cur >= pages - 1 })];
  }

  function viewAddons(s) {
    const t = TYPE[s.type];
    const hybrid = s.type === 'hybrid';
    // 하이브리드: 검색할 종류 (플러그인 / Forge 모드)
    state.addonKind = state.addonKind || 'plugin';
    const installed = h('div.list');
    const results = h('div.list');
    const resultNote = h('span.note');
    const bar = progressBar(0);
    const barLabel = h('span.note');
    const progressBox = h('div.progress-line.hidden', null, barLabel, bar);
    trackProgress(`addon-${s.id}`, bar, barLabel);

    // 설치된 목록 — 모드팩처럼 수백 개여도 다루기 쉽게: 이름 거르기 · 상태 거르기 · 쪽 나누기
    const LIST_PAGE = 40;
    const lq = state.addonFilter[s.id] || (state.addonFilter[s.id] = { text: '', show: 'all', page: 0 });
    let allItems = [];
    const installedPager = h('div.pager');
    const installedNote = h('span.note');
    const rowOf = (a) =>
      h(
        `div.list-item${a.enabled ? '' : '.disabled'}`,
        null,
        a.iconUrl ? h('img.icon-img', { src: a.iconUrl, alt: '', loading: 'lazy' }) : h('div.icon-img.icon-ph.txt', null, (a.title || '?')[0]),
        h(
          'div',
          { style: { minWidth: 0 } },
          h(
            'div.list-title',
            null,
            h('span.txt', null, a.title),
            hybrid ? h('span.tag.txt', null, a.kind === 'mod' ? '모드' : '플러그인') : null,
            a.dependencyOf ? h('span.tag.txt', null, '자동 설치된 의존성') : null,
            a.projectId ? null : h('span.tag.txt', null, a.manual ? '폴더에 직접 넣음' : '파일로 추가'),
            a.importedFromFile ? h('span.tag.txt', { title: '같은 파일이 Modrinth 에 있어 업데이트·호환성 검사 가능' }, 'Modrinth 확인됨') : null,
          ),
          h('div.note', null, a.versionNumber ? `${a.versionNumber} · ${a.fileName}` : a.fileName),
          compatLine(a),
        ),
        h(
          'div.list-actions',
          null,
          toggle(a.enabled, async (on) => {
            await call('addons:toggle', s.id, a.fileName, on);
            toast(on ? `${a.title} 켜짐` : `${a.title} 꺼짐`);
            refreshInstalled();
          }),
          button(null, async () => {
            const ok = await modal({ title: `${a.title} 삭제`, body: h('p', null, '파일 삭제. 설정 폴더는 유지'), actions: [{ label: '취소', value: false }, { label: '삭제', value: true, kind: 'danger' }] });
            if (ok && (await call('addons:remove', s.id, a.fileName))) refreshInstalled();
          }, { small: true, kind: 'ghost', icon: '✕', title: '삭제' }),
        ),
      );
    const problem = (a) => (a.compat && a.compat.status === 'bad') || (a.enabled && a.missing && a.missing.length);
    const drawInstalled = () => {
      const needle = lq.text.trim().toLowerCase();
      const shown = allItems.filter((a) => {
        if (lq.show === 'on' && !a.enabled) return false;
        if (lq.show === 'off' && a.enabled) return false;
        if (lq.show === 'problem' && !problem(a)) return false;
        return !needle || `${a.title} ${a.fileName}`.toLowerCase().includes(needle);
      });
      const pages = Math.max(1, Math.ceil(shown.length / LIST_PAGE));
      lq.page = Math.min(lq.page, pages - 1);
      const on = allItems.filter((a) => a.enabled).length;
      const bad = allItems.filter(problem).length;
      installedNote.textContent = `전체 ${allItems.length} · 켜짐 ${on} · 꺼짐 ${allItems.length - on}${bad ? ` · 확인 필요 ${bad}` : ''}${shown.length !== allItems.length ? ` — ${shown.length}개 표시` : ''}`;
      put(installed, ...(shown.length ? shown.slice(lq.page * LIST_PAGE, (lq.page + 1) * LIST_PAGE).map(rowOf) : [h('span.empty', null, allItems.length ? '조건에 맞는 항목 없음' : `설치된 ${t.addon} 없음 — "찾기"에서 검색하거나 파일로 추가`)]));
      put(installedPager, ...(pages > 1 ? pagerButtons(lq.page, pages, (p) => {
        lq.page = p;
        drawInstalled();
        installed.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }) : []));
    };
    const refreshInstalled = async () => {
      const list = await call('addons:list', s.id);
      if (!Array.isArray(list)) return;
      allItems = list.sort((a, b) => (a.dependencyOf ? 1 : 0) - (b.dependencyOf ? 1 : 0) || String(a.title).localeCompare(String(b.title)));
      if (viewSeg) viewSeg.querySelector('.seg-item .txt').textContent = `설치됨 ${allItems.length}`;
      drawInstalled();
    };

    /** 직접 추가한 파일의 호환 여부와 빠진 의존성 */
    const compatLine = (a) => {
      const parts = [];
      if (a.compat && a.compat.status === 'bad') parts.push(h('span.compat.bad', null, `호환 안 됨 · ${a.compat.reason}`));
      else if (a.compat && a.compat.status === 'unknown') parts.push(h('span.compat.dim', null, `호환 확인 불가 · ${a.compat.reason}`));
      else if (a.compat && a.compat.status === 'ok') parts.push(h('span.compat.ok', null, `${s.version} 호환`));
      if (a.enabled && a.missing && a.missing.length) {
        parts.push(h('span.compat.brass', null, `필요: ${a.missing.join(', ')}`));
        if (s.type !== 'vanilla') {
          parts.push(
            button('설치', async (e) => {
              e.currentTarget.disabled = true;
              for (const name of a.missing) {
                const r = await call('addons:installByName', s.id, name, a.kind || null);
                if (r && r !== true) toast(`${r.installed.map((x) => x.title).join(', ')} 설치`, { kind: 'ok' });
              }
              refreshInstalled();
            }, { small: true, title: 'Modrinth 에서 찾아 설치' }),
          );
        }
      }
      return parts.length ? h('div.compat-line', null, parts) : null;
    };

    /** 파일에서 추가 (선택 창 또는 끌어다 놓기) */
    const importFiles = async (paths) => {
      // 모드팩은 오래 걸린다. 다른 화면으로 갔다 와도 진행 막대가 이어지도록 작업 상태를 앱 상태에 둔다
      if (state.addonJobs[s.id]) return toast('이미 파일(모드팩)을 넣는 중 — 끝난 뒤 다시 시도', { kind: 'error' });
      state.addonJobs[s.id] = true;
      state.progress[`addon-${s.id}`] = { key: `addon-${s.id}`, text: '파일 확인 중', percent: 0 };
      showJob();
      const r = await call('addons:importFiles', s.id, paths);
      delete state.addonJobs[s.id];
      delete state.progress[`addon-${s.id}`];
      // 지금 보고 있는 화면이 이 서버의 모드 탭이면 새로 그린다
      if (state.page === 'server' && state.selected === s.id && state.tab === 'addons') renderTab();
      if (!r || r === true) return;
      for (const p of r.packs || []) {
        const extra = [p.datapacks ? `데이터팩 ${p.datapacks}개는 월드에` : null, p.skipped ? `서버가 쓰지 않는 리소스팩·셰이더 ${p.skipped}개 건너뜀` : null, p.failed.length ? `${p.failed.length}개 받기 실패` : null].filter(Boolean).join(' · ');
        toast(`모드팩 ${p.name}${p.version ? ` ${p.version}` : ''} — 모드 ${p.mods}개 · 설정 파일 ${p.overrides}개 추가${extra ? ` · ${extra}` : ''}${r.needsRestart ? ' — 재시작 시 적용' : ''}`, { kind: p.failed.length ? 'error' : 'ok', timeout: 9000 });
        for (const w of p.warnings) toast(w, { kind: 'error', timeout: 9000 });
        if (p.failed.length) console.warn('모드팩 받기 실패', p.failed);
      }
      for (const a of r.added) {
        const how = a.fromModrinth ? ' (Modrinth 파일로 확인)' : '';
        if (!a.enabled) toast(`${a.title} 추가 — 버전 불일치로 꺼 둠: ${a.compat.reason}`, { kind: 'error', timeout: 8000 });
        else toast(`${a.title} 추가${how}${r.needsRestart ? ' — 재시작 시 적용' : ''}`, { kind: 'ok', timeout: 6000 });
      }
      for (const x of r.rejected) toast(`${x.file} 추가 불가 — ${x.reason}`, { kind: 'error', timeout: 8000 });
    };
    // 넣는 중인 작업이 있으면 진행 막대와 마지막 진행 상황을 다시 보여 주고, 추가 버튼은 막는다
    const showJob = () => {
      const job = state.addonJobs[s.id];
      progressBox.classList.toggle('hidden', !job);
      if (job) {
        const p = state.progress[`addon-${s.id}`] || {};
        bar.set(p.percent || 0);
        barLabel.textContent = p.text || '파일 확인 중';
      }
      for (const b of dropZone.querySelectorAll('button')) b.disabled = !!job;
    };
    const fileExt = s.type === 'vanilla' ? '.zip' : s.type === 'paper' ? '.jar' : '.jar · 모드팩(.zip · .mrpack)';
    const dropZone = h(
      'div.drop-zone',
      {
        ondragover: (e) => {
          e.preventDefault();
          dropZone.classList.add('over');
        },
        ondragleave: () => dropZone.classList.remove('over'),
        ondrop: (e) => {
          e.preventDefault();
          dropZone.classList.remove('over');
          const paths = [...e.dataTransfer.files].map((f) => window.mc.pathForFile && window.mc.pathForFile(f)).filter(Boolean);
          if (paths.length) importFiles(paths);
        },
      },
      h('span.note', null, `${fileExt} 파일을 여기에 끌어다 놓기 · Modrinth 에 없는 ${t.addon} 추가`),
      button('파일에서 추가', () => importFiles(null), { small: true, icon: '＋' }),
    );

    const PAGE = 20;
    // Modrinth 는 offset + limit 이 10,000 을 넘으면 결과를 주지 않는다
    const MAX_PAGES = Math.floor(10000 / PAGE);
    const q = { query: '', sort: 'downloads', page: 0, seq: 0, kind: hybrid ? state.addonKind : null };
    const kindLabel = () => (hybrid ? (q.kind === 'mod' ? 'Forge 모드' : '플러그인') : t.addon);
    let timer = null;
    const pager = h('div.pager');
    const resultsCard = h('div.card');

    const goPage = (p) => {
      q.page = p;
      doSearch();
      resultsCard.scrollIntoView({ block: 'start', behavior: 'smooth' });
    };

    const renderPager = (total) => {
      const pages = Math.min(Math.ceil(total / PAGE), MAX_PAGES);
      if (pages <= 1) return put(pager);
      put(pager, ...pagerButtons(q.page, pages, goPage));
    };

    const doSearch = async () => {
      const seq = ++q.seq;
      resultNote.textContent = '찾는 중…';
      const r = await call('addons:search', s.id, q.query, { limit: PAGE, offset: q.page * PAGE, index: q.sort, kind: q.kind });
      if (seq !== q.seq) return; // 더 최근 검색이 있으면 버린다
      if (!r || r === true) {
        resultNote.textContent = '검색 실패';
        return;
      }
      const pages = Math.min(Math.ceil(r.total / PAGE), MAX_PAGES);
      resultNote.textContent = `${s.version} · ${hybrid ? kindLabel() : t.sub} 호환만 표시 · ${fmt.num(r.total)}개${pages > 1 ? ` · ${q.page + 1}/${pages}페이지` : ''}`;
      renderPager(r.total);
      put(results, 
        ...(r.hits.length
          ? r.hits.map((hit) =>
              h(
                'div.list-item',
                null,
                hit.iconUrl ? h('img.icon-img', { src: hit.iconUrl, alt: '' }) : h('div.icon-img.icon-ph.txt', null, hit.title[0]),
                h('div', { style: { minWidth: 0 } }, h('div.list-title', null, h('span.txt', null, hit.title), h('span.note', null, `↓ ${fmt.num(hit.downloads)}`)), h('div.list-desc.row-desc', null, hit.description)),
                hit.installed
                  ? h('span.tag.ok', null, '설치됨')
                  : button('설치', async (e) => {
                      const btn = e.currentTarget;
                      btn.disabled = true;
                      progressBox.classList.remove('hidden');
                      const res = await call('addons:install', s.id, hit.projectId, q.kind);
                      progressBox.classList.add('hidden');
                      if (res && res !== true) {
                        const extra = res.installed.filter((a) => a.projectId !== hit.projectId).map((a) => a.title);
                        toast(`${hit.title} 설치 완료${extra.length ? ` (의존성 ${extra.join(', ')} 함께 설치)` : ''}${res.needsRestart ? ' — 재시작 시 적용' : ''}`, { kind: 'ok', timeout: 6500 });
                        if (res.skipped.length) toast(`설치하지 못한 의존성: ${res.skipped.map((x) => x.title).join(', ')}`, { kind: 'error', timeout: 8000 });
                        hit.installed = true;
                        btn.replaceWith(h('span.tag.ok', null, '설치됨'));
                        refreshInstalled();
                      } else btn.disabled = false;
                    }, { small: true, kind: 'primary' }),
              ),
            )
          : [h('span.empty', null, '결과 없음')]),
      );
    };

    const sortSeg = seg(
      [
        { value: 'downloads', label: '다운로드순' },
        { value: 'relevance', label: '관련도순' },
        { value: 'updated', label: '최근 업데이트' },
        { value: 'newest', label: '최신 등록' },
      ],
      q.sort,
      (v) => {
        q.sort = v;
        q.page = 0;
        doSearch();
      },
      { name: '정렬' },
    );

    const searchField = input('', (v) => {
      q.query = v;
      q.page = 0;
      clearTimeout(timer);
      timer = setTimeout(doSearch, 350);
    });
    const placeholder = () => {
      const k = hybrid ? q.kind : null;
      const ex = k === 'plugin' || s.type === 'paper' ? 'EssentialsX, LuckPerms' : k === 'mod' || s.type === 'forge' || s.type === 'neoforge' ? 'JEI, Create' : s.type === 'fabric' ? 'Sodium, Lithium' : 'Vanilla Tweaks';
      searchField.placeholder = `${kindLabel()} 이름으로 찾기 (예: ${ex})`;
    };
    placeholder();
    const kindSeg = hybrid
      ? seg(ADDON_KINDS.map((k) => ({ value: k.value, label: k.label })), q.kind, (v) => {
          q.kind = state.addonKind = v;
          q.page = 0;
          placeholder();
          doSearch();
        }, { name: '종류' })
      : null;

    // 위: 설치됨 / 찾기 (나란히 두지 않고 한 번에 하나 — 목록이 길어도 한 화면에서 다룬다)
    state.addonView = state.addonView || 'installed';
    const installedPanel = h('div.stack');
    const searchPanel = h('div.stack');
    const viewSeg = seg([{ value: 'installed', label: `설치됨` }, { value: 'search', label: 'Modrinth에서 찾기' }], state.addonView, (v) => {
      state.addonView = v;
      installedPanel.hidden = v !== 'installed';
      searchPanel.hidden = v !== 'search';
    }, { name: '보기' });
    const filterField = input(lq.text, (v) => {
      lq.text = v;
      lq.page = 0;
      drawInstalled();
    }, { placeholder: `${t.addon} 이름이나 파일 이름으로 거르기` });
    const showSeg = seg([{ value: 'all', label: '전체' }, { value: 'on', label: '켜짐' }, { value: 'off', label: '꺼짐' }, { value: 'problem', label: '확인 필요' }], lq.show, (v) => {
      lq.show = v;
      lq.page = 0;
      drawInstalled();
    }, { name: '상태' });
    const tools = h(
      'div.inline',
      null,
      button('모두 업데이트', async () => {
        const n = await call('addons:update', s.id);
        if (n !== undefined) {
          toast(n ? `${n}개 새 버전으로 교체` : '모두 최신', { kind: 'ok' });
          refreshInstalled();
        }
      }, { small: true, icon: '⬆' }),
      MOD_TYPES.includes(s.type) || hybrid
        ? button('접속용 mods.zip', async () => {
            const r = await call('addons:exportModsZip', s.id);
            if (r && r !== true) toast(`mods.zip 저장 — 모드 ${r.count}개 · 압축을 풀어 .minecraft/mods 에 넣기 (${s.type === 'fabric' ? 'Fabric Loader' : s.type === 'neoforge' ? 'NeoForge' : 'Forge'} ${r.loader || ''} · 마인크래프트 ${r.minecraft})`.replace('  ', ' '), { kind: 'ok', timeout: 10000 });
          }, { small: true, kind: 'primary', icon: '⇪', title: '접속할 때 필요한 모드 jar 파일을 mods.zip 으로 내보내기 (서버 전용 모드 제외)' })
        : null,
    );
    append(installedPanel, [
      h('div.card', null,
        h('div.card-head', null, h('div', null, h('h2', null, `설치된 ${t.addon}`), installedNote), tools),
        dropZone,
        h('div.addon-filter', null, filterField, showSeg),
        installed,
        installedPager,
      ),
    ]);
    append(searchPanel, [append(resultsCard, [h('div.card-head', null, h('div', null, h('h2', null, 'Modrinth에서 찾기'), resultNote)), h('div.stack', null, kindSeg ? h('div.sort-row', null, h('span.note', null, '종류'), kindSeg) : null, searchField, h('div.sort-row', null, h('span.note', null, '정렬'), sortSeg), results, pager)])]);
    installedPanel.hidden = state.addonView !== 'installed';
    searchPanel.hidden = state.addonView !== 'search';

    refreshInstalled();
    doSearch();
    setTimeout(showJob);

    return h('div.stack', { style: { gap: '12px' } }, h('div.addon-top', null, viewSeg), progressBox, installedPanel, searchPanel);
  }

  // 백업
  function viewBackups(s) {
    const bk = { ...s.backup };
    const list = h('div.list');
    const refresh = async () => {
      const items = await call('backups:list', s.id);
      if (!Array.isArray(items)) return;
      const reasonLabel = { manual: '직접', auto: '자동', stop: '정지 시', 'before-restore': '복원 전', 'before-update': '업데이트 전', 'before-import': '맵 교체 전', 'before-reset': '월드 재생성 전' };
      put(list, 
        ...(items.length
          ? items.map((b) =>
              h(
                'div.list-item',
                null,
                h('span.tag.txt', null, reasonLabel[b.reason] || b.reason),
                h('div', null, h('div.txt', null, fmt.date(b.createdAt)), h('div.note', null, fmt.bytes(b.size))),
                h(
                  'div.list-actions',
                  null,
                  button('복원', async () => {
                    if (s.status !== 'stopped') return toast('복원은 서버를 끈 뒤 가능', { kind: 'error' });
                    const ok = await modal({ title: '백업 복원', body: [h('p', null, `${fmt.date(b.createdAt)} 시점의 월드로 교체`), h('p.note', null, '현재 월드는 "복원 전" 백업으로 따로 보관')], actions: [{ label: '취소', value: false }, { label: '복원', value: true, kind: 'primary' }] });
                    if (ok && (await call('backups:restore', s.id, b.file))) {
                      toast('복원 완료', { kind: 'ok' });
                      refresh();
                    }
                  }, { small: true }),
                  button(null, async () => {
                    const ok = await modal({ title: '백업 삭제', body: h('p', null, '백업 파일 삭제'), actions: [{ label: '취소', value: false }, { label: '삭제', value: true, kind: 'danger' }] });
                    if (ok && (await call('backups:delete', s.id, b.file))) refresh();
                  }, { small: true, kind: 'ghost', icon: '✕', title: '삭제' }),
                ),
              ),
            )
          : [h('span.empty', null, '백업 없음')]),
      );
    };
    refresh();
    const save = (patch) => {
      Object.assign(bk, patch);
      call('server:settings', s.id, { backup: patch });
    };
    return h(
      'div.grid.grid-2',
      null,
      h(
        'div.card',
        null,
        h(
          'div.card-head',
          null,
          h('div', null, h('h2', null, '백업 목록'), h('div.note', null, '월드(world, 네더, 엔드)를 zip으로 저장')),
          button('지금 백업', async (e) => {
            e.currentTarget.disabled = true;
            const r = await call('backups:create', s.id);
            e.currentTarget.disabled = false;
            if (r) {
              toast('백업 완료', { kind: 'ok' });
              refresh();
            }
          }, { kind: 'primary', icon: '⤓', small: true }),
        ),
        list,
      ),
      h(
        'div.card',
        null,
        h('div.card-head', null, h('h2', null, '자동 백업')),
        row('정해진 간격마다', '서버 실행 중 저장을 잠시 멈추고 백업', toggle(bk.enabled, (v) => save({ enabled: v }))),
        row('간격', null, seg([15, 30, 60, 120].map((m) => ({ value: m, label: m < 60 ? `${m}분` : `${m / 60}시간` })), bk.intervalMin, (v) => save({ intervalMin: v }))),
        row('서버를 끌 때', '서버를 끌 때마다 월드 백업', toggle(bk.onStop, (v) => save({ onStop: v }))),
        row('자동 백업 보관 개수', '오래된 자동 백업부터 삭제 (직접 만든 백업은 유지)', slider({ min: 3, max: 50, value: bk.keep, onInput: (v) => { clearTimeout(bk.t); bk.t = setTimeout(() => save({ keep: v }), 400); }, format: (v) => `${v}개` })),
      ),
    );
  }

  // 설정: server.properties 를 풀어서
  function viewSettings(s) {
    const draft = { ...s.settings, name: s.name, memoryMb: s.memoryMb, optimize: s.optimize };
    const specs = state.specs;
    // 바꾸면 바로 저장한다 (연달아 바꾸면 모아서 한 번). 켜져 있으면 명령으로 바로 적용되는 항목은 즉시 반영
    let timer = null;
    let saving = false;
    const scheduleSave = (delay = 450) => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (saving) return scheduleSave(200);
        saving = true;
        try {
          await save();
        } finally {
          saving = false;
        }
      }, delay);
    };
    const set = (k, delay) => (v) => {
      draft[k] = v;
      scheduleSave(delay);
    };
    const rules = { changes: {}, onChange: (delay) => scheduleSave(delay) };
    const save = async () => {
      const { levelName, ...rest } = draft;
      const r = await call('server:settings', s.id, rest);
      if (!r || r === true) return;
      const a = r.applied || { now: [], restart: [] };
      if (Object.keys(rules.changes).length) {
        const g = await call('server:setGameRules', s.id, rules.changes);
        if (g && g !== true) {
          a.now.push(...g.changed);
          rules.changes = {};
          if (rules.reload) rules.reload();
        }
      }
      if (!a.now.length && !a.restart.length) return;
      if (!a.running) return toast(`저장됨 (${a.now.join(', ')}) — 다음 실행 때 적용`, { kind: 'ok' });
      const parts = [a.now.length ? `바로 적용: ${a.now.join(', ')}` : null, a.restart.length ? `재시작 후 적용: ${a.restart.join(', ')}` : null].filter(Boolean);
      toast(`저장됨 — ${parts.join(' · ')}`, { kind: 'ok', timeout: a.restart.length ? 7000 : 4000 });
    };
    const memMarks = specs ? [{ value: specs.recommendedMb, label: `추천 ${fmt.gb(specs.recommendedMb)}` }] : null;
    const mem = slider({ min: 1024, max: specs ? specs.maxMb : 8192, step: 512, value: draft.memoryMb, onInput: set('memoryMb'), format: fmt.gb, marks: memMarks });
    if (memMarks) mem.classList.add('has-marks');

    return h(
      'div.stack',
      { style: { gap: '20px' } },
      h(
        'div.grid.grid-2',
        null,
        h(
          'div.card',
          null,
          h('div.card-head', null, h('h2', null, '기본 설정')),
          row('서버 이름', '이 앱에서만 보이는 이름', input(draft.name, set('name', 900))),
          row('서버 설명', '서버 목록에 보이는 한 줄', input(draft.motd, set('motd', 900), { maxLength: 59 })),
          row('난이도', '몬스터의 세기와 배고픔 속도 · 켜져 있으면 바로 적용', seg(DIFFICULTY, draft.difficulty, set('difficulty'))),
          row('게임 모드', '처음 들어온 사람의 모드 · 켜져 있으면 바로 적용', seg(GAMEMODE, draft.gamemode, set('gamemode'))),
          row('최대 인원', '동시에 들어올 수 있는 사람 수', slider({ min: 2, max: 50, value: draft.maxPlayers, onInput: set('maxPlayers'), format: (v) => `${v}명` })),
          row('PVP', '플레이어끼리 공격 가능 · 1.21.9 이후 버전은 켜져 있으면 바로 적용', toggle(draft.pvp, set('pvp'))),
          row('하드코어', '죽으면 관전자로 전환', toggle(draft.hardcore, set('hardcore'))),
          row('비행 허용', '비행 모드·플러그인 사용 시 필요', toggle(draft.allowFlight, set('allowFlight'))),
          row('커맨드 블록', '커맨드 블록 사용 가능 · 1.21.9 이후 버전은 켜져 있으면 바로 적용', toggle(draft.commandBlocks, set('commandBlocks'))),
        ),
        h(
          'div.stack',
          { style: { gap: '20px' } },
          h(
            'div.card',
            null,
            h('div.card-head', null, h('h2', null, '접속 · 보안')),
            row('화이트리스트', '목록에 넣은 플레이어만 접속 (접속자 탭에서 관리) · 켜져 있으면 바로 적용', toggle(draft.whitelist, set('whitelist'))),
            row('정품 인증', '끄면 복제 계정도 접속 가능 (위험)', toggle(draft.onlineMode, set('onlineMode'))),
            row('스폰 보호 범위', '스폰 주변은 OP만 수정 가능', slider({ min: 0, max: 32, value: draft.spawnProtection, onInput: set('spawnProtection'), format: (v) => (v ? `${v}칸` : '없음') })),
            row('포트', '보통은 기본값 유지', input(draft.port, (v) => {
              const port = Number(v);
              // 입력 중인 값(예: 25)은 저장하지 않는다
              if (port >= 1024 && port <= 65535) set('port', 900)(port);
            }, { type: 'number', min: 1024, max: 65535, style: { maxWidth: '130px' } })),
          ),
          h(
            'div.card',
            null,
            h('div.card-head', null, h('h2', null, '성능')),
            row('메모리', `PC 메모리 ${specs ? `${specs.totalGb}GB` : ''} 기준 추천값 표시`, mem),
            row('시야 거리', '줄이면 서버 부담 감소 (추천 8~10)', slider({ min: 3, max: 20, value: draft.viewDistance, onInput: set('viewDistance'), format: (v) => `${v}칸` })),
            row('시뮬레이션 거리', '작물·몹이 움직이는 거리 (추천 6~8)', slider({ min: 3, max: 16, value: draft.simulationDistance, onInput: set('simulationDistance'), format: (v) => `${v}칸` })),
            row('자동 최적화', "Aikar's flags(JVM 옵션)와 Paper 추천 설정", toggle(draft.optimize, set('optimize'))),
          ),
        ),
      ),
      h(
        'div.card',
        null,
        h('div.card-head', null, h('h2', null, '연결 방식')),
        row(
          'playit.gg 터널',
          '포트포워딩 없이 접속 주소 발급 (추천)',
          h('div.inline', null, button('터널 연결', () => startTunnel(s.id), { small: true, kind: 'primary' }), button('playit 연결 초기화', async () => {
            const ok = await modal({ title: 'playit 연결 초기화', body: h('p', null, '저장된 playit.gg 연결과 접속 주소를 지우고 처음부터 다시 연결'), actions: [{ label: '취소', value: false }, { label: '초기화', value: true, kind: 'danger' }] });
            if (ok && (await call('tunnel:reset'))) {
              for (const x of state.servers) if (x.network && x.network.mode !== 'upnp') x.network = { ...x.network, address: null };
              state.reach = {};
              renderAddress();
              toast('playit 연결·접속 주소 초기화 — "터널 연결"로 다시 연결', { kind: 'ok', timeout: 6000 });
            }
          }, { small: true, kind: 'ghost' })),
        ),
        row(
          'UPnP 포트 열기',
          '공유기가 UPnP를 지원하고 포트포워딩이 되는 사람만 (선택)',
          h('div.inline', null, button(s.network && s.network.mode === 'upnp' ? '다시 열기' : '포트 열기', async () => {
            toast('공유기를 찾는 중…');
            const r = await call('upnp:open', s.id);
            if (r && r !== true) {
              toast(`포트 열림 — ${r.address}`, { kind: 'ok' });
              const fresh = (await call('servers:list')) || [];
              state.servers = fresh;
              renderAddress();
            }
          }, { small: true }), s.network && s.network.mode === 'upnp' ? button('닫기', () => call('upnp:close', s.id), { small: true, kind: 'ghost' }) : null),
        ),
      ),
      gameRulesCard(s, rules),
      worldSettingsCard(s),
      h(
        'div.create-bar',
        null,
        h('div.inline', null, button('서버 폴더 열기', () => call('server:openFolder', s.id), { icon: '⌂' })),
        h('span.note', null, '바꾸면 바로 저장 · 켜져 있으면 난이도·게임 모드·화이트리스트·게임 규칙은 즉시 적용'),
      ),
    );
  }

  // ---------- 게임 규칙 (gamerule) ----------
  function gameRulesCard(s, rules) {
    const body = h('div', null, h('span.note', null, '불러오는 중…'));
    const control = (r) => {
      const cur = r.key in rules.changes ? rules.changes[r.key] : r.value;
      if (r.kind === 'bool') {
        return toggle(cur, (v) => {
          rules.changes[r.key] = v;
          rules.onChange();
        });
      }
      return input(cur, (v) => {
        if (v === '' || !Number.isFinite(Number(v))) return;
        rules.changes[r.key] = Number(v);
        rules.onChange(900);
      }, { type: 'number', min: r.min ?? 0, max: r.max, style: { maxWidth: '110px' } });
    };
    const ruleRow = (r) => row(r.label, [r.desc, r.pending ? '다음 실행 때 적용' : null].filter(Boolean).join(' · ') || null, control(r));
    const load = async () => {
      const g = await call('server:gameRules', s.id);
      if (!g || g === true) return;
      if (!g.available) {
        put(body, h('span.note', null, '월드가 아직 없음 — 서버를 한 번 켜면 설정 가능'));
        return;
      }
      const more = h('details.rules-more', null, h('summary', null, h('span.note', null, `그 밖의 규칙 ${g.other.length}개 (영문 이름)`)), h('div', null, g.other.map(ruleRow)));
      put(body, ...g.common.map(ruleRow), g.other.length ? more : null);
    };
    rules.reload = load;
    load();
    return h(
      'div.card',
      null,
      h('div.card-head', null, h('div', null, h('h2', null, '게임 규칙'), h('div.note', null, `월드에 저장되는 규칙(gamerule) · 켜져 있으면 바로 적용 · 앱에서 정한 값은 켤 때마다 다시 맞춤${s.type === 'paper' ? ' · 오버월드·네더·엔드 모두 적용' : ''}`))),
      body,
    );
  }

  // ---------- 맵(월드) 설정 편집기 ----------
  const WORLD_TYPES = [
    { value: 'normal', label: '기본' },
    { value: 'flat', label: '평지' },
    { value: 'large_biomes', label: '큰 바이옴' },
    { value: 'amplified', label: '증폭' },
  ];
  const BLOCKS = [
    ['bedrock', '기반암'], ['stone', '돌'], ['deepslate', '심층암'], ['dirt', '흙'], ['grass_block', '잔디 블록'], ['sand', '모래'], ['sandstone', '사암'],
    ['gravel', '자갈'], ['clay', '점토'], ['water', '물'], ['lava', '용암'], ['snow_block', '눈 블록'], ['ice', '얼음'], ['packed_ice', '단단한 얼음'],
    ['netherrack', '네더랙'], ['end_stone', '엔드 돌'], ['obsidian', '흑요석'], ['glass', '유리'], ['air', '공기'],
  ];
  const BIOMES = [
    ['plains', '평원'], ['ocean', '바다'], ['deep_ocean', '깊은 바다'], ['warm_ocean', '따뜻한 바다'], ['desert', '사막'], ['forest', '숲'], ['taiga', '타이가'],
    ['snowy_plains', '눈 덮인 평원'], ['jungle', '정글'], ['savanna', '사바나'], ['swamp', '늪'], ['badlands', '악지'], ['mushroom_fields', '버섯 들판'], ['the_void', '공허'],
  ];
  // 레이어는 아래층(기반암)부터 · 평지를 고르면 고전 평지에서 시작
  const FLAT_PRESETS = {
    classic: { label: '고전 평지', biome: 'plains', layers: [['bedrock', 1], ['dirt', 2], ['grass_block', 1]] },
  };
  const presetLayers = (key) => FLAT_PRESETS[key].layers.map(([block, height]) => ({ block, height }));
  const defaultWorld = () => ({ source: 'new', type: 'normal', seed: '', structures: true, flat: { preset: 'classic', biome: 'plains', layers: presetLayers('classic') } });

  /** 월드 유형 · 평지 레이어 · 시드 · 구조물. w 를 그 자리에서 고친다 */
  function worldEditor(w) {
    const wrap = h('div.stack', { style: { gap: '4px' } });
    const draw = () => {
      const flat = w.type === 'flat';
      const total = (w.flat.layers || []).reduce((a, l) => a + (Number(l.height) || 0), 0);
      const layerRows = [...w.flat.layers]
        .map((l, i) => ({ l, i }))
        .reverse() // 위층부터 보여준다
        .map(({ l, i }) =>
          h(
            'div.layer-row',
            null,
            h('span.note.num', null, i === w.flat.layers.length - 1 ? '맨 위' : i === 0 ? '맨 아래' : `${i + 1}층`),
            select(BLOCKS.map(([value, label]) => ({ value, label: `${label} (${value})` })), l.block, (v) => {
              l.block = v;
              w.flat.preset = 'custom';
            }),
            input(l.height, (v) => {
              l.height = Math.max(1, Math.floor(Number(v) || 1));
              w.flat.preset = 'custom';
              totalNote.textContent = totalText();
            }, { type: 'number', min: 1, max: 384, style: { width: '90px' } }),
            h('span.note', null, '칸'),
            button(null, () => {
              if (w.flat.layers.length <= 1) return toast('레이어 1개 이상 필요', { kind: 'error' });
              w.flat.layers.splice(i, 1);
              w.flat.preset = 'custom';
              draw();
            }, { small: true, kind: 'ghost', icon: '✕', title: '레이어 삭제' }),
          ),
        );
      const totalText = () => {
        const t = w.flat.layers.reduce((a, l) => a + (Number(l.height) || 0), 0);
        return `전체 ${t}칸 · 지면 높이 Y=${-64 + t}${t > 384 ? ' · 최대 384칸 초과' : ''}`;
      };
      const totalNote = h(`span.note${total > 384 ? '.bad' : ''}`, null, totalText());
      put(
        wrap,
        row('월드 유형', '평지: 층을 직접 쌓는 맵 · 큰 바이옴: 바이옴이 넓음 · 증폭: 산이 매우 높음', seg(WORLD_TYPES, w.type, (v) => {
          w.type = v;
          draw();
        })),
        flat
          ? [
              row('바이옴', '물 색·날씨·스폰되는 몹이 달라짐', select(BIOMES.map(([value, label]) => ({ value, label: `${label} (${value})` })), w.flat.biome, (v) => {
                w.flat.biome = v;
                w.flat.preset = 'custom';
              })),
              h(
                'div.layers',
                null,
                h('div.inline', null, h('span.txt', null, '층 (위에서 아래로)'), h('span.spacer'), totalNote, button('맨 위에 층 추가', () => {
                  w.flat.layers.push({ block: 'stone', height: 1 });
                  w.flat.preset = 'custom';
                  draw();
                }, { small: true, icon: '＋' })),
                layerRows,
              ),
            ]
          : null,
        row('시드', '비우면 무작위 · 같은 시드는 같은 지형', input(w.seed, (v) => (w.seed = v.trim()), { placeholder: '무작위', maxLength: 32 })),
        row('구조물 생성', '마을·요새 등 생성', toggle(w.structures, (v) => (w.structures = v))),
      );
    };
    draw();
    return wrap;
  }

  const TYPE_LABEL = { normal: '기본', flat: '평지', large_biomes: '큰 바이옴', amplified: '증폭' };

  /** 설정 탭: 지금 맵 정보 · 다른 맵으로 바꾸기 · 새 설정으로 다시 만들기 */
  function worldSettingsCard(s) {
    const info = h('div.stack', { style: { gap: '2px' } }, h('span.note', null, '불러오는 중…'));
    const stopped = s.status === 'stopped';
    let current = null;
    call('world:info', s.id).then((w) => {
      if (!w || w === true) return;
      current = w;
      const flat = w.type === 'flat' && w.flat ? ` · ${w.flat.layers.map((l) => `${l.block}×${l.height}`).join(' / ')}` : '';
      put(
        info,
        h('span.txt', null, `${TYPE_LABEL[w.type] || w.type}${flat}`),
        h('span.note', null, `${w.seed ? `시드 ${w.seed}` : '시드 무작위'} · 구조물 ${w.structures ? '생성' : '없음'}${w.saved && w.saved.version ? ` · 저장 버전 ${w.saved.version}` : w.exists ? '' : ' · 아직 생성 전(다음 실행 때 생성)'}`),
      );
    });

    const importMap = async (kind) => {
      const r = await call('world:import', s.id, kind);
      if (!r || r === true) return;
      const ok = await modal({
        title: '맵 바꾸기',
        body: [importSummary(r), h('p.note', null, '현재 월드는 "맵 교체 전" 백업으로 보관 후 교체')],
        actions: [{ label: '취소', value: false }, { label: r.newer ? '그래도 바꾸기' : '바꾸기', value: true, kind: r.newer ? 'danger' : 'primary' }],
      });
      if (!ok) return;
      const done = await call('world:importConfirm', s.id, r.path);
      if (done && done !== true) {
        toast(`맵 교체 완료 — ${done.name}`, { kind: 'ok' });
        renderTab();
      }
    };

    const regenerate = async () => {
      const base = current || defaultWorld();
      const w = { ...defaultWorld(), ...base, source: 'new', flat: base.flat ? { preset: 'custom', ...base.flat, layers: base.flat.layers.map((l) => ({ ...l })) } : defaultWorld().flat };
      const ok = await modal({
        title: '새 설정으로 월드 다시 만들기',
        body: [worldEditor(w), h('p.note', null, '현재 월드는 "월드 재생성 전" 백업으로 보관 후 삭제 · 다음 서버 실행 때 새 월드 생성')],
        actions: [{ label: '취소', value: false }, { label: '다시 만들기', value: true, kind: 'danger' }],
      });
      if (!ok) return;
      if (await call('world:regenerate', s.id, w)) {
        toast('월드 삭제 · 다음 실행 때 새 설정으로 생성', { kind: 'ok', timeout: 6000 });
        renderTab();
      }
    };

    return h(
      'div.card',
      null,
      h('div.card-head', null, h('div', null, h('h2', null, '맵'), h('div.note', null, stopped ? '맵 교체·재생성 전 현재 월드 자동 백업' : '맵 교체·재생성은 서버를 끈 뒤 가능'))),
      row('현재 맵', null, info),
      row('다른 맵으로 바꾸기', '싱글플레이 저장 폴더 또는 zip', h('div.inline', null, button('폴더 선택', () => importMap('folder'), { small: true, disabled: !stopped }), button('zip 선택', () => importMap('zip'), { small: true, disabled: !stopped }))),
      row('월드 다시 만들기', '월드 유형·평지 층·시드를 바꿔 새로 생성', button('설정하고 다시 만들기', regenerate, { small: true, kind: 'danger', disabled: !stopped })),
    );
  }

  /** 맵 가져오기 선택 결과 표시 */
  function importSummary(info) {
    if (!info) return h('span.note', null, '선택한 맵 없음');
    return h(
      'div.stack',
      { style: { gap: '2px' } },
      h('span.txt', null, info.name || '맵'),
      h('span.note', null, `${info.version ? `저장 버전 ${info.version}` : '저장 버전 확인 불가'} · ${info.path}`),
      info.newer ? h('span.note.bad', null, '서버보다 새 버전에서 저장된 맵 — 열리지 않거나 손상될 수 있음') : null,
    );
  }

  // ---------- 새 서버 만들기 (마법사가 아니라 한 화면) ----------
  /** 만들기 화면 머리: 새로 만들기 / 기존 서버 가져오기 전환 */
  function createHead(title, sub) {
    return h(
      'div.create-head',
      null,
      h('div', null, h('h1', null, title), h('p', { style: { marginTop: '6px' } }, sub)),
      seg([{ value: 'new', label: '새로 만들기' }, { value: 'import', label: '기존 서버 가져오기' }], state.createMode || 'new', (v) => switchCreateMode(v)),
    );
  }

  function renderCreate() {
    if (state.createMode === 'import') return renderImport();
    const specs = state.specs || { recommendedMb: 4096, maxMb: 8192, totalGb: 8 };
    const c = (state.create = state.create || {
      type: 'paper',
      version: null,
      versions: {},
      name: '',
      nameAuto: true, // 직접 고치기 전까지 (버전) (종류) 서버 형식으로 따라간다
      motdAuto: true, // 직접 고치기 전까지 서버 이름을 따라간다
      world: defaultWorld(),
      memoryMb: specs.recommendedMb,
      optimize: true,
      eula: false,
      settings: { difficulty: 'normal', gamemode: 'survival', maxPlayers: 10, pvp: true, whitelist: false, hardcore: false, onlineMode: true, motd: '' },
      busy: false,
    });

    const root = h('div.main-scroll');
    const defaultName = () => `${c.version || ''} ${TYPE[c.type].label}`.trim();
    const nameField = input(c.name, (v) => {
      c.name = v;
      c.nameAuto = false;
      if (v.trim()) nameRow.classList.remove('invalid');
      syncAutoMotd();
    }, { maxLength: 40 });
    const motdField = input(c.settings.motd, (v) => {
      c.settings.motd = v;
      c.motdAuto = false;
    }, { maxLength: 59 });
    const syncAutoMotd = () => {
      if (!c.motdAuto) return;
      c.settings.motd = c.name.trim();
      motdField.value = c.settings.motd;
    };
    const syncAutoName = () => {
      if (!c.nameAuto) return;
      c.name = defaultName();
      nameField.value = c.name;
      nameRow.classList.remove('invalid');
      syncAutoMotd();
    };
    const worldBody = h('div');
    const drawWorld = () => {
      const w = c.world;
      if (w.source === 'import') {
        const pick = async (kind) => {
          const r = await call('world:pick', kind, c.version);
          if (r && r !== true) {
            w.importPath = r.path;
            w.importInfo = r;
            drawWorld();
          }
        };
        put(
          worldBody,
          row('가져올 맵', '싱글플레이 저장 폴더(level.dat 가 있는 폴더) 또는 그 폴더를 압축한 zip', h('div.inline', null, button('폴더 선택', () => pick('folder'), { small: true }), button('zip 선택', () => pick('zip'), { small: true }))),
          h('div.import-info', null, importSummary(w.importInfo)),
        );
      } else {
        put(worldBody, worldEditor(w));
      }
    };
    drawWorld();
    const worldCard = h(
      'div.card',
      null,
      h('div.card-head', null, h('div', null, h('h2', null, '맵'), h('div.note', null, '새로 만들 맵의 지형 또는 기존 맵 가져오기'))),
      row('맵 준비', null, seg([{ value: 'new', label: '새 맵 만들기' }, { value: 'import', label: '기존 맵 가져오기' }], c.world.source, (v) => {
        c.world.source = v;
        drawWorld();
      })),
      worldBody,
    );
    const nameRow = row('서버 이름', '이 앱에서만 표시 · 비우면 만들 수 없음', nameField);
    const versionBox = h('div');
    const javaBox = h('div.pc-item.well-sm');
    const bar = progressBar(0);
    const barLabel = h('span.txt');
    trackProgress('create', bar, barLabel);
    const progressBox = h('div.card.progress-line', { class: c.busy ? '' : 'hidden' }, barLabel, bar);

    // 만들기 버튼은 왼쪽 판 위쪽에 있다
    const refreshCreate = () => {
      const btn = $('#createGo');
      if (!btn) return;
      btn.disabled = !c.eula || !c.version || c.busy;
      btn.classList.toggle('is-locked', !c.eula);
      btn.title = !c.eula ? 'EULA 동의 필요' : !c.version ? '버전 선택 필요' : '';
    };
    live.refreshCreate = refreshCreate;
    live.eula = {
      get: () => c.eula,
      set: (v) => {
        c.eula = v;
        refreshCreate();
      },
    };

    const loadVersions = async () => {
      put(versionBox, h('span.note', null, '버전 목록을 불러오는 중…'));
      if (!c.versions[c.type]) {
        const r = await call('versions:list', c.type);
        if (!r || r === true) {
          put(versionBox, h('span.note.bad', null, '버전 목록 불러오기 실패 — 인터넷 연결 확인'), button('다시 시도', loadVersions, { small: true }));
          return;
        }
        c.versions[c.type] = r;
      }
      const v = c.versions[c.type];
      if (!c.version || !v.versions.includes(c.version)) c.version = v.latest;
      syncAutoName();
      put(versionBox, 
        h(
          'div.inline',
          null,
          select(
            v.versions.slice(0, 60).map((x) => ({ value: x, label: x === v.latest ? `${x} (최신 안정)` : x })),
            c.version,
            (x) => {
              c.version = x;
              syncAutoName();
              checkJava();
            },
          ),
        ),
      );
      checkJava();
      refreshCreate();
    };

    const checkJava = async () => {
      put(javaBox, dot('busy'), h('div', null, h('div.txt', null, 'Java 확인 중…')), h('span'));
      const r = await window.mc.invoke('java:check', c.version);
      if (!r.ok) return;
      const { major, found } = r.data;
      const key = `java-${major}`;
      const jbar = progressBar(0);
      const jlabel = h('span.note');
      trackProgress(key, jbar, jlabel);
      put(javaBox, 
        dot(found ? 'ok' : 'busy'),
        h('div', { style: { minWidth: 0 } }, h('div.txt', null, `Java ${major} 필요`), found ? h('div.note', null, found.managed ? '앱 폴더에 설치됨' : 'PC에 설치된 Java 사용') : h('div.note', null, '없음 → 서버 생성 시 앱 폴더에 자동 설치 (시스템 설치 없음)'), found ? null : h('div.progress-line.hidden', null, jlabel, jbar)),
        found
          ? h('span.tag.ok', null, '준비됨')
          : button('지금 받기', async (e) => {
              e.currentTarget.disabled = true;
              jbar.parentElement.classList.remove('hidden');
              if (await call('java:install', major)) {
                state.javaInstalled = (await call('java:installed')) || state.javaInstalled;
                renderSide();
                checkJava();
              }
            }, { small: true }),
      );
    };

    const cardKey = () => (MOD_TYPES.includes(c.type) ? 'mod' : c.type);
    const loaderRow = h('div');
    const drawLoader = () => {
      put(
        loaderRow,
        MOD_TYPES.includes(c.type)
          ? row('모드 로더', [h('div', null, 'Forge: 대형 콘텐츠 모드(Create 등) 대부분 지원'), h('div', null, 'NeoForge: Forge 후속, 1.20.2 이후 새 모드 다수'), h('div', null, 'Fabric: 가볍고 최신 버전 대응이 빠름')], seg([{ value: 'forge', label: 'Forge (기본)' }, { value: 'neoforge', label: 'NeoForge' }, { value: 'fabric', label: 'Fabric' }], c.type, (v) => {
              c.type = v;
              c.modLoader = v;
              syncAutoName();
              loadVersions();
            }))
          : null,
      );
    };
    const typeCards = h(
      'div.type-grid',
      null,
      TYPE_CARDS.map((t) =>
        h(
          `button.type-card${cardKey() === t.key ? '.on' : ''}`,
          {
            type: 'button',
            onclick: (e) => {
              c.type = t.key === 'mod' ? c.modLoader || 'forge' : t.key;
              typeCards.querySelectorAll('.type-card').forEach((x) => x.classList.remove('on'));
              e.currentTarget.classList.add('on');
              drawLoader();
              renderSide();
              syncAutoName();
              loadVersions();
            },
          },
          typeMark(t.key, '.type-ico'),
          h('h3', null, t.label),
          h('span.note', null, t.sub),
          h('p', { style: { fontSize: '0.82rem' } }, t.desc),
        ),
      ),
    );
    drawLoader();

    const memMarks = [{ value: specs.recommendedMb, label: `추천 ${fmt.gb(specs.recommendedMb)}` }];
    const mem = slider({ min: 1024, max: specs.maxMb, step: 512, value: c.memoryMb, onInput: (v) => (c.memoryMb = v), format: fmt.gb, marks: memMarks });
    mem.classList.add('has-marks');

    const set = (k) => (v) => (c.settings[k] = v);

    const create = async () => {
      if (!c.name.trim()) {
        nameRow.classList.add('invalid');
        nameRow.scrollIntoView({ block: 'center', behavior: 'smooth' });
        nameField.focus();
        return toast('서버 이름 필요', { kind: 'error' });
      }
      if (c.world.source === 'import' && !c.world.importPath) {
        worldCard.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return toast('가져올 맵 선택 필요', { kind: 'error' });
      }
      if (!c.eula) return toast('EULA 동의 필요', { kind: 'error' });
      if (busy) return;
      busy = true;
      c.busy = true;
      refreshCreate();
      // UI가 사라지고 패널이 꺼진 뒤, 패널 화면의 로딩 화면이 실제 진행을 따라간다
      const s = await runLoad({
        cap: `MCES · SV-NEW · ${TYPE[c.type].sub.toUpperCase()} ${c.version}`,
        status: `${c.name.trim()} 만드는 중`,
        mark: c.type,
        progressKey: 'create',
        work: () => call('servers:create', { type: c.type, version: c.version, name: c.name.trim(), memoryMb: c.memoryMb, optimize: c.optimize, eula: c.eula, settings: c.settings, world: c.world }, 'create'),
      });
      c.busy = false;
      if (s && s !== true) {
        state.create = null;
        if (!state.servers.find((x) => x.id === s.id)) state.servers.push(s);
        state.javaInstalled = (await call('java:installed')) || state.javaInstalled;
        toast(`${s.name} 생성 완료`, { kind: 'ok', timeout: 6000 });
        await leaveLoader(() => {
          state.page = 'server';
          state.selected = s.id;
          state.tab = 'overview';
        });
      } else {
        await leaveLoader(() => {
          state.page = 'home';
        });
      }
      busy = false;
    };
    live.createAction = create;

    root.append(
      h(
        'div.stack',
        { style: { gap: '18px' } },
        createHead('새 서버 만들기', '"서버 만들기"를 누르면 Java 확인부터 최적화까지 자동 진행'),

        h('div.card', null, h('div.card-head', null, h('h2', null, '서버 종류')), typeCards, loaderRow),

        h('div.card', null, h('div.card-head', null, h('div', null, h('h2', null, '만들기 전에 확인'), h('div.note', null, '이 PC에서 자동 확인'))), h(
          'div.precheck',
          null,
          javaBox,
          h('div.pc-item.well-sm', null, dot('ok'), h('div', null, h('div.txt', null, `PC 메모리 ${specs.totalGb}GB`), h('div.note', null, `서버 추천 할당 ${fmt.gb(specs.recommendedMb)} (나머지는 PC·게임용)`)), h('span.num.sky', null, fmt.gb(specs.recommendedMb))),
        )),

        h(
          'div.grid.grid-2',
          null,
          h(
            'div.card',
            null,
            h('div.card-head', null, h('h2', null, '버전 · 메모리')),
            row('마인크래프트 버전', '접속할 클라이언트와 같은 버전 사용. 기본값은 최신 안정 버전', versionBox),
            nameRow,
            row('메모리', 'PC 사양 기준 추천값 표시', mem),
            row('자동 최적화', "Aikar's flags" + (c.type === 'paper' ? ' · Paper 추천 설정' : '') + ' · 적정 시야 거리' + (c.type === 'fabric' ? ' · 최적화 모드(Lithium 등)' : c.type === 'forge' || c.type === 'neoforge' ? ' · 최적화 모드(ModernFix 등)' : ''), toggle(c.optimize, (v) => (c.optimize = v))),
          ),
          h(
            'div.card',
            null,
            h('div.card-head', null, h('h2', null, '기본 설정')),
            row('난이도', '몬스터의 세기와 배고픔 속도', seg(DIFFICULTY, c.settings.difficulty, set('difficulty'))),
            row('게임 모드', '처음 들어온 사람의 모드', seg(GAMEMODE, c.settings.gamemode, set('gamemode'))),
            row('최대 인원', '동시에 들어올 수 있는 사람 수', slider({ min: 2, max: 50, value: c.settings.maxPlayers, onInput: set('maxPlayers'), format: (v) => `${v}명` })),
            row('PVP', '플레이어끼리 공격 가능', toggle(c.settings.pvp, set('pvp'))),
            row('화이트리스트', '허락한 플레이어만 접속', toggle(c.settings.whitelist, set('whitelist'))),
            row('서버 설명', '서버 목록에 보이는 한 줄 · 기본값은 서버 이름', motdField),
          ),
        ),

        worldCard,

        progressBox,
        h('div.create-bar', null, h('span.note', null, '서버와 Java는 모두 앱 폴더 안에 생성 · 왼쪽 위 "서버 만들기"로 시작')),
      ),
    );
    loadVersions();
    refreshCreate();
    return root;
  }

  // ---------- 기존 서버 가져오기 (앱 밖에서 만든 서버 폴더) ----------
  const FLAVOR_NOTE = { Paper: 'Paper', Purpur: 'Purpur (Paper 계열)', Folia: 'Folia (Paper 계열)', Pufferfish: 'Pufferfish (Paper 계열)', Spigot: 'Spigot (Bukkit 계열)', CraftBukkit: 'CraftBukkit', 'Bukkit 계열': 'Bukkit 계열', Fabric: 'Fabric', Forge: 'Forge', NeoForge: 'NeoForge', Vanilla: '바닐라' };

  function renderImport() {
    const specs = state.specs || { recommendedMb: 4096, maxMb: 8192, totalGb: 8 };
    const g = (state.importing = state.importing || { det: null, mode: 'copy', name: '', memoryMb: specs.recommendedMb, optimize: true, eula: false, busy: false, inspecting: false });
    const root = h('div.main-scroll');
    const body = h('div.stack', { style: { gap: '22px' } });

    const inspect = async (dir) => {
      g.inspecting = true;
      draw();
      const det = dir ? await call('servers:inspectImport', dir) : await call('servers:pickImport');
      g.inspecting = false;
      if (det && det !== true) {
        g.det = det;
        g.name = det.name || '';
        g.memoryMb = Math.min(specs.maxMb, Math.max(1024, det.memoryMb || specs.recommendedMb));
        g.eula = !!det.eula;
      }
      draw();
      renderSide();
    };

    const folderCard = () => {
      const zone = h(
        'div.drop-zone',
        {
          ondragover: (e) => {
            e.preventDefault();
            zone.classList.add('over');
          },
          ondragleave: () => zone.classList.remove('over'),
          ondrop: (e) => {
            e.preventDefault();
            zone.classList.remove('over');
            const p = [...e.dataTransfer.files].map((f) => window.mc.pathForFile && window.mc.pathForFile(f)).find(Boolean);
            if (p) inspect(p);
          },
        },
        h('span.note', null, g.inspecting ? '폴더 확인 중…' : g.det ? g.det.path : '서버 폴더를 여기에 끌어다 놓기'),
        button(g.det ? '다른 폴더' : '폴더 선택', () => inspect(null), { small: true, icon: '⌂', disabled: g.inspecting || g.busy }),
      );
      return h(
        'div.card',
        null,
        h('div.card-head', null, h('div', null, h('h2', null, '서버 폴더'), h('div.note', null, 'server.properties 와 서버 jar 가 있는 폴더 (Paper · Spigot · Bukkit · Purpur · Fabric · Forge · 바닐라)'))),
        zone,
      );
    };

    const detectedCard = (d) => {
      const addonName = d.type === 'paper' ? '플러그인' : d.type === 'vanilla' ? null : '모드';
      return h(
        'div.card',
        null,
        h('div.card-head', null, h('h2', null, '알아낸 정보')),
        h(
          'div.list',
          null,
          info('종류', `${FLAVOR_NOTE[d.flavor] || d.flavor} → ${TYPE[d.type].label}`),
          info('버전', d.version),
          d.jarFile ? info('실행 파일', d.jarFile) : null,
          addonName ? info(addonName, `${d.addonCount}개 (그대로 사용)`) : null,
          info('월드', d.worldVersion ? `${d.levelName} · 저장 버전 ${d.worldVersion}` : `${d.levelName} · 없음`),
          info('포트', String(d.port)),
          d.memoryFrom ? info('기존 메모리', `${fmt.gb(d.memoryMb)} (${d.memoryFrom})`) : null,
        ),
        d.warnings.length ? h('div.stack', { style: { gap: '4px', marginTop: '10px' } }, d.warnings.map((w) => h('span.compat.brass', null, w))) : null,
      );
    };

    const bar = progressBar(0);
    const barLabel = h('span.txt');
    trackProgress('import', bar, barLabel);
    const progressBox = h('div.card.progress-line', { class: g.busy ? '' : 'hidden' }, barLabel, bar);

    const run = async () => {
      if (!g.name.trim()) return toast('서버 이름 필요', { kind: 'error' });
      if (!g.eula) return toast('EULA 동의 필요', { kind: 'error' });
      if (busy) return;
      busy = true;
      g.busy = true;
      const s = await runLoad({
        cap: `MCES · SV-NEW · IMPORT`,
        status: `${g.name.trim()} 가져오는 중`,
        mark: (g.det && g.det.type) || 'paper',
        progressKey: 'import',
        work: () => call('servers:import', { path: g.det.path, mode: g.mode, name: g.name.trim(), memoryMb: g.memoryMb, optimize: g.optimize, eula: g.eula }, 'import'),
      });
      g.busy = false;
      if (s && s !== true) {
        state.importing = null;
        state.createMode = 'new';
        if (!state.servers.find((x) => x.id === s.id)) state.servers.push(s);
        state.javaInstalled = (await call('java:installed')) || state.javaInstalled;
        toast(`${s.name} 가져오기 완료`, { kind: 'ok', timeout: 6000 });
        await leaveLoader(() => {
          state.page = 'server';
          state.selected = s.id;
          state.tab = 'overview';
        });
      } else {
        await leaveLoader(() => {
          state.page = 'home';
        });
      }
      busy = false;
    };
    live.createAction = run;

    const optionsCard = (d) => {
      const memMarks = [{ value: specs.recommendedMb, label: `추천 ${fmt.gb(specs.recommendedMb)}` }];
      const mem = slider({ min: 1024, max: specs.maxMb, step: 512, value: g.memoryMb, onInput: (v) => (g.memoryMb = v), format: fmt.gb, marks: memMarks });
      mem.classList.add('has-marks');
      return h(
        'div.card',
        null,
        h('div.card-head', null, h('h2', null, '가져오기 설정')),
        row(
          '가져오는 방법',
          g.mode === 'copy' ? '앱 데이터 폴더로 복사 · 원래 폴더는 그대로 남음' : '원래 폴더를 그대로 사용 · 앱에서 삭제해도 폴더는 남음',
          seg([{ value: 'copy', label: '복사 (권장)' }, { value: 'inplace', label: '그 자리에서 사용' }], g.mode, (v) => {
            g.mode = v;
            draw();
          }),
        ),
        row('서버 이름', '이 앱에서만 표시', input(g.name, (v) => (g.name = v), { maxLength: 40 })),
        row('메모리', d.memoryFrom ? `기존 실행 파일(${d.memoryFrom}) 값으로 채움` : 'PC 사양 기준 추천값 표시', mem),
        row('자동 최적화', "Aikar's flags(JVM 옵션)만 적용 · 기존 설정 파일은 그대로", toggle(g.optimize, (v) => (g.optimize = v))),
      );
    };

    const draw = () => {
      const d = g.det;
      const ok = d && !d.problems.length;
      const btn = $('#createGo');
      if (btn) {
        btn.disabled = !ok || g.busy || !(g.eula || (d && d.eula));
        btn.classList.toggle('is-locked', !!(ok && !(g.eula || d.eula)));
        btn.title = !ok ? '서버 폴더 선택 필요' : '';
      }
      live.refreshCreate = () => {
        const b2 = $('#createGo');
        if (b2) {
          b2.disabled = !ok || g.busy || !(g.eula || (d && d.eula));
          b2.classList.toggle('is-locked', !!(ok && !(g.eula || d.eula)));
        }
      };
      // 이 폴더에 동의 기록이 없을 때만 왼쪽 위에 EULA 동의를 띄운다
      const wantEula = ok && !d.eula;
      if (!!live.eula !== wantEula) {
        live.eula = wantEula
          ? {
              get: () => g.eula,
              set: (v) => {
                g.eula = v;
                live.refreshCreate();
              },
            }
          : null;
        updateCreateGo();
      }
      put(
        body,
        folderCard(),
        d && d.problems.length ? h('div.card', null, h('div.card-head', null, h('h2', null, '가져올 수 없음')), h('div.stack', { style: { gap: '4px' } }, d.problems.map((p) => h('span.note.bad', null, p)))) : null,
        ok ? h('div.grid.grid-2', null, detectedCard(d), optionsCard(d)) : null,
        progressBox,
        ok ? h('div.create-bar', null, h('span.note', null, '월드 · 플러그인 · 설정 파일은 그대로 유지 · 왼쪽 위 "서버 가져오기"로 시작')) : null,
      );
      progressBox.classList.toggle('hidden', !g.busy);
    };
    draw();
    root.append(h('div.stack', { style: { gap: '18px' } }, createHead('기존 서버 가져오기', '앱 밖에서 만든 서버를 목록에 추가'), body));
    return root;
  }

  // ---------- 업데이트 (호환성 경고 포함) ----------
  async function openUpdate(s) {
    toast('업데이트를 확인하는 중…');
    const first = await call('server:checkUpdate', s.id);
    if (!first || first === true) return;
    let target = first.latest;
    let report = first;
    const body = h('div.stack');
    const renderReport = () => {
      const newer = first.available.filter((v) => window.compareVersions(v, s.version) >= 0).slice(0, 40);
      put(body, 
        row('바꿀 버전', `지금은 ${s.version}${s.build ? ` (빌드 ${s.build})` : ''}`, select(newer.map((v) => ({ value: v, label: v === first.latest ? `${v} (최신)` : v === s.version ? `${v} (현재 · 최신 빌드로)` : v })), target, async (v) => {
          target = v;
          body.style.opacity = 0.5;
          report = (await call('server:checkUpdate', s.id, v)) || report;
          body.style.opacity = 1;
          renderReport();
        })),
        report.sameVersion ? h('p', null, '같은 버전의 최신 빌드로 교체. 플러그인·모드는 유지') : null,
        report.javaChange ? h('p.brass', null, '다른 Java 버전 필요 → 앱 폴더에 자동 설치') : null,
        report.incompatible && report.incompatible.length
          ? h('div.card', { style: { padding: '14px 16px' } }, h('h3.bad', null, `새 버전과 안 맞는 ${TYPE[s.type].addon} ${report.incompatible.length}개`), h('p.note', null, '업데이트 시 자동 비활성화. 호환 버전이 나오면 다시 켜기'), h('div.list', null, report.incompatible.map((a) => h('div.list-item', { style: { gridTemplateColumns: 'auto 1fr' } }, dot('bad'), h('span.txt', null, a.reason ? `${a.title} — ${a.reason}` : a.title)))))
          : null,
        report.compatible && report.compatible.length && !report.sameVersion ? h('p.note', null, `호환되는 ${TYPE[s.type].addon} ${report.compatible.length}개는 새 버전 파일로 자동 교체`) : null,
        report.unknown && report.unknown.length ? h('p.note', null, `직접 넣은 파일 ${report.unknown.length}개(${report.unknown.map((a) => a.title).join(', ')})는 호환 여부 확인 불가`) : null,
        h('p.note', null, '업데이트 전 월드 자동 백업. 올린 버전은 되돌리기 불가'),
      );
    };
    renderReport();
    const ok = await modal({ title: '서버 업데이트', body, actions: [{ label: '취소', value: false }, { label: '업데이트', value: true, kind: 'primary' }] });
    if (!ok) return;
    toast(`${target}(으)로 업데이트 중…`, { timeout: 6000 });
    const r = await call('server:applyUpdate', s.id, target);
    if (r && r !== true) toast(`${target}(으)로 업데이트 완료`, { kind: 'ok' });
  }

  async function removeServer(s) {
    let keep = false;
    const ok = await modal({
      title: `${s.name} 삭제`,
      body: [h('p', null, '서버 폴더(월드, 플러그인, 설정) 전체 삭제. 되돌리기 불가'), checkbox(false, (v) => (keep = v), '백업 파일은 남겨 두기')],
      actions: [{ label: '취소', value: false }, { label: '삭제', value: true, kind: 'danger' }],
    });
    if (!ok) return;
    if (await call('server:remove', s.id, { keepBackups: keep })) toast('삭제됨');
  }

  // 버전 비교(업데이트 목록 거르기용)
  window.compareVersions = (a, b) => {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  };

  init();
})();
