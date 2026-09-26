'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mceasy-'));
process.env.MC_EASY_DATA = tmp;

const versions = require('../src/main/versions');
const system = require('../src/main/system');
const props = require('../src/main/properties');
const optimize = require('../src/main/optimize');
const { ErrorTranslator } = require('../src/main/errors');
const java = require('../src/main/java');
const modrinth = require('../src/main/modrinth');
const reach = require('../src/main/reachability');
const { Tunnel, pickTunnel, pickTunnelByPort, tunnelLocalPort } = require('../src/main/tunnel');
const { RE } = require('../src/main/server-manager');
const backup = require('../src/main/backup');
const paths = require('../src/main/paths');

test('마크 버전별 Java', () => {
  assert.strictEqual(versions.javaForVersionFallback('1.21.4'), 21);
  assert.strictEqual(versions.javaForVersionFallback('1.20.5'), 21);
  assert.strictEqual(versions.javaForVersionFallback('1.20.4'), 17);
  assert.strictEqual(versions.javaForVersionFallback('1.18.2'), 17);
  assert.strictEqual(versions.javaForVersionFallback('1.16.5'), 8);
  assert.strictEqual(versions.javaForVersionFallback('26.1'), 25);
  assert.strictEqual(versions.normalizeJavaFeature(16), 17);
  assert.ok(versions.compareVersions('1.21.10', '1.21.9') > 0);
  assert.ok(versions.compareVersions('1.21', '1.21.0') === 0);
});

test('java -version 파싱', () => {
  assert.strictEqual(java.parseJavaVersion('java version "1.8.0_392"'), 8);
  assert.strictEqual(java.parseJavaVersion('openjdk version "21.0.4" 2024-07-16 LTS'), 21);
  assert.strictEqual(java.parseJavaVersion('openjdk version "17" 2021-09-14'), 17);
});

test('RAM 추천', () => {
  assert.strictEqual(system.recommendMemoryMb(16), 6 * 1024);
  assert.strictEqual(system.recommendMemoryMb(8), 3 * 1024);
  assert.strictEqual(system.recommendMemoryMb(64), 12 * 1024);
  const d = system.recommendDistances(6 * 1024, 10);
  assert.strictEqual(d.viewDistance, 10);
  assert.ok(d.simulationDistance <= d.viewDistance);
});

test('server.properties 병합은 순서와 주석을 지킨다', () => {
  const src = '#comment\nmotd=hello\ndifficulty=easy\n';
  const out = props.merge(src, { difficulty: 'hard', 'max-players': 8 });
  assert.strictEqual(out, '#comment\nmotd=hello\ndifficulty=hard\nmax-players=8\n');
  const friendly = props.fromProperties(props.parse(out));
  assert.strictEqual(friendly.difficulty, 'hard');
  assert.strictEqual(friendly.maxPlayers, 8);
  assert.deepStrictEqual(props.toProperties({ whitelist: true }), { 'white-list': true, 'enforce-whitelist': true });
});

test("Aikar's flags", () => {
  const f = optimize.aikarFlags(6144);
  assert.ok(f.includes('-Xms6144M') && f.includes('-Xmx6144M'));
  assert.ok(f.includes('-XX:G1HeapRegionSize=8M'));
  assert.ok(optimize.aikarFlags(16384).includes('-XX:G1HeapRegionSize=16M'));
  // JDK 20에서 없어진 옵션은 넣지 않는다 (Java 21에서 JVM이 켜지지 않음)
  assert.ok(!f.some((x) => x.includes('G1RSetUpdatingPauseIntervalMillis')));
  assert.strictEqual(f[0], '-XX:+IgnoreUnrecognizedVMOptions');
});

