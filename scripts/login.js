// Playwright 手工登录：打开浏览器让你登录 WorkBuddy，完成后自动保存 Cookie / storageState
// 用法: npm i playwright && npx playwright install chromium && node scripts/login.js
import { interactiveLogin } from '../src/auth.js';
import { AUTH } from '../src/config.js';

console.log('登录地址：', AUTH.loginUrl);
console.log('（无头模式下不会弹窗，请设置 WB_HEADLESS=false 并确保已安装 playwright）');
await interactiveLogin();
console.log('登录完成，凭证已写入 data/cookie.txt 与 data/storage-state.json');
