// 集中配置。所有值都可以用同名环境变量覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 允许用 WB_DATA_DIR 指向独立目录（测试隔离，避免污染真实缓存）
export const DATA_DIR = process.env.WB_DATA_DIR ? path.resolve(process.env.WB_DATA_DIR) : path.join(ROOT, 'data');
export const CERT_DIR = path.join(ROOT, 'certs');
export const PUBLIC_DIR = path.join(ROOT, 'public');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CERT_DIR, { recursive: true });

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function envInt(name, fallback) {
  const n = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(n) ? n : fallback;
}
function envBool(name, fallback) {
  const v = env(name, '');
  if (v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

// ---- WorkBuddy 上游（默认占位，请在 config.json 或环境变量里改成真实值）----
export const UPSTREAM = {
  base: env('WB_BASE', 'https://www.[WORK_BUDDY_HOST]'),
  // 网页端聊天用的接口路径，用 {conversationId} 占位
  chatPath: env('WB_CHAT_PATH', '/api/chat'),
  // 新建会话
  newConvPath: env('WB_NEW_CONV_PATH', '/api/conversations'),
  // 额度/账户信息（可选，用于 /api/quota）
  quotaPath: env('WB_QUOTA_PATH', '/api/user/quota'),
  // 模型列表（可选）
  modelsPath: env('WB_MODELS_PATH', '/api/models'),
  // 上游要求的 Origin / Referer
  origin: env('WB_ORIGIN', 'https://www.[WORK_BUDDY_HOST]'),
  referer: env('WB_REFERER', 'https://www.[WORK_BUDDY_HOST]/chat'),
  // 抓取响应时用的协议：sse | json
  responseMode: env('WB_RESPONSE_MODE', 'sse'),
  ua: env('WB_UA', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'),
  defaultModel: env('WB_DEFAULT_MODEL', 'workbuddy-default'),
  convIdKey: env('WB_CONV_KEY', 'conversation_id'),
  // 响应字段路径（自动嗅探失败时用 config.json 覆盖）
  deltaPath: env('WB_DELTA', ''),
  reasoningPath: env('WB_REASONING', ''),
  finishPath: env('WB_FINISH', ''),
  usagePath: env('WB_USAGE', ''),
  errorPath: env('WB_ERROR', ''),
  convIdRespPath: env('WB_CONV_RESP', ''),
};

// config.json 里的 upstream 段合并进来（环境变量优先）
(function mergeUserUpstream() {
  try {
    const p = path.join(ROOT, 'config.json');
    if (!fs.existsSync(p)) return;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j.upstream) {
      for (const [k, v] of Object.entries(j.upstream)) {
        if (process.env['WB_' + k.toUpperCase()] === undefined) UPSTREAM[k] = v;
      }
    }
    if (j.aliases) process.env.WB_MODEL_ALIAS = JSON.stringify(j.aliases);
  } catch {}
})();

export const SERVER = {
  port: envInt('PORT', 8787),
  host: env('HOST', '127.0.0.1'),
  // 对外 API 的访问密钥；留空=不鉴权
  apiKey: env('API_KEY', 'sk-workbuddy-local'),
  // 管理台口令：默认关闭。仅当设了 ADMIN_PASSWORD 且 HOST 非本机时才建议启用
  adminPassword: env('ADMIN_PASSWORD', ''),
  // 允许访问的来源（CORS），* 表示全部
  corsOrigin: env('CORS_ORIGIN', '*'),
  // 上游请求超时（毫秒）
  timeoutMs: envInt('TIMEOUT_MS', 300000),
  // 并发上限，超过排队
  maxConcurrency: envInt('MAX_CONCURRENCY', 8),
};

export const AUTH = {
  // 账号凭证文件：Cookie 串 / 登录态 JSON
  cookieFile: path.join(DATA_DIR, 'cookie.txt'),
  storageFile: path.join(DATA_DIR, 'storage-state.json'),
  bearerFile: path.join(DATA_DIR, 'bearer.txt'),
  // 号池目录：每个 *.json 是一个账号（{id, cookie|bearer, weight, enabled}）
  accountsFile: path.join(DATA_DIR, 'accounts.json'),
  // 附加到上游请求的固定头（JSON 字符串，如 {"x-workspace-id":"123"}）
  extraHeaders: JSON.parse(env('WB_EXTRA_HEADERS', '{}')),
  // Cookie 失效时是否自动用 Playwright 重新登录
  autoRelogin: envBool('AUTO_RELOGIN', false),
  loginUrl: env('WB_LOGIN_URL', 'https://www.[WORK_BUDDY_HOST]/login'),
  headless: envBool('WB_HEADLESS', true),
};

export const PROXY_CFG = {
  // 本地 SOCKS/HTTP 代理，给 Playwright 登录用（可选）
  httpProxy: env('HTTP_PROXY', process.env.http_proxy || ''),
  // 是否信任系统代理
  trustEnvProxy: envBool('TRUST_ENV_PROXY', true),
};

export function runtimePaths() {
  return { ROOT, DATA_DIR, CERT_DIR, PUBLIC_DIR };
}

// 读取可选的 config.json（优先级低于环境变量）
export function loadUserConfig() {
  const p = path.join(ROOT, 'config.json');
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.warn('[config] config.json 解析失败:', e.message);
  }
  return null;
}