test('실제 힙 사용량은 GC 로그에서 읽는다 (RSS 는 AlwaysPreTouch 로 늘 최대)', () => {
  assert.deepStrictEqual(optimize.gcLogArgs(21), ['-Xlog:gc:file=logs/mces-gc.log:uptime:filecount=0']);
  assert.deepStrictEqual(optimize.gcLogArgs(8), ['-Xloggc:logs/mces-gc.log', '-XX:+PrintGC']);
  const j21 = '[2.3s] GC(5) Concurrent Undo Cycle\n[2.7s] GC(6) Pause Young (Normal) (G1 Evacuation Pause) 229M->81M(512M) 1.184ms\n[3.1s] GC(7) Pause Young (Normal) (G1 Evacuation Pause) 1G->300M(6144M) 2.1ms\n';
  assert.deepStrictEqual(optimize.parseGcLog(j21), { beforeMb: 1024, usedMb: 300, committedMb: 6144 });
  const j8 = '12.3: [GC pause (G1 Evacuation Pause) (young) 204800K->51200K(1048576K), 0.0012 secs]';
  assert.deepStrictEqual(optimize.parseGcLog(j8), { beforeMb: 200, usedMb: 50, committedMb: 1024 });
  assert.strictEqual(optimize.parseGcLog('[0.01s] Using G1'), null);
  // 에이전트 파일: 현재 사용량, 15초 넘게 갱신 안 됐으면 버린다
  const now = Date.now();
  assert.deepStrictEqual(optimize.parseHeapFile(`${512 * 1048576} ${2048 * 1048576} ${12288 * 1048576} ${now}\n`, now), { usedMb: 512, committedMb: 2048, maxMb: 12288 });
  assert.strictEqual(optimize.parseHeapFile(`1 2 3 ${now - 20000}`, now), null);
  assert.strictEqual(optimize.parseHeapFile('garbage', now), null);
});

test('Paper 설정은 생성된 파일에만 주석을 살려 덮어쓴다', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'paper-'));
  assert.strictEqual(optimize.applyPaperConfigs(dir), false);
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'paper-world-defaults.yml'), '# keep me\n_version: 30\nchunks:\n  max-auto-save-chunks-per-tick: 24\n');
  fs.writeFileSync(path.join(dir, 'spigot.yml'), 'config-version: 12\nworld-settings:\n  default:\n    mob-spawn-range: 8\n');
  fs.writeFileSync(path.join(dir, 'bukkit.yml'), 'spawn-limits:\n  monsters: 70\n');
  assert.strictEqual(optimize.applyPaperConfigs(dir), true);
  const paper = fs.readFileSync(path.join(dir, 'config', 'paper-world-defaults.yml'), 'utf8');
  assert.match(paper, /# keep me/);
  assert.match(paper, /_version: 30/);
  assert.match(paper, /max-auto-save-chunks-per-tick: 8/);
  assert.match(paper, /redstone-implementation: ALTERNATE_CURRENT/);
  assert.match(fs.readFileSync(path.join(dir, 'spigot.yml'), 'utf8'), /mob-spawn-range: 6/);
});

test('오류 번역', () => {
  const t = new ErrorTranslator();
  const port = t.check('[12:00:00 WARN]: **** FAILED TO BIND TO PORT!');
  assert.strictEqual(port.kind, 'port-in-use');
  assert.strictEqual(port.actions[0].id, 'change-port');

  const mem = t.check('Error occurred during initialization of VM\nCould not reserve enough space for 8388608KB object heap');
  assert.strictEqual(mem.kind, 'heap-too-big');

  const jvm = t.check("Unrecognized VM option 'G1RSetUpdatingPauseIntervalMillis=100'");
  assert.strictEqual(jvm.kind, 'jvm-option');
  assert.strictEqual(jvm.actions[0].id, 'disable-optimize');

  const oom = t.check('java.lang.OutOfMemoryError: Java heap space');
  assert.strictEqual(oom.kind, 'out-of-memory');

  const jv = t.check('java.lang.UnsupportedClassVersionError: net/minecraft/Main has been compiled by a more recent version of the Java Runtime (class file version 65.0)');
  assert.strictEqual(jv.kind, 'java-version');
  assert.strictEqual(jv.actions[0].payload.need, 21);

  // 여러 줄에 걸친 플러그인 오류
  t.check("[12:00:01 ERROR]: Could not load 'plugins/OldPlugin.jar' in folder 'plugins'");
  const api = t.check('org.bukkit.plugin.InvalidPluginException: Unsupported API version 1.13');
  assert.strictEqual(api.kind, 'plugin-api-version');
  assert.match(api.message, /OldPlugin/);
  assert.match(api.message, /맞지 않음 → 비활성화/);
  assert.strictEqual(api.actions[0].payload.file, 'OldPlugin.jar');

  t.check("[12:00:02 ERROR]: Could not load 'plugins/EssentialsChat.jar' in folder 'plugins'");
  const dep = t.check('org.bukkit.plugin.UnknownDependencyException: Unknown/missing dependency plugins: [Essentials, Vault]. Please download and install these plugins to run \'EssentialsChat\'.');
  assert.strictEqual(dep.kind, 'plugin-missing-dep');
  assert.deepStrictEqual(dep.actions[0].payload.names, ['Essentials', 'Vault']);

  const en = t.check('[12:00:03 ERROR]: Error occurred while enabling BrokenThing v1.0 (Is it up to date?)');
  assert.strictEqual(en.kind, 'plugin-enable-error');
  assert.strictEqual(en.actions[0].payload.name, 'BrokenThing');

  // 같은 오류는 잠시 동안 다시 알리지 않는다
  assert.strictEqual(t.check('**** FAILED TO BIND TO PORT!'), null);
  assert.strictEqual(t.check('[12:00:00 INFO]: Steve joined the game'), null);
});

