'use strict';
// 테스트용 가짜 마인크래프트 서버: Paper와 비슷한 로그를 내고 stdin 명령에 응답한다.
const fs = require('fs');
const readline = require('readline');
const log = (m) => process.stdout.write(`[12:00:00 INFO]: ${m}\n`);
// 시작 중 종료 재현: quiet = 아무 출력 없이 종료, crash = Java 충돌 기록 + 줄바꿈 없는 마지막 출력
if (process.env.MCES_FAKE_MODE === 'quiet') process.exit(3);
if (process.env.MCES_FAKE_MODE === 'crash') {
  fs.writeFileSync('hs_err_pid4242.log', '#\n# A fatal error has been detected by the Java Runtime Environment:\n#\n#  EXCEPTION_ACCESS_VIOLATION (0xc0000005)\n#\n---------------  S U M M A R Y ------------\n');
  process.stdout.write('last words without newline', () => process.exit(1));
  return;
}
log('Starting minecraft server version 1.21.1');
fs.mkdirSync('world', { recursive: true });
if (!fs.existsSync('world/level.dat')) fs.writeFileSync('world/level.dat', 'level');
setTimeout(() => log('Done (1.234s)! For help, type "help"'), 100);
// 앱이 넘긴 -Xlog:gc 처럼 GC 로그를 남긴다 (실제 힙 사용량 측정 확인용)
fs.mkdirSync('logs', { recursive: true });
// 힙 측정 에이전트처럼 현재 사용량 파일도 남긴다 (에이전트 값이 GC 로그보다 우선)
fs.writeFileSync('logs/mces-heap.txt', `${200 * 1048576} ${1024 * 1048576} ${1024 * 1048576} ${Date.now()}\n`);
fs.appendFileSync('logs/mces-gc.log', '[0.9s] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 300M->120M(1024M) 2.0ms\n');
setTimeout(() => {
  log('UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5');
  log('Steve joined the game');
  log('Alex[/127.0.0.1:50123] logged in with entity id 7 at ([world]0.5, 64.0, 0.5)');
  log('[VIP] Alex joined the game');
  log('<Steve> Bob joined the game');
}, 250);
setTimeout(() => log('Alex lost connection: Disconnected'), 600);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (cmd) => {
  // 설정 명령 대답 (바닐라 문구). MCES_FAKE_CONSOLE=reject 면 거부, silent 면 대답 없음
  const settingCmd = /^(?:execute in \S+ run )?(gamerule|difficulty|defaultgamemode|whitelist) ?(\S*) ?(\S*)/.exec(cmd);
  if (settingCmd && process.env.MCES_FAKE_CONSOLE === 'silent') return;
  if (settingCmd && process.env.MCES_FAKE_CONSOLE === 'reject') return log('Unknown or incomplete command, see below for error');
  if (settingCmd) {
    const [, c, a, b] = settingCmd;
    if (c === 'gamerule') log(`Gamerule ${a} is now set to: ${b}`);
    else if (c === 'difficulty') log(`The difficulty has been set to ${a}`);
    else if (c === 'defaultgamemode') log(`The default game mode is now ${a}`);
    else log(`Whitelist is now turned ${a}`);
    return;
  }
  if (cmd === 'tps') log('TPS from last 1m, 5m, 15m: 19.5, 19.9, 20.0');
  else if (cmd === 'list') log('There are 1 of a max of 20 players online: Steve');
  else if (cmd === 'save-all flush') log('Saved the game');
  else if (cmd.startsWith('kick ')) log(`Kicked ${cmd.split(' ')[1]}`);
  else if (cmd === 'stop') {
    log('Stopping server');
    setTimeout(() => process.exit(0), 50);
  }
});
