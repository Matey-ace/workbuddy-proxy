// 上游适配层：OpenAI 请求 <-> WorkBuddy 网页端接口
// 设计目标：字段路径全部可配置（config.json / 环境变量），上游改版时不用改代码。
import fs from 'node:fs';
import path from 'node:path';
import { UPSTREAM, AUTH, SERVER, DATA_DIR } from './config.js';
import log from './logger.js';
import * as auth from './auth.js';

export class UpstreamError extends Error {
  constructor(message, { status = 502, auth = false, retryable = false, detail = '' } = {}) {
    super(message);
    this.status = status;
    this.auth = auth;
    this.retryable = retryable;
    this.detail = detail;
  }
}

// ---------- 通用工具 ----------
function getPath(obj, p) {
  if (!p) return undefined;
  const parts = String(p)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const k of parts) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

const MOCK_TEXT = process.env.WB_MOCK_TEXT || '';

// ---------- 上游 ----------
function convIdFile() {
  return path.join(DATA_DIR, 'conversation-map.json');
}
const convMap = (() => {
  try {
    if (fs.existsSync(convIdFile())) return JSON.parse(fs.readFileSync(convIdFile(), 'utf8'));
  } catch {}
  return {};
})();
function saveConvMap() {
  try {
    fs.writeFileSync(convIdFile(), JSON.stringify(convMap, null, 2), 'utf8');
  } catch (e) {
    log.warn('会话映射保存失败：', e.message);
  }
}
export function getConvId(key) {
  return convMap[key];
}
export function setConvId(key, id) {
  convMap[key] = id;
  saveConvMap();
}

function buildHeaders(creds, extra = {}) {
  const h = {
    Accept: 'text/event-stream, application/json, */*',
    'Content-Type': 'application/json',
    'User-Agent': UPSTREAM.ua,
    Origin: UPSTREAM.origin,
    Referer: UPSTREAM.referer,
    ...AUTH.extraHeaders,
    ...extra,
  };
  if (creds?.bearer) h.Authorization = `Bearer ${creds.bearer}`;
  if (creds?.cookie) h.Cookie = creds.cookie;
  return h;
}

function url(p) {
  return UPSTREAM.base.replace(/\/+$/, '') + (p.startsWith('/') ? p : '/' + p);
}

// 检测登录失效
function looksLoggedOut(status, text) {
  if (status === 401 || status === 403) return true;
  const head = String(text || '').slice(0, 400).toLowerCase();
  return /登录已失效|请先登录|登录超时|sign in to continue|unauthorized|token expired/.test(head);
}

