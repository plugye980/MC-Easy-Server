'use strict';
// 서버 생성 시 기본으로 넣는 최적화: Aikar's flags, Paper/Spigot/Bukkit 설정, 적정 view-distance
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

/**
 * Aikar's flags (https://docs.papermc.io/paper/aikars-flags). 12GB 이상이면 큰 힙용 값을 쓴다.
 * G1RSetUpdatingPauseIntervalMillis 는 JDK 20에서 없어져 Java 21 이상에서는 JVM이 아예 켜지지 않으므로 뺀다.
 * 앞으로 다른 옵션이 없어져도 서버가 켜지도록 IgnoreUnrecognizedVMOptions 를 맨 앞에 둔다.
 */
function aikarFlags(memoryMb) {
  const big = memoryMb >= 12 * 1024;
  return [
    '-XX:+IgnoreUnrecognizedVMOptions',
    `-Xms${memoryMb}M`,
    `-Xmx${memoryMb}M`,
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=200',
    '-XX:+UnlockExperimentalVMOptions',
    '-XX:+DisableExplicitGC',
    '-XX:+AlwaysPreTouch',
    `-XX:G1NewSizePercent=${big ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${big ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${big ? '16M' : '8M'}`,
    `-XX:G1ReservePercent=${big ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${big ? 20 : 15}`,
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:SurvivorRatio=32',
    '-XX:+PerfDisableSharedMem',
    '-XX:MaxTenuringThreshold=1',
    '-Dusing.aikars.flags=https://mcflags.emc.gs',
    '-Daikars.new.flags=true',
  ];
}

function plainFlags(memoryMb) {
  return [`-Xms${Math.min(1024, memoryMb)}M`, `-Xmx${memoryMb}M`];
}

/** server.properties 최적값 (모든 서버 종류 공통) */
function propertyDefaults() {
  return {
    'network-compression-threshold': 256,
    'sync-chunk-writes': true,
    'entity-broadcast-range-percentage': 100,
  };
}

// 경로 → 값. 파일이 이미 생성된 뒤에만 덮어쓴다(버전 키를 건드리지 않기 위해).
const PAPER_WORLD = {
  'chunks.max-auto-save-chunks-per-tick': 8,
  'chunks.prevent-moving-into-unloaded-chunks': true,
  'collisions.max-entity-collisions': 2,
  'environment.optimize-explosions': true,
  'environment.treasure-maps.find-already-discovered.loot-tables': true,
  'environment.treasure-maps.find-already-discovered.villager-trade': true,
  'misc.redstone-implementation': 'ALTERNATE_CURRENT',
  'tick-rates.grass-spread': 4,
  'tick-rates.container-update': 1,
  'tick-rates.mob-spawner': 2,
  'entities.armor-stands.do-collision-entity-lookups': false,
  'entities.armor-stands.tick': false,
  'hopper.disable-move-event': false,
  'hopper.ignore-occluding-blocks': true,
};
const SPIGOT = {
  'world-settings.default.merge-radius.item': 3.5,
  'world-settings.default.merge-radius.exp': 4.0,
  'world-settings.default.mob-spawn-range': 6,
  'world-settings.default.entity-activation-range.animals': 16,
  'world-settings.default.entity-activation-range.monsters': 24,
  'world-settings.default.entity-activation-range.raiders': 48,
  'world-settings.default.entity-activation-range.misc': 8,
  'world-settings.default.tick-inactive-villagers': false,
  'world-settings.default.nerf-spawner-mobs': true,
};
const BUKKIT = {
  'spawn-limits.monsters': 50,
  'spawn-limits.animals': 8,
  'spawn-limits.water-animals': 3,
  'spawn-limits.water-ambient': 5,
  'spawn-limits.ambient': 1,
  'ticks-per.monster-spawns': 4,
  'chunk-gc.period-in-ticks': 400,
};

/** YAML 문서의 주석을 살린 채 점 경로 값만 바꾼다. 없는 파일이면 false. */
function patchYaml(file, values) {
  if (!fs.existsSync(file)) return false;
  const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
  for (const [dotted, value] of Object.entries(values)) {
    doc.setIn(dotted.split('.'), value);
  }
  fs.writeFileSync(file, doc.toString());
  return true;
}

