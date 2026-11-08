// 自测：解析器 + 上游连通性（不需要真实上游也能跑解析器部分）
import assert from 'node:assert';
import { __test } from '../src/toolParser.js';
import { ToolCallExtractor } from '../src/toolParser.js';

let pass = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.log('  ✗ ' + name + ' → ' + e.message);
    process.exitCode = 1;
  }
}

console.log('[1] 工具调用解析');
t('fence 代码块解析', () => {
  const ex = new ToolCallExtractor({ enabled: true, mode: 'auto' });
  const r = ex.push('好的，我来查一下：\n```json\n{"tool_calls":[{"id":"c1","type":"function","function":{"name":"get_weather","arguments":{"city":"北京"}}}]}\n```\n');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(r.toolCalls[0].function.arguments), { city: '北京' });
  assert.ok(!r.plain.includes('get_weather'));
});

t('流式分片跨 chunk 解析', () => {
  const ex = new ToolCallExtractor({ enabled: true, mode: 'auto' });
  const s = '前缀文本```json\n{"tool_calls":[{"id":"c2","function":{"name":"search","arguments":{"q":"abc"}}}]}\n```后缀';
  let calls = [];
  let plain = '';
  for (let i = 0; i < s.length; i += 7) {
    const r = ex.push(s.slice(i, i + 7));
    calls.push(...r.toolCalls);
    plain += r.plain;
  }
  assert.equal(calls.length, 1, '应解析出 1 个调用');
  assert.equal(calls[0].function.name, 'search');
  assert.ok(plain.includes('前缀文本') && plain.includes('后缀'), '普通文本应保留');
});

t('裸 JSON 对象解析', () => {
  const ex = new ToolCallExtractor({ enabled: true, mode: 'json' });
  const r = ex.push('调用工具: {"name":"calc","arguments":{"expr":"1+1"}} 结束');
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, 'calc');
});

t('普通文本不误判', () => {
  const ex = new ToolCallExtractor({ enabled: true, mode: 'auto' });
  const r = ex.push('这里有个 JSON 例子 {"a": 1} 但它不是工具调用。');
  assert.equal(r.toolCalls.length, 0);
  assert.ok(r.plain.includes('不是工具调用'));
});

t('normalize 多种形态', () => {
  const { normalize } = __test;
  assert.equal(normalize({ name: 'f', arguments: { x: 1 } })[0].function.name, 'f');
  assert.equal(normalize({ function_call: { name: 'g', arguments: '{}' } })[0].function.name, 'g');
  assert.equal(normalize({ tool_calls: [{ id: 'z', function: { name: 'h', arguments: '{}' } }] })[0].id, 'z');
  assert.equal(normalize({ foo: 1 }).length, 0);
});

t('findClose 括号平衡', () => {
  const { findClose } = __test;
  const s = 'xx{"a":{"b":1}}yy';
  assert.equal(s[findClose(s, s.indexOf('{'))], '}');
  assert.equal(findClose('{"a":', 0), -1);
});

console.log('[2] 上游连通性（需要已配置凭证）');
try {
  const { probe } = await import('../src/upstream.js');
  const { loadAccounts } = await import('../src/auth.js');
  const n = loadAccounts();
  if (!n) {
    console.log('  - 跳过：未配置凭证（data/cookie.txt 为空）');
  } else {
    const r = await probe({ probeMessage: 'ping' });
    console.log('  ' + (r.ok ? '✓' : '✗') + ' upstream probe → ' + JSON.stringify(r).slice(0, 200));
    if (!r.ok) process.exitCode = 1;
  }
} catch (e) {
  console.log('  ✗ 探测异常: ' + e.message);
  process.exitCode = 1;
}

console.log(pass + ' 个解析器用例通过');
