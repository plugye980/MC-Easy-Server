'use strict';
// PC 사양 확인 → 서버 메모리·시야 거리 추천
const os = require('os');

const GB = 1024 ** 3;

/** 전체 RAM(GB) → 서버에 줄 메모리(MB). 운영체제와 게임 클라이언트 몫을 남긴다. */
function recommendMemoryMb(totalGb) {
  let gb;
  if (totalGb <= 4) gb = 1.5;
  else if (totalGb <= 6) gb = 2;
  else if (totalGb <= 8) gb = 3;
  else if (totalGb <= 12) gb = 4;
  else if (totalGb <= 16) gb = 6;
  else if (totalGb <= 24) gb = 8;
  else if (totalGb <= 32) gb = 10;
  else gb = 12; // 그 이상은 GC 부담만 커진다
  return Math.round(gb * 1024);
}

/** 할당 메모리(MB) → 적정 view-distance / simulation-distance */
function recommendDistances(memoryMb, maxPlayers = 10) {
  const gb = memoryMb / 1024;
  let view = gb < 3 ? 6 : gb < 5 ? 8 : gb < 8 ? 10 : 12;
  if (maxPlayers > 20) view -= 2;
  view = Math.max(5, view);
  const simulation = Math.max(4, Math.min(view - 2, 8));
  return { viewDistance: view, simulationDistance: simulation };
}

function specs() {
  const totalGb = os.totalmem() / GB;
  const cpus = os.cpus();
  const recommendedMb = recommendMemoryMb(totalGb);
  return {
    totalMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMb: Math.round(os.freemem() / 1024 / 1024),
    totalGb: Math.round(totalGb * 10) / 10,
    cpuModel: cpus[0] ? cpus[0].model.trim() : '알 수 없음',
    cpuCores: cpus.length,
    platform: process.platform,
    arch: process.arch,
    recommendedMb,
    // 슬라이더 상한: 전체의 75% 또는 16GB 중 작은 값
    maxMb: Math.max(1024, Math.min(Math.floor((os.totalmem() / 1024 / 1024) * 0.75), 16384)),
  };
}

module.exports = { specs, recommendMemoryMb, recommendDistances };
