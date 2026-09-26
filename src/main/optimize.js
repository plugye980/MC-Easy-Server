'use strict';
// 서버 생성 시 기본으로 넣는 최적화: Aikar's flags, Paper/Spigot/Bukkit 설정, 적정 view-distance
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

/** Aikar's flags (https://docs.papermc.io/paper/aikars-flags). 12GB 이상이면 큰 힙용 값을 쓴다. */
function aikarFlags(memoryMb) {
  const big = memoryMb >= 12 * 1024;
  return [
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
    '-XX:G1RSetUpdatingPauseIntervalMillis=100',
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

/** Fabric 서버에 기본으로 넣는 서버 최적화 모드 (Modrinth slug) */
const FABRIC_OPTIMIZATION_MODS = ['fabric-api', 'lithium', 'ferrite-core'];

module.exports = { aikarFlags, plainFlags, propertyDefaults, applyPaperConfigs, patchYaml, FABRIC_OPTIMIZATION_MODS, PAPER_WORLD };
