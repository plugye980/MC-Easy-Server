'use strict';
// playit.gg 터널
// - 에이전트(v0.17.1, 단독 실행형)를 앱 폴더에 받아 앱 안에서 실행한다.
// - 계정 연결(claim), 터널 만들기, 주소 조회는 에이전트 출력 대신 playit API를 직접 부른다.
//   (에이전트의 -s 로그는 상태의 첫 줄만 찍어서 주소를 읽을 수 없다)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const paths = require('./paths');
const { download, USER_AGENT } = require('./http');

// 1.0.x 의 playit-* 실행 파일은 에이전트 데몬(playitd)이다. 서비스로 설치하지 않고 --secret-path 로 앱 안에서 직접 띄운다.
// (0.17.x 는 playit 서버가 터널 자동 생성을 AgentVersionTooOld 로 거절한다)
const AGENT_VERSION = '1.0.10';
const RELEASE = `https://github.com/playit-cloud/playit-agent/releases/download/v${AGENT_VERSION}`;
const API = 'https://api.playit.gg';

function assetName() {
  const arm = process.arch === 'arm64';
  if (process.platform === 'win32') return 'playit-windows-x86_64-signed.exe';
  if (process.platform === 'linux') return arm ? 'playit-linux-aarch64' : 'playit-linux-amd64';
  return null; // macOS용 단독 실행 파일은 배포되지 않는다
}

/** playit API 호출. 응답은 {status: success|fail|error, data} 형태다. */
async function playitApi(route, body, secret, fetchImpl = fetch) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT };
  if (secret) headers.Authorization = `Agent-Key ${secret}`;
  const res = await fetchImpl(`${API}${route}`, { method: 'POST', headers, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000) });
  if (res.status === 429) throw Object.assign(new Error('playit 요청 과다 — 잠시 뒤 다시 시도'), { retry: true });
  const json = await res.json();
  if (json.status === 'success') return json.data;
  const detail = typeof json.data === 'string' ? json.data : JSON.stringify(json.data || json);
  throw Object.assign(new Error(detail), { fail: json.status === 'fail', data: json.data });
}

/** rundata 에서 이 서버용 마인크래프트 터널을 고른다: 이름이 같은 것 → 없으면 아무 마인크래프트 터널 */
function pickTunnel(rundata, name) {
  const tunnels = (rundata && rundata.tunnels) || [];
  const mc = tunnels.filter((t) => !t.tunnel_type || t.tunnel_type === 'minecraft-java');
  return mc.find((t) => t.name === name) || null;
}

/** 웹에서 직접 만든 터널도 쓰기: 이름이 달라도 로컬 포트가 서버 포트와 같은 마인크래프트 터널 */
function pickTunnelByPort(rundata, port) {
  const tunnels = ((rundata && rundata.tunnels) || []).filter((t) => !t.tunnel_type || t.tunnel_type === 'minecraft-java');
  return tunnels.find((t) => tunnelLocalPort(t) === Number(port)) || null;
}

