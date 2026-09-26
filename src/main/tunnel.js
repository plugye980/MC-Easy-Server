'use strict';
// playit.gg 터널: 에이전트를 앱 폴더에 받아 앱 안에서 실행하고, 접속 주소를 알아낸다.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const paths = require('./paths');
const { download } = require('./http');

const RELEASE = 'https://github.com/playit-cloud/playit-agent/releases/latest/download';
const ADDRESS_RE = /\b((?:[a-z0-9-]+\.)+(?:joinmc\.link|ply\.gg|playit\.gg))(?::(\d{2,5}))?\b/gi;
const CLAIM_RE = /https:\/\/playit\.gg\/(?:claim|mc)\/[A-Za-z0-9_-]+/i;

function assetName() {
  const arm = process.arch === 'arm64';
  if (process.platform === 'win32') return 'playit-windows-x86_64-signed.exe';
  if (process.platform === 'darwin') return arm ? 'playit-darwin-arm64' : 'playit-darwin-amd64';
  return arm ? 'playit-linux-aarch64' : 'playit-linux-amd64';
}

/** 출력에서 터널 주소를 뽑는다. 주소 뒤 포트가 25565가 아니면 붙여서 돌려준다. */
function extractAddresses(text) {
  const out = [];
  for (const m of String(text).matchAll(ADDRESS_RE)) {
    const host = m[1].toLowerCase();
    if (host === 'playit.gg' || host.startsWith('www.') || host.startsWith('api.')) continue;
    out.push(m[2] && m[2] !== '25565' ? `${host}:${m[2]}` : host);
  }
  return [...new Set(out)];
}

/** `tunnels list` JSON에서 이름이 같은 터널의 주소와 로컬 포트를 찾는다. */
function findTunnelInList(json, name) {
  const list = Array.isArray(json) ? json : json.tunnels || json.data || [];
  const t = list.find((x) => x.name === name);
  if (!t) return null;
  const alloc = (t.alloc && (t.alloc.data || t.alloc)) || {};
  const domain = t.custom_domain || alloc.assigned_srv || alloc.assigned_domain || alloc.ip_hostname;
  const port = alloc.port_start;
  const address = domain ? (alloc.assigned_srv || !port || port === 25565 ? domain : `${domain}:${port}`) : null;
  return { id: t.id, address, localPort: t.local_port || (t.origin && t.origin.data && t.origin.data.local_port) || null };
}

