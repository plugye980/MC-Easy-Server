'use strict';
/* MC Easy Server — 한 화면에서 서버 추가 · 관리 (Docker Desktop처럼 왼쪽 목록 + 오른쪽 상세) */
(function () {
  const { h, $, fmt, button, seg, toggle, checkbox, slider, select, input, row, dot, progressBar, toast, modal, call } = window.UI;
  const Charts = window.Charts;

  const TYPE = {
    paper: { label: '플러그인 서버', sub: 'Paper', desc: '플러그인으로 기능을 더해요. 가장 가볍고 빨라요.', addon: '플러그인', folder: 'plugins' },
    fabric: { label: '모드 서버', sub: 'Fabric', desc: '모드를 넣어요. 친구들도 같은 모드를 설치해야 해요.', addon: '모드', folder: 'mods' },
    vanilla: { label: '바닐라 서버', sub: 'Vanilla', desc: '아무것도 넣지 않은 공식 서버예요.', addon: '데이터팩', folder: 'datapacks' },
  };
  const STATUS = {
    stopped: { label: '꺼짐', dot: 'off' },
    starting: { label: '켜는 중', dot: 'busy' },
    running: { label: '켜짐', dot: 'ok' },
    stopping: { label: '저장하고 끄는 중', dot: 'busy' },
  };
  const DIFFICULTY = [
    { value: 'peaceful', label: '평화로움', hint: '몬스터가 나오지 않아요' },
    { value: 'easy', label: '쉬움' },
    { value: 'normal', label: '보통' },
    { value: 'hard', label: '어려움' },
  ];
  const GAMEMODE = [
    { value: 'survival', label: '서바이벌', hint: '자원을 모으며 살아남기' },
    { value: 'creative', label: '크리에이티브', hint: '무한 블록, 자유 건축' },
    { value: 'adventure', label: '모험', hint: '블록을 부수거나 놓을 수 없어요' },
  ];

  const state = {
    servers: [],
    selected: null, // 서버 id 또는 'new'
    tab: 'overview',
    specs: null,
    settings: { theme: 'dark' },
    tunnel: { status: 'idle', addresses: {} },
    javaInstalled: [],
    alerts: {}, // serverId -> [alert]
    consoles: {}, // serverId -> [line]
    history: {}, // serverId -> [point]
    reach: {}, // serverId -> 점검 결과
    progress: {}, // key -> {text, percent}
    create: null,
  };
  const progressViews = new Map(); // key -> [{bar, label}]
  let live = {}; // 현재 화면의 갱신 가능한 요소들

  const server = () => state.servers.find((s) => s.id === state.selected) || null;

  // ---------- 시작 ----------
  async function init() {
    state.settings = (await call('app:settings')) || state.settings;
    applyTheme(state.settings.theme);
    const [specs, servers, tunnel, javaInstalled] = await Promise.all([call('system:specs'), call('servers:list'), call('tunnel:state'), call('java:installed')]);
    state.specs = specs;
    state.servers = servers || [];
    state.tunnel = tunnel || state.tunnel;
    state.javaInstalled = javaInstalled || [];
    state.selected = state.servers[0] ? state.servers[0].id : 'new';
    subscribe();
    render();
    setInterval(autoCheck, 60 * 1000);
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
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
        toast(`${s.name} 서버가 켜졌어요`, { kind: 'ok' });
        setTimeout(() => checkReach(s.id), 4000);
      }
    });
    mc.on('server:removed', ({ serverId }) => {
      state.servers = state.servers.filter((s) => s.id !== serverId);
      if (state.selected === serverId) state.selected = state.servers[0] ? state.servers[0].id : 'new';
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
      if (s) s.metrics = { tps: e.tps, memoryMb: e.memoryMb, cpu: e.cpu };
      if (e.serverId === state.selected && live.updateMetrics) live.updateMetrics();
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
      if (state.selected && state.selected !== 'new') renderAddress();
    });
    mc.on('progress', (p) => {
      state.progress[p.key] = p;
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
    renderSide();
    renderMain();
  }

  function renderSide() {
    const specs = state.specs;
    const list = h(
      'div.server-list',
      null,
      state.servers.length
        ? state.servers.map((s) =>
            h(
              `button.srv${s.id === state.selected ? '.on' : ''}`,
              { type: 'button', onclick: () => selectServer(s.id) },
              dot(STATUS[s.status].dot),
              h('span', { style: { minWidth: 0 } }, h('span.srv-name.txt', null, s.name), h('span.srv-meta.note', null, `${TYPE[s.type].sub} ${s.version}${s.status === 'running' ? ` · ${s.players.length}명` : ''}`)),
              s.status === 'running' && s.metrics && s.metrics.tps !== null ? h('span.num.sky', { style: { fontSize: '0.78rem' } }, s.metrics.tps.toFixed(1)) : null,
            ),
          )
        : h('span.empty.note', null, '아직 서버가 없어요'),
    );
    const side = $('#side');
    side.replaceChildren(
      h('div.brand', null, h('div.brand-mark'), h('div', null, h('h1', null, 'MC Easy Server'), h('span.note', null, '친구들과 여는 마인크래프트 서버'))),
      h(
        'div.side-section',
        { style: { flex: '1', minHeight: 0 } },
        h('div.side-head', null, h('span.label', null, '내 서버'), button(null, () => selectServer('new'), { icon: '+', small: true, kind: 'ghost', title: '새 서버 만들기' })),
        list,
        button('새 서버 만들기', () => selectServer('new'), { icon: '+', kind: state.selected === 'new' ? 'primary' : undefined, class: 'btn-block' }),
      ),
      h(
        'div.side-foot',
        null,
        specs
          ? h(
              'div.spec',
              null,
              h('span.note', null, 'PC 메모리'),
              h('span.num', null, `${specs.totalGb}GB`),
              h('span.note', null, '추천 할당'),
              h('span.num.sky', null, fmt.gb(specs.recommendedMb)),
              h('span.note', null, 'CPU'),
              h('span.num', null, `${specs.cpuCores}코어`),
              h('span.note', null, 'Java'),
              h('span.num', null, state.javaInstalled.length ? state.javaInstalled.map((j) => j.major).join(', ') : '아직 없음'),
            )
          : null,
        seg(
          [
            { value: 'dark', label: '어둡게' },
            { value: 'light', label: '밝게' },
          ],
          state.settings.theme,
          async (theme) => {
            applyTheme(theme);
            state.settings = (await call('app:setSettings', { theme })) || state.settings;
            if (live.updateMetrics) live.updateMetrics();
          },
          { name: '테마' },
        ),
      ),
    );
    side.querySelector('.side-foot .seg').classList.add('seg-wide');
  }

  function selectServer(id) {
    if (state.selected !== id) state.tab = 'overview';
    state.selected = id;
    render();
  }

  function renderMain() {
    live = {};
    progressViews.clear();
    const main = $('#main');
    if (state.selected === 'new') {
      main.replaceChildren(renderCreate());
      return;
    }
    const s = server();
    if (!s) {
      main.replaceChildren(h('div.empty-state', null, h('div.stack', null, h('h2', null, '서버를 골라 주세요'))));
      return;
    }
    live.head = h('div');
    live.alerts = h('div');
    live.address = h('div');
    live.tabs = h('div.tabs-wrap');
    live.content = h('div.main-scroll');
    main.replaceChildren(live.head, live.alerts, live.address, live.tabs, live.content);
    renderHead();
    renderAlerts();
    renderAddress();
    renderTabs();
    renderTab();
    if (s.status === 'running' && !state.reach[s.id]) checkReach(s.id);
  }

  // ---------- 머리: 이름 · 상태 · 켜기/끄기 · 업데이트 · 삭제 ----------
  function renderHead() {
    const s = server();
    if (!s || !live.head) return;
    const st = STATUS[s.status];
    const busy = s.status === 'starting' || s.status === 'stopping';
    const startKey = `start-${s.id}`;
    const startBar = progressBar(0);
    const startLabel = h('span.note');
    trackProgress(startKey, startBar, startLabel);
    live.head.replaceChildren(
      h(
        'div.head',
        null,
        h(
          'div.head-title',
          null,
          h('h1', null, s.name),
          h(
            'div.head-meta',
            null,
            h('span.chip', null, dot(st.dot), st.label),
            h('span.chip', null, `${TYPE[s.type].label} · ${TYPE[s.type].sub}`),
            h('span.chip', null, `마인크래프트 ${s.version}`),
            s.status === 'running' && s.startedAt ? h('span.note', null, `${fmt.uptime(Date.now() - s.startedAt)}째 켜져 있어요`) : null,
          ),
        ),
        h(
          'div.head-actions',
          null,
          s.status === 'stopped'
            ? button('켜기', () => startServer(s.id), { kind: 'primary', icon: '▶' })
            : button(s.status === 'stopping' ? '끄는 중…' : '끄기', () => call('server:stop', s.id), { icon: '■', disabled: s.status === 'stopping' }),
          button('다시 켜기', () => call('server:restart', s.id), { icon: '↻', disabled: s.status !== 'running' }),
          button('업데이트', () => openUpdate(s), { icon: '⬆', disabled: busy }),
          button('삭제', () => removeServer(s), { icon: '✕', kind: 'danger', disabled: busy }),
        ),
      ),
      ...(s.status === 'starting' ? [h('div', { style: { padding: '0 32px 12px' } }, h('div.progress-line', null, startLabel, startBar))] : []),
    );
  }

  async function startServer(id) {
    await call('server:start', id);
  }

  // ---------- 오류 안내 ----------
  function renderAlerts() {
    const s = server();
    if (!s || !live.alerts) return;
    const list = state.alerts[s.id] || [];
    live.alerts.replaceChildren(
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
      h('span.check-item', { title: detail || '' }, dot(ok === null ? 'off' : ok ? 'ok' : 'bad'), h(`span.txt${ok === null ? '' : ok ? '.ok' : '.bad'}`, null, label));

    let main;
    if (t.status === 'claiming' && t.claimUrl) {
      main = h(
        'div.address-main',
        null,
        dot('busy'),
        h('div', { style: { minWidth: 0 } }, h('div.txt', null, '처음 한 번만: playit.gg 계정 연결을 승인해 주세요'), h('div.note', null, '브라우저가 열렸어요. 로그인(또는 게스트) 후 "Add Agent"를 누르면 자동으로 이어져요.')),
        button('브라우저에서 열기', () => call('app:openExternal', t.claimUrl), { small: true, kind: 'primary' }),
      );
    } else if (address) {
      main = h(
        'div.address-main',
        null,
        h('span.note', { style: { whiteSpace: 'nowrap' } }, s.network && s.network.mode === 'upnp' ? '공유기 주소' : '친구 접속 주소'),
        h('span.address-text.num.sky', null, address),
        button('복사', async () => {
          if (await call('app:copy', address)) toast('주소를 복사했어요. 친구에게 보내 주세요!', { kind: 'ok' });
        }, { small: true, kind: 'primary', icon: '⧉' }),
        button(null, () => editAddress(s), { small: true, kind: 'ghost', icon: '✎', title: '주소 직접 입력' }),
      );
    } else {
      const tunnelBusy = t.status === 'downloading' || t.status === 'connecting';
      const bar = progressBar(0);
      trackProgress(`tunnel-${s.id}`, bar, null);
      main = h(
        'div.address-main',
        null,
        dot(tunnelBusy ? 'busy' : 'off'),
        h('div', { style: { minWidth: 0, flex: 1 } }, h('div.txt', null, tunnelBusy ? t.message || '터널 연결 중' : '아직 친구 접속 주소가 없어요'), tunnelBusy ? bar : h('div.note', null, t.status === 'error' ? t.message : '터널을 연결하면 포트포워딩 없이 친구가 들어올 수 있어요.')),
        button('터널 연결', () => startTunnel(s.id), { small: true, kind: 'primary', disabled: tunnelBusy }),
        button(null, () => editAddress(s), { small: true, kind: 'ghost', icon: '✎', title: '주소 직접 입력' }),
      );
    }

    live.address.replaceChildren(
      h(
        'div.card.address-bar',
        null,
        main,
        h(
          'div.checks',
          null,
          light(running && r ? r.local.online : null, '서버 응답', r && r.local.online ? `응답 ${r.local.latency}ms` : ''),
          light(running && r && r.address ? r.external.online : null, '외부 접속', r && r.external.checkedBy ? `${r.external.checkedBy} 점검` : ''),
          button('점검', () => checkReach(s.id, true), { small: true, kind: 'ghost', disabled: !running, title: '외부에서 접속 가능한지 다시 확인' }),
        ),
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
      toast('터널은 켜졌지만 주소를 자동으로 찾지 못했어요. playit.gg 대시보드의 주소를 ✎ 버튼으로 입력해 주세요.', { timeout: 9000 });
    }
  }

  async function editAddress(s) {
    let value = currentAddress(s) || '';
    const choice = await modal({
      title: '접속 주소',
      body: [
        h('p', null, 'playit.gg 대시보드에 나온 주소나, 직접 포트포워딩한 공인 IP 주소를 넣을 수 있어요.'),
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
      if (r.data.external.online) toast('외부에서 접속할 수 있어요!', { kind: 'ok' });
      else if (!r.data.address) toast('먼저 터널을 연결하거나 주소를 넣어 주세요.');
      else toast('외부에서 아직 접속이 안 돼요. 터널이 켜져 있는지 확인해 주세요.', { kind: 'error' });
    }
  }

  function autoCheck() {
    for (const s of state.servers) if (s.status === 'running') checkReach(s.id);
  }

  // ---------- 탭 ----------
  function renderTabs() {
    const s = server();
    if (!s) return;
    live.tabs.replaceChildren(
      seg(
        [
          { value: 'overview', label: '개요' },
          { value: 'console', label: '콘솔' },
          { value: 'players', label: `접속자${s.players.length ? ` ${s.players.length}` : ''}` },
          { value: 'addons', label: TYPE[s.type].addon },
          { value: 'backups', label: '백업' },
          { value: 'settings', label: '설정' },
        ],
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
    const views = { overview: viewOverview, console: viewConsole, players: viewPlayers, addons: viewAddons, backups: viewBackups, settings: viewSettings };
    const scroll = live.content.scrollTop;
    live.content.replaceChildren(views[state.tab](s));
    if (state.tab === 'overview' || state.tab === 'players') live.content.scrollTop = scroll;
    // 탭 이름의 접속자 수 갱신
    const playersTab = live.tabs.querySelectorAll('.seg-item .txt')[2];
    if (playersTab) playersTab.textContent = `접속자${s.players.length ? ` ${s.players.length}` : ''}`;
  }

  // 개요: TPS 게이지 · 메모리 능선 · 접속자 · 서버 정보
  function viewOverview(s) {
    const running = s.status === 'running';
    const gauge = Charts.gauge({ size: 220, max: 20 });
    const tpsText = h('div.stat-value.num.sky');
    const tpsNote = h('div.note');
    const memChart = Charts.ridge({ width: 600, height: 170, max: s.memoryMb, tag: 'MEMORY' });
    const memText = h('span.stat-value.num.sky');
    const cpuText = h('span.num');
    const memNote = h('span.note');

    live.updateMetrics = () => {
      const cur = state.servers.find((x) => x.id === s.id) || s;
      const m = cur.metrics || {};
      const on = cur.status === 'running';
      gauge.update(on ? m.tps : null);
      tpsText.textContent = on && m.tps !== null && m.tps !== undefined ? m.tps.toFixed(1) : '–';
      tpsNote.textContent = !on ? '서버가 켜지면 보여요' : m.tps === null || m.tps === undefined ? '측정 중…' : m.tps >= 18 ? '아주 쾌적해요' : m.tps >= 14 ? '조금 느려요' : '많이 버거워해요';
      const hist = state.history[s.id] || [];
      memChart.update(hist.map((p) => p.memoryMb));
      memText.textContent = on ? fmt.gb(m.memoryMb || 0) : '–';
      memNote.textContent = `/ 할당 ${fmt.gb(cur.memoryMb)}`;
      cpuText.textContent = on ? `CPU ${m.cpu || 0}%` : '';
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
          h('div.card-head', null, h('div', null, h('h2', null, '성능'), h('div.note', null, '초당 틱(TPS)이 20에 가까울수록 렉이 없어요'))),
          h(
            'div.grid',
            { style: { gridTemplateColumns: 'minmax(180px, 240px) 1fr', alignItems: 'center' } },
            h('div.gauge-wrap', null, gauge, h('div.gauge-center', null, tpsText, h('div.note', null, 'TPS'))),
            h('div.stack', { style: { gap: '6px' } }, h('div.inline', null, h('span.txt', null, '상태'), tpsNote), h('div.inline', null, memText, memNote), cpuText),
          ),
        ),
        h('div.card', null, h('div.card-head', null, h('div', null, h('h2', null, '메모리 사용량'), h('div.note', null, '최근 15분'))), h('div.well.chart-well', null, memChart)),
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
            : h('span.empty', null, running ? '아직 아무도 없어요' : '서버가 꺼져 있어요'),
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
            info(TYPE[s.type].addon, `${(s.addons || []).length}개`),
          ),
        ),
      ),
    );
    requestAnimationFrame(() => live.updateMetrics && live.updateMetrics());
    return view;
  }

  function info(label, value) {
    return h('div.list-item', { style: { gridTemplateColumns: '1fr auto', padding: '9px 2px' } }, h('span.note', null, label), h('span.num', null, value));
  }

  // 콘솔
  function viewConsole(s) {
    const box = h('div.well.console');
    for (const e of state.consoles[s.id] || []) appendConsole(box, e, false);
    let value = '';
    const field = input('', (v) => (value = v), {
      placeholder: s.status === 'running' ? '명령어 입력 (예: say 안녕, time set day)' : '서버를 켜면 명령어를 보낼 수 있어요',
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
        box.replaceChildren();
        for (const e of lines) appendConsole(box, e, false);
        box.scrollTop = box.scrollHeight;
      });
    }
    return h('div.card', null, box, h('div.console-input', null, field, button('보내기', send, { kind: 'primary', disabled: s.status !== 'running' })));
  }

  function appendConsole(box, e, scroll = true) {
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const kind = e.kind !== 'out' ? e.kind : /\bWARN\b/.test(e.line) ? 'warn' : /\b(ERROR|SEVERE|FATAL)\b|Exception/.test(e.line) ? 'error' : '';
    box.appendChild(h(`div.console-line${kind ? `.${kind}` : ''}`, null, e.line));
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
    const labels = { kick: '강퇴했어요', op: 'OP를 줬어요', deop: 'OP를 뺐어요', 'whitelist-add': '화이트리스트에 넣었어요', 'whitelist-remove': '화이트리스트에서 뺐어요', ban: '차단했어요', pardon: '차단을 풀었어요' };
    if (action === 'kick' || action === 'ban') {
      const ok = await modal({ title: `${name} 님을 ${action === 'kick' ? '강퇴' : '차단'}할까요?`, body: h('p', null, action === 'kick' ? '다시 들어올 수는 있어요.' : '차단을 풀기 전까지 들어올 수 없어요.'), actions: [{ label: '취소', value: false }, { label: action === 'kick' ? '강퇴' : '차단', value: true, kind: 'danger' }] });
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
      online.appendChild(s.players.length ? h('div.list', null, s.players.map((p) => playerRow(s, p, false, lists))) : h('span.empty', null, running ? '아직 아무도 없어요' : '서버를 켜면 접속자가 보여요'));

      let name = '';
      const nameField = input('', (v) => (name = v), { placeholder: '플레이어 이름', disabled: !running });
      side.append(
        h(
          'div.card',
          null,
          h('div.card-head', null, h('div', null, h('h2', null, '이름으로 관리'), h('div.note', null, running ? '접속하지 않은 친구도 미리 추가할 수 있어요' : '서버가 켜져 있을 때 할 수 있어요'))),
          h('div.stack', null, nameField, h('div.inline', null, button('화이트리스트 추가', () => name && playerAction(s, 'whitelist-add', name.trim()), { small: true, disabled: !running }), button('OP 주기', () => name && playerAction(s, 'op', name.trim()), { small: true, disabled: !running }), button('차단', () => name && playerAction(s, 'ban', name.trim()), { small: true, kind: 'danger', disabled: !running }))),
        ),
        nameList(s, '화이트리스트', s.settings.whitelist ? '켜짐 — 목록에 있는 사람만 들어올 수 있어요' : '꺼짐 — 설정 탭에서 켤 수 있어요', lists.whitelist, 'whitelist-remove', '빼기', running),
        nameList(s, '관리자 (OP)', '명령어를 쓸 수 있는 사람', lists.ops, 'deop', 'OP 해제', running),
        lists.banned.length ? nameList(s, '차단됨', '', lists.banned, 'pardon', '차단 해제', running) : null,
      );
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
        : h('span.empty', null, '비어 있어요'),
    );
  }

  // 추가 기능: 설치됨 + Modrinth 검색 · 원클릭 설치
  function viewAddons(s) {
    const t = TYPE[s.type];
    const installed = h('div.list');
    const results = h('div.list');
    const resultNote = h('span.note');
    const bar = progressBar(0);
    const barLabel = h('span.note');
    const progressBox = h('div.progress-line.hidden', null, barLabel, bar);
    trackProgress(`addon-${s.id}`, bar, barLabel);

    const refreshInstalled = async () => {
      const list = await call('addons:list', s.id);
      if (!Array.isArray(list)) return;
      installed.replaceChildren(
        ...(list.length
          ? list
              .sort((a, b) => (a.dependencyOf ? 1 : 0) - (b.dependencyOf ? 1 : 0))
              .map((a) =>
                h(
                  `div.list-item${a.enabled ? '' : '.disabled'}`,
                  null,
                  a.iconUrl ? h('img.icon-img', { src: a.iconUrl, alt: '' }) : h('div.icon-img.icon-ph.txt', null, (a.title || '?')[0]),
                  h(
                    'div',
                    { style: { minWidth: 0 } },
                    h('div.list-title', null, h('span.txt', null, a.title), a.dependencyOf ? h('span.tag.txt', null, '자동 설치된 의존성') : null, a.manual ? h('span.tag.txt', null, '직접 넣은 파일') : null),
                    h('div.note', null, a.versionNumber ? `${a.versionNumber} · ${a.fileName}` : a.fileName),
                  ),
                  h(
                    'div.list-actions',
                    null,
                    toggle(a.enabled, async (on) => {
                      await call('addons:toggle', s.id, a.fileName, on);
                      toast(on ? `${a.title} 켰어요` : `${a.title} 껐어요`);
                      refreshInstalled();
                    }),
                    button(null, async () => {
                      const ok = await modal({ title: `${a.title} 삭제`, body: h('p', null, '파일을 지워요. 설정 폴더는 남아 있어요.'), actions: [{ label: '취소', value: false }, { label: '삭제', value: true, kind: 'danger' }] });
                      if (ok && (await call('addons:remove', s.id, a.fileName))) refreshInstalled();
                    }, { small: true, kind: 'ghost', icon: '✕', title: '삭제' }),
                  ),
                ),
              )
          : [h('span.empty', null, `아직 설치한 ${t.addon}이(가) 없어요. 오른쪽에서 찾아 설치해 보세요.`)]),
      );
    };

    let query = '';
    let timer = null;
    const doSearch = async () => {
      resultNote.textContent = '찾는 중…';
      const r = await call('addons:search', s.id, query, { limit: 20 });
      if (!r || r === true) {
        resultNote.textContent = '검색하지 못했어요.';
        return;
      }
      resultNote.textContent = `${s.version} · ${t.sub}에 맞는 것만 보여줘요 · ${fmt.num(r.total)}개`;
      results.replaceChildren(
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
                      const res = await call('addons:install', s.id, hit.projectId);
                      progressBox.classList.add('hidden');
                      if (res && res !== true) {
                        const extra = res.installed.filter((a) => a.projectId !== hit.projectId).map((a) => a.title);
                        toast(`${hit.title} 설치 완료${extra.length ? ` (필요한 ${extra.join(', ')}도 같이 설치)` : ''}${res.needsRestart ? ' — 다시 켜면 적용돼요' : ''}`, { kind: 'ok', timeout: 6500 });
                        if (res.skipped.length) toast(`설치하지 못한 의존성: ${res.skipped.map((x) => x.title).join(', ')}`, { kind: 'error', timeout: 8000 });
                        hit.installed = true;
                        btn.replaceWith(h('span.tag.ok', null, '설치됨'));
                        refreshInstalled();
                      } else btn.disabled = false;
                    }, { small: true, kind: 'primary' }),
              ),
            )
          : [h('span.empty', null, '맞는 결과가 없어요')]),
      );
    };

    const searchField = input('', (v) => {
      query = v;
      clearTimeout(timer);
      timer = setTimeout(doSearch, 350);
    }, { placeholder: `${t.addon} 이름으로 찾기 (예: ${s.type === 'paper' ? 'EssentialsX, LuckPerms' : s.type === 'fabric' ? 'Sodium, Lithium' : 'Vanilla Tweaks'})` });

    refreshInstalled();
    doSearch();

    return h(
      'div.grid.grid-2',
      null,
      h(
        'div.card',
        null,
        h(
          'div.card-head',
          null,
          h('div', null, h('h2', null, `설치된 ${t.addon}`), h('div.note', null, `${t.folder} 폴더 · 끄면 파일 이름 뒤에 .disabled가 붙어요`)),
          h(
            'div.inline',
            null,
            button('모두 업데이트', async () => {
              const n = await call('addons:update', s.id);
              if (n !== undefined) {
                toast(n ? `${n}개를 새 버전으로 바꿨어요` : '모두 최신이에요', { kind: 'ok' });
                refreshInstalled();
              }
            }, { small: true, icon: '⬆' }),
            s.type === 'fabric'
              ? button('친구용 모드팩', async () => {
                  const r = await call('addons:exportMrpack', s.id);
                  if (r && r !== true) toast(`모드팩(.mrpack)을 저장했어요 — 모드 ${r.count}개. 친구들은 Modrinth 앱이나 Prism 런처로 열면 돼요.`, { kind: 'ok', timeout: 8000 });
                }, { small: true, kind: 'primary', icon: '⇪', title: '친구들이 설치해야 할 모드 목록을 .mrpack으로 내보내요' })
              : null,
          ),
        ),
        installed,
      ),
      h('div.card', null, h('div.card-head', null, h('div', null, h('h2', null, 'Modrinth에서 찾기'), resultNote)), h('div.stack', null, searchField, progressBox, results)),
    );
  }

  // 백업
  function viewBackups(s) {
    const bk = { ...s.backup };
    const list = h('div.list');
    const refresh = async () => {
      const items = await call('backups:list', s.id);
      if (!Array.isArray(items)) return;
      const reasonLabel = { manual: '직접', auto: '자동', stop: '정지 시', 'before-restore': '복원 전', 'before-update': '업데이트 전' };
      list.replaceChildren(
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
                    if (s.status !== 'stopped') return toast('복원하려면 먼저 서버를 꺼 주세요.', { kind: 'error' });
                    const ok = await modal({ title: '이 백업으로 되돌릴까요?', body: [h('p', null, `${fmt.date(b.createdAt)} 시점의 월드로 바꿔요.`), h('p.note', null, '지금 월드는 "복원 전" 백업으로 따로 남겨 두니 안심하세요.')], actions: [{ label: '취소', value: false }, { label: '복원', value: true, kind: 'primary' }] });
                    if (ok && (await call('backups:restore', s.id, b.file))) {
                      toast('복원했어요', { kind: 'ok' });
                      refresh();
                    }
                  }, { small: true }),
                  button(null, async () => {
                    const ok = await modal({ title: '백업 삭제', body: h('p', null, '이 백업 파일을 지울까요?'), actions: [{ label: '취소', value: false }, { label: '삭제', value: true, kind: 'danger' }] });
                    if (ok && (await call('backups:delete', s.id, b.file))) refresh();
                  }, { small: true, kind: 'ghost', icon: '✕', title: '삭제' }),
                ),
              ),
            )
          : [h('span.empty', null, '아직 백업이 없어요')]),
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
          h('div', null, h('h2', null, '백업 목록'), h('div.note', null, '월드(world, 네더, 엔드)를 zip으로 저장해요')),
          button('지금 백업', async (e) => {
            e.currentTarget.disabled = true;
            const r = await call('backups:create', s.id);
            e.currentTarget.disabled = false;
            if (r) {
              toast('백업했어요', { kind: 'ok' });
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
        row('정해진 간격마다', '서버가 켜져 있는 동안 저장을 잠깐 멈추고 안전하게 백업해요', toggle(bk.enabled, (v) => save({ enabled: v }))),
        row('간격', null, seg([15, 30, 60, 120].map((m) => ({ value: m, label: m < 60 ? `${m}분` : `${m / 60}시간` })), bk.intervalMin, (v) => save({ intervalMin: v }))),
        row('서버를 끌 때', '끌 때마다 월드를 한 번 더 백업해요', toggle(bk.onStop, (v) => save({ onStop: v }))),
        row('자동 백업 보관 개수', '오래된 자동 백업부터 지워요 (직접 만든 백업은 지우지 않아요)', slider({ min: 3, max: 50, value: bk.keep, onInput: (v) => { clearTimeout(bk.t); bk.t = setTimeout(() => save({ keep: v }), 400); }, format: (v) => `${v}개` })),
      ),
    );
  }

  // 설정: server.properties 를 풀어서
  function viewSettings(s) {
    const draft = { ...s.settings, name: s.name, memoryMb: s.memoryMb, optimize: s.optimize };
    const specs = state.specs;
    const set = (k) => (v) => {
      draft[k] = v;
    };
    const save = async () => {
      const { levelName, ...rest } = draft;
      const r = await call('server:settings', s.id, rest);
      if (r) toast(s.status === 'stopped' ? '저장했어요' : '저장했어요 — 서버를 다시 켜면 적용돼요', { kind: 'ok' });
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
          h('div.card-head', null, h('h2', null, '게임 규칙')),
          row('서버 이름', '이 앱에서만 보이는 이름', input(draft.name, set('name'))),
          row('서버 설명', '친구의 서버 목록에 보이는 한 줄', input(draft.motd, set('motd'), { maxLength: 59 })),
          row('난이도', '몬스터의 세기와 배고픔 속도', seg(DIFFICULTY, draft.difficulty, set('difficulty'))),
          row('게임 모드', '처음 들어온 사람의 모드', seg(GAMEMODE, draft.gamemode, set('gamemode'))),
          row('최대 인원', '동시에 들어올 수 있는 사람 수', slider({ min: 2, max: 50, value: draft.maxPlayers, onInput: set('maxPlayers'), format: (v) => `${v}명` })),
          row('PVP', '플레이어끼리 공격할 수 있어요', toggle(draft.pvp, set('pvp'))),
          row('하드코어', '죽으면 관전자가 돼요', toggle(draft.hardcore, set('hardcore'))),
          row('비행 허용', '비행 모드/플러그인을 쓰는 경우 켜 주세요', toggle(draft.allowFlight, set('allowFlight'))),
          row('커맨드 블록', '커맨드 블록을 쓸 수 있어요', toggle(draft.commandBlocks, set('commandBlocks'))),
        ),
        h(
          'div.stack',
          { style: { gap: '20px' } },
          h(
            'div.card',
            null,
            h('div.card-head', null, h('h2', null, '접속 · 보안')),
            row('화이트리스트', '목록에 넣은 친구만 들어올 수 있어요 (접속자 탭에서 관리)', toggle(draft.whitelist, set('whitelist'))),
            row('정품 인증', '끄면 복제 계정도 들어올 수 있어 위험해요', toggle(draft.onlineMode, set('onlineMode'))),
            row('스폰 보호 범위', '스폰 주변을 OP만 고칠 수 있어요', slider({ min: 0, max: 32, value: draft.spawnProtection, onInput: set('spawnProtection'), format: (v) => (v ? `${v}칸` : '없음') })),
            row('포트', '보통은 그대로 두세요', input(draft.port, (v) => (draft.port = Number(v) || 25565), { type: 'number', min: 1024, max: 65535, style: { maxWidth: '130px' } })),
          ),
          h(
            'div.card',
            null,
            h('div.card-head', null, h('h2', null, '성능')),
            row('메모리', `PC 메모리 ${specs ? `${specs.totalGb}GB` : ''} 기준 추천값이 표시돼요`, mem),
            row('시야 거리', '줄이면 서버가 가벼워져요 (추천 8~10)', slider({ min: 3, max: 20, value: draft.viewDistance, onInput: set('viewDistance'), format: (v) => `${v}칸` })),
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
          '포트포워딩 없이 주소를 받아요 (추천)',
          h('div.inline', null, button('터널 연결', () => startTunnel(s.id), { small: true, kind: 'primary' }), button('playit 연결 초기화', async () => {
            const ok = await modal({ title: 'playit 연결 초기화', body: h('p', null, '저장된 playit.gg 연결을 지우고 처음부터 다시 연결해요.'), actions: [{ label: '취소', value: false }, { label: '초기화', value: true, kind: 'danger' }] });
            if (ok) call('tunnel:reset');
          }, { small: true, kind: 'ghost' })),
        ),
        row(
          'UPnP 포트 열기',
          '공유기가 UPnP를 지원하고 포트포워딩이 되는 사람만 (선택)',
          h('div.inline', null, button(s.network && s.network.mode === 'upnp' ? '다시 열기' : '포트 열기', async () => {
            toast('공유기를 찾는 중…');
            const r = await call('upnp:open', s.id);
            if (r && r !== true) {
              toast(`포트를 열었어요 — ${r.address}`, { kind: 'ok' });
              const fresh = (await call('servers:list')) || [];
              state.servers = fresh;
              renderAddress();
            }
          }, { small: true }), s.network && s.network.mode === 'upnp' ? button('닫기', () => call('upnp:close', s.id), { small: true, kind: 'ghost' }) : null),
        ),
      ),
      h(
        'div.create-bar',
        null,
        h('div.inline', null, button('서버 폴더 열기', () => call('server:openFolder', s.id), { icon: '⌂' })),
        button('설정 저장', save, { kind: 'primary', icon: '✓', class: 'btn-lg' }),
      ),
    );
  }

  // ---------- 새 서버 만들기 (마법사가 아니라 한 화면) ----------
  function renderCreate() {
    const specs = state.specs || { recommendedMb: 4096, maxMb: 8192, totalGb: 8 };
    const c = (state.create = state.create || {
      type: 'paper',
      version: null,
      versions: {},
      name: '',
      memoryMb: specs.recommendedMb,
      optimize: true,
      eula: false,
      settings: { difficulty: 'normal', gamemode: 'survival', maxPlayers: 10, pvp: true, whitelist: false, hardcore: false, onlineMode: true, motd: '친구들과 함께하는 서버' },
      busy: false,
    });

    const root = h('div.main-scroll', { style: { paddingTop: '26px' } });
    const versionBox = h('div');
    const javaBox = h('div.pc-item.well-sm');
    const createBtn = button('서버 만들기', () => create(), { kind: 'primary', icon: '✓', class: 'btn-lg' });
    const bar = progressBar(0);
    const barLabel = h('span.txt');
    trackProgress('create', bar, barLabel);
    const progressBox = h('div.card.progress-line', { class: c.busy ? '' : 'hidden' }, barLabel, bar);

    const refreshCreate = () => {
      createBtn.disabled = !c.eula || !c.version || c.busy;
      createBtn.title = !c.eula ? 'EULA에 동의해 주세요' : !c.version ? '버전을 골라 주세요' : '';
    };

    const loadVersions = async () => {
      versionBox.replaceChildren(h('span.note', null, '버전 목록을 불러오는 중…'));
      if (!c.versions[c.type]) {
        const r = await call('versions:list', c.type);
        if (!r || r === true) {
          versionBox.replaceChildren(h('span.note.bad', null, '버전 목록을 가져오지 못했어요. 인터넷 연결을 확인해 주세요.'), button('다시 시도', loadVersions, { small: true }));
          return;
        }
        c.versions[c.type] = r;
      }
      const v = c.versions[c.type];
      if (!c.version || !v.versions.includes(c.version)) c.version = v.latest;
      versionBox.replaceChildren(
        h(
          'div.inline',
          null,
          select(
            v.versions.slice(0, 60).map((x) => ({ value: x, label: x === v.latest ? `${x} (최신 안정)` : x })),
            c.version,
            (x) => {
              c.version = x;
              checkJava();
            },
          ),
        ),
      );
      checkJava();
      refreshCreate();
    };

    const checkJava = async () => {
      javaBox.replaceChildren(dot('busy'), h('div', null, h('div.txt', null, 'Java 확인 중…')), h('span'));
      const r = await window.mc.invoke('java:check', c.version);
      if (!r.ok) return;
      const { major, found } = r.data;
      const key = `java-${major}`;
      const jbar = progressBar(0);
      const jlabel = h('span.note');
      trackProgress(key, jbar, jlabel);
      javaBox.replaceChildren(
        dot(found ? 'ok' : 'busy'),
        h('div', { style: { minWidth: 0 } }, h('div.txt', null, `Java ${major} 필요`), found ? h('div.note', null, found.managed ? '앱 폴더에 설치돼 있어요' : 'PC에 있는 Java를 써요') : h('div.note', null, '없어요 → 만들 때 앱 폴더에 자동으로 받아요 (시스템에 설치하지 않아요)'), found ? null : h('div.progress-line.hidden', null, jlabel, jbar)),
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

    const typeCards = h(
      'div.type-grid',
      null,
      Object.entries(TYPE).map(([key, t]) =>
        h(
          `button.type-card${c.type === key ? '.on' : ''}`,
          {
            type: 'button',
            onclick: (e) => {
              c.type = key;
              typeCards.querySelectorAll('.type-card').forEach((x) => x.classList.remove('on'));
              e.currentTarget.classList.add('on');
              loadVersions();
            },
          },
          h('span.type-ico'),
          h('h3', null, t.label),
          h('span.note', null, t.sub),
          h('p', { style: { fontSize: '0.82rem' } }, t.desc),
        ),
      ),
    );

    const memMarks = [{ value: specs.recommendedMb, label: `추천 ${fmt.gb(specs.recommendedMb)}` }];
    const mem = slider({ min: 1024, max: specs.maxMb, step: 512, value: c.memoryMb, onInput: (v) => (c.memoryMb = v), format: fmt.gb, marks: memMarks });
    mem.classList.add('has-marks');

    const set = (k) => (v) => (c.settings[k] = v);

    const create = async () => {
      if (!c.eula) return toast('EULA에 동의해 주세요', { kind: 'error' });
      c.busy = true;
      refreshCreate();
      progressBox.classList.remove('hidden');
      const s = await call('servers:create', { type: c.type, version: c.version, name: c.name, memoryMb: c.memoryMb, optimize: c.optimize, eula: c.eula, settings: c.settings }, 'create');
      c.busy = false;
      progressBox.classList.add('hidden');
      refreshCreate();
      if (s && s !== true) {
        state.create = null;
        if (!state.servers.find((x) => x.id === s.id)) state.servers.push(s);
        state.javaInstalled = (await call('java:installed')) || state.javaInstalled;
        toast(`${s.name}을(를) 만들었어요! 켜기 버튼을 눌러 보세요.`, { kind: 'ok', timeout: 6000 });
        selectServer(s.id);
      }
    };

    root.append(
      h(
        'div.stack',
        { style: { gap: '22px', maxWidth: '1080px' } },
        h('div', null, h('h1', null, '새 서버 만들기'), h('p', { style: { marginTop: '6px' } }, '아래 내용을 고르고 "서버 만들기"를 누르면 Java 확인부터 최적화까지 알아서 해요.')),

        h('div.card', null, h('div.card-head', null, h('div', null, h('h2', null, '만들기 전에 확인'), h('div.note', null, '이 PC에서 자동으로 확인했어요'))), h(
          'div.precheck',
          null,
          javaBox,
          h('div.pc-item.well-sm', null, dot('ok'), h('div', null, h('div.txt', null, `PC 메모리 ${specs.totalGb}GB`), h('div.note', null, `서버에는 ${fmt.gb(specs.recommendedMb)}를 추천해요 (나머지는 PC와 게임용)`)), h('span.num.sky', null, fmt.gb(specs.recommendedMb))),
        )),

        h('div.card', null, h('div.card-head', null, h('h2', null, '서버 종류')), typeCards),

        h(
          'div.grid.grid-2',
          null,
          h(
            'div.card',
            null,
            h('div.card-head', null, h('h2', null, '버전 · 메모리')),
            row('마인크래프트 버전', '친구들과 같은 버전을 쓰세요. 기본값은 최신 안정 버전이에요', versionBox),
            row('서버 이름', '이 앱에서만 보여요', input(c.name, (v) => (c.name = v), { placeholder: '예: 우리들의 야생 서버' })),
            row('메모리', '추천값이 표시돼 있어요', mem),
            row('자동 최적화', "Aikar's flags · Paper 추천 설정 · 적정 시야 거리" + (c.type === 'fabric' ? ' · 최적화 모드(Lithium 등)' : ''), toggle(c.optimize, (v) => (c.optimize = v))),
          ),
          h(
            'div.card',
            null,
            h('div.card-head', null, h('h2', null, '기본 설정')),
            row('난이도', '몬스터의 세기와 배고픔 속도', seg(DIFFICULTY, c.settings.difficulty, set('difficulty'))),
            row('게임 모드', '처음 들어온 사람의 모드', seg(GAMEMODE, c.settings.gamemode, set('gamemode'))),
            row('최대 인원', '동시에 들어올 수 있는 사람 수', slider({ min: 2, max: 50, value: c.settings.maxPlayers, onInput: set('maxPlayers'), format: (v) => `${v}명` })),
            row('PVP', '플레이어끼리 공격할 수 있어요', toggle(c.settings.pvp, set('pvp'))),
            row('화이트리스트', '허락한 친구만 들어올 수 있어요', toggle(c.settings.whitelist, set('whitelist'))),
            row('서버 설명', '서버 목록에 보이는 한 줄', input(c.settings.motd, set('motd'), { maxLength: 59 })),
          ),
        ),

        h(
          'div.card.eula',
          null,
          checkbox(c.eula, (v) => {
            c.eula = v;
            refreshCreate();
          }, '마인크래프트 이용 약관(EULA)에 동의해요 — 서버를 열려면 꼭 필요해요'),
          button('약관 읽기', () => call('app:openExternal', 'https://aka.ms/MinecraftEULA'), { small: true, kind: 'ghost' }),
        ),

        progressBox,
        h('div.create-bar', null, h('span.note', null, '서버와 Java는 모두 앱 폴더 안에 만들어져요.'), createBtn),
      ),
    );
    loadVersions();
    refreshCreate();
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
      body.replaceChildren(
        row('바꿀 버전', `지금은 ${s.version}${s.build ? ` (빌드 ${s.build})` : ''}`, select(newer.map((v) => ({ value: v, label: v === first.latest ? `${v} (최신)` : v === s.version ? `${v} (현재 · 최신 빌드로)` : v })), target, async (v) => {
          target = v;
          body.style.opacity = 0.5;
          report = (await call('server:checkUpdate', s.id, v)) || report;
          body.style.opacity = 1;
          renderReport();
        })),
        report.sameVersion ? h('p', null, '같은 버전 안에서 최신 빌드로 바꿔요. 플러그인/모드는 그대로 둬요.') : null,
        report.javaChange ? h('p.brass', null, '이 버전은 다른 Java가 필요해요 → 앱 폴더에 자동으로 받아요.') : null,
        report.incompatible && report.incompatible.length
          ? h('div.card', { style: { padding: '14px 16px' } }, h('h3.bad', null, `새 버전과 안 맞는 ${TYPE[s.type].addon} ${report.incompatible.length}개`), h('p.note', null, '업데이트하면 자동으로 꺼 둬요. 나중에 맞는 버전이 나오면 다시 켜세요.'), h('div.list', null, report.incompatible.map((a) => h('div.list-item', { style: { gridTemplateColumns: 'auto 1fr' } }, dot('bad'), h('span.txt', null, a.title)))))
          : null,
        report.compatible && report.compatible.length && !report.sameVersion ? h('p.note', null, `맞는 ${TYPE[s.type].addon} ${report.compatible.length}개는 새 버전 파일로 자동 교체해요.`) : null,
        report.unknown && report.unknown.length ? h('p.note', null, `직접 넣은 파일 ${report.unknown.length}개(${report.unknown.map((a) => a.title).join(', ')})는 호환 여부를 알 수 없어요.`) : null,
        h('p.note', null, '업데이트 전에 월드를 자동으로 백업해요. 한 번 올린 버전은 되돌릴 수 없어요.'),
      );
    };
    renderReport();
    const ok = await modal({ title: '서버 업데이트', body, actions: [{ label: '취소', value: false }, { label: '업데이트', value: true, kind: 'primary' }] });
    if (!ok) return;
    toast(`${target}(으)로 업데이트하는 중… 잠시 기다려 주세요`, { timeout: 6000 });
    const r = await call('server:applyUpdate', s.id, target);
    if (r && r !== true) toast(`${target}(으)로 업데이트했어요`, { kind: 'ok' });
  }

  async function removeServer(s) {
    let keep = false;
    const ok = await modal({
      title: `${s.name}을(를) 삭제할까요?`,
      body: [h('p', null, '서버 폴더(월드, 플러그인, 설정)를 모두 지워요. 되돌릴 수 없어요.'), checkbox(false, (v) => (keep = v), '백업 파일은 남겨 두기')],
      actions: [{ label: '취소', value: false }, { label: '삭제', value: true, kind: 'danger' }],
    });
    if (!ok) return;
    if (await call('server:remove', s.id, { keepBackups: keep })) toast('삭제했어요');
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