test('로그 파싱 정규식', () => {
  const msg = (l) => RE.message.exec(l)[1];
  assert.strictEqual(msg('[12:34:56] [Server thread/INFO]: Steve joined the game'), 'Steve joined the game');
  assert.strictEqual(msg('[12:34:56 INFO]: Steve left the game'), 'Steve left the game');
  assert.ok(RE.join.test('Steve joined the game'));
  // 플러그인이 입장 문구를 바꾸거나 칭호를 붙여도 접속을 바로 잡는다
  assert.strictEqual(RE.login.exec('Steve[/127.0.0.1:54321] logged in with entity id 123 at ([world]1.5, 64.0, 2.5)')[1], 'Steve');
  assert.strictEqual(RE.join.exec('[관리자] Steve joined the game')[1], 'Steve');
  assert.strictEqual(RE.lost.exec('Alex lost connection: Disconnected')[1], 'Alex');
  assert.strictEqual(RE.leave.exec('[VIP] Alex left the game')[1], 'Alex');
  assert.ok(RE.chat.test('<Steve> Bob joined the game'));
  assert.ok(RE.chat.test('[Not Secure] <Steve> hi'));
  assert.ok(RE.done.test('Done (4.123s)! For help, type "help"'));
  assert.strictEqual(RE.tpsPaper.exec('TPS from last 1m, 5m, 15m: *20.0, 19.98, 19.9')[1], '20.0');
  assert.strictEqual(RE.mspt.exec('Average time per tick: 3.2ms (Target: 50.0ms)')[1], '3.2');
  const l = RE.list.exec('There are 2 of a max of 20 players online: Alex, Steve');
  assert.strictEqual(l[3], 'Alex, Steve');
  assert.strictEqual(RE.uuid.exec('UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5')[2], '069a79f4-44e9-4726-a5be-fca90e38aaf5');
});

test('Modrinth 필터는 서버 종류·버전에 맞춘다', () => {
  const paper = modrinth.searchFacets({ type: 'paper', version: '1.21.1' });
  assert.deepStrictEqual(paper[0], ['categories:paper', 'categories:spigot', 'categories:bukkit']);
  assert.deepStrictEqual(paper[1], ['versions:1.21.1']);
  const fabric = modrinth.searchFacets({ type: 'fabric', version: '1.21.1' });
  assert.ok(fabric.some((f) => f.includes('server_side:required')));
  assert.strictEqual(modrinth.addonFolder({ type: 'fabric' }), 'mods');
  assert.strictEqual(modrinth.addonFolder({ type: 'vanilla', levelName: 'world' }), path.join('world', 'datapacks'));
});

test('mrpack 내보내기는 서버 전용 모드를 뺀다', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'fabric-'));
  const server = {
    name: '테스트',
    version: '1.21.1',
    loaderVersion: '0.16.5',
    addons: [
      { title: 'Fabric API', fileName: 'fabric-api.jar', enabled: true, clientSide: 'required', sha1: 'a', sha512: 'b', url: 'https://cdn.modrinth.com/x.jar', size: 10 },
      { title: 'Lithium', fileName: 'lithium.jar', enabled: true, clientSide: 'optional', sha1: 'c', sha512: 'd', url: 'https://cdn.modrinth.com/y.jar', size: 10 },
      { title: 'ServerOnly', fileName: 'server-only.jar', enabled: true, clientSide: 'unsupported', sha1: 'e', sha512: 'f', url: 'u', size: 1 },
    ],
  };
  const out = path.join(dir, 'pack.mrpack');
  const r = await modrinth.exportMrpack(server, dir, out);
  assert.strictEqual(r.count, 2);
  assert.ok(fs.statSync(out).size > 100);
});

