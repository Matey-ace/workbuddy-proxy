// WorkBuddy 5.6+ 桌面端 at-rest 凭据解密
// 原理：用 WorkBuddy.exe 自身作为 Electron Node 运行时（ELECTRON_RUN_AS_NODE=1），
//       调用其私有 binding 取出 atRestSecretKey，再用 AES-256-GCM 解开 auth 字段。
// 参考 dsh-connect-workbuddy 5.20.2 的实现（fieldAad / deriveAtRestKeyId / 多文件名）。
import { spawn } from 'node:child_process';
import { createHash, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from './logger.js';

const HOME = os.homedir();

// Framing code：field = 2（5.7+ 起的封装格式；旧的 file=1 已不适用）
const FRAMING_FIELD = 2;

// ---------- AAD 构造（与 App 的 fieldAad 一致）----------
function buildAad(keyId, suite) {
  const prefix = Buffer.from('WB-AAD\0', 'ascii');
  const lp = (v) => {
    const b = Buffer.from(v, 'utf8');
    const h = Buffer.allocUnsafe(4);
    h.writeUInt32BE(b.length);
    return Buffer.concat([h, b]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    prefix,
    Buffer.from([1]),
    lp('WBEV1'),
    lp('sym-v1'),
    suiteBytes,
    lp(keyId),
    Buffer.from([FRAMING_FIELD]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

// keyId = sha256(32字节密钥) 的前 16 个 hex；用于校验信封是否属于当前密钥
function deriveKeyId(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

function parseWrapped(v) {
  if (!v || typeof v !== 'object' || v.$wbEncrypted !== 1 || typeof v.envelope !== 'string') return null;
  let inner;
  try {
    inner = JSON.parse(Buffer.from(v.envelope, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!inner || inner.suite !== 1 || typeof inner.keyId !== 'string') return null;
  try {
    return {
      suite: inner.suite,
      keyId: inner.keyId,
      nonce: Buffer.from(inner.nonce, 'base64'),
      authTag: Buffer.from(inner.authTag, 'base64'),
      ciphertext: Buffer.from(inner.ciphertext, 'base64'),
    };
  } catch {
    return null;
  }
}

function openField(key, env) {
  const d = createDecipheriv('aes-256-gcm', key, env.nonce, { authTagLength: 16 });
  d.setAAD(buildAad(env.keyId, env.suite));
  d.setAuthTag(env.authTag);
  return Buffer.concat([d.update(env.ciphertext), d.final()]).toString('utf8');
}

// ---------- 定位 WorkBuddy.exe ----------
export function findExe(product = 'cn') {
  const envKey = product === 'ai' ? 'WORKBUDDY_AI_ELECTRON_BIN' : 'WORKBUDDY_ELECTRON_BIN';
  if (process.env[envKey]) return process.env[envKey];
  const cands = [];
  if (product === 'ai') {
    cands.push(
      path.join(HOME, 'AppData', 'Local', 'Programs', 'WorkBuddy AI', 'WorkBuddyAI.exe'),
      path.join(HOME, 'AppData', 'Local', 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
      'C:\\Program Files\\WorkBuddy AI\\WorkBuddyAI.exe',
      'E:\\overseas workbuddy\\WorkBuddyAI\\WorkBuddyAI.exe'
    );
  } else {
    cands.push(path.join(HOME, 'AppData', 'Local', 'Programs', 'WorkBuddy', 'WorkBuddy.exe'));
  }
  // 注册表（uninstall DisplayIcon 指向 exe）
  const reg = regExeCandidates();
  cands.push(...reg[product]);
  // 扫所有盘符（两层深度）
  const drives = ['C:', 'D:', 'E:', 'F:'];
  for (const d of drives) {
    try {
      for (const top of fs.readdirSync(d + '\\', { withFileTypes: true })) {
        if (!top.isDirectory()) continue;
        const base = path.join(d + '\\', top.name);
        const sub2 = [base, ...(() => {
          try {
            return fs.readdirSync(base, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => path.join(base, x.name));
          } catch {
            return [];
          }
        })()];
        for (const b of sub2) {
          if (product === 'ai') {
            cands.push(path.join(b, 'WorkBuddyAI', 'WorkBuddyAI.exe'));
            cands.push(path.join(b, 'WorkBuddy AI', 'WorkBuddyAI.exe'));
          } else {
            cands.push(path.join(b, 'WorkBuddy', 'WorkBuddy.exe'));
          }
        }
      }
    } catch {}
  }
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

// 从注册表反查安装路径（国际版没有默认路径）
function regExeCandidates() {
  const out = { cn: [], ai: [] };
  try {
    const { execFileSync } = require('node:child_process');
    const keys = [
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    ];
    for (const k of keys) {
      let raw = '';
      try {
        raw = execFileSync('reg', ['query', k, '/s', '/v', 'DisplayIcon'], { encoding: 'utf8', timeout: 15000 });
      } catch {}
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/DisplayIcon\s+REG_SZ\s+(.+\.exe)/i);
        if (!m) continue;
        const exe = m[1].trim().replace(/,\s*\d+$/, '');
        if (/WorkBuddyAI\.exe$/i.test(exe)) out.ai.push(exe);
        else if (/WorkBuddy\.exe$/i.test(exe)) out.cn.push(exe);
      }
    }
  } catch (e) {
    log.debug('注册表查询失败：', e.message);
  }
  return out;
}

// ---------- 取出 at-rest 密钥 ----------
export function fetchAtRestKey(exePath, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve) => {
    if (!exePath || !fs.existsSync(exePath)) return resolve({ ok: false, error: '未找到 WorkBuddy.exe（可用 WORKBUDDY_ELECTRON_BIN / WORKBUDDY_AI_ELECTRON_BIN 指定）' });
    const outFile = path.join(os.tmpdir(), `wb-atrest-${process.pid}-${Date.now()}.json`);
    const helper = `
try {
  const p = process._linkedBinding('electron_browser_workbuddy_storage').loggerGet();
  require('fs').writeFileSync(${JSON.stringify(outFile)}, String(p));
} catch (e) {
  require('fs').writeFileSync(${JSON.stringify(outFile)}, 'ERR:' + (e && e.message));
}`;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        fs.unlinkSync(outFile);
      } catch {}
      resolve(r);
    };
    let child;
    try {
      child = spawn(exePath, ['-e', helper], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'ignore'],
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, error: 'spawn 失败: ' + e.message });
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({ ok: false, error: '取密钥超时' });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ ok: false, error: 'spawn 错误: ' + e.message });
    });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        if (!fs.existsSync(outFile)) return finish({ ok: false, error: 'helper 未产出结果' });
        const raw = fs.readFileSync(outFile, 'utf8');
        fs.unlinkSync(outFile);
        if (raw.startsWith('ERR:')) return finish({ ok: false, error: raw.slice(4) });
        const j = JSON.parse(raw);
        if (j.version !== 1 || typeof j.atRestSecretKey !== 'string') return finish({ ok: false, error: 'payload 结构不符' });
        const key = createHash('sha256').update(j.atRestSecretKey, 'utf8').digest();
        finish({ ok: true, key });
      } catch (e) {
        finish({ ok: false, error: e.message });
      }
    });
  });
}

