// 真实链路测试：用本机 WorkBuddy 凭据，直连官方接口
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const KEY = process.env.API_KEY || 'sk-workbuddy-local';
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY };

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name);
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? ' → ' + extra : ''));
  }
}

async function chat(body) {
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

console.log('[1] 原生状态');
const st = await (await fetch(`${BASE}/api/native/status`)).json().catch(() => null);
ok('凭据可用', st?.ok === true, JSON.stringify(st).slice(0, 200));
if (st?.ok) console.log(`    接口=${st.endpoint}  Token=${st.tokenLen}B  剩余=${Math.floor((st.expiresInSec || 0) / 86400)}天`);

console.log('[2] 模型目录');
let r = await fetch(`${BASE}/v1/models`, { headers: H });
const ml = await r.json();
ok('模型数量 > 0', (ml.data || []).length > 0, String((ml.data || []).length));
const ids = (ml.data || []).map((m) => m.id);
console.log('    ' + ids.slice(0, 8).join(', ') + (ids.length > 8 ? ' …' : ''));

console.log('[3] 单轮对话');
{
  const { status, json: j } = await chat({ model: 'glm-5.3', messages: [{ role: 'user', content: '只回复：收到' }], stream: false });
  ok('HTTP 200', status === 200, JSON.stringify(j).slice(0, 200));
  const c = j?.choices?.[0]?.message?.content || '';
  ok('有回复内容', c.length > 0, c.slice(0, 60));
  console.log('    回复: ' + c.replace(/\n/g, ' ').slice(0, 70));
  ok('有 usage', !!j?.usage, JSON.stringify(j?.usage));
}

console.log('[4] 流式对话');
{
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: '从1数到5' }], stream: true }),
  });
  const txt = await res.text();
  const lines = txt.split('\n').filter((l) => l.startsWith('data:'));
  let acc = '';
  for (const l of lines) {
    const d = l.slice(5).trim();
    if (d === '[DONE]') continue;
    try {
      acc += JSON.parse(d).choices?.[0]?.delta?.content || '';
    } catch {}
  }
  ok('流式 200', res.status === 200, String(res.status));
  ok('分片 > 1', lines.length > 1, String(lines.length));
  ok('累积文本非空', acc.length > 0);
  ok('以 [DONE] 结束', txt.includes('[DONE]'));
  console.log('    分片数=' + lines.length + ' 文本: ' + acc.replace(/\n/g, ' ').slice(0, 60));
}

console.log('[5] 多模型');
{
  const region = (process.env.WB_REGION || 'cn').toLowerCase() === 'ai' ? 'ai' : 'cn';
  // 只测目录里确实存在的模型（两个版本的目录不完全一致）
  const wanted = ['glm-5.3', 'deepseek-v4.1-flash', 'kimi-k3-1'].filter((m) => ids.includes(m));
  for (const m of wanted.length ? wanted : ids.slice(0, 3)) {
    const { status, json: j } = await chat({ model: m, messages: [{ role: 'user', content: '说 ok' }], stream: false });
    const c = j?.choices?.[0]?.message?.content || j?.error?.message || '';
    ok(m, status === 200 && c.length > 0, c.slice(0, 80));
  }
}

console.log('[6] Anthropic 协议');
{
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'glm-5.3', max_tokens: 100, messages: [{ role: 'user', content: '回复 OK' }] }),
  });
  const j = await res.json();
  ok('messages 200', res.status === 200, JSON.stringify(j).slice(0, 200));
  ok('有 content', (j?.content?.[0]?.text || '').length > 0);
}

console.log('[7] Ollama 协议');
{
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: '回复 OK' }], stream: false }),
  });
  const j = await res.json();
  ok('api/chat 200', res.status === 200, JSON.stringify(j).slice(0, 200));
  ok('done=true', j?.done === true);
}

console.log('');
console.log(fail === 0 ? `全部通过 ✓ (${pass} 项)` : `${fail} 项失败 / ${pass} 项通过`);
process.exit(fail ? 1 : 0);
