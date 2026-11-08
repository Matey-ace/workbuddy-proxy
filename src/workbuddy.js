// WorkBuddy 原生上游：直连官方 /v2/chat/completions
// 上游本身就是 OpenAI 兼容 SSE，所以这里是薄转发 —— 不需要伪 function calling。
// 支持两个版本：cn（国内版 www.workbuddy.cn）和 ai（国际版 www.workbuddy.ai）
// 参考 dsh-connect-workbuddy 5.20.2：PRODUCT_UA / v3/config / modelPromotions / 多账号池
import { randomUUID } from 'node:crypto';
import { resolveTokens } from './creddecrypt.js';
import log from './logger.js';

export const CN_BASE = process.env.WB_CN_CHAT_BASE || 'https://copilot.tencent.com';
export const GLOBAL_BASE = process.env.WB_GLOBAL_CHAT_BASE || 'https://www.workbuddy.ai';
export const CN_BILLING = process.env.WB_CN_BILLING_BASE || 'https://www.codebuddy.cn';
export const GLOBAL_BILLING = process.env.WB_GLOBAL_BILLING_BASE || 'https://www.workbuddy.ai';

// 5.8.3 桌面 App 的正式 UA（app 版本两次 + CLI 版本一次）
export const PRODUCT_UA = process.env.WB_PRODUCT_UA || 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0';
export const CLIENT_UA = process.env.WB_CLIENT_UA || 'CLI/2.63.2 CodeBuddy/2.63.2';
const APP_VERSION = { cn: process.env.WB_APP_VERSION || '5.8.3', ai: process.env.WB_AI_APP_VERSION || '5.8.3' };
const CACHE_TTL = 5 * 60 * 1000;

// 每个版本一份缓存
const caches = { cn: { at: 0, tokens: null }, ai: { at: 0, tokens: null } };

export function regionOf(domain) {
  return /workbuddy\.ai$/i.test(String(domain || '')) ? 'global' : 'cn';
}
/** region 名 -> 本地 App 版本（product）。ai 指国际版桌面 App */
export function productOfRegion(region) {
  const r = String(region || '').toLowerCase();
  return r === 'global' || r === 'ai' ? 'ai' : 'cn';
}
export function chatBase(domain) {
  return regionOf(domain) === 'global' ? GLOBAL_BASE : CN_BASE;
}
export function billingBase(domain) {
  return regionOf(domain) === 'global' ? GLOBAL_BILLING : CN_BILLING;
}

/** 国际版不支持非流式，非流式请求统一由调用方聚合 SSE 实现 */
export function supportsNonStream(region) {
  return productOfRegion(region) === 'cn';
}

/** 从本机 WorkBuddy 解出 token（带缓存）。region: 'cn' | 'global' */
export async function getCredentials(region = 'cn', force = false) {
  const product = productOfRegion(region);
  const c = caches[product];
  if (!force && c.tokens && Date.now() - c.at < CACHE_TTL) return c.tokens;
  const r = await resolveTokens(product);
  if (!r.ok) return { ok: false, error: r.error, region, product };
  const tokens = { ...r, region, enterpriseId: r.enterpriseId || '' };
  caches[product] = { at: Date.now(), tokens };
  log.info(
    `WorkBuddy 凭据已就绪（${region}）：${r.domain}（token ${r.accessToken.length}B，${r.expiresAt ? new Date(r.expiresAt).toLocaleString() : '-'} 过期）`
  );
  return tokens;
}

export function cachedCredentials(region = 'cn') {
  return caches[productOfRegion(region)].tokens;
}

export function appVersion(region) {
  return APP_VERSION[productOfRegion(region)];
}

