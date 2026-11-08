// WorkBuddy → 通用 Agent API 反向代理：入口
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { SERVER, UPSTREAM, PUBLIC_DIR, DATA_DIR, AUTH, runtimePaths } from './config.js';
import log from './logger.js';
import * as auth from './auth.js';
import * as models from './models.js';
import * as upstream from './upstream.js';
import * as mitm from './mitm.js';
import * as localdiscover from './localdiscover.js';
import * as wb from './workbuddy.js';
import * as reqlog from './reqlog.js';
import { Stats } from './stats.js';
import { Limiter } from './queue.js';
import { handleChatCompletions, json } from './openai.js';
import { handleMessages } from './anthropic.js';
import { handleOllamaChat, handleOllamaGenerate, handleOllamaTags, handleOllamaVersion } from './ollama.js';

const limiter = new Limiter(SERVER.maxConcurrency);
Stats.queue = limiter.stats;

auth.loadAccounts();
models.load();

// 启动时尝试用本机 WorkBuddy 凭据（原生直连），并自动同步真实模型目录
(async () => {
  try {
    const region = (process.env.WB_REGION || 'cn').toLowerCase();
    const useAI = region === 'ai' || region === 'global';
    // 即使指定了某个版本，也把两个都试一遍并记录状态
    for (const r of ['cn', 'global']) {
      const cred = await wb.getCredentials(r);
      if (cred.ok) log.info(`原生上游就绪（${r}）：${wb.chatBase(cred.domain)}/v2/chat/completions`);
      else log.warn(`原生上游不可用（${r}）：${cred.error}`);
    }
    const active = useAI ? 'global' : 'cn';
    if ((process.env.WB_UPSTREAM_MODE || 'auto') === 'web') return;
    const m = await wb.listModels(active);
    if (m.ok && m.ids?.length) {
      models.setModels(m.ids, 'upstream');
      log.info(`已同步 ${m.ids.length} 个模型（${active}）：${m.ids.slice(0, 6).join(', ')}${m.ids.length > 6 ? ' …' : ''}`);
    }
  } catch (e) {
    log.warn('原生凭据加载异常：' + e.message);
  }
})();

// 启动时尝试拉取上游模型清单
(async () => {
  const ids = await upstream.fetchUpstreamModels();
  if (ids?.length) models.setModels(ids);
})();

const sessions = new Map(); // 简易会话：token -> {exp}
function issueToken() {
  const t = Buffer.from(`${Date.now()}-${Math.random()}`).toString('base64url');
  sessions.set(t, Date.now() + 3600_000);
  return t;
}
function adminOk(req) {
  // 默认无口令：只监听本机时管理台直接可用
  if (!SERVER.adminPassword) return true;
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (validToken(t)) return true;
  // 也接受直接用 API Key 访问管理端
  return !!SERVER.apiKey && (req.headers['x-api-key'] === SERVER.apiKey || t === SERVER.apiKey);
}