class Tunnel extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.state = { status: 'idle', claimUrl: null, addresses: {}, message: null, log: [] };
  }

  get dir() {
    return path.join(paths.tools(), 'playit');
  }
  get bin() {
    return path.join(this.dir, process.platform === 'win32' ? 'playit.exe' : 'playit');
  }
  get secretFile() {
    return path.join(this.dir, 'secret.json');
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
    const clean = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trim();
    if (!clean) return;
    this.state.log.push(clean);
    if (this.state.log.length > 200) this.state.log.shift();
    const claim = CLAIM_RE.exec(clean);
    if (claim && !this.readSecret()) this.set({ claimUrl: claim[0], status: 'claiming' });
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
    fs.mkdirSync(this.dir, { recursive: true });
    this.set({ status: 'downloading', message: '터널 프로그램(playit) 내려받는 중' });
    await download(`${RELEASE}/${assetName()}`, this.bin, {
      onProgress: ({ received, total }) => onProgress({ text: 'playit 내려받는 중', percent: total ? received / total : 0 }),
    });
    if (process.platform !== 'win32') fs.chmodSync(this.bin, 0o755);
    return this.bin;
  }

  run(args, { timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { timeout, windowsHide: true, cwd: this.dir }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`;
        out.split(/\r?\n/).forEach((l) => this.logLine(l));
        if (err) return reject(Object.assign(new Error(out.trim() || err.message), { stdout }));
        resolve(String(stdout).trim());
      });
    });
  }

  /** 처음 한 번: 브라우저에서 playit 계정과 연결(claim)하고 비밀키를 받아 둔다. */
  async claim() {
    const code = (await this.run(['claim', 'generate'])).split(/\s+/).pop();
    const url = (await this.run(['claim', 'url', code])).match(/https?:\/\/\S+/);
    this.set({ status: 'claiming', claimUrl: url ? url[0] : `https://playit.gg/claim/${code}`, message: '브라우저에서 playit.gg 연결을 승인해 주세요' });
    this.emit('open-url', this.state.claimUrl);
    // 사용자가 승인할 때까지 기다린다(최대 10분)
    const secret = (await this.run(['claim', 'exchange', code, '--wait', '600'], { timeout: 11 * 60 * 1000 })).split(/\s+/).pop();
    if (!secret || secret.length < 16) throw new Error('playit 연결 승인을 받지 못했어요. 다시 시도해 주세요.');
    fs.writeFileSync(this.secretFile, JSON.stringify({ secret }));
    this.set({ claimUrl: null });
    return secret;
  }

  /** 서버용 마인크래프트 터널을 준비하고 주소를 알아낸다. */
  async prepareServer(server) {
    const secret = this.readSecret();
    const name = `mc-easy-${server.id.slice(0, 8)}`;
    try {
      await this.run(['--secret', secret, 'tunnels', 'prepare', name, 'minecraft-java', '1', '--exact']);
    } catch (e) {
      this.logLine(`tunnels prepare 실패: ${e.message}`);
    }
    try {
      const raw = await this.run(['--secret', secret, 'tunnels', 'list']);
      const jsonStart = raw.search(/[[{]/);
      const found = jsonStart >= 0 ? findTunnelInList(JSON.parse(raw.slice(jsonStart)), name) : null;
      if (found && found.address) {
        const addresses = { ...this.state.addresses, [server.id]: found.address };
        this.set({ addresses });
        if (found.localPort && Number(found.localPort) !== Number(server.port)) {
          this.set({ message: `playit 터널이 ${found.localPort}번 포트로 연결돼 있어요. playit.gg에서 로컬 포트를 ${server.port}로 바꿔 주세요.` });
        }
        return found.address;
      }
    } catch (e) {
      this.logLine(`tunnels list 실패: ${e.message}`);
    }
    return null;
  }

  /** 터널 시작. 이미 켜져 있으면 해당 서버 주소만 준비한다. */
  async start(server, onProgress) {
    try {
      await this.ensureBinary(onProgress);
      if (!this.readSecret()) await this.claim();
      this.set({ status: 'connecting', message: '터널 연결 중' });
      const address = await this.prepareServer(server);
      if (!this.proc) this.spawnAgent();
      if (address) this.set({ status: 'running', message: null });
      return address;
    } catch (e) {
      this.set({ status: 'error', message: e.message });
      throw e;
    }
  }

  spawnAgent() {
    const secret = this.readSecret();
    this.proc = spawn(this.bin, ['--secret', secret, '--stdout', 'start'], { cwd: this.dir, windowsHide: true });
    const onData = (buf) => {
      const text = buf.toString();
      text.split(/\r?\n/).forEach((l) => this.logLine(l));
      const found = extractAddresses(text);
      if (found.length) this.set({ status: 'running', lastSeenAddresses: found });
      if (/tunnel running|agent registered|tunnels? (?:are )?running/i.test(text)) this.set({ status: 'running', message: null });
    };
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);
    this.proc.on('exit', (code) => {
      this.proc = null;
      if (this.state.status !== 'idle') this.set({ status: code === 0 ? 'idle' : 'error', message: code === 0 ? null : `터널이 멈췄어요 (코드 ${code})` });
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
    this.set({ addresses: {}, claimUrl: null });
  }
}

module.exports = { Tunnel, extractAddresses, findTunnelInList, assetName };
