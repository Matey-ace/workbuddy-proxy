// 一键启动：后台拉起服务、等就绪、自动打开管理台。服务已在跑则直接打开。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 8787;
const URL = `http://127.0.0.1:${PORT}`;

function ping() {
  return new Promise((resolve) => {
    const req = http.get(URL + '/health', { timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (await ping()) {
    console.log('服务已在运行：' + URL);
    openBrowser(URL);
    process.exit(0);
  }

  console.log('正在启动 WorkBuddy Proxy…');
  const logDir = path.join(ROOT, 'data');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'server.log'), 'a');
  // 关键：detached + unref + windowsHide，让子进程完全独立于本脚本存活
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: process.env,
  });
  child.on('error', (e) => console.error('spawn 失败:', e.message));
  child.unref();

  // 等待就绪（最多 30 秒）
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await ping()) {
      console.log('已就绪：' + URL);
      openBrowser(URL);
      process.exit(0);
    }
  }
  console.error('启动超时，请查看 data/server.log');
  process.exit(1);
})();