function validToken(t) {
  const exp = sessions.get(t);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(t);
    return false;
  }
  return true;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', SERVER.corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,x-api-key,anthropic-version');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function authorized(req) {
  if (!SERVER.apiKey) return true;
  const hdr = req.headers.authorization || '';
  const key = hdr.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-key'] || '';
  return key === SERVER.apiKey;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pem': 'application/x-pem-file',
  '.crt': 'application/x-x509-ca-cert',
};

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    // ---------- 静态资源 / 管理台 ----------
    if (p === '/' || p === '/index.html' || p === '/admin') return serveStatic(res, 'index.html');
    if (p.startsWith('/assets/') || /\.(js|css|svg|ico|png)$/.test(p)) return serveStatic(res, p.replace(/^\/+/, ''));

    // ---------- 管理 API ----------
    // 兼容旧的登录端点：未设口令时直接放行
    if (p === '/api/admin/login' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      if (!SERVER.adminPassword || b.password === SERVER.adminPassword) {
        return json(res, 200, { token: issueToken(), required: !!SERVER.adminPassword });
      }
      return json(res, 401, { error: '口令错误' });
    }
    if (p.startsWith('/api/')) {
      // Ollama 公共路由优先（避免被管理端命名空间吃掉）
      if (p === '/api/chat' && req.method === 'POST') {
        if (!authorized(req)) return json(res, 401, { error: 'API Key 无效' });
        const b = await readBody(req);
        return handleOllamaChat(req, res, b, { limiter });
      }
      if (p === '/api/generate' && req.method === 'POST') {
        if (!authorized(req)) return json(res, 401, { error: 'API Key 无效' });
        const b = await readBody(req);
        return handleOllamaGenerate(req, res, b, { limiter });
      }
      if (p === '/api/tags') return handleOllamaTags(res);
      if (p === '/api/version') return handleOllamaVersion(res);

      // 仅在显式设置 ADMIN_PASSWORD 时才需要鉴权
      if (SERVER.adminPassword && !adminOk(req)) return json(res, 401, { error: '需要口令（ADMIN_PASSWORD）' });
      return handleAdminApi(req, res, p, url);
    }

    // ---------- 健康检查（不需要鉴权）----------
    if (p === '/health' || p === '/healthz') {
      return json(res, 200, { ok: true, accounts: auth.getAll().length, queue: limiter.stats, uptimeMs: Date.now() - Stats.snapshot().startedAt });
    }

    // ---------- 对外 API（需要 API_KEY）----------
    if (!authorized(req)) {
      return json(res, 401, { error: { message: 'API Key 无效', type: 'authentication_error' } });
    }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      const b = await readBody(req);
      return handleChatCompletions(req, res, b, { limiter });
    }
    if ((p === '/v1/messages' || p === '/anthropic/v1/messages') && req.method === 'POST') {
      const b = await readBody(req);
      return handleMessages(req, res, b, { limiter });
    }
    if (p === '/v1/models' || p === '/v1/list' || p === '/models') {
      return json(res, 200, { object: 'list', data: models.list() });
    }
    if (p === '/v1/completions' && req.method === 'POST') {
      const b = await readBody(req);
      const prompt = typeof b.prompt === 'string' ? b.prompt : Array.isArray(b.prompt) ? b.prompt.join('\n') : '';
      return handleChatCompletions(req, res, { ...b, messages: [{ role: 'user', content: prompt }] }, { limiter });
    }
    return json(res, 404, { error: { message: `未知路由 ${p}`, type: 'not_found' } });
  } catch (e) {
    log.error('请求处理异常：', e.message);
    if (!res.headersSent) return json(res, 400, { error: { message: e.message, type: 'invalid_request_error' } });
    try {
      res.end();
    } catch {}
  }
});