test('터널: rundata 에서 서버 터널 고르기', () => {
  const data = { tunnels: [
    { name: 'other', tunnel_type: 'minecraft-java', display_address: 'a.joinmc.link' },
    { name: 'mc-easy-12345678', tunnel_type: 'minecraft-java', display_address: 'x.joinmc.link', agent_config: { fields: [{ name: 'local_port', value: '25566' }] } },
  ] };
  const t = pickTunnel(data, 'mc-easy-12345678');
  assert.strictEqual(t.display_address, 'x.joinmc.link');
  assert.strictEqual(tunnelLocalPort(t), 25566);
  assert.strictEqual(pickTunnel(data, 'none'), null);
  // 웹에서 직접 만든 터널(이름이 다름)도 로컬 포트가 같으면 쓴다
  assert.strictEqual(pickTunnelByPort(data, 25566).display_address, 'x.joinmc.link');
  assert.strictEqual(pickTunnelByPort(data, 25570), null);
});

test('터널: playit API로 연결 → 터널 만들기 → 주소 받기 (가짜 API)', async () => {
  const calls = [];
  let created = false;
  let setupPolls = 0;
  const reply = (data, status = 'success') => ({ status: 200, json: async () => ({ status, data }) });
  const fetchImpl = async (url, opts) => {
    const route = url.replace('https://api.playit.gg', '');
    const body = JSON.parse(opts.body);
    calls.push({ route, body, auth: opts.headers.Authorization });
    if (route === '/claim/setup') return reply(++setupPolls < 2 ? 'WaitingForUser' : 'UserAccepted');
    if (route === '/claim/exchange') return reply({ secret_key: 'abcdef0123' });
    if (route === '/v1/agents/rundata') {
      return reply({ agent_id: 'agent-1', pending: [], tunnels: created ? [{ name: 'mc-easy-srvabcde', tunnel_type: 'minecraft-java', display_address: 'brave-fox.gl.joinmc.link', agent_config: { fields: [{ name: 'local_port', value: '25570' }] } }] : [] });
    }
    if (route === '/v1/tunnels/create') {
      created = true;
      return reply({ id: 't-1' });
    }
    return reply('NotFound', 'fail');
  };
  const t = new Tunnel({ fetchImpl });
  fs.mkdirSync(t.dir, { recursive: true });
  fs.writeFileSync(t.bin, ''); // 실행 파일 다운로드 건너뛰기
  t.spawnAgent = () => {}; // 실제 에이전트는 띄우지 않는다
  const opened = [];
  t.on('open-url', (u) => opened.push(u));

  const address = await t.start({ id: 'srvabcdef-0000', port: 25570 });
  assert.strictEqual(address, 'brave-fox.gl.joinmc.link');
  assert.match(opened[0], /^https:\/\/playit\.gg\/claim\/[0-9a-f]{10}$/);
  assert.strictEqual(t.readSecret(), 'abcdef0123');
  const create = calls.find((c) => c.route === '/v1/tunnels/create');
  assert.strictEqual(create.auth, 'Agent-Key abcdef0123');
  assert.deepStrictEqual(create.body.ports, { type: 'tunnel-type', details: 'minecraft-java' });
  assert.deepStrictEqual(create.body.origin, { type: 'agent', data: { agent_id: 'agent-1', config: { fields: [{ name: 'local_ip', value: '127.0.0.1' }, { name: 'local_port', value: '25570' }] } } });
  assert.ok(!calls.some((c) => c.route === '/tunnels/create'), '새 API 가 되면 예전 API 는 부르지 않는다');
  assert.strictEqual(t.state.status, 'running');
  assert.strictEqual(t.state.message, null);

  // 두 번째부터는 연결·생성 없이 주소만 가져온다
  calls.length = 0;
  assert.strictEqual(await t.start({ id: 'srvabcdef-0000', port: 25570 }), 'brave-fox.gl.joinmc.link');
  assert.ok(!calls.some((c) => c.route.startsWith('/claim') || /tunnels\/create/.test(c.route)));
});