function tunnelLocalPort(t) {
  const fields = (t && t.agent_config && t.agent_config.fields) || [];
  const f = fields.find((x) => x.name === 'local_port');
  return f ? Number(f.value) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Tunnel extends EventEmitter {
  constructor({ fetchImpl } = {}) {
    super();
    this.fetchImpl = fetchImpl || ((...a) => fetch(...a));
    this.proc = null;
    this.claiming = null;
    this.state = { status: 'idle', claimUrl: null, addresses: {}, message: null, agentId: null, log: [] };
  }

  get dir() {
    return path.join(paths.tools(), 'playit');
  }
  get bin() {
    // 버전을 파일 이름에 넣어, 예전에 받은 다른 버전 파일을 쓰지 않게 한다
    return path.join(this.dir, `playit-${AGENT_VERSION}${process.platform === 'win32' ? '.exe' : ''}`);
  }
  get secretFile() {
    return path.join(this.dir, 'secret.json');
  }

  api(route, body) {
    return playitApi(route, body, this.readSecret(), this.fetchImpl);
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.publicState());
  }
  publicState() {
    const { log, ...rest } = this.state;
    return { ...rest, log: log.slice(-40), linked: !!this.readSecret() };
  }
  logLine(line) {
    const clean = String(line).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim();
    if (!clean) return;
    this.state.log.push(clean);
    if (this.state.log.length > 200) this.state.log.shift();
    this.emit('log', clean);
  }

  readSecret() {
    try {
      return JSON.parse(fs.readFileSync(this.secretFile, 'utf8')).secret || null;
    } catch {
      return null;
    }
  }

  async ensureBinary(onProgress = () => {}) {
    if (fs.existsSync(this.bin)) return this.bin;
    const asset = assetName();
    if (!asset) throw new Error('macOS는 앱 내 playit 실행 불가 — playit.gg 앱을 직접 설치하고 주소 옆 ✎ 버튼으로 주소 입력');
    fs.mkdirSync(this.dir, { recursive: true });
    this.set({ status: 'downloading', message: '터널 프로그램(playit) 내려받는 중' });
    await download(`${RELEASE}/${asset}`, this.bin, {
      onProgress: ({ received, total }) => onProgress({ text: 'playit 내려받는 중', percent: total ? received / total : 0 }),
    });
    if (process.platform !== 'win32') fs.chmodSync(this.bin, 0o755);
    // 예전 버전 파일 정리
    for (const f of fs.readdirSync(this.dir)) {
      if (/^playit(\.exe)?$/.test(f) || (/^playit-[\d.]+(\.exe)?$/.test(f) && path.join(this.dir, f) !== this.bin)) fs.rmSync(path.join(this.dir, f), { force: true });
    }
    return this.bin;
  }

  /** 처음 한 번: 브라우저에서 playit 계정과 연결(claim)하고 비밀키를 받아 둔다. */
  async claim() {
    if (this.claiming) return this.claiming;
    this.claiming = (async () => {
      const code = crypto.randomBytes(5).toString('hex');
      const url = `https://playit.gg/claim/${code}`;
      this.set({ status: 'claiming', claimUrl: url, message: '브라우저에서 playit.gg 연결 승인 대기' });
      this.emit('open-url', url);
      const deadline = Date.now() + 15 * 60 * 1000;
      // 1) 사용자가 브라우저에서 승인할 때까지
      for (;;) {
        if (Date.now() > deadline) throw new Error('playit 연결 승인 시간 초과 — "터널 연결" 다시 실행');
        let res;
        try {
          res = await this.api('/claim/setup', { code, agent_type: 'self-managed', version: `playit ${AGENT_VERSION}` });
        } catch (e) {
          this.logLine(`claim/setup: ${e.message}`);
          await sleep(2000);
          continue;
        }
        const s = String(res).toLowerCase().replace(/[^a-z]/g, '');
        if (s === 'useraccepted') break;
        if (s === 'userrejected') throw new Error('playit.gg에서 연결 거절됨');
        await sleep(1000);
      }
      // 2) 비밀키 받기
      for (;;) {
        try {
          const res = await this.api('/claim/exchange', { code });
          const secret = res && res.secret_key;
          if (secret) {
            fs.mkdirSync(this.dir, { recursive: true });
            fs.writeFileSync(this.secretFile, JSON.stringify({ secret }));
            this.set({ claimUrl: null, message: '연결 승인 완료 — 에이전트 시작' });
            // 웹이 "에이전트 오프라인"에 머무르지 않도록 바로 띄운다
            if (!this.proc) this.spawnAgent();
            this.emit('claimed');
            return secret;
          }
        } catch (e) {
          if (!e.fail && !e.retry) throw e;
        }
        if (Date.now() > deadline) throw new Error('playit 비밀키 발급 실패 — 다시 시도');
        await sleep(2000);
      }
    })();
    try {
      return await this.claiming;
    } finally {
      this.claiming = null;
    }
  }

  rundata() {
    return this.api('/v1/agents/rundata', {});
  }

  /** 서버용 마인크래프트 터널을 준비(없으면 만들기)하고 주소를 알아낸다. */
  async prepareServer(server) {
    const name = `mc-easy-${server.id.slice(0, 8)}`;
    // 에이전트가 막 켜졌으면 등록될 때까지 잠깐 기다린다
    let data = null;
    for (let i = 0; !data; i++) {
      try {
        data = await this.rundata();
      } catch (e) {
        if (i >= 5) throw new Error(`playit 연결 실패: ${e.message}`);
        await sleep(2000);
      }
    }
    this.set({ agentId: data.agent_id });
    let t = pickTunnel(data, name) || pickTunnelByPort(data, server.port);
    if (!t && !(data.pending || []).some((p) => p.name === name)) {
      const port = Number(server.port);
      // 1) 웹 대시보드와 같은 새 API (/v1/tunnels/create) — 로컬 주소는 에이전트 설정 필드로 넘긴다
      // 2) 예전 API (/tunnels/create) — 옛 에이전트용
      const requests = [
        ['/v1/tunnels/create', {
          name,
          ports: { type: 'tunnel-type', details: 'minecraft-java' },
          origin: { type: 'agent', data: { agent_id: data.agent_id, config: { fields: [{ name: 'local_ip', value: '127.0.0.1' }, { name: 'local_port', value: String(port) }] } } },
          enabled: true,
          alloc: null,
          firewall_id: null,
        }],
        ['/tunnels/create', {
          name, tunnel_type: 'minecraft-java', port_type: 'tcp', port_count: 1, enabled: true, alloc: null, firewall_id: null, proxy_protocol: null,
          origin: { type: 'agent', data: { agent_id: data.agent_id, local_ip: '127.0.0.1', local_port: port } },
        }],
      ];
      let created = false;
      const errors = [];
      // 막 켠 에이전트는 등록되기까지 몇 초 걸린다 → 그 경우에만 잠깐 다시 시도
      for (let attempt = 0; !created && attempt < 10; attempt++) {
        if (attempt) {
          this.set({ message: `에이전트 등록 대기 중 (${attempt}/9)` });
          await sleep(3000);
        }
        errors.length = 0;
        for (const [route, body] of requests) {
          try {
            await this.api(route, body);
            created = true;
            break;
          } catch (e) {
            errors.push(`${route}: ${e.message}`);
            this.logLine(`${route}: ${e.message}`);
          }
        }
        if (!created && !errors.some((m) => /AgentNotFound|AgentVersionTooOld|retry/i.test(m))) break;
      }
      if (!created) {
        throw new Error(`playit 터널 자동 생성 실패 (${errors.join(' / ')}) — https://playit.gg/account/agents/${data.agent_id} 에서 Minecraft Java 터널 추가, 로컬 포트 ${server.port}`);
      }
    }
    // 새 터널은 주소가 배정될 때까지 잠시 걸린다 (playit 이 알려주는 진행 상태를 그대로 보여준다)
    for (let i = 0; !t && i < 40; i++) {
      await sleep(2000);
      data = await this.rundata();
      t = pickTunnel(data, name) || pickTunnelByPort(data, server.port);
      const pending = (data.pending || []).find((p) => p.name === name);
      this.set({ message: pending && pending.status_msg ? `터널 준비 중 — ${pending.status_msg}` : '주소 배정 대기 중' });
    }
    if (!t) throw new Error(`터널 주소 배정 지연 — https://playit.gg/account/agents/${data.agent_id} 에서 확인`);
    this.set({ message: null });
    const port = tunnelLocalPort(t);
    if (port && port !== Number(server.port)) {
      this.set({ message: `playit 터널이 ${port}번 포트로 연결됨 — playit.gg에서 로컬 포트를 ${server.port}로 변경 필요` });
    }
    if (t.disabled_reason) this.set({ message: `playit 터널 꺼짐: ${t.disabled_reason}` });
    this.set({ addresses: { ...this.state.addresses, [server.id]: t.display_address } });
    return t.display_address;
  }

  /** 터널 시작. 이미 켜져 있으면 해당 서버 주소만 준비한다. */
  async start(server, onProgress) {
    try {
      await this.ensureBinary(onProgress);
      if (!this.readSecret()) await this.claim();
      this.set({ status: 'connecting', message: '터널 연결 중' });
      if (!this.proc) this.spawnAgent();
      const address = await this.prepareServer(server);
      // 진행 중 문구는 지우고, 포트 불일치 같은 경고만 남긴다
      const msg = this.state.message;
      this.set({ status: 'running', message: msg && /변경 필요|꺼짐/.test(msg) ? msg : null });
      return address;
    } catch (e) {
      this.set({ status: 'error', message: e.message, claimUrl: null });
      throw e;
    }
  }

  get secretPath() {
    return path.join(this.dir, 'agent.secret');
  }

  /** 다른 playit(서비스 설치판)과 겹치지 않는 IPC 경로 */
  get socketPath() {
    if (process.platform === 'win32') return '\\\\.\\pipe\\mces-playit';
    return path.join(os.tmpdir(), `mces-playit-${process.getuid ? process.getuid() : 'u'}.sock`);
  }

  spawnAgent() {
    // 비밀키는 명령줄 대신 파일로 넘긴다(작업 관리자에 노출되지 않게). 형식: 16진 문자열 한 줄
    fs.writeFileSync(this.secretPath, `${this.readSecret()}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') fs.rmSync(this.socketPath, { force: true });
    this.proc = spawn(this.bin, ['--secret-path', this.secretPath, '--socket-path', this.socketPath], {
      cwd: this.dir,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });
    const started = Date.now();
    const onData = (buf) => buf.toString().split(/\r?\n/).forEach((l) => this.logLine(l));
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);
    this.proc.on('error', (e) => this.set({ status: 'error', message: `playit 실행 실패: ${e.message}` }));
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.state.status === 'idle') return;
      // 인터넷이 잠깐 끊기면 데몬이 종료된다 → 잠시 뒤 다시 띄운다
      this.restarts = Date.now() - started > 60000 ? 0 : (this.restarts || 0) + 1;
      if (this.restarts <= 5) {
        this.set({ message: `터널 다시 연결 중 (${this.restarts}/5)` });
        setTimeout(() => {
          if (!this.proc && this.state.status !== 'idle' && this.readSecret()) this.spawnAgent();
        }, 5000 * this.restarts);
      } else {
        this.set({ status: 'error', message: `터널 중지됨 (코드 ${code}) — 인터넷 연결 확인 후 "터널 연결"` });
      }
    });
  }

  /** 수동으로 주소를 입력한 경우 */
  setAddress(serverId, address) {
    this.set({ addresses: { ...this.state.addresses, [serverId]: address } });
  }

  stop() {
    this.set({ status: 'idle', message: null });
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  reset() {
    this.stop();
    fs.rmSync(this.secretFile, { force: true });
    fs.rmSync(this.secretPath, { force: true });
    this.set({ addresses: {}, claimUrl: null, agentId: null });
  }
}

module.exports = { Tunnel, pickTunnel, pickTunnelByPort, tunnelLocalPort, playitApi, assetName, AGENT_VERSION };
