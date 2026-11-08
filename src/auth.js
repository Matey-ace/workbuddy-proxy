// 凭证管理：单账号 / 号池轮转 / 自动续登
import fs from 'node:fs';
import { AUTH, PROXY_CFG } from './config.js';
import log from './logger.js';

function readIfExists(p) {
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  } catch {}
  return '';
}

// 归一化：支持整串 Cookie、以及 storage-state.json（Playwright 格式）
export function normalizeCookie(raw) {
  if (!raw) return '';
  const t = raw.trim();
  if (!t) return '';
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const j = JSON.parse(t);
      let cookies = Array.isArray(j) ? j : j.cookies;
      // storage-state: { cookies: [...], origins: [...] }
      if (!cookies && j.origins) {
        cookies = j.origins.flatMap((o) => (o.localStorage || []).map((x) => ({ name: x.name, value: x.value })));
      }
      if (Array.isArray(cookies)) return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch (e) {
      log.warn('凭证 JSON 解析失败：', e.message);
    }
    return t;
  }
  return t;
}

let state = {
  accounts: [], // [{ id, cookie, bearer, weight, enabled, fails, lastUsed }]
  cursor: 0,
  cookie: '',
  bearer: '',
};

export function loadAccounts() {
  const out = [];
  // 1) 号池文件
  let pool = [];
  if (fs.existsSync(AUTH.accountsFile)) {
    try {
      pool = JSON.parse(fs.readFileSync(AUTH.accountsFile, 'utf8'));
      if (!Array.isArray(pool)) pool = [pool];
    } catch (e) {
      log.warn('accounts.json 解析失败：', e.message);
    }
  }
  for (const [i, a] of pool.entries()) {
    out.push({
      id: a.id || `acc${i + 1}`,
      cookie: normalizeCookie(a.cookie || (a.storage ? JSON.stringify(a.storage) : '')),
      bearer: a.bearer || a.token || '',
      weight: Number(a.weight) > 0 ? Number(a.weight) : 1,
      enabled: a.enabled !== false,
      fails: 0,
      lastUsed: 0,
    });
  }
  // 2) 单账号文件（cookie.txt / storage-state.json / bearer.txt）
  const singleCookie = normalizeCookie(readIfExists(AUTH.cookieFile)) || normalizeCookie(readIfExists(AUTH.storageFile));
  const singleBearer = readIfExists(AUTH.bearerFile);
  if (singleCookie || singleBearer) {
    out.push({ id: 'default', cookie: singleCookie, bearer: singleBearer, weight: 1, enabled: true, fails: 0, lastUsed: 0 });
  }
  state.accounts = out.filter((a) => a.cookie || a.bearer);
  if (state.accounts.length === 0) {
    state.cookie = '';
    state.bearer = singleBearer || '';
  } else {
    pick(true);
  }
  log.info(`凭证加载完成：${state.accounts.length} 个账号` + (state.accounts.length ? '' : '（未登录，管理台可粘贴 Cookie）'));
  return state.accounts.length;
}

export function current() {
  return { cookie: state.cookie, bearer: state.bearer, id: state.accounts[state.cursor]?.id || 'none' };
}

export function getAll() {
  return state.accounts;
}

// 加权轮转 + 失败降级
export function pick(reset = false) {
  const list = state.accounts.filter((a) => a.enabled && (a.cookie || a.bearer));
  if (list.length === 0) return null;
  if (reset) state.cursor = 0;
  // 简单加权：按 weight 展开索引
  const bag = [];
  list.forEach((a, i) => {
    for (let k = 0; k < (a.weight || 1); k++) bag.push(i);
  });
  const idx = bag[Math.floor(Math.random() * bag.length)] ?? 0;
  state.cursor = state.accounts.indexOf(list[idx]);
  const a = state.accounts[state.cursor];
  state.cookie = a.cookie || '';
  state.bearer = a.bearer || '';
  a.lastUsed = Date.now();
  return a;
}

export function rotate() {
  const a = pick();
  if (a) log.warn(`切换备用账号 → ${a.id}`);
  return a;
}

export function markFail(id, errText = '') {
  const a = state.accounts.find((x) => x.id === id);
  if (!a) return;
  a.fails += 1;
  const auth = /401|403|未登录|登录已失效|invalid token|expired|unauthorized/i.test(errText);
  if (auth) {
    a.enabled = false;
    log.error(`账号 ${id} 凭证失效，已停用。${AUTH.autoRelogin ? '尝试自动重登…' : '请在管理台更新 Cookie。'}`);
    if (AUTH.autoRelogin) void autoRelogin(a);
  }
}

// 保存用户粘贴/脚本导入的凭证
export function saveSingle({ cookie, bearer }) {
  if (cookie) {
    const nc = normalizeCookie(cookie);
    fs.writeFileSync(AUTH.cookieFile, nc, 'utf8');
    state.cookie = nc;
  }
  if (bearer) {
    fs.writeFileSync(AUTH.bearerFile, String(bearer).trim(), 'utf8');
    state.bearer = String(bearer).trim();
  }
  loadAccounts();
  return current();
}

// ---- 自动重登（需要 playwright，未安装时安全降级）----
let reloginTask = null;
export async function autoRelogin(account) {
  if (reloginTask) return reloginTask;
  reloginTask = (async () => {
    try {
      const { chromium } = await import('playwright');
      const browser = await chromium.launch({
        headless: AUTH.headless,
        proxy: PROXY_CFG.httpProxy ? { server: PROXY_CFG.httpProxy } : undefined,
      });
      const ctx = await browser.newContext({ storageState: fs.existsSync(AUTH.storageFile) ? AUTH.storageFile : undefined });
      const page = await ctx.newPage();
      await page.goto(AUTH.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      log.info('请在弹出的浏览器中完成登录（等待 3 分钟）…');
      try {
        await page.waitForFunction(
          () => !/login|signin/i.test(location.href),
          { timeout: 180000 }
        );
      } catch {
        log.warn('等待登录超时');
      }
      await ctx.storageState({ path: AUTH.storageFile });
      const c = (await ctx.cookies()).map((x) => `${x.name}=${x.value}`).join('; ');
      if (c) fs.writeFileSync(AUTH.cookieFile, c, 'utf8');
      if (account) {
        account.cookie = c;
        account.enabled = true;
        account.fails = 0;
      }
      await browser.close();
      log.info('自动重登完成，凭证已保存');
      loadAccounts();
    } catch (e) {
      log.error('自动重登失败：', e.message);
    } finally {
      reloginTask = null;
    }
  })();
  return reloginTask;
}

// 供 Playwright 手工登录脚本使用
export async function interactiveLogin() {
  return autoRelogin(null);
}