/** Paper 설정 파일이 생성돼 있으면 최적값을 넣는다. 한 파일이라도 적용되면 true. */
function applyPaperConfigs(serverDir) {
  const results = [
    patchYaml(path.join(serverDir, 'config', 'paper-world-defaults.yml'), PAPER_WORLD),
    patchYaml(path.join(serverDir, 'spigot.yml'), SPIGOT),
    patchYaml(path.join(serverDir, 'bukkit.yml'), BUKKIT),
  ];
  return results.every(Boolean);
}

// ---------- 실제 힙 사용량 ----------
// Aikar's flags 는 -Xms = -Xmx 와 AlwaysPreTouch 로 시작하자마자 힙 전체를 OS 에서 받아 둔다.
// 그래서 프로세스 메모리(RSS)는 늘 할당량에 붙어 있다 → 실제 사용량은 GC 로그에서 읽는다.
const GC_LOG = 'logs/mces-gc.log';

function gcLogArgs(javaMajor) {
  if (javaMajor >= 9) return [`-Xlog:gc:file=${GC_LOG}:uptime:filecount=0`];
  return [`-Xloggc:${GC_LOG}`, '-XX:+PrintGC'];
}

// 현재 힙 사용량: 서버 JVM 안의 작은 에이전트(mces-agent.jar)가 2초마다 파일에 쓴다.
// GC 로그는 GC 가 일어날 때만 기록되고(큰 힙에서는 드묾) GC 직후 값만 남으므로 보조로만 쓴다.
const AGENT_JAR = 'mces-agent.jar';
const HEAP_FILE = 'logs/mces-heap.txt';

function agentArgs() {
  return [`-javaagent:${AGENT_JAR}=${HEAP_FILE}`];
}

/** "사용 커밋 최대 시각(ms)" 한 줄. 오래된(15초 넘은) 값은 버린다 */
function parseHeapFile(text, now = Date.now()) {
  const m = /^(\d+) (\d+) (-?\d+) (\d+)\s*$/.exec(String(text));
  if (!m) return null;
  if (now - Number(m[4]) > 15000) return null;
  return { usedMb: Math.round(Number(m[1]) / 1048576), committedMb: Math.round(Number(m[2]) / 1048576), maxMb: Number(m[3]) > 0 ? Math.round(Number(m[3]) / 1048576) : null };
}

const toMb = (n, unit) => {
  const v = Number(n);
  return unit === 'G' ? v * 1024 : unit === 'K' ? v / 1024 : unit === 'B' ? v / 1048576 : v;
};

/**
 * GC 로그 마지막 기록에서 힙 사용량을 읽는다.
 *   Java 9+: "[12.3s] GC(6) Pause Young (Normal) (G1 Evacuation Pause) 229M->81M(512M) 1.184ms"
 *   Java 8:  "12.3: [GC pause (G1 Evacuation Pause) (young) 229M->81M(512M), 0.0012 secs]"
 * @returns {{beforeMb:number, usedMb:number, committedMb:number}|null}
 */
function parseGcLog(text) {
  const re = /(\d+(?:\.\d+)?)([BKMG])->(\d+(?:\.\d+)?)([BKMG])\((\d+(?:\.\d+)?)([BKMG])\)/g;
  let m;
  let last = null;
  while ((m = re.exec(text))) last = m;
  if (!last) return null;
  return {
    beforeMb: Math.round(toMb(last[1], last[2])),
    usedMb: Math.round(toMb(last[3], last[4])),
    committedMb: Math.round(toMb(last[5], last[6])),
  };
}

/** Fabric 서버에 기본으로 넣는 서버 최적화 모드 (Modrinth slug) */
const FABRIC_OPTIMIZATION_MODS = ['fabric-api', 'lithium', 'ferrite-core'];
/** Forge 서버에 기본으로 넣는 최적화 모드: 로딩·메모리 개선 (Modrinth slug) */
const FORGE_OPTIMIZATION_MODS = ['modernfix', 'ferrite-core'];

module.exports = { AGENT_JAR, HEAP_FILE, agentArgs, parseHeapFile, GC_LOG, gcLogArgs, parseGcLog, aikarFlags, plainFlags, propertyDefaults, applyPaperConfigs, patchYaml, FABRIC_OPTIMIZATION_MODS, FORGE_OPTIMIZATION_MODS, PAPER_WORLD };
