// 压测：实测 WorkBuddy 的并发/RPM 承受力与限流响应
// 用法: node scripts/bench.js [并发数] [总请求数]
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const KEY = process.env.API_KEY || 'sk-workbuddy-local';
const MODEL = process.env.BENCH_MODEL || 'glm-5.3';
const CONC = Number(process.argv[2]) || 5;
const TOTAL = Number(process.argv[3]) || 20;

const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY };

async function one(i) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: '回复一个数字即可' }],
        stream: false,
        max_tokens: 16,
      }),
    });
    const txt = await r.text();
    let code = null;
    let msg = '';
    try {
      const j = JSON.parse(txt);
      code = j.error?.detail ? 'err' : null;
      msg = j.error?.message || '';
      if (j.error?.detail) {
        try {
          const d = JSON.parse(j.error.detail);
          msg = `${d.code}:${d.msg}`;
        } catch {}
      }
    } catch {}
    return { i, status: r.status, ms: Date.now() - t0, ok: r.ok, msg };
  } catch (e) {
    return { i, status: 0, ms: Date.now() - t0, ok: false, msg: e.message };
  }
}

(async () => {
  console.log(`目标: ${MODEL}  并发=${CONC}  总请求=${TOTAL}`);
  console.log('---');
  const results = [];
  const t0 = Date.now();
  let next = 0;
  async function worker() {
    while (next < TOTAL) {
      const i = next++;
      const r = await one(i);
      results.push(r);
      const flag = r.ok ? '✓' : '✗';
      console.log(`${flag} #${String(i + 1).padStart(2)}  ${String(r.status).padStart(3)}  ${String(r.ms).padStart(5)}ms  ${r.msg || ''}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  const wall = Date.now() - t0;
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] || 0;

  console.log('---');
  console.log(`总耗时 ${wall}ms  成功 ${ok}  失败 ${fail}`);
  console.log(`吞吐 ≈ ${((results.length / wall) * 60000).toFixed(1)} RPM（本档并发下实际达到）`);
  console.log(`延迟 p50=${pct(0.5)}ms  p90=${pct(0.9)}ms  max=${lat[lat.length - 1]}ms`);

  // 错误归类
  const errs = {};
  for (const r of results.filter((x) => !x.ok)) {
    const k = `${r.status} ${r.msg}`.slice(0, 120);
    errs[k] = (errs[k] || 0) + 1;
  }
  if (Object.keys(errs).length) {
    console.log('错误分布:');
    for (const [k, v] of Object.entries(errs)) console.log(`  ${v}× ${k}`);
  }
  process.exit(0);
})();