function serveStatic(res, rel) {
  const fp = path.join(PUBLIC_DIR, rel);
  if (!fp.startsWith(PUBLIC_DIR) || !fs.existsSync(fp)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const ext = path.extname(fp);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

// ---------- 管理端 API ----------
async function handleAdminApi(req, res, p, url) {
  const method = req.method;
  const send = (obj, code = 200) => json(res, code, obj);

  if (p === '/api/status' && method === 'GET') {
    const cur = auth.current();
    return send({
      ok: true,
      accounts: auth.getAll().map((a) => ({ id: a.id, enabled: a.enabled, fails: a.fails, weight: a.weight, hasCookie: !!a.cookie, hasBearer: !!a.bearer, lastUsed: a.lastUsed })),
      current: { id: cur.id, cookieLen: cur.cookie?.length || 0, hasBearer: !!cur.bearer },
      stats: Stats.snapshot(),
      queue: limiter.stats,
      models: models.list(),
      modelsSource: models.source(),
      aliases: models.raw().aliases,
      upstream: { base: UPSTREAM.base, chatPath: UPSTREAM.chatPath, responseMode: UPSTREAM.responseMode, defaultModel: UPSTREAM.defaultModel },
      mitm: mitm.mitmStatus(),
      ca: mitm.caExists() ? mitm.caPath() : null,
      configPath: path.join(runtimePaths().ROOT, 'config.json'),
      apiKey: SERVER.apiKey || '',
      endpoints: {
        openai: '/v1/chat/completions',
        anthropic: '/v1/messages',
        ollama: '/api/chat',
        models: '/v1/models',
      },
      host: SERVER.host,
      port: SERVER.port,
    });
  }

  if (p === '/api/config' && method === 'GET') return send({ ...runtimeSnapshot() });
  if (p === '/api/config' && method === 'POST') {
    const b = await readBody(req);
    applyConfig(b);
    return send({ ok: true, ...runtimeSnapshot() });
  }

  if (p === '/api/credentials' && method === 'POST') {
    const b = await readBody(req);
    const cur = auth.saveSingle({ cookie: b.cookie, bearer: b.bearer });
    return send({ ok: true, current: { id: cur.id, cookieLen: cur.cookie?.length || 0, hasBearer: !!cur.bearer } });
  }
  if (p === '/api/accounts' && method === 'POST') {
    const b = await readBody(req);
    const list = Array.isArray(b.accounts) ? b.accounts : [];
    fs.writeFileSync(AUTH.accountsFile, JSON.stringify(list, null, 2), 'utf8');
    auth.loadAccounts();
    return send({ ok: true, count: auth.getAll().length });
  }

  if (p === '/api/models' && method === 'POST') {
    const b = await readBody(req);
    if (Array.isArray(b.models)) models.setModels(b.models, 'manual');
    if (b.aliases) models.setAliases(b.aliases);
    return send({ ok: true, models: models.list(), aliases: models.raw().aliases });
  }
  if (p === '/api/models/refresh' && method === 'POST') {
    const ids = await upstream.fetchUpstreamModels();
    if (ids?.length) models.setModels(ids, 'upstream');
    return send({ ok: !!ids?.length, models: models.list(), source: models.source(), count: ids?.length || 0 });
  }
  if (p === '/api/models/reset' && method === 'POST') {
    models.resetModels();
    return send({ ok: true, models: models.list(), source: models.source() });
  }

  if (p.startsWith('/api/native/')) {
    // status 允许匿名（仅摘要）；其余需管理台口令
    const isStatus = p === '/api/native/status' && method === 'GET';
    if (!isStatus && !adminOk(req)) return send({ error: '需要管理台登录' }, 401);
  }
  // ---------- 调用记录 ----------
  if (p === '/api/requests' && method === 'GET') {
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    const offset = Number(url.searchParams.get('offset')) || 0;
    return send({ items: reqlog.list({ limit, offset }), stats: reqlog.stats() });
  }
  if (p.startsWith('/api/requests/') && method === 'GET') {
    const id = p.slice('/api/requests/'.length);
    const rec = reqlog.get(id);
    return rec ? send(rec) : send({ error: '未找到' }, 404);
  }
  if (p === '/api/requests/clear' && method === 'POST') {
    reqlog.clear();
    return send({ ok: true });
  }

  if (p === '/api/native/status' && method === 'GET') {
    const region = (url.searchParams.get('region') || 'cn').toLowerCase() === 'ai' ? 'global' : 'cn';
    const cred = await wb.getCredentials(region);
    const redacted = !adminOk(req);
    return send({
      ok: cred.ok,
      error: cred.error || null,
      region,
      domain: cred.domain || null,
      base: cred.ok ? wb.chatBase(cred.domain) : null,
      endpoint: cred.ok ? wb.chatBase(cred.domain) + '/v2/chat/completions' : null,
      tokenLen: cred.ok ? cred.accessToken.length : 0,
      expiresAt: cred.expiresAt || null,
      expiresInSec: cred.expiresAt ? Math.round((cred.expiresAt - Date.now()) / 1000) : null,
      hasRefresh: !!cred.refreshToken,
      uid: redacted ? null : cred.uid || null,
      source: cred.source || null,
      mode: process.env.WB_UPSTREAM_MODE || 'auto',
      models: models.list().map((m) => m.id),
    });
  }
  if (p === '/api/native/all' && method === 'GET') {
    // 两个版本都查
    const out = {};
    for (const [region, product] of [['cn', 'cn'], ['ai', 'ai']]) {
      const cred = await wb.getCredentials(region);
      out[region] = {
        ok: cred.ok,
        error: cred.error || null,
        domain: cred.domain || null,
        endpoint: cred.ok ? wb.chatBase(cred.domain) + '/v2/chat/completions' : null,
        expiresInSec: cred.expiresAt ? Math.round((cred.expiresAt - Date.now()) / 1000) : null,
      };
    }
    return send(out);
  }
  if (p === '/api/native/refresh' && method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const region = (b.region || 'cn').toLowerCase() === 'ai' ? 'global' : 'cn';
    return send(await wb.refreshAccessToken(region));
  }
  if (p === '/api/native/balance' && method === 'GET') {
    const region = (url.searchParams.get('region') || 'cn').toLowerCase() === 'ai' ? 'global' : 'cn';
    return send(await wb.getUserResource(region));
  }
  if (p === '/api/native/models' && method === 'GET') {
    const region = (url.searchParams.get('region') || 'cn').toLowerCase() === 'ai' ? 'global' : 'cn';
    const r = await wb.listModels(region);
    if (r.ids?.length) models.setModels(r.ids, 'upstream');
    return send({ ok: r.ok, status: r.status, region, ids: r.ids || [], count: r.ids?.length || 0, source: r.source, models: r.models || [], promotions: r.promotions || [], error: r.error });
  }
  if (p === '/api/native/catalog' && method === 'GET') {
    // 聚合：模型目录 + 倍率 + 促销 + 余额 + 福利，管理台一个请求拿全
    const region = (url.searchParams.get('region') || 'cn').toLowerCase() === 'ai' ? 'global' : 'cn';
    const [m, b] = await Promise.all([wb.listModels(region), wb.getUserResource(region)]);
    const credits = b.credits || {};
    const promoByModel = {};
    for (const pr of m.promotions || []) for (const id of pr.modelIds || []) promoByModel[id] = pr.label || '优惠';
    const rows = (m.models || []).map((x) => ({
      ...x,
      credits: x.credits || credits[x.id] || '',
      promo: promoByModel[x.id] || '',
    }));
    return send({
      region,
      ok: m.ok,
      source: m.source,
      count: rows.length,
      models: rows,
      promotions: m.promotions || [],
      balance: { ok: b.ok, data: b.data, benefits: b.benefits, error: b.lastError },
    });
  }

  if (p === '/api/discover' && method === 'GET') {
    return send(await localdiscover.discover());
  }
  if (p === '/api/discover/adopt' && method === 'POST') {
    // 从本机发现结果里尽力自动填充配置（能填的填，填不了的说明原因）
    const rep = await localdiscover.discover();
    const filled = [];
    if (rep.auth?.domain) {
      const base = `https://${rep.auth.domain}`;
      applyConfig({ upstream: { base, origin: base, referer: base + '/chat' } });
      filled.push('upstream.base=' + base);
    }
    if (rep.account?.nickname) filled.push('account=' + rep.account.nickname);
    return send({ ok: filled.length > 0, filled, report: rep });
  }

  if (p === '/api/quota' && method === 'GET') {
    const q = await upstream.fetchQuota();
    return send(q);
  }
  if (p === '/api/probe' && method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    const r = await upstream.probe({ probeMessage: b.message || 'ping', probeModel: b.model });
    return send(r);
  }

  if (p === '/api/sniff/start' && method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    mitm.startMitm({ port: Number(b.port) || 8899 });
    return send({ ok: true, port: Number(b.port) || 8899 });
  }
  if (p === '/api/sniff/stop' && method === 'POST') {
    mitm.stopMitm();
    return send({ ok: true });
  }
  if (p === '/api/sniff/list' && method === 'GET') return send({ items: mitm.getSniffed() });
  if (p === '/api/sniff/clear' && method === 'POST') {
    mitm.clearSniffed();
    return send({ ok: true });
  }
  if (p === '/api/sniff/adopt' && method === 'POST') {
    const b = await readBody(req);
    const idx = Number(b.index);
    const items = mitm.getSniffed();
    const it = items[idx];
    if (!it) return send({ error: '索引无效' }, 400);
    const cookie = b.cookie || it.cookie || '';
    const bearer = b.bearer || it.headers?.authorization || '';
    auth.saveSingle({ cookie, bearer });
    return send({ ok: true, cookieLen: cookie.length, hasBearer: !!bearer });
  }
  if (p === '/api/ca' && method === 'GET') {
    if (!mitm.caExists()) mitm.generateCA();
    const crt = fs.readFileSync(mitm.caPath());
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="workbuddy-proxy-ca.crt"', 'Content-Length': crt.length });
    return res.end(crt);
  }
  if (p === '/api/logs' && method === 'GET') return send({ items: log.ring().slice(-200) });
  if (p === '/api/stats/reset' && method === 'POST') {
    Stats.reset();
    return send({ ok: true });
  }
  if (p === '/api/concurrency' && method === 'POST') {
    const b = await readBody(req);
    limiter.setMax(Number(b.max) || 8);
    return send({ ok: true, queue: limiter.stats });
  }
  if (p === '/api/relogin' && method === 'POST') {
    await auth.interactiveLogin();
    return send({ ok: true, accounts: auth.getAll().length });
  }

  return send({ error: '未知管理接口 ' + p }, 404);
}

function runtimeSnapshot() {
  const cfgPath = path.join(runtimePaths().ROOT, 'config.json');
  let user = {};
  try {
    if (fs.existsSync(cfgPath)) user = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  return {
    upstream: {
      base: UPSTREAM.base,
      chatPath: UPSTREAM.chatPath,
      newConvPath: UPSTREAM.newConvPath,
      quotaPath: UPSTREAM.quotaPath,
      modelsPath: UPSTREAM.modelsPath,
      origin: UPSTREAM.origin,
      referer: UPSTREAM.referer,
      responseMode: UPSTREAM.responseMode,
      defaultModel: UPSTREAM.defaultModel,
    },
    server: { port: SERVER.port, host: SERVER.host, maxConcurrency: SERVER.maxConcurrency, timeoutMs: SERVER.timeoutMs },
    file: user,
    path: cfgPath,
  };
}

function applyConfig(b) {
  const cfgPath = path.join(runtimePaths().ROOT, 'config.json');
  let cur = {};
  try {
    if (fs.existsSync(cfgPath)) cur = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch {}
  const next = {
    ...cur,
    upstream: { ...(cur.upstream || {}), ...(b.upstream || {}) },
    server: { ...(cur.server || {}), ...(b.server || {}) },
    headers: { ...(cur.headers || {}), ...(b.headers || {}) },
    models: b.models !== undefined ? b.models : cur.models,
    aliases: b.aliases !== undefined ? b.aliases : cur.aliases,
    deltaPath: b.deltaPath ?? cur.deltaPath,
    reasoningPath: b.reasoningPath ?? cur.reasoningPath,
    finishPath: b.finishPath ?? cur.finishPath,
    usagePath: b.usagePath ?? cur.usagePath,
    errorPath: b.errorPath ?? cur.errorPath,
    convIdKey: b.convIdKey ?? cur.convIdKey,
    convIdRespPath: b.convIdRespPath ?? cur.convIdRespPath,
  };
  Object.assign(UPSTREAM, next.upstream);
  if (next.headers) Object.assign(AUTH.extraHeaders, next.headers);
  if (Array.isArray(next.models)) models.setModels(next.models);
  if (next.aliases) models.setAliases(next.aliases);
  Object.assign(UPSTREAM, {
    deltaPath: next.deltaPath,
    reasoningPath: next.reasoningPath,
    finishPath: next.finishPath,
    usagePath: next.usagePath,
    errorPath: next.errorPath,
    convIdKey: next.convIdKey,
    convIdRespPath: next.convIdRespPath,
  });
  fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2), 'utf8');
  log.info('配置已更新并写入 config.json（部分项需重启完全生效）');
}

server.listen(SERVER.port, SERVER.host, () => {
  log.info(`WorkBuddy 反代已启动 → http://${SERVER.host}:${SERVER.port}`);
  log.info(`OpenAI  : POST http://${SERVER.host}:${SERVER.port}/v1/chat/completions`);
  log.info(`Claude  : POST http://${SERVER.host}:${SERVER.port}/v1/messages`);
  log.info(`Ollama  : POST http://${SERVER.host}:${SERVER.port}/api/chat`);
  log.info(`管理台  : http://${SERVER.host}:${SERVER.port}/`);
  if (!auth.getAll().length) log.warn('尚未配置凭证：打开管理台粘贴 Cookie，或用抓包代理自动抓取');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info('退出中…');
    Stats.save();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
