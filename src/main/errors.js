'use strict';
// 로그에서 흔한 오류를 잡아 쉬운 말과 해결 버튼으로 바꾼다.

const stripColors = (s) => s.replace(/\u001b\[[0-9;]*m/g, '').replace(/§[0-9a-fk-or]/gi, '');

/** jar 파일 이름 또는 플러그인 이름을 뽑는다 */
function pluginFromPath(p) {
  const base = p.replace(/\\/g, '/').split('/').pop();
  return base.replace(/\.jar$/i, '');
}

const RULES = [
  {
    id: 'port-in-use',
    test: /FAILED TO BIND TO PORT|Address already in use|BindException/i,
    build: () => ({
      severity: 'error',
      title: '포트 사용 중',
      message: '다른 프로그램(또는 다른 서버)이 같은 포트를 사용 중 → 빈 포트로 바꿔 다시 실행',
      actions: [{ id: 'change-port', label: '빈 포트로 바꾸고 다시 켜기' }],
    }),
  },
  {
    id: 'heap-too-big',
    test: /Could not reserve enough space for .*object heap|Invalid maximum heap size|Cannot allocate memory|insufficient memory for the Java Runtime/i,
    build: () => ({
      severity: 'error',
      title: '메모리 과다 할당',
      message: 'PC 여유 메모리보다 많이 할당해 실행 실패 → 추천값으로 낮춰 다시 실행',
      actions: [{ id: 'lower-memory', label: '추천 메모리로 낮추기' }],
    }),
  },
  {
    id: 'out-of-memory',
    test: /java\.lang\.OutOfMemoryError/i,
    build: () => ({
      severity: 'error',
      title: '서버 메모리 부족',
      message: '할당 메모리 전부 사용 → 메모리 늘리기 또는 시야 거리 줄이기',
      actions: [{ id: 'raise-memory', label: '메모리 1GB 늘리기' }, { id: 'lower-view', label: '시야 거리 2칸 줄이기' }],
    }),
  },
  {
    id: 'java-version',
    test: /UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime/i,
    build: (line) => {
      const m = /class file version (\d+)/.exec(line);
      const need = m ? Number(m[1]) - 44 : null;
      return {
        severity: 'error',
        title: 'Java 버전 불일치',
        message: need
          ? `Java ${need} 이상 필요 → 맞는 Java를 받아 다시 실행`
          : '서버와 맞지 않는 Java 버전 → 맞는 Java를 받아 다시 실행',
        actions: [{ id: 'fix-java', label: '맞는 Java 받기', payload: { need } }],
      };
    },
  },
  {
    id: 'jvm-option',
    test: /Unrecognized VM option|Could not create the Java Virtual Machine|Unrecognized option: /i,
    build: () => ({
      severity: 'error',
      title: 'Java 실행 옵션 오류',
      message: '이 Java가 지원하지 않는 실행 옵션으로 실행 실패 → 최적화 옵션을 끄고 다시 실행',
      actions: [{ id: 'disable-optimize', label: '최적화 옵션 끄고 다시 켜기' }],
    }),
  },
  {
    id: 'eula',
    test: /You need to agree to the EULA/i,
    build: () => ({
      severity: 'warn',
      title: 'EULA 동의 필요',
      message: '마인크래프트 이용 약관(EULA) 동의 후 실행 가능',
      actions: [{ id: 'accept-eula', label: '동의하고 다시 켜기' }],
    }),
  },
  {
    // 의존성 누락: Spigot식 "Unknown/missing dependency plugins: [Vault]" 와
    // Paper식 "... missing dependency plugins: [Vault]", "Unknown dependency Vault." 를 모두 잡는다.
    id: 'plugin-missing-dep',
    multiline: true,
    test: /(?:Could not load (?:plugin )?'(?:.*?[\\/])?(?:plugins[\\/])?([^'\\/]+?\.jar)')[\s\S]*?(?:dependency plugins:?\s*\[([^\]]+)\]|Unknown dependency ([\w-]+))/i,
    build: (line, m) => {
      const deps = (m[2] || m[3]).split(',').map((s) => s.trim()).filter(Boolean);
      return {
        severity: 'error',
        title: '필요한 플러그인 없음',
        message: `"${pluginFromPath(m[1])}" 실행에 ${deps.join(', ')} 필요 → 함께 설치`,
        actions: [
          { id: 'install-deps', label: '필요한 플러그인 설치', payload: { names: deps, kind: 'plugin' } },
          { id: 'disable-plugin', label: '이 플러그인 끄기', payload: { file: m[1] } },
        ],
      };
    },
  },
  {
    id: 'plugin-api-version',
    multiline: true,
    test: /Could not load (?:plugin )?'(?:.*?[\\/])?(?:plugins[\\/])?([^'\\/]+?\.jar)'[\s\S]*?(?:Unsupported API version|UnsupportedClassVersionError|InvalidPluginException|InvalidDescriptionException|newer than|is not compatible)/i,
    build: (line, m) => ({
      severity: 'error',
      title: '버전이 맞지 않는 플러그인',
      message: `"${pluginFromPath(m[1])}" 플러그인이 현재 서버 버전과 맞지 않음 → 비활성화`,
      actions: [{ id: 'disable-plugin', label: '비활성화', payload: { file: m[1] } }],
    }),
  },
  {
    id: 'plugin-enable-error',
    test: /Error occurred while enabling (\S+)/i,
    build: (line, m) => ({
      severity: 'warn',
      title: '플러그인 실행 오류',
      message: `"${m[1]}" 플러그인 실행 실패 (버전 불일치 또는 설정 오류) → 비활성화`,
      actions: [{ id: 'disable-plugin', label: '비활성화', payload: { name: m[1] } }],
    }),
  },
  {
    // Forge: "Mod ID: 'create', Requested by: 'createaddon', Expected range: '[0.5.1,)', Actual version: '[MISSING]'"
    id: 'forge-missing-dep',
    test: /Mod ID: '([\w-]+)', Requested by: '([\w-]+)', Expected range: '([^']*)', Actual version: '([^']*)'/,
    build: (line, m) => ({
      severity: 'error',
      title: m[4] === '[MISSING]' ? '모드 의존성 없음' : '모드 의존성 버전 불일치',
      message: `"${m[2]}" 모드에 "${m[1]}" ${m[3]} 필요 (현재 ${m[4] === '[MISSING]' ? '없음' : m[4]}) → 설치 또는 이 모드 끄기`,
      actions: [
        { id: 'install-deps', label: `${m[1]} 설치`, payload: { names: [m[1]], kind: 'mod' } },
        { id: 'disable-mod', label: '이 모드 끄기', payload: { modId: m[2] } },
      ],
    }),
  },
  {
    // Mixin: 모드(또는 하이브리드 서버)가 마인크래프트 코드를 고쳐 끼우다 실패. 설정 파일 이름으로 모드를 짐작한다
    id: 'mixin-failed',
    test: /Mixin apply (?:failed|for mod \S+ failed) ([\w.-]+?\.json)|Mixin \[([\w.-]+?\.json):/i,
    build: (line, m) => {
      const cfg = m[1] || m[2];
      const mod = cfg.replace(/\.json$/i, '').replace(/^mixins?\./i, '').replace(/[.-]mixins?$/i, '').split(/[.-]/)[0];
      if (/^arclight|^mohist|^ketting|^magma/i.test(mod)) {
        return {
          severity: 'error',
          title: '하이브리드 서버와 모드 충돌',
          message: '하이브리드 서버가 플러그인용으로 마인크래프트 코드를 고치는 중 실패 → 같은 부분을 고치는 모드와 충돌하거나 이 하이브리드 빌드의 문제. 모드를 모두 끄고 켜 보고, 켜지면 반씩 다시 켜서 원인 모드 찾기',
          actions: [{ id: 'open-tab', label: '모드 목록 보기', payload: { tab: 'addons' } }],
        };
      }
      return {
        severity: 'error',
        title: '모드 적용 실패 (Mixin)',
        message: `"${mod}" 모드가 마인크래프트 코드를 고치다 실패 → 이 버전과 맞지 않거나 다른 모드와 충돌. 이 모드 끄기 또는 버전 확인`,
        actions: [
          { id: 'disable-mod', label: '이 모드 끄기', payload: { modId: mod } },
          { id: 'open-tab', label: '모드 목록 보기', payload: { tab: 'addons' } },
        ],
      };
    },
  },
  {
    id: 'fabric-incompatible',
    test: /Incompatible mods? (?:found|set)|Mod resolution failed/i,
    build: () => ({
      severity: 'error',
      title: '호환되지 않는 모드',
      message: '현재 버전과 맞지 않거나 다른 모드가 필요한 모드 있음 → 로그의 모드를 비활성화하거나 필요한 모드 설치',
      actions: [{ id: 'open-tab', label: '모드 목록 보기', payload: { tab: 'addons' } }],
    }),
  },
  {
    id: 'fabric-mod-requires',
    test: /Mod '([^']+)' \(([\w-]+)\) [\d.\w+-]+ requires (?:any version|version [^ ]+) of (?:mod )?'?([^',]+?)'?(?:,| \(|$)/i,
    build: (line, m) => ({
      severity: 'error',
      title: '모드 의존성 없음 또는 버전 불일치',
      message: `"${m[1]}" 모드에 "${m[3]}" 필요 → 설치 또는 이 모드 끄기`,
      actions: [
        { id: 'install-deps', label: `${m[3]} 설치`, payload: { names: [m[3]], kind: 'mod' } },
        { id: 'disable-mod', label: '이 모드 끄기', payload: { modId: m[2] } },
      ],
    }),
  },
  {
    // 한 틱이 max-tick-time(기본 60초)을 넘기면 워치독이 서버를 멈춘 것으로 보고 끈다.
    // /tick rate 를 너무 높이면 서버가 목표를 못 따라가 뒤처짐이 쌓여 같은 일이 생긴다.
    id: 'watchdog',
    test: /A single server tick took ([\d.]+) seconds|Considering it to be crashed, server will forcibly shutdown|Watchdog \(Watching Server\)/i,
    build: (line, m) => ({
      severity: 'error',
      title: '서버 멈춤으로 강제 종료 (워치독)',
      message: `한 번의 처리(틱)가 ${m[1] ? `${Math.round(Number(m[1]))}초` : '너무 오래'} 끝나지 않아 서버가 스스로 종료 → /tick rate 를 올렸다면 기본값(20)으로 되돌리기, 아니면 시야 거리 줄이기`,
      actions: [
        { id: 'reset-tick-rate', label: '틱 속도 20으로 되돌리고 다시 켜기' },
        { id: 'lower-view', label: '시야 거리 2칸 줄이기' },
      ],
    }),
  },
  {
    id: 'overloaded',
    test: /Can't keep up! Is the server overloaded\?/i,
    cooldown: 5 * 60 * 1000,
    build: () => ({
      severity: 'info',
      title: '서버 처리 지연',
      message: '틱 처리가 밀리는 중 → 시야 거리를 줄이면 부담 감소',
      actions: [{ id: 'lower-view', label: '시야 거리 2칸 줄이기' }],
    }),
  },
  {
    id: 'world-locked',
    test: /session\.lock|The directory is already locked|Failed to start the minecraft server.*lock/i,
    build: () => ({
      severity: 'error',
      title: '월드가 다른 곳에서 사용 중',
      message: '같은 월드를 다른 서버가 사용 중 → 먼저 켜진 서버 종료 필요',
      actions: [],
    }),
  },
];

class ErrorTranslator {
  constructor() {
    this.seen = new Map();
    this.recent = [];
  }
  /** 한 줄을 검사해 번역된 알림(또는 null)을 돌려준다. */
  check(rawLine) {
    const line = stripColors(rawLine);
    // 스택트레이스처럼 원인이 다음 줄에 나오는 경우를 위해 최근 몇 줄을 함께 본다.
    this.recent.push(line);
    if (this.recent.length > 4) this.recent.shift();
    const context = this.recent.join('\n');
    for (const rule of RULES) {
      const m = rule.test.exec(rule.multiline ? context : line);
      if (!m) continue;
      const built = rule.build(line, m);
      const key = `${rule.id}:${JSON.stringify(built.actions.map((a) => a.payload || null))}`;
      const last = this.seen.get(key);
      const cooldown = rule.cooldown || 60 * 1000;
      if (last && Date.now() - last < cooldown) return null;
      this.seen.set(key, Date.now());
      if (rule.multiline) this.recent = [];
      return { id: `${rule.id}-${Date.now()}`, kind: rule.id, line, ...built };
    }
    return null;
  }
  reset() {
    this.seen.clear();
    this.recent = [];
  }
}

module.exports = { ErrorTranslator, stripColors };
