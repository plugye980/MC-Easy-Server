'use strict';
// UPnP 포트 열기 (공유기가 UPnP를 지원하고, 직접 포트포워딩이 가능한 사람용 선택 기능)
const dgram = require('dgram');
const os = require('os');
const { request } = require('./http');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];

function localIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) return i.address;
    }
  }
  return null;
}

function discover(timeout = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set();
    const finish = () => {
      try { sock.close(); } catch { /* 이미 닫힘 */ }
      resolve([...found]);
    };
    sock.on('message', (msg) => {
      const m = /^location:\s*(.+)$/im.exec(msg.toString());
      if (m) found.add(m[1].trim());
    });
    sock.on('error', finish);
    sock.bind(() => {
      for (const st of ['urn:schemas-upnp-org:device:InternetGatewayDevice:1', 'urn:schemas-upnp-org:device:InternetGatewayDevice:2']) {
        const q = Buffer.from(
          `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`,
        );
        sock.send(q, SSDP_PORT, SSDP_ADDR);
      }
    });
    setTimeout(finish, timeout);
  });
}

async function findService() {
  const locations = await discover();
  for (const loc of locations) {
    try {
      const xml = await (await request(loc, { timeout: 4000 })).text();
      for (const type of SERVICES) {
        const re = new RegExp(`<serviceType>${type.replace(/[.:]/g, '\\$&')}</serviceType>[\\s\\S]*?<controlURL>([^<]+)</controlURL>`, 'i');
        const m = re.exec(xml);
        if (m) return { type, controlUrl: new URL(m[1].trim(), loc).toString() };
      }
    } catch { /* 다음 장치 */ }
  }
  return null;
}

async function soap(service, action, args) {
  const body = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  const envelope = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.type}">${body}</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(service.controlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${service.type}#${action}"` },
    body: envelope,
    signal: AbortSignal.timeout(6000),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = /<errorDescription>([^<]+)</.exec(text);
    throw new Error(code ? code[1] : `UPnP ${action} 실패 (${res.status})`);
  }
  return text;
}

/** 공유기에 포트를 연다. 성공하면 외부 주소를 돌려준다. */
async function openPort(port, description = 'MCES') {
  const service = await findService();
  if (!service) throw new Error('UPnP 지원 공유기 없음 — 공유기 설정에서 UPnP를 켜거나 터널(playit.gg) 사용');
  const ip = localIp();
  if (!ip) throw new Error('이 PC의 내부 IP 없음');
  for (const proto of ['TCP']) {
    await soap(service, 'AddPortMapping', {
      NewRemoteHost: '',
      NewExternalPort: port,
      NewProtocol: proto,
      NewInternalPort: port,
      NewInternalClient: ip,
      NewEnabled: 1,
      NewPortMappingDescription: description,
      NewLeaseDuration: 0,
    });
  }
  const xml = await soap(service, 'GetExternalIPAddress', {});
  const m = /<NewExternalIPAddress>([^<]*)</.exec(xml);
  const external = m ? m[1] : null;
  return { externalIp: external, address: external ? (port === 25565 ? external : `${external}:${port}`) : null, internalIp: ip };
}

async function closePort(port) {
  const service = await findService();
  if (!service) return;
  await soap(service, 'DeletePortMapping', { NewRemoteHost: '', NewExternalPort: port, NewProtocol: 'TCP' }).catch(() => {});
}

module.exports = { openPort, closePort, localIp };
