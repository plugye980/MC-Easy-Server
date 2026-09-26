'use strict';
// 접속 가능 여부 점검: 로컬 Server List Ping + 외부 점검(mcsrvstat.us)
const net = require('net');
const { getJson } = require('./http');

function varint(n) {
  const out = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: result, size: pos - offset };
    shift += 7;
    if (shift > 35) throw new Error('varint too long');
  }
  return null;
}

function packet(id, payload) {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
}

/** 마인크래프트 Server List Ping. 서버가 응답하면 인원·버전을 돌려준다. */
function ping(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout, () => done({ online: false, error: 'timeout' }));
    socket.on('error', (e) => done({ online: false, error: e.code || e.message }));
    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      const hs = Buffer.concat([varint(767), varint(hostBuf.length), hostBuf, portBuf, varint(1)]);
      socket.write(packet(0x00, hs));
      socket.write(packet(0x00, Buffer.alloc(0)));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        let off = len.size;
        const id = readVarint(buf, off);
        off += id.size;
        const strLen = readVarint(buf, off);
        off += strLen.size;
        const json = JSON.parse(buf.slice(off, off + strLen.value).toString('utf8'));
        done({
          online: true,
          latency: Date.now() - started,
          players: json.players ? { online: json.players.online, max: json.players.max } : null,
          version: json.version ? json.version.name : null,
        });
      } catch (e) {
        done({ online: false, error: e.message });
      }
    });
  });
}

/** "abc.joinmc.link" / "abc.gl.joinmc.link:12345" / "1.2.3.4:25565" → {host, port} */
function splitAddress(address, defaultPort = 25565) {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(String(address).trim());
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
}

/**
 * 외부 점검: 인터넷 쪽에서 실제로 접속되는지 공개 점검 서비스에 물어본다.
 * (같은 공유기 안에서 스스로 접속해보는 것은 NAT 헤어핀 때문에 믿을 수 없다.)
 */
async function externalCheck(address) {
  try {
    const data = await getJson(`https://api.mcsrvstat.us/3/${encodeURIComponent(address)}`, { timeout: 15000 });
    return {
      online: !!data.online,
      players: data.players ? { online: data.players.online, max: data.players.max } : null,
      checkedBy: 'mcsrvstat.us',
    };
  } catch (e) {
    // 점검 서비스가 안 될 때는 직접 핑으로 대신한다(터널 주소는 이 방법도 믿을 만하다).
    const a = splitAddress(address);
    if (!a) return { online: false, error: e.message };
    const r = await ping(a.host, a.port, 8000);
    return { ...r, checkedBy: 'direct' };
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

async function findFreePort(start = 25565, taken = []) {
  for (let p = start; p < start + 200; p++) {
    if (taken.includes(p)) continue;
    if (await isPortFree(p)) return p;
  }
  throw new Error('빈 포트 없음');
}

module.exports = { ping, externalCheck, splitAddress, isPortFree, findFreePort, varint, readVarint };