test('Server List Ping 은 로컬 서버 응답을 읽는다', async () => {
  const net = require('net');
  const srv = net.createServer((sock) => {
    sock.once('data', () => {
      const json = Buffer.from(JSON.stringify({ version: { name: '1.21.1' }, players: { online: 1, max: 20 } }));
      const body = Buffer.concat([reach.varint(0), reach.varint(json.length), json]);
      sock.write(Buffer.concat([reach.varint(body.length), body]));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const r = await reach.ping('127.0.0.1', srv.address().port, 2000);
  srv.close();
  assert.strictEqual(r.online, true);
  assert.deepStrictEqual(r.players, { online: 1, max: 20 });
  assert.deepStrictEqual(reach.splitAddress('abc.joinmc.link:1234'), { host: 'abc.joinmc.link', port: 1234 });
});

test('월드 백업과 복원', async () => {
  paths.init(null);
  const id = 'srv-test';
  const dir = path.join(tmp, 'servers', id);
  fs.mkdirSync(path.join(dir, 'world', 'region'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'v1');
  fs.writeFileSync(path.join(dir, 'world', 'region', 'r.0.0.mca'), Buffer.alloc(5000, 1));
  fs.writeFileSync(path.join(dir, 'world', 'session.lock'), 'x');
  fs.mkdirSync(path.join(dir, 'world_nether'));
  fs.writeFileSync(path.join(dir, 'world_nether', 'level.dat'), 'n');
  const b = await backup.create(id, dir, 'world', 'manual');
  assert.ok(b.size > 0);
  fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'v2');
  await backup.restore(id, dir, 'world', b.file);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'world', 'level.dat'), 'utf8'), 'v1');
  assert.ok(fs.existsSync(path.join(dir, 'world_nether', 'level.dat')));
  assert.ok(!fs.existsSync(path.join(dir, 'world', 'session.lock')));
  // 복원 전 자동 백업이 남는다
  assert.ok(backup.list(id).some((x) => x.reason === 'before-restore'));
  await assert.rejects(backup.restore(id, dir, 'world', path.join(tmp, 'elsewhere.zip')));
});

test('터널: 에이전트가 새 버전으로 등록되기 전(AgentVersionTooOld)에는 기다렸다 다시 만든다', async () => {
  let createCalls = 0;
  let created = false;
  const reply = (data, status = 'success') => ({ status: 200, json: async () => ({ status, data }) });
  const fetchImpl = async (url) => {
    const route = url.replace('https://api.playit.gg', '');
    if (route === '/v1/agents/rundata') {
      return reply({ agent_id: 'agent-2', pending: [], tunnels: created ? [{ name: 'mc-easy-retrytes', tunnel_type: 'minecraft-java', display_address: 'late.joinmc.link' }] : [] });
    }
    if (route === '/v1/tunnels/create' || route === '/tunnels/create') {
      createCalls++;
      if (createCalls <= 2) return reply('AgentNotFound', 'fail'); // 첫 시도(새·예전 API 둘 다) 거절
      created = true;
      return reply({ id: 't-2' });
    }
    return reply('NotFound', 'fail');
  };
  const t = new Tunnel({ fetchImpl });
  fs.mkdirSync(t.dir, { recursive: true });
  fs.writeFileSync(t.bin, '');
  fs.writeFileSync(t.secretFile, JSON.stringify({ secret: 'abcdef0123' }));
  t.spawnAgent = () => {};
  const address = await t.start({ id: 'retrytest-0000', port: 25565 });
  assert.strictEqual(address, 'late.joinmc.link');
  assert.strictEqual(createCalls, 3);
});

test('터널: 만든 뒤 대기(pending) 상태를 보여주고, 주소가 나오면 대기 문구를 지운다', async () => {
  let polls = 0;
  const reply = (data, status = 'success') => ({ status: 200, json: async () => ({ status, data }) });
  const messages = [];
  const fetchImpl = async (url) => {
    const route = url.replace('https://api.playit.gg', '');
    if (route === '/v1/agents/rundata') {
      polls++;
      if (polls === 1) return reply({ agent_id: 'a3', pending: [], tunnels: [] });
      if (polls < 4) return reply({ agent_id: 'a3', pending: [{ id: 'p', name: 'mc-easy-pendingt', status_msg: 'allocating' }], tunnels: [] });
      return reply({ agent_id: 'a3', pending: [], tunnels: [{ name: 'mc-easy-pendingt', tunnel_type: 'minecraft-java', display_address: 'ready.joinmc.link' }] });
    }
    if (route === '/v1/tunnels/create') return reply({ id: 't' });
    return reply('NotFound', 'fail');
  };
  const t = new Tunnel({ fetchImpl });
  fs.mkdirSync(t.dir, { recursive: true });
  fs.writeFileSync(t.bin, '');
  fs.writeFileSync(t.secretFile, JSON.stringify({ secret: 'abcdef0123' }));
  t.spawnAgent = () => {};
  t.on('state', (x) => x.message && messages.push(x.message));
  assert.strictEqual(await t.start({ id: 'pendingtest-0000', port: 25565 }), 'ready.joinmc.link');
  assert.ok(messages.includes('터널 준비 중 — allocating'));
  assert.strictEqual(t.state.message, null);
  assert.strictEqual(t.state.status, 'running');
});
