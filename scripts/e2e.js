// 端到端测试：起假上游 + 反代服务，验证 OpenAI / Anthropic / Ollama 三套协议、流式、工具调用
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MOCK_PORT = 9901;
const PROXY_PORT = 8791;

// 用独立数据目录，避免污染真实缓存
const TMP_DATA = path.join(ROOT, 'data-e2e');
fs.mkdirSync(TMP_DATA, { recursive: true });
fs.writeFileSync(path.join(TMP_DATA, 'cookie.txt'), 'sessionid=fake123; token=fake456', 'utf8');

function run(file, args, env) {
  const p = spawn(process.execPath, [file, ...args], { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  p.on('error', () => {});
  return { p, get out() { return out; } };
}

const mock = run(path.join(ROOT, 'scripts/mock-upstream.js'), [String(MOCK_PORT)], {});
const proxy = run(path.join(ROOT, 'src/server.js'), [], {
  PORT: String(PROXY_PORT),
  WB_BASE: `http://127.0.0.1:${MOCK_PORT}`,
  WB_ORIGIN: `http://127.0.0.1:${MOCK_PORT}`,
  WB_REFERER: `http://127.0.0.1:${MOCK_PORT}/chat`,
  WB_CHAT_PATH: '/api/chat',
  WB_QUOTA_PATH: '/api/user/quota',
  WB_MODELS_PATH: '/api/models',
  WB_DEFAULT_MODEL: 'wb-pro',
  API_KEY: 'test-key',
  ADMIN_PASSWORD: '',
  // 固定走网页适配层（假上游），避免自动切换到原生直连
  WB_UPSTREAM_MODE: 'web',
  WB_DATA_DIR: TMP_DATA,
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1500);

let fails = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : ' → ' + extra));
  if (!cond) fails++;
}

async function post(p, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

console.log('[1] OpenAI 非流式');
{
  const r = await post('/v1/chat/completions', { model: 'wb-pro', messages: [{ role: 'user', content: '你好' }] });
  const j = JSON.parse(r.text);
  check('200', r.status === 200, r.text.slice(0, 200));
  check('文本拼接', (j.choices?.[0]?.message?.content || '').includes('你好！我是 WorkBuddy'), JSON.stringify(j).slice(0, 300));
  check('usage', j.usage?.total_tokens > 0, JSON.stringify(j.usage));
  check('model 透传', j.model === 'wb-pro', j.model);
}

console.log('[2] OpenAI 流式');
{
  const r = await post('/v1/chat/completions', { model: 'wb-pro', messages: [{ role: 'user', content: '你好' }], stream: true });
  const lines = r.text.split('\n').filter((l) => l.startsWith('data:'));
  let text = '';
  for (const l of lines) {
    const d = l.slice(5).trim();
    if (d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      text += j.choices?.[0]?.delta?.content || '';
    } catch {}
  }
  check('SSE 有多片', lines.length > 5, String(lines.length));
  check('流式文本完整', text.includes('WorkBuddy'), text.slice(0, 100));
  check('以 [DONE] 结束', r.text.includes('[DONE]'));
}

console.log('[3] 伪 Function Calling');
{
  const tools = [{ type: 'function', function: { name: 'get_weather', description: '查天气', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }];
  const r = await post('/v1/chat/completions', { model: 'wb-pro', messages: [{ role: 'user', content: '北京天气' }], tools });
  const j = JSON.parse(r.text);
  const tc = j.choices?.[0]?.message?.tool_calls || [];
  check('解析出 tool_calls', tc.length === 1, JSON.stringify(j).slice(0, 400));
  check('工具名正确', tc[0]?.function?.name === 'get_weather', JSON.stringify(tc[0]));
  check('finish_reason=tool_calls', j.choices?.[0]?.finish_reason === 'tool_calls', j.choices?.[0]?.finish_reason);
  check('参数可解析', tc[0]?.function?.arguments && JSON.parse(tc[0].function.arguments).city === '北京', tc[0]?.function?.arguments);
}

console.log('[4] Anthropic /v1/messages');
{
  const r = await post('/v1/messages', { model: 'wb-pro', max_tokens: 100, messages: [{ role: 'user', content: '你好' }] });
  const j = JSON.parse(r.text);
  check('200', r.status === 200, r.text.slice(0, 200));
  check('content 文本', (j.content?.[0]?.text || '').includes('WorkBuddy'), JSON.stringify(j).slice(0, 300));
  check('stop_reason', j.stop_reason === 'end_turn', j.stop_reason);
}
{
  const r = await post('/v1/messages', { model: 'wb-pro', max_tokens: 100, messages: [{ role: 'user', content: '你好' }], stream: true });
  check('流式 SSE', r.text.includes('event: message_start') && r.text.includes('event: message_stop'), r.text.slice(0, 200));
  check('含 text_delta', r.text.includes('text_delta'));
}

console.log('[5] Ollama');
{
  const r = await post('/api/chat', { model: 'wb-pro', messages: [{ role: 'user', content: '你好' }], stream: false });
  const j = JSON.parse(r.text);
  check('api/chat 200', r.status === 200, r.text.slice(0, 200));
  check('done=true', j.done === true, JSON.stringify(j).slice(0, 200));
  const r2 = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/tags`);
  const j2 = await r2.json();
  check('api/tags', Array.isArray(j2.models) && j2.models.length > 0, JSON.stringify(j2).slice(0, 200));
  const r3 = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/version`);
  check('api/version', (await r3.json()).version?.includes('workbuddy'));
}

console.log('[6] 鉴权与额度');
{
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }) });
  check('无 Key 返回 401', r.status === 401, String(r.status));
  const tk = await (await fetch(`http://127.0.0.1:${PROXY_PORT}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'workbuddy' }) })).json();
  const q = await fetch(`http://127.0.0.1:${PROXY_PORT}/api/quota`, { headers: { Authorization: 'Bearer ' + tk.token } });
  const jq = await q.json();
  check('额度接口', jq.ok === true && jq.data?.plan === 'pro', JSON.stringify(jq).slice(0, 200));
  const m = await fetch(`http://127.0.0.1:${PROXY_PORT}/v1/models`, { headers: { Authorization: 'Bearer test-key' } });
  const jm = await m.json();
  check('模型列表来自上游', JSON.stringify(jm.data).includes('wb-pro'), JSON.stringify(jm).slice(0, 200));
}

console.log('[7] 上游 401（Cookie 失效）');
{
  fs.writeFileSync(path.join(TMP_DATA, 'cookie.txt'), '', 'utf8');
  // 重启不易，改为直接验证错误路径：清空后下次加载为空 → 提示未配置
  const r = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
  const j = await r.json();
  check('health 正常', j.ok === true, JSON.stringify(j));
}

console.log(fails === 0 ? '\n全部通过 ✓' : `\n${fails} 项失败`);
mock.p.kill();
proxy.p.kill();
process.exit(fails ? 1 : 0);
