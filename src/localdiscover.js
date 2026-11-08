// 本机 WorkBuddy 自动发现：扫安装目录/配置目录/本地网关，尽量免手工配置
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from './logger.js';

const execFileP = promisify(execFile);
const HOME = os.homedir();

// 常见安装路径候选
function installCandidates() {
  const out = [];
  const drives = ['C:', 'D:', 'E:', 'F:'].filter((d) => {
    try {
      fs.accessSync(d + '\\');
      return true;
    } catch {
      return false;
    }
  });
  for (const d of drives) {
    out.push(`${d}\\Program Files\\WorkBuddy`, `${d}\\Program Files (x86)\\WorkBuddy`, `${d}\\WorkBuddy`);
    // 扫描一层：用户把应用装在了任意目录
    try {
      for (const top of fs.readdirSync(d + '\\', { withFileTypes: true })) {
        if (!top.isDirectory()) continue;
        const p = `${d}\\${top.name}`;
        out.push(path.join(p, 'WorkBuddy'));
        // 再深一层（比如 E:\新建文件夹\WorkBuddy）
        try {
          for (const sub of fs.readdirSync(p, { withFileTypes: true })) {
            if (sub.isDirectory()) out.push(path.join(p, sub.name, 'WorkBuddy'));
          }
        } catch {}
      }
    } catch {}
  }
  return [...new Set(out)];
}

function isInstall(p) {
  try {
    return fs.existsSync(path.join(p, 'WorkBuddy.exe')) || fs.existsSync(path.join(p, 'resources', 'app.asar'));
  } catch {
    return false;
  }
}

// 配置根目录
function configRoots() {
  return [
    path.join(HOME, '.workbuddy'),
    path.join(HOME, 'AppData', 'Roaming', 'WorkBuddy'),
    path.join(HOME, 'Library', 'Application Support', 'WorkBuddy'),
    path.join(HOME, '.config', 'WorkBuddy'),
  ];
}

// 读账号快照（明文）
function readAccount(root) {
  const p = path.join(root, 'storage', 'skeleton', 'account-snapshot.json');
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// 读 auth 文件结构（token 是加密的，这里只报告元信息）
function readAuthInfo() {
  const cands = [
    path.join(HOME, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    path.join(HOME, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
    path.join(HOME, '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
  ];
  for (const p of cands) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const a = j.auth || {};
      const isEnc = (v) => v && typeof v === 'object' && v.$wbEncrypted === 1;
      return {
        path: p,
        uid: j.account?.uid,
        domain: a.domain,
        tokenType: a.tokenType,
        scope: a.scope,
        expiresAt: a.expiresAt,
        refreshExpiresAt: a.refreshExpiresAt,
        expiresInSec: a.expiresAt ? Math.round((a.expiresAt - Date.now()) / 1000) : null,
        accessTokenEncrypted: isEnc(a.accessToken),
        refreshTokenEncrypted: isEnc(a.refreshToken),
        sessionState: a.sessionState,
      };
    } catch (e) {
      log.warn('读取 auth 失败：', e.message);
    }
  }
  return null;
}

// 读 keyblob（只报告结构，不解密）
function readKeyblob(root) {
  const p = path.join(root, 'keyblob');
  try {
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      path: p,
      keyId: j.keyId,
      slots: (j.slots || []).map((s) => ({ type: s.type, protectorKeyId: s.protectorKeyId, wrappedLen: s.wrapped?.length })),
    };
  } catch {
    return null;
  }
}

// 找 WorkBuddy 进程监听的本地端口
// 用 Node 原生探测：解析 netstat（避免依赖 PowerShell 管道）
async function findLocalPorts(pids) {
  const ports = new Set();
  try {
    // 方案 A：netstat -ano（跨版本可用）
    const { stdout } = await execFileP('netstat', ['-ano', '-p', 'TCP'], { timeout: 8000, windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (!m) continue;
      const [, addr, port, pid] = m;
      if (!/127\.0\.0\.1|\[::1\]|0\.0\.0\.0/.test(addr)) continue;
      if (pids && pids.size && !pids.has(Number(pid))) continue;
      ports.add(Number(port));
    }
  } catch (e) {
    log.debug('netstat 失败：', e.message);
  }
  return [...ports];
}

// 取 WorkBuddy 进程 PID 集合
async function findWbPids() {
  const pids = new Set();
  try {
    const { stdout } = await execFileP('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/FO', 'CSV', '/NH'], { timeout: 8000, windowsHide: true });
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^"WorkBuddy\.exe","(\d+)"/i);
      if (m) pids.add(Number(m[1]));
    }
  } catch (e) {
    log.debug('tasklist 失败：', e.message);
  }
  return pids;
}

