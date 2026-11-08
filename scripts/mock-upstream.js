// 假上游：模拟 WorkBuddy 的 SSE 聊天接口，用于端到端自测
// 用法: node scripts/mock-upstream.js 9900
import http from 'node:http';

const port = Number(process.argv[2]) || 9900;
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'wb-pro' }, { id: 'wb-fast' }] }));
  }
  if (u.pathname === '/api/user/quota') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ used: 12, total: 100, plan: 'pro' }));
  }
  if (u.pathname === '/api/chat') {
    if (!req.headers.cookie) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: '登录已失效' } }));
    }
    let body = '';
    for await (const c of req) body += c;
    const j = JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ conversation_id: 'conv_abc123' })}\n\n`);
    const text = j.messages?.at(-1)?.content || '';
    const useTool = /天气|weather/.test(text);
    if (useTool) {
      const chunks = ['我先查一下。\n', '```json\n', '{"tool_calls":[{"id":"c1","type":"function","function":{"name":"get_weather","arguments":{"city":"北京"}}}]}\n', '```\n'];
      for (const c of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 20));
      }
    } else {
      for (const ch of '你好！我是 WorkBuddy。'.split('')) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 15));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '思考：打招呼' } }] })}\n\n`);
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 7 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(404);
  res.end('nope');
});
server.listen(port, '127.0.0.1', () => console.log('mock upstream on ' + port));
