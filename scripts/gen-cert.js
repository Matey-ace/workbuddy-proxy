// 生成本地 CA（用于 HTTPS 抓包）
import { generateCA, caPath } from '../src/mitm.js';
generateCA();
console.log('CA 证书：' + caPath());
console.log('Windows: 双击 certs\\ca.crt.pem 改名 ca.crt 后安装到「受信任的根证书颁发机构」');