function probePort(port, timeout = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (r) => {
      try {
        s.destroy();
      } catch {}
      resolve(r);
    };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

// 探测是否 CodeBuddy Gateway（根路径有标题）
async function probeGateway(port) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal });
    clearTimeout(t);
    const txt = await r.text();
    if (txt.includes('CodeBuddy') || txt.includes('Gateway')) {
      return { port, kind: 'codebuddy-gateway', title: (txt.match(/<title>(.*?)<\/title>/) || [])[1] || 'CodeBuddy Gateway' };
    }
    return { port, kind: 'http', title: null };
  } catch {
    return null;
  }
}

/**
 * 全面扫描本机环境。返回可直接用于渲染的报告。
 */
export async function discover() {
  const report = {
    at: Date.now(),
    install: null,
    configRoot: null,
    account: null,
    auth: null,
    keyblob: null,
    gateways: [],
    mitmRunning: false,
    ready: false,
    blockers: [],
    nextSteps: [],
  };

  // 1) 安装目录
  report.install = installCandidates().find(isInstall) || null;
  if (!report.install) report.blockers.push('未找到 WorkBuddy 安装目录');

  // 2) 配置目录
  report.configRoot = configRoots().find((p) => fs.existsSync(p)) || null;
  if (!report.configRoot) report.blockers.push('未找到 ~/.workbuddy 配置目录');

  // 3) 账号与凭证
  if (report.configRoot) {
    const snap = readAccount(report.configRoot);
    report.account = snap?.primary || null;
    report.keyblob = readKeyblob(report.configRoot);
  }
  report.auth = readAuthInfo();

  // 4) 本地网关
  const wbPids = await findWbPids();
  const ports = await findLocalPorts(wbPids);
  for (const p of ports) {
    if (!(await probePort(p))) continue;
    const g = await probeGateway(p);
    if (g) report.gateways.push(g);
  }

  // 5) 判断可用性与阻塞点
  if (report.auth) {
    if (report.auth.accessTokenEncrypted) {
      report.blockers.push('accessToken 被 $wbEncrypted 信封加密，密钥在 keyblob 的 static-v1 槽（需 WorkBuddy 运行时解封）');
    }
    if (report.auth.expiresInSec !== null && report.auth.expiresInSec < 0) {
      report.blockers.push('accessToken 已过期，需要 WorkBuddy 刷新');
    }
  }
  if (report.gateways.length) {
    report.nextSteps.push('检测到本地 CodeBuddy Gateway，可直接作为 Agent 后端（需其内部 ticket）');
  }
  report.nextSteps.push('用抓包代理从 WorkBuddy 运行时抓一次真实请求，即可拿到可复用的 Header');

  log.info(`本机发现：install=${!!report.install} config=${!!report.configRoot} account=${report.account?.nickname || '-'} gateways=${report.gateways.length}`);
  return report;
}

/**
 * 尝试从运行中的 WorkBuddy 进程内存外泄点拿 token：读 IPC ticket。
 * （ticket 是给命名管道用的，不代表能直接当 HTTP Bearer）
 */
export function readIpcTicket(configRoot) {
  try {
    const p = path.join(configRoot || path.join(HOME, '.workbuddy'), 'wbipc', 'endpoint.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
