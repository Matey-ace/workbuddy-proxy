// HTTPS 抓包代理：本地 CA 动态签发站点证书，解密流量并转发到真实上游。
// 用途：从浏览器/客户端流量里抓出 WorkBuddy 的 Cookie / Authorization / 自定义头，
//       一键导入成本服务的凭证，同时观察真实请求结构（用于配置字段路径）。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CERT_DIR, DATA_DIR } from './config.js';
import log from './logger.js';

const CA_KEY = path.join(CERT_DIR, 'ca.key.pem');
const CA_CRT = path.join(CERT_DIR, 'ca.crt.pem');
const CACHE_DIR = path.join(CERT_DIR, 'cache');
const SNIFF_FILE = path.join(DATA_DIR, 'sniffed.json');

export function caExists() {
  return fs.existsSync(CA_KEY) && fs.existsSync(CA_CRT);
}
export function caPath() {
  return CA_CRT;
}

export function generateCA() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const openssl = process.env.OPENSSL_BIN || 'openssl';
  // 自包含 cnf：不依赖系统 openssl.cnf（Windows 常见问题）
  const cnf = path.join(CERT_DIR, 'ca.cnf');
  fs.writeFileSync(
    cnf,
    [
      '[req]',
      'distinguished_name=dn',
      'prompt=no',
      'x509_extensions=v3_ca',
      '[dn]',
      'CN=WorkBuddy Proxy Local CA',
      'O=Local Sniffer',
      '[v3_ca]',
      'basicConstraints=critical,CA:TRUE',
      'keyUsage=critical,keyCertSign,cRLSign',
      'subjectKeyIdentifier=hash',
      '',
    ].join('\n'),
    'utf8'
  );
  const args = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', CA_KEY, '-out', CA_CRT, '-days', '3650', '-config', cnf];
  execFileSync(openssl, args, { stdio: 'ignore' });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  log.info('已生成自签 CA：' + CA_CRT);
  return { CA_KEY, CA_CRT };
}

const certCache = new Map();
function siteCert(host) {
  if (certCache.has(host)) return certCache.get(host);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const safe = host.replace(/[^a-zA-Z0-9._-]/g, '_');
  const keyP = path.join(CACHE_DIR, `${safe}.key.pem`);
  const crtP = path.join(CACHE_DIR, `${safe}.crt.pem`);
  if (!fs.existsSync(keyP) || !fs.existsSync(crtP)) {
    const openssl = process.env.OPENSSL_BIN || 'openssl';
    const cnf = path.join(CACHE_DIR, `${safe}.cnf`);
    const san = `subjectAltName=DNS:${host},DNS:*.${host},DNS:localhost,IP:127.0.0.1`;
    fs.writeFileSync(
      cnf,
      ['[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', `CN=${host}`, '[ext]', san, 'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', ''].join('\n'),
      'utf8'
    );
    const csr = path.join(CACHE_DIR, `${safe}.csr`);
    execFileSync(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyP, '-out', csr, '-config', cnf], { stdio: 'ignore' });
    execFileSync(openssl, ['x509', '-req', '-in', csr, '-CA', CA_CRT, '-CAkey', CA_KEY, '-CAcreateserial', '-out', crtP, '-days', '825', '-sha256', '-extfile', cnf, '-extensions', 'ext'], { stdio: 'ignore' });
  }
  const pair = { key: fs.readFileSync(keyP), cert: fs.readFileSync(crtP) };
  certCache.set(host, pair);
  return pair;
}

// ---------------- 抓包记录 ----------------
let sniffed = [];
try {
  if (fs.existsSync(SNIFF_FILE)) sniffed = JSON.parse(fs.readFileSync(SNIFF_FILE, 'utf8'));
} catch {}
let saveTimer = null;
function saveSniff() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(SNIFF_FILE, JSON.stringify(sniffed.slice(-300), null, 2), 'utf8');
    } catch (e) {
      log.warn('抓包记录保存失败：', e.message);
    }
  }, 1000);
  saveTimer.unref?.();
}
export function getSniffed() {
  return sniffed.slice(-120).reverse();
}
export function clearSniffed() {
  sniffed = [];
  saveSniff();
}

const INTERESTING = ['cookie', 'authorization', 'x-auth', 'x-token', 'x-csrf', 'x-session', 'x-workspace', 'x-user', 'x-api', 'x-app', 'x-device', 'x-client'];
function record(host, method, urlPath, headers, bodyPreview) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const hit = Object.keys(lower).filter((k) => INTERESTING.some((p) => k.includes(p)));
  const cookie = lower.cookie || '';
  const isApi = /\/api\/|chat|completion|conversation|message|model|agent|query/i.test(urlPath || '');
  if (!isApi && !cookie) return;
  if (cookie && cookie.length < 8 && !hit.length) return;
  const entry = {
    at: Date.now(),
    host,
    method,
    path: urlPath,
    url: `https://${host}${urlPath}`,
    headers: Object.fromEntries(hit.map((k) => [k, String(lower[k]).slice(0, 4000)])),
    cookie: String(cookie).slice(0, 8000),
    bodyPreview: (bodyPreview || '').slice(0, 800),
  };
  sniffed.push(entry);
  if (sniffed.length > 300) sniffed.shift();
  saveSniff();
  log.info(`[sniff] ${method} ${host}${String(urlPath).slice(0, 80)} cookie=${cookie ? cookie.length + 'B' : '-'} hdr=${hit.join(',') || '-'}`);
}