function baseHeaders(cred, { conversation = false, productConfig = false } = {}) {
  const billing = billingBase(cred.domain);
  const v = appVersion(cred.region);
  const h = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: billing,
    Referer: billing + '/',
    // /v3/config 按 UA 分渠道：必须用 App 自身的 PRODUCT_UA 才拿得到 app 渠道目录
    'User-Agent': productConfig ? PRODUCT_UA : CLIENT_UA,
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + cred.accessToken,
    'X-User-Id': cred.uid || '',
    'X-No-Enterprise-Id': '1',
    'X-Domain': cred.domain || '',
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': v,
    'X-Product': 'SaaS',
  };
  if (!cred.uid) {
    delete h['X-User-Id'];
    h['X-No-User-Id'] = '1';
  }
  if (!cred.domain) {
    delete h['X-Domain'];
    h['X-No-Department-Info'] = '1';
  }
  if (conversation) {
    const reqId = randomUUID();
    h['X-Conversation-ID'] = randomUUID();
    h['X-Conversation-Request-ID'] = reqId;
    h['X-Conversation-Message-ID'] = randomUUID();
  }
  return h;
}

/**
 * 国际版的额外约束：
 *  1. 只支持 stream:true（非流式返回 code 11101）
 *  2. 首条消息必须是 system prompt（否则 code 11128）
 * 这里统一规整请求体，避免每个调用方各写一遍。
 */
export function prepareBody(body, region) {
  const out = { ...body };
  // 国际版约束：只支持 stream:true，且首条必须是 system prompt
  if (productOfRegion(region) === 'ai') {
    out.stream = true;
    const msgs = Array.isArray(out.messages) ? out.messages : [];
    if (!msgs.length || msgs[0].role !== 'system') {
      out.messages = [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }, ...msgs];
    }
  }
  return out;
}

export const DEFAULT_SYSTEM_PROMPT = process.env.WB_AI_SYSTEM_PROMPT || 'You are a helpful assistant.';

/**
 * 调用 WorkBuddy 对话接口，返回原始 Response（SSE）。
 * body 已是 OpenAI 格式，直接透传。
 */
export async function chatCompletions(body, { signal, retryOnAuth = true, region = 'cn' } = {}) {
  const cred = await getCredentials(region);
  if (!cred.ok) {
    const e = new Error('WorkBuddy 凭据不可用：' + cred.error);
    e.status = 401;
    e.auth = true;
    throw e;
  }
  const payload = prepareBody(body, region);
  const url = `${chatBase(cred.domain)}/v2/chat/completions`;
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: baseHeaders(cred, { conversation: true }), body: JSON.stringify(payload), signal });
  } catch (e) {
    const err = new Error('连接 WorkBuddy 失败：' + e.message);
    err.status = 502;
    throw err;
  }

  if ((res.status === 401 || res.status === 403) && retryOnAuth) {
    log.warn(`WorkBuddy(${region}) 返回 ${res.status}，尝试刷新凭据后重试`);
    caches[productOfRegion(region)] = { at: 0, tokens: null };
    await getCredentials(region, true);
    return chatCompletions(body, { signal, retryOnAuth: false, region });
  }
  return res;
}

