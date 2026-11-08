// 开机自启：在启动文件夹放一个快捷方式，登录 Windows 后自动拉起服务
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STARTUP = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const BAT = path.join(ROOT, '一键启动.bat');
const LNK = path.join(STARTUP, 'WorkBuddy Proxy.lnk');

const action = process.argv[2] || 'status';

function ps(script) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000 });
}

if (action === 'enable') {
  if (!fs.existsSync(STARTUP)) {
    console.error('未找到启动文件夹：' + STARTUP);
    process.exit(1);
  }
  // 用 PowerShell 的 WScript.Shell COM 创建快捷方式（正确处理中文路径）
  const script = `
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut(${JSON.stringify(LNK)})
$lnk.TargetPath = ${JSON.stringify(BAT)}
$lnk.WorkingDirectory = ${JSON.stringify(ROOT)}
$lnk.WindowStyle = 7
$lnk.Description = 'WorkBuddy Proxy 自动启动'
$lnk.Save()
`;
  try {
    ps(script);
    console.log('已启用开机自启：' + LNK);
  } catch (e) {
    console.error('创建快捷方式失败：' + (e.stderr || e.message));
  }
} else if (action === 'disable') {
  try {
    fs.unlinkSync(LNK);
    console.log('已关闭开机自启');
  } catch {
    console.log('开机自启未启用');
  }
} else {
  console.log(fs.existsSync(LNK) ? '开机自启：已启用' : '开机自启：未启用');
  console.log('  node scripts/autostart.js enable   启用');
  console.log('  node scripts/autostart.js disable  关闭');
}