// ---------------- 代理服务 ----------------
let proxyServer = null;
let tlsServer = null;

function forward(req, res, { secure, onRequest }) {
  const hostHeader = req.headers.host || '';
  // 解密后的请求 Host 头可能不含原始 CONNECT 端口，优先用隧道建立时记录的目标
  const tgt = req.socket?.__mitmTarget;
  const host = tgt?.host || hostHeader.split(':')[0];
  const port_ = tgt?.port || Number(hostHeader.split(':')[1]) || (secure ? 443 : 80);
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    record(host, req.method, req.url, req.headers, body.toString('utf8'));
    try {
      onRequest?.({ host, method: req.method, url: req.url, headers: req.headers, body });
    } catch (e) {
      log.warn('onRequest 回调异常：', e.message);
    }
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['accept-encoding']; // 避免解压/长度不一致问题
    const opts = { hostname: host, port: port_, path: req.url, method: req.method, headers };
    // secure 场景：优先按 TLS 连上游，失败自动降级为明文（自测/内网 HTTP 上游）
    const mods = secure ? [https, http] : [http];
    let idx = 0;
    const attempt = () => {
      const mod = mods[idx];
      const p = mod.request(opts, (up) => {
        try {
          res.writeHead(up.statusCode || 502, up.headers);
        } catch {}
        up.pipe(res);
      });
      p.on('error', (e) => {
        idx++;
        if (idx < mods.length) {
          log.debug(`抓包 TLS 转发失败，降级明文：${e.message}`);
          return attempt();
        }
        log.warn('抓包转发失败：', e.message);
        try {
          if (!res.headersSent) res.writeHead(502);
          res.end('proxy error: ' + e.message);
        } catch {}
      });
      if (body.length) p.write(body);
      p.end();
    };
    attempt();
  });
}

export function startMitm({ port = 8899, host = '127.0.0.1', onRequest } = {}) {
  if (proxyServer) return proxyServer;
  if (!caExists()) generateCA();

  const defaultPair = siteCert('localhost');
  // 明文 HTTP 代理
  proxyServer = http.createServer((req, res) => forward(req, res, { secure: false, onRequest }));

  // 解密后的 HTTPS 流量：TLS 握手完成后把 socket 交给 http.Server 解析
  const httpsInner = http.createServer((req, res) => forward(req, res, { secure: true, onRequest }));
  tlsServer = tls.createServer(
    {
      key: defaultPair.key,
      cert: defaultPair.cert,
      ALPNProtocols: ['http/1.1'],
      SNICallback: (servername, cb) => {
        try {
          const pair = siteCert(servername);
          cb(null, tls.createSecureContext({ key: pair.key, cert: pair.cert }));
        } catch (e) {
          cb(e);
        }
      },
    },
    (tlsSocket) => {
      // 继承隧道目标（Host 头可能不带端口）
      tlsSocket.__mitmTarget = tlsSocket._parent?.__mitmTarget || tlsSocket.__mitmTarget;
      httpsInner.emit('connection', tlsSocket);
    }
  );
  tlsServer.on('tlsClientError', (err) => log.debug('TLS 客户端错误：', err.message));
  proxyServer.httpsInner = httpsInner;

  proxyServer.on('connect', (req, clientSocket, head) => {
    const [targetHost, targetPort] = String(req.url || '').split(':');
    const port_ = Number(targetPort) || 443;
    log.debug('CONNECT ' + targetHost + ':' + port_);

    // 直连（不解密）白名单：证书固定/证书透明类域名，解密会失败
    const passthrough = (process.env.WB_SNIFF_PASSTHROUGH || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (passthrough.some((d) => targetHost === d || targetHost.endsWith('.' + d))) {
      const up = net.connect(port_, targetHost, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) up.write(head);
        up.pipe(clientSocket);
        clientSocket.pipe(up);
      });
      up.on('error', () => {
        try {
          clientSocket.end();
        } catch {}
      });
      clientSocket.on('error', () => {
        try {
          up.end();
        } catch {}
      });
      return;
    }

    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) clientSocket.unshift(head);
    // 记录真实目标，供解密后的转发使用
    clientSocket.__mitmTarget = { host: targetHost, port: port_ };
    // 把裸 socket 交给 TLS Server 做握手解密（tls.Server 内部监听 'connection'）
    tlsServer.emit('connection', clientSocket);
  });

  proxyServer.listen(port, host, () => {
    log.info(`抓包代理已启动：http://${host}:${port} （CA: ${CA_CRT}）`);
  });
  proxyServer.on('error', (e) => log.error('抓包代理错误：', e.message));
  proxyServer.tlsServer = tlsServer;
  return proxyServer;
}

export function stopMitm() {
  try {
    proxyServer?.httpsInner?.close();
    proxyServer?.close();
    tlsServer?.close();
  } catch {}
  proxyServer = null;
  tlsServer = null;
}

export function mitmStatus() {
  return { running: !!proxyServer, ca: caExists() ? CA_CRT : null };
}