/** 刷新 token（用 refreshToken） */
export async function refreshAccessToken(region = 'cn') {
  const found = await getCredentials(region);
  if (!found.ok || !found.refreshToken) return { ok: false, error: '缺少 refreshToken' };
  const url = `${chatBase(found.domain)}/v2/plugin/auth/token/refresh`;
  const h = baseHeaders(found);
  delete h['Content-Type'];
  h['X-Refresh-Token'] = found.refreshToken;
  h['X-Auth-Refresh-Source'] = 'workbuddy';
  try {
    const res = await fetch(url, { method: 'POST', headers: h });
    const j = await res.json();
    if (!res.ok || j.code !== 0) return { ok: false, error: `refresh ${res.status}: ${JSON.stringify(j).slice(0, 200)}` };
    caches[productOfRegion(region)] = { at: 0, tokens: null };
    return { ok: true, accessToken: j.data?.accessToken, expiresIn: j.data?.expiresIn };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 容错的 JSON 读取（上游偶尔返回多余内容）
async function readJsonSafe(res) {
  const txt = await res.text();
  try {
    return { json: JSON.parse(txt), raw: txt };
  } catch {
    const i = txt.indexOf('{');
    if (i >= 0) {
      let depth = 0;
      for (let k = i; k < txt.length; k++) {
        if (txt[k] === '{') depth++;
        else if (txt[k] === '}') {
          depth--;
          if (depth === 0) {
            try {
              return { json: JSON.parse(txt.slice(i, k + 1)), raw: txt };
            } catch {
              break;
            }
          }
        }
      }
    }
    return { json: null, raw: txt };
  }
}

/** 余额 / 积分（含每日签到等福利状态，只读） */
export async function getUserResource(region = 'cn') {
  const cred = await getCredentials(region);
  if (!cred.ok) return { ok: false, error: cred.error };
  const base = billingBase(cred.domain);
  const H = baseHeaders(cred);
  const out = { ok: false, region };

  // 主余额：官方客户端用 POST + 固定查询体（GET 会 404）
  const fmt = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const now = new Date();
  const body = JSON.stringify({
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 3185136e6)),
  });
  try {
    const res = await fetch(`${base}/v2/billing/meter/get-user-resource`, { method: 'POST', headers: H, body });
    const { json: j, raw } = await readJsonSafe(res);
    if (res.ok && j !== null) {
      out.ok = true;
      out.status = res.status;
      out.data = j;
      out.raw = raw.slice(0, 800);
    } else {
      out.lastError = `get-user-resource ${res.status}`;
    }
  } catch (e) {
    out.lastError = e.message;
  }

  // 福利状态（签到礼包 / 补偿），无 /v2 前缀，POST + 空对象体
  out.benefits = [];
  for (const [kind, path] of [['gift', '/billing/meter/check-gift-claimed'], ['compensation', '/billing/meter/compensation-status']]) {
    try {
      const res = await fetch(base + path, { method: 'POST', headers: H, body: '{}' });
      const { json: j } = await readJsonSafe(res);
      if (j && j.code === 0) out.benefits.push({ kind, data: j.data ?? j });
      else out.benefits.push({ kind, status: res.status, code: j?.code });
    } catch (e) {
      out.benefits.push({ kind, error: e.message });
    }
  }

  // 模型倍率（来自 /v3/config，一次请求，缓存到调用方）
  try {
    const res = await fetch(`${base}/v3/config`, { headers: baseHeaders(cred, { productConfig: true }) });
    const { json: j } = await readJsonSafe(res);
    const d = j?.data ?? j;
    if (Array.isArray(d?.models)) {
      const clean = (v) => {
        const m = String(v || '').match(/x\d+(?:\.\d+)?/i);
        return m ? m[0] : '';
      };
      out.credits = Object.fromEntries(d.models.filter((m) => m.id && m.credits).map((m) => [m.id, clean(m.credits)]));
      out.promotions = (d.modelPromotions || []).filter((p) => p.enabled !== false).map((p) => ({ id: p.id, label: p.badge?.label || '', modelIds: p.modelIds || [] }));
    }
  } catch {}

  return out;
}

// 国际版 /v3/config 实测目录（5.8.x），仅在接口不可用时兜底
const FALLBACK_GLOBAL_MODELS = [
  'default-model',
  'max-model',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'hy4free',
  'hy4std',
  'hy3',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'minimax-m3.1-flash',
  'kimi-k3-1',
  'step-5-preview',
  'space-bunny',
  'lite',
];

/**
 * 模型目录（5.20.2 对齐）：优先 /v3/config（App 渠道，61 个模型 + 倍率 + 促销），
 * 失败降级 /console/enterprises/personal/models（CLI 渠道），再失败用内置兜底。
 * 返回 ids 及每个模型的 credits / 能力 / 促销 badge，供管理台展示。
 */
