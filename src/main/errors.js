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
      title: '포트가 이미 사용 중이에요',
      message: '다른 프로그램(또는 이미 켜진 다른 서버)이 같은 포트를 쓰고 있어요. 비어 있는 포트로 바꿔서 다시 켤까요?',
      actions: [{ id: 'change-port', label: '빈 포트로 바꾸고 다시 켜기' }],
    }),
  },
  {
    id: 'heap-too-big',
    test: /Could not reserve enough space for .*object heap|Invalid maximum heap size|Cannot allocate memory|insufficient memory for the Java Runtime/i,
    build: () => ({
      severity: 'error',
      title: '메모리를 너무 많이 할당했어요',
      message: 'PC에 남은 메모리보다 많이 달라고 해서 서버가 켜지지 않았어요. 추천값으로 낮춰서 다시 켤까요?',
      actions: [{ id: 'lower-memory', label: '추천 메모리로 낮추기' }],
    }),
  },
  {
    id: 'out-of-memory',
    test: /java\.lang\.OutOfMemoryError/i,
    build: () => ({
      severity: 'error',
      title: '서버 메모리가 부족해요',
      message: '서버에 준 메모리를 다 써버렸어요. 메모리를 늘리거나 시야 거리를 줄이면 좋아져요.',
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
        title: 'Java 버전이 맞지 않아요',
        message: need
          ? `이 서버(또는 플러그인)는 Java ${need} 이상이 필요해요. 맞는 Java를 자동으로 받아서 다시 켤까요?`
          : '이 서버에 맞는 Java 버전이 아니에요. 맞는 Java를 자동으로 받아서 다시 켤까요?',
        actions: [{ id: 'fix-java', label: '맞는 Java 받기', payload: { need } }],
      };
    },
  },
  {
    id: 'eula',
    test: /You need to agree to the EULA/i,
    build: () => ({
      severity: 'warn',
      title: 'EULA 동의가 필요해요',
      message: '마인크래프트 이용 약관(EULA)에 동의해야 서버가 켜져요.',
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
        title: '필요한 플러그인이 빠져 있어요',
        message: `"${pluginFromPath(m[1])}" 플러그인이 동작하려면 ${deps.join(', ')} 이(가) 필요해요. 같이 설치할까요?`,
        actions: [
          { id: 'install-deps', label: '필요한 플러그인 설치', payload: { names: deps } },
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
      title: '버전이 맞지 않는 플러그인이 있어요',
      message: `"${pluginFromPath(m[1])}" 플러그인이 현재 서버 버전과 맞지 않아요 → 비활성화할까요?`,
      actions: [{ id: 'disable-plugin', label: '비활성화', payload: { file: m[1] } }],
    }),
  },
  {
    id: 'plugin-enable-error',
    test: /Error occurred while enabling (\S+)/i,
    build: (line, m) => ({
      severity: 'warn',
      title: '플러그인이 켜지다 오류가 났어요',
      message: `"${m[1]}" 플러그인이 제대로 켜지지 않았어요. 서버 버전과 안 맞거나 설정이 잘못됐을 수 있어요 → 비활성화할까요?`,
      actions: [{ id: 'disable-plugin', label: '비활성화', payload: { name: m[1] } }],
    }),
  },
  {
    id: 'fabric-incompatible',
    test: /Incompatible mods? (?:found|set)|Mod resolution failed/i,
    build: () => ({
      severity: 'error',
      title: '서로 맞지 않는 모드가 있어요',
      message: '설치된 모드 중 현재 버전과 맞지 않거나 다른 모드가 필요한 것이 있어요. 아래 로그에 나온 모드를 비활성화하거나 필요한 모드를 설치해 주세요.',
      actions: [{ id: 'open-tab', label: '모드 목록 보기', payload: { tab: 'addons' } }],
    }),
  },
  {
    id: 'fabric-mod-requires',
    test: /Mod '([^']+)' \(([\w-]+)\) [\d.\w+-]+ requires (?:any version|version [^ ]+) of (?:mod )?'?([^',]+?)'?(?:,| \(|$)/i,
    build: (line, m) => ({
      severity: 'error',
      title: '모드에 필요한 것이 빠졌거나 버전이 달라요',
      message: `"${m[1]}" 모드는 "${m[3]}" 이(가) 필요해요. 설치하거나 이 모드를 끌까요?`,
      actions: [
        { id: 'install-deps', label: `${m[3]} 설치`, payload: { names: [m[3]] } },
        { id: 'disable-mod', label: '이 모드 끄기', payload: { modId: m[2] } },
      ],
    }),
  },
  {
    id: 'overloaded',
    test: /Can't keep up! Is the server overloaded\?/i,
    cooldown: 5 * 60 * 1000,
    build: () => ({
      severity: 'info',
      title: '서버가 조금 버거워해요',
      message: '처리가 밀리고 있어요. 시야 거리를 줄이면 가벼워져요.',
      actions: [{ id: 'lower-view', label: '시야 거리 2칸 줄이기' }],
    }),
  },
  {
    id: 'world-locked',
    test: /session\.lock|The directory is already locked|Failed to start the minecraft server.*lock/i,
    build: () => ({
      severity: 'error',
      title: '월드가 다른 곳에서 열려 있어요',
      message: '같은 월드를 이미 다른 서버가 쓰고 있어요. 먼저 켜진 서버를 꺼 주세요.',
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