// ---------- 读 auth 文件 ----------
// 5.7.x 起 Windows 版可能只写 workbuddy-desktop-ai.info（Issue #174），
// 也可能带时间戳备份。这里列出所有已知文件名并按修改时间取最新。
const AUTH_BASENAMES = [
  'workbuddy-desktop.info',
  'workbuddy-desktop-ai.info',
  '.workbuddy-auth.json',
];

function authDirs() {
  const rel = ['CodeBuddyExtension', 'Data', 'Public', 'auth'];
  return [
    path.join(HOME, 'AppData', 'Local', ...rel),
    path.join(HOME, 'AppData', 'Roaming', ...rel),
    path.join(HOME, 'Library', 'Application Support', ...rel),
    path.join(HOME, '.config', ...rel),
  ];
}

export function authFileCandidates(product) {
  const envKey = product === 'ai' ? 'WORKBUDDY_AI_AUTH_FILE' : 'WORKBUDDY_AUTH_FILE';
  const out = [];
  if (process.env[envKey]) out.push(process.env[envKey]);
  // 通用覆盖变量（新版插件也用 WORKBUDDY_AUTH_FILE 指向国际版）
  if (process.env.WORKBUDDY_AUTH_FILE) out.push(process.env.WORKBUDDY_AUTH_FILE);
  for (const d of authDirs()) {
    for (const n of AUTH_BASENAMES) out.push(path.join(d, n));
    // 时间戳备份：workbuddy-desktop-ai.info.<ts>.bak
    try {
      for (const f of fs.readdirSync(d)) {
        if (/^workbuddy-desktop(-ai)?\.info\./.test(f)) out.push(path.join(d, f));
      }
    } catch {}
  }
  return [...new Set(out)];
}

