'use strict';
// 게임 규칙(gamerule): 월드 파일에 적힌 실제 이름을 쉬운 설명과 짝짓는다.
// 버전마다 이름이 다르다 (keepInventory → keep_inventory, doDaylightCycle → advance_time 등).
// 비교는 "minecraft:" 와 밑줄을 빼고 소문자로 한다.

const norm = (k) => String(k).toLowerCase().replace(/^minecraft:/, '').replace(/_/g, '');

/** 자주 쓰는 규칙. names 는 버전별로 알려진 이름들 (정규화 전) */
const CATALOG = [
  { id: 'keepInventory', names: ['keepInventory'], label: '인벤토리 유지', desc: '죽어도 아이템·경험치 유지' },
  { id: 'doMobSpawning', names: ['doMobSpawning', 'spawn_mobs'], label: '몹 자연 스폰', desc: '끄면 몬스터·동물이 저절로 생기지 않음' },
  { id: 'spawnMonsters', names: ['spawnMonsters', 'spawn_monsters'], label: '몬스터 스폰', desc: '끄면 적대적 몬스터만 생기지 않음' },
  { id: 'doDaylightCycle', names: ['doDaylightCycle', 'advance_time'], label: '낮/밤 흐름', desc: '끄면 지금 시간에서 멈춤' },
  { id: 'doWeatherCycle', names: ['doWeatherCycle', 'advance_weather'], label: '날씨 변화', desc: '끄면 지금 날씨에서 멈춤' },
  { id: 'mobGriefing', names: ['mobGriefing'], label: '몹의 블록 파괴', desc: '크리퍼 폭발 지형 파괴, 엔더맨 블록 옮기기 등' },
  { id: 'doFireTick', names: ['doFireTick'], label: '불 번짐', desc: '끄면 불이 퍼지거나 꺼지지 않음' },
  { id: 'naturalRegeneration', names: ['naturalRegeneration', 'natural_health_regeneration'], label: '자연 회복', desc: '배가 부르면 체력 회복' },
  { id: 'doImmediateRespawn', names: ['doImmediateRespawn', 'immediate_respawn'], label: '즉시 부활', desc: '사망 화면 없이 바로 부활' },
  { id: 'playersSleepingPercentage', names: ['playersSleepingPercentage', 'players_sleeping_percentage'], label: '밤 넘기기 인원', desc: '잠든 사람이 몇 % 이상이면 아침 (0~100)', min: 0, max: 100, unit: '%' },
  { id: 'doInsomnia', names: ['doInsomnia', 'spawn_phantoms'], label: '팬텀 등장', desc: '오래 안 자면 팬텀 등장' },
  { id: 'fallDamage', names: ['fallDamage'], label: '낙하 피해' },
  { id: 'fireDamage', names: ['fireDamage'], label: '불 피해' },
  { id: 'drowningDamage', names: ['drowningDamage'], label: '익사 피해' },
  { id: 'freezeDamage', names: ['freezeDamage'], label: '동사 피해', desc: '가루눈 속 추위 피해' },
  { id: 'doTraderSpawning', names: ['doTraderSpawning', 'spawn_wandering_traders'], label: '떠돌이 상인 등장' },
  { id: 'doPatrolSpawning', names: ['doPatrolSpawning', 'spawn_patrols'], label: '약탈대 등장' },
  { id: 'disableRaids', names: ['disableRaids'], label: '습격 끄기', desc: '켜면 마을 습격이 일어나지 않음' },
  { id: 'doEntityDrops', names: ['doEntityDrops', 'entity_drops'], label: '엔티티 드롭', desc: '수레·액자 등이 부서질 때 아이템 떨굼' },
  { id: 'doTileDrops', names: ['doTileDrops', 'block_drops'], label: '블록 드롭', desc: '끄면 블록을 부숴도 아이템이 안 나옴' },
  { id: 'doMobLoot', names: ['doMobLoot', 'mob_drops'], label: '몹 드롭', desc: '몹이 죽을 때 아이템 떨굼' },
  { id: 'showDeathMessages', names: ['showDeathMessages'], label: '사망 메시지' },
  { id: 'announceAdvancements', names: ['announceAdvancements', 'show_advancement_messages'], label: '발전과제 알림' },
  { id: 'randomTickSpeed', names: ['randomTickSpeed'], label: '작물·나무 성장 속도', desc: '기본 3 · 높이면 빨라짐 (서버 부담 증가)', min: 0, max: 100 },
  { id: 'spawnRadius', names: ['spawnRadius', 'respawn_radius'], label: '스폰 범위', desc: '처음·부활 위치가 흩어지는 거리 (칸)', min: 0, max: 64 },
  { id: 'universalAnger', names: ['universalAnger', 'universal_anger'], label: '모두에게 분노', desc: '화난 중립 몹이 주변 모두를 공격' },
];

/** server.properties 에서 게임 규칙으로 옮겨간 설정 (1.21.9 이후) */
const PROPERTY_RULES = {
  pvp: ['pvp'],
  commandBlocks: ['commandBlocksEnabled', 'command_blocks_work', 'command_blocks_enabled', 'enableCommandBlocks'],
};

/** 규칙 이름 목록(파일에 적힌 그대로)에서 후보 이름과 같은 것을 찾는다 */
function findKey(keys, names) {
  const want = new Set(names.map(norm));
  return keys.find((k) => want.has(norm(k))) || null;
}

/**
 * 월드의 규칙을 화면용 목록으로 만든다.
 * @param {{[key: string]: {value, kind}}} rules 월드에 저장된 규칙
 * @returns {{common: object[], other: object[]}}
 */
function describe(rules) {
  const keys = Object.keys(rules);
  const used = new Set();
  // 설정 화면의 PVP·커맨드 블록 항목이 다루므로 목록에서는 뺀다
  for (const names of Object.values(PROPERTY_RULES)) {
    const k = findKey(keys, names);
    if (k) used.add(k);
  }
  const common = [];
  for (const c of CATALOG) {
    const key = findKey(keys, c.names);
    if (!key || used.has(key)) continue;
    used.add(key);
    common.push({ key, ...rules[key], id: c.id, label: c.label, desc: c.desc || null, min: c.min, max: c.max, unit: c.unit });
  }
  const other = keys
    .filter((k) => !used.has(k))
    .sort()
    .map((k) => ({ key: k, ...rules[k], label: k.replace(/^minecraft:/, ''), desc: null }));
  return { common, other };
}

/** gamerule 명령 (키는 파일에 적힌 이름 그대로) */
function command(key, value) {
  if (!/^[\w:.-]+$/.test(key)) throw new Error('잘못된 규칙 이름');
  const v = typeof value === 'boolean' ? String(value) : String(Math.trunc(Number(value)));
  if (v === 'NaN') throw new Error('잘못된 값');
  return `gamerule ${key} ${v}`;
}

module.exports = { CATALOG, PROPERTY_RULES, findKey, describe, command, norm };
