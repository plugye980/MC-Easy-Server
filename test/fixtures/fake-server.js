'use strict';
// 테스트용 가짜 마인크래프트 서버: Paper와 비슷한 로그를 내고 stdin 명령에 응답한다.
const fs = require('fs');
const readline = require('readline');
const log = (m) => process.stdout.write(`[12:00:00 INFO]: ${m}\n`);
log('Starting minecraft server version 1.21.1');
fs.mkdirSync('world', { recursive: true });
fs.writeFileSync('world/level.dat', 'level');
setTimeout(() => log('Done (1.234s)! For help, type "help"'), 100);
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
  if (cmd === 'tps') log('TPS from last 1m, 5m, 15m: 19.5, 19.9, 20.0');
  else if (cmd === 'list') log('There are 1 of a max of 20 players online: Steve');
  else if (cmd === 'save-all flush') log('Saved the game');
  else if (cmd.startsWith('kick ')) log(`Kicked ${cmd.split(' ')[1]}`);
  else if (cmd === 'stop') {
    log('Stopping server');
    setTimeout(() => process.exit(0), 50);
  }
});