async function rawFetch(u, init, timeoutMs = SERVER.timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(u, { ...init, signal: ac.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 请求体构造 ----------
export function toUpstreamBody(req, { convId, stream }) {
  const messages = req.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(''),
  }));
  const body = {
    model: req.model || UPSTREAM.defaultModel,
    messages,
    stream: !!stream,
    temperature: req.temperature ?? undefined,
    top_p: req.top_p ?? undefined,
    max_tokens: req.max_tokens ?? undefined,
  };
  if (convId) body.conversation_id = convId;
  if (UPSTREAM.convIdKey && UPSTREAM.convIdKey !== 'conversation_id' && convId) {
    body[UPSTREAM.convIdKey] = convId;
    delete body.conversation_id;
  }
  // 工具定义走提示词注入（网页端通常不支持 function calling 协议）
  const sys = injectTools(messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n'), req.tools);
  if (sys) {
    const others = messages.filter((m) => m.role !== 'system');
    body.messages = [{ role: 'system', content: sys }, ...others];
  }
  return body;
}

const TOOL_PROTOCOL = `
你可以使用下列工具。需要调用工具时，**只输出**如下格式的一段 JSON（可多段，逐段输出，不要附加其他文字）：
\`\`\`json
{"tool_calls":[{"id":"call_<序号>","type":"function","function":{"name":"<工具名>","arguments":<参数对象>}}]}
\`\`\`
工具定义：
`;

export function injectTools(systemText, tools) {
  if (!Array.isArray(tools) || tools.length === 0) return systemText || '';
  const desc = tools
    .map((t) => (t.type === 'function' || !t.type ? t.function || t : t))
    .map((f) => `- ${f.name}: ${f.description || ''}\n  参数 schema: ${JSON.stringify(f.parameters || {})}`)
    .join('\n');
  return `${systemText || ''}\n${TOOL_PROTOCOL}${desc}`;
}

// ---------- 响应解析 ----------
// 自动嗅探常见增量字段；也可用 WB_DELTA 等环境变量强制指定。
const CANDIDATES = {
  delta: [
    UPSTREAM.deltaPath,
    'choices.0.delta.content',
    'delta.text',
    'content',
    'text',
    'data.text',
    'v',
    'message.content',
    'choices.0.text',
  ],
  reasoning: [UPSTREAM.reasoningPath, 'choices.0.delta.reasoning_content', 'reasoning_content', 'reasoning', 'choices.0.delta.reasoning'],
  finish: [UPSTREAM.finishPath, 'choices.0.finish_reason', 'finish_reason'],
  usage: [UPSTREAM.usagePath, 'usage', 'data.usage'],
  error: [UPSTREAM.errorPath, 'error.message', 'error', 'message'],
  convId: [UPSTREAM.convIdRespPath, 'conversation_id', 'data.conversation_id', 'id'],
};

function firstDefined(obj, paths) {
  for (const p of paths) {
    if (!p) continue;
    const v = getPath(obj, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// 从一条 SSE data: 载荷中抽取事件
function parseEvent(payload) {
  let obj = payload;
  if (typeof payload === 'string') {
    try {
      obj = JSON.parse(payload);
    } catch {
      return { type: 'text', text: payload };
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  if (obj.type === 'ping' || obj.type === 'heartbeat') return null;

  const err = firstDefined(obj, CANDIDATES.error);
  if (typeof err === 'string' && /error|错误|fail|invalid|过载|限流/i.test(obj.error?.code || err) && obj.error) {
    return { type: 'error', text: typeof err === 'string' ? err : JSON.stringify(err) };
  }
  if (obj.error) return { type: 'error', text: typeof obj.error === 'string' ? obj.error : obj.error.message || JSON.stringify(obj.error) };

  const out = [];
  const convId = firstDefined(obj, CANDIDATES.convId);
  if (convId && typeof convId === 'string') out.push({ type: 'conv', id: convId });

  const reasoning = firstDefined(obj, CANDIDATES.reasoning);
  if (typeof reasoning === 'string') out.push({ type: 'reasoning', text: reasoning });

  const delta = firstDefined(obj, CANDIDATES.delta);
  if (typeof delta === 'string') out.push({ type: 'text', text: delta });
  else if (Array.isArray(delta)) {
    for (const d of delta) if (d?.type === 'text' && d.text) out.push({ type: 'text', text: d.text });
  }

  const finish = firstDefined(obj, CANDIDATES.finish);
  if (finish) out.push({ type: 'finish', reason: finish });

  const usage = firstDefined(obj, CANDIDATES.usage);
  if (usage && typeof usage === 'object') out.push({ type: 'usage', usage });

  // [DONE] 或显式 done
  if (obj.done === true || obj.data === '[DONE]') out.push({ type: 'finish', reason: 'stop' });
  return out.length ? out : null;
}

// SSE 字节流 → 事件行
async function* sseLines(body) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  if (buf.trim()) yield buf;
}

/**
 * 调用上游，产出统一事件：
 *   {type:'text'|'reasoning', text}
 *   {type:'finish', reason}
 *   {type:'usage', usage}
 *   {type:'conv', id}
 */
export async function* streamChat(req, { convId, signal, attempt = 0 } = {}) {
  if (auth.getAll().length === 0) {
    throw new UpstreamError('未配置凭证，请在管理台粘贴 WorkBuddy Cookie', { status: 401, auth: true });
  }
  const creds = auth.current();
  const body = toUpstreamBody(req, { convId, stream: true });
  const u = url(UPSTREAM.chatPath);
  log.info(`→ 上游 ${u} model=${body.model} conv=${convId || 'new'}`);

  let res;
  try {
    res = await rawFetch(u, { method: 'POST', headers: buildHeaders(creds), body: JSON.stringify(body) }, SERVER.timeoutMs);
  } catch (e) {
    throw new UpstreamError('连接上游失败: ' + e.message, { status: 502, retryable: true });
  }

  if (!res.ok || looksLoggedOut(res.status, '')) {
    const txt = await res.text().catch(() => '');
    if (looksLoggedOut(res.status, txt)) {
      auth.markFail(creds.id, txt);
      const next = auth.rotate();
      if (next && next.id !== creds.id && attempt < 3) {
        yield* streamChat(req, { convId, signal, attempt: attempt + 1 });
        return;
      }
      throw new UpstreamError('WorkBuddy 登录态失效，请更新 Cookie', { status: 401, auth: true, detail: txt.slice(0, 300) });
    }
    throw new UpstreamError(`上游返回 ${res.status}`, { status: res.status === 429 ? 429 : 502, retryable: res.status >= 500 || res.status === 429, detail: txt.slice(0, 500) });
  }

  const ctype = res.headers.get('content-type') || '';
  if (!res.body) throw new UpstreamError('上游无响应体', { status: 502 });

  if (ctype.includes('text/event-stream') || UPSTREAM.responseMode === 'sse') {
    let eventName = '';
    for await (const line of sseLines(res.body)) {
      if (signal?.aborted) return;
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (!line.startsWith('data:')) continue;
      let payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        yield { type: 'finish', reason: 'stop' };
        return;
      }
      if (payload.startsWith('{') && !payload.endsWith('}')) {
        // 多行 JSON：继续读到空行为止由外层保证，这里尽力容错
      }
      const evts = parseEvent(payload);
      if (!evts) continue;
      for (const e of evts) {
        if (e.type === 'error' && eventName === 'error') throw new UpstreamError(e.text, { status: 502 });
        yield e;
        if (e.type === 'finish') return;
      }
    }
    yield { type: 'finish', reason: 'stop' };
    return;
  }

  // 非流式 JSON
  const text = await res.text();
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new UpstreamError('上游返回非 JSON', { status: 502, detail: text.slice(0, 300) });
  }
  const evts = parseEvent(obj) || [];
  for (const e of evts) yield e;
  if (!evts.some((e) => e.type === 'finish')) yield { type: 'finish', reason: 'stop' };
}

// 新建会话（可选能力，失败不影响主流程）
export async function createConversation(title = 'API Session') {
  const creds = auth.current();
  if (!creds?.cookie && !creds?.bearer) return null;
  try {
    const res = await rawFetch(url(UPSTREAM.newConvPath), {
      method: 'POST',
      headers: buildHeaders(creds),
      body: JSON.stringify({ title }),
    }, 20000);
    if (!res.ok) return null;
    const j = await res.json();
    return j.id || j.conversation_id || j.data?.id || null;
  } catch (e) {
    log.debug('创建会话失败：', e.message);
    return null;
  }
}

export async function fetchQuota() {
  const creds = auth.current();
  if (!creds?.cookie && !creds?.bearer) return { ok: false, error: '未配置凭证' };
  try {
    const res = await rawFetch(url(UPSTREAM.quotaPath), { method: 'GET', headers: buildHeaders(creds) }, 20000);
    const txt = await res.text();
    let j = null;
    try {
      j = JSON.parse(txt);
    } catch {}
    return { ok: res.ok, status: res.status, data: j, raw: txt.slice(0, 2000), loggedOut: looksLoggedOut(res.status, txt) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function fetchUpstreamModels() {
  const creds = auth.current();
  if (!creds?.cookie && !creds?.bearer) return null;
  try {
    const res = await rawFetch(url(UPSTREAM.modelsPath), { method: 'GET', headers: buildHeaders(creds) }, 20000);
    if (!res.ok) return null;
    const j = await res.json();
    const arr = Array.isArray(j) ? j : j.data || j.models || [];
    return arr.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  } catch {
    return null;
  }
}

// ---------- 健康检查 / 自测 ----------
export async function probe({ probeMessage = 'ping', probeModel } = {}) {
  const started = Date.now();
  try {
    const req = { model: probeModel || UPSTREAM.defaultModel, messages: [{ role: 'user', content: probeMessage }] };
    let text = '';
    let finish = null;
    for await (const e of streamChat(req, {})) {
      if (e.type === 'text') text += e.text;
      if (e.type === 'finish') finish = e.reason;
      if (text.length > 200) break;
    }
    return { ok: true, latencyMs: Date.now() - started, sample: text.slice(0, 200), finish };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: e.message, status: e.status, auth: !!e.auth };
  }
}