export async function listModels(region = 'cn') {
  const cred = await getCredentials(region);
  if (!cred.ok) return { ok: false, error: cred.error, ids: [], models: [], promotions: [] };
  const base = billingBase(cred.domain);

  // --- 主路径 /v3/config ---
  try {
    const res = await fetch(`${base}/v3/config`, { headers: baseHeaders(cred, { productConfig: true }) });
    const { json: j } = await readJsonSafe(res);
    const d = j?.data ?? j;
    if (res.ok && Array.isArray(d?.models) && d.models.length) {
      // cli agent 的可用名单（与 App 选择器一致）
      const cli = (d.agents || []).find((a) => a.name === 'cli' || a.description === 'cli agent') || (d.agents || [])[0];
      const allowed = Array.isArray(cli?.models) && cli.models.length ? new Set(cli.models) : null;
      const all = d.models.map((m) => {
        // credits 可能是 "x0.15" 也可能是带说明的文字，只保留倍率部分
        const raw = String(m.credits || '');
        const cm = raw.match(/x\d+(?:\.\d+)?/i);
        return {
          id: m.id || m.name,
          name: m.name || m.id,
          description: m.descriptionZh || m.descriptionEn || '',
          credits: cm ? cm[0] : raw,
          maxInputTokens: m.maxInputTokens || null,
          maxOutputTokens: m.maxOutputTokens || null,
          supportsImages: !!m.supportsImages,
          supportsToolCall: !!m.supportsToolCall,
          supportsReasoning: !!m.supportsReasoning,
        };
      }).filter((m) => m.id);
      const models = allowed ? all.filter((m) => allowed.has(m.id)) : all;
      // 促销徽章
      const promotions = (d.modelPromotions || []).filter((p) => p.enabled !== false).map((p) => ({
        id: p.id,
        label: p.badge?.label || p.badge?.labelZh || '',
        modelIds: p.modelIds || [],
        discount: p.discount ?? null,
      }));
      return { ok: true, status: res.status, source: 'v3/config', ids: models.map((m) => m.id), models, promotions };
    }
  } catch (e) {
    log.debug(`/v3/config 失败（${region}）：${e.message}`);
  }

  // --- 降级：CLI 渠道旧接口 ---
  try {
    const url = `${base}/console/enterprises/${cred.enterpriseId || 'personal'}/models`;
    const h = baseHeaders(cred);
    h['X-Request-ID'] = randomUUID();
    const res = await fetch(url, { headers: h });
    const { json: j } = await readJsonSafe(res);
    const d = j?.data ?? j;
    const all = Array.isArray(d?.models) ? d.models.map((m) => ({ id: m.id || m.name, name: m.name || m.id, credits: m.credits || '' })).filter((m) => m.id) : [];
    const cliAgent = (d?.agents || []).find((a) => a.name === 'cli');
    const cli = Array.isArray(cliAgent?.models) ? cliAgent.models : [];
    const models = cli.length ? all.filter((m) => cli.includes(m.id)) : all;
    if (models.length) return { ok: true, status: res.status, source: 'console/enterprises', ids: models.map((m) => m.id), models, promotions: [] };
  } catch (e) {
    log.debug(`旧模型接口失败（${region}）：${e.message}`);
  }

  // --- 兜底 ---
  const ids = regionOf(cred.domain) === 'global' ? FALLBACK_GLOBAL_MODELS : FALLBACK_CN_MODELS;
  return { ok: true, source: 'fallback', ids, models: ids.map((id) => ({ id, name: id })), promotions: [] };
}

const FALLBACK_CN_MODELS = ['auto', 'hy4free', 'hy4std', 'hy3', 'hy3-x', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'space-bunny', 'minimax-m3.1-flash', 'kimi-k3.1-pro', 'kimi-k3-1', 'kimi-k2.8-preview', 'deepseek-v4-pro', 'step-5-preview', 'mimo-v2.6-pro'];