export function readAuthDoc(product = 'cn') {
  // 先看显式指定的路径
  const explicit = product === 'ai' ? process.env.WORKBUDDY_AI_AUTH_FILE : '';
  const candidates = authFileCandidates(product).filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  // 按 mtime 降序：实时文件永远优先于备份
  candidates.sort((a, b) => {
    if (explicit && a === explicit) return -1;
    if (explicit && b === explicit) return 1;
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  for (const p of candidates) {
    try {
      const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
      const auth = doc.auth || doc;
      // 必须有可用的 token 字段
      if (!auth || (typeof auth.accessToken !== 'string' && !auth.accessToken?.$wbEncrypted)) continue;
      // 区域要匹配：按 domain 过滤，避免国内/国际版串号
      const dom = String(auth.domain || '').toLowerCase();
      const wantAI = product === 'ai';
      if (wantAI && dom && !dom.includes('workbuddy.ai') && !dom.includes('codebuddy.ai')) continue;
      if (!wantAI && dom && (dom.includes('workbuddy.ai') || dom.includes('codebuddy.ai'))) continue;
      return { path: p, doc };
    } catch (e) {
      log.warn('读取 auth 失败:', e.message);
    }
  }
  return null;
}

/**
 * 解出可用的 accessToken / refreshToken。
 * product: 'cn'（国内版，www.workbuddy.cn）| 'ai'（国际版，www.workbuddy.ai）
 */
export async function resolveTokens(product = 'cn') {
  const found = readAuthDoc(product);
  if (!found) return { ok: false, error: `未找到 auth 文件（${product}）` };
  const { doc } = found;
  const auth = doc.auth || doc;
  const accessW = parseWrapped(auth.accessToken);
  const refreshW = parseWrapped(auth.refreshToken);

  // 已是明文
  if (!accessW && typeof auth.accessToken === 'string' && auth.accessToken) {
    return {
      ok: true,
      plaintext: true,
      product,
      accessToken: auth.accessToken,
      refreshToken: typeof auth.refreshToken === 'string' ? auth.refreshToken : null,
      domain: auth.domain,
      expiresAt: auth.expiresAt,
      source: found.path,
    };
  }
  if (!accessW) return { ok: false, error: 'auth 中未找到可解的信封' };

  const exe = findExe(product);
  const kr = await fetchAtRestKey(exe);
  if (!kr.ok) return { ok: false, error: '取密钥失败: ' + kr.error, exe, product };
  const key = kr.key;

  // keyId 校验：信封里的 keyId 必须等于当前密钥派生出的 id，
  // 否则说明该 auth 文件属于另一个 App/密钥，换一个 exe 或文件重试
  const expectedKeyId = deriveKeyId(key);
  if (accessW.keyId !== expectedKeyId) {
    return {
      ok: false,
      error: `信封 keyId=${accessW.keyId} 与密钥 ${expectedKeyId} 不匹配（可能用错 App 或凭据已重新加密）`,
      exe,
      product,
      expectedKeyId,
      gotKeyId: accessW.keyId,
    };
  }

  try {
    const accessToken = openField(key, accessW);
    let refreshToken = null;
    if (refreshW) {
      try {
        refreshToken = openField(key, refreshW);
      } catch {}
    }
    // 昵称也可能是加密的
    let nickname = doc.account?.nickname;
    if (nickname && typeof nickname === 'object' && nickname.$wbEncrypted === 1) {
      try {
        const w = parseWrapped(nickname);
        if (w) nickname = openField(key, w);
      } catch {}
    }
    if (nickname && typeof nickname === 'object') nickname = '';
    return {
      ok: true,
      product,
      accessToken,
      refreshToken,
      nickname,
      uid: doc.account?.uid,
      enterpriseId: doc.account?.enterpriseId || '',
      domain: auth.domain,
      tokenType: auth.tokenType,
      scope: auth.scope,
      expiresAt: auth.expiresAt,
      refreshExpiresAt: auth.refreshExpiresAt,
      source: found.path,
      exe,
    };
  } catch (e) {
    return { ok: false, error: '解密失败: ' + e.message + '（keyId 或密钥不匹配）', exe, product };
  }
}

// 两个版本都试，返回各自状态
export async function resolveAll() {
  const [cn, ai] = [await resolveTokens('cn'), await resolveTokens('ai')];
  return { cn, ai };
}
