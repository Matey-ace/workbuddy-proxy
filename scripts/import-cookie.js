// 从命令行导入 Cookie / Bearer
// 用法: node scripts/import-cookie.js "cookie=xxx; token=yyy" [bearer]
import { saveSingle } from '../src/auth.js';

const cookie = process.argv[2] || '';
const bearer = process.argv[3] || '';
if (!cookie && !bearer) {
  console.log('用法: node scripts/import-cookie.js "<cookie 串>" [bearer token]');
  console.log('也可以直接写入 data/cookie.txt / data/bearer.txt');
  process.exit(1);
}
const cur = saveSingle({ cookie, bearer });
console.log('已保存。当前账号:', cur.id, 'cookie 长度:', cur.cookie.length, 'bearer:', cur.bearer ? '有' : '无');
