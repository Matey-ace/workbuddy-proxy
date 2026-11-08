// Anthropic Messages API 兼容层（/v1/messages，含 stream SSE）
// 默认走原生 WorkBuddy 上游，无需网页端 Cookie。
import { randomUUID } from 'node:crypto';
import * as upstream from './upstream.js';
import * as wb from './workbuddy.js';
import * as models from './models.js';
import * as auth from './auth.js';
import { Stats } from './stats.js';
import { json, clientIp, extractKey } from './openai.js';
import * as reqlog from './reqlog.js';
import log from './logger.js';
import { ToolCallExtractor } from './toolParser.js';

async function useNative() {
  const mode = process.env.WB_UPSTREAM_MODE || 'auto';
  if (mode === 'native') return true;
  if (mode === 'web') return false;
  const cred = await wb.getCredentials(pickRegion());
  return cred.ok;
}

function pickRegion() {
  const r = (process.env.WB_REGION || 'cn').toLowerCase();
  return r === 'ai' || r === 'global' ? 'global' : 'cn';
}

export async function handleMessages(req, res, body, ctx) {
  const logId = reqlog.begin({
    protocol: 'anthropic',
    model: models.resolve(body.model || 'glm-5.3'),
    stream: body.stream === true,
    region: pickRegion() === 'global' ? 'ai' : 'cn',
    ip: clientIp(req),
    ua: req.headers['user-agent'],
    apiKey: extractKey(req),
    messages: body.messages,
    tools: body.tools,
    bytesIn: Number(req.headers['content-length']) || 0,
  });
  ctx = { ...ctx, logId };
  if (await useNative()) return nativeMessages(req, res, body, ctx);
  return legacyMessages(req, res, body, ctx);
}

// 原生：转成 OpenAI 格式交给 WorkBuddy，再转回 Anthropic 结构
async function nativeMessages(req, res, body, { limiter, logId }) {
  const stream = body.stream === true;
  const sys = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('\n') : '';
  const messages = (body.messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(''),
  }));
  if (sys) messages.unshift({ role: 'system', content: sys });
  if (!messages.length) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages 不能为空' } });

  const model = models.resolve(body.model || 'glm-5.3');
  const tools = Array.isArray(body.tools)
    ? body.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }))
    : undefined;

  const release = await limiter.acquire();
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const id = 'msg_' + randomUUID().replace(/-/g, '');

  const send = (event, data) => {
    if (!stream) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const payload = { model, messages, stream: true, max_tokens: body.max_tokens, temperature: body.temperature, top_p: body.top_p, tools };
    for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

    const up = await wb.chatCompletions(payload, { signal: ac.signal, region: pickRegion() });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      if (!res.headersSent) return json(res, up.status === 401 ? 401 : 502, { type: 'error', error: { type: 'upstream_error', message: `上游 ${up.status}`, detail: t.slice(0, 400) } });
    }

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      send('ping', { type: 'ping' });
    }

    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    let started = false;
    let toolIdx = 0;
    const toolBuf = new Map();
    let outputTokens = 0;

    const feed = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const d = t.slice(5).trim();
      if (!d || d === '[DONE]') return;
      let j;
      try {
        j = JSON.parse(d);
      } catch {
        return;
      }
      const ch = j.choices?.[0];
      if (!ch) return;
      if (j.usage?.completion_tokens) outputTokens = j.usage.completion_tokens;
      const delta = ch.delta || {};
      if (delta.content) {
        if (stream) {
          if (!started) {
            send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
            started = true;
          }
          send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta.content } });
        }
        text += delta.content;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index ?? toolIdx;
          if (!toolBuf.has(i)) {
            toolBuf.set(i, { id: tc.id || `call_${i}`, name: tc.function?.name || '', args: '' });
            if (stream) {
              send('content_block_start', { type: 'content_block_start', index: (started ? 1 : 0) + [...toolBuf.keys()].indexOf(i), content_block: { type: 'tool_use', id: toolBuf.get(i).id, name: toolBuf.get(i).name, input: {} } });
            }
          }
          const e = toolBuf.get(i);
          if (tc.function?.name && !e.name) e.name = tc.function.name;
          if (tc.function?.arguments) e.args += tc.function.arguments;
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const l of lines) feed(l);
    }
    if (buf) feed(buf);

    const stop = toolBuf.size ? 'tool_use' : 'end_turn';
    if (stream) {
      if (started) send('content_block_stop', { type: 'content_block_stop', index: 0 });
      let k = 0;
      for (const [, e] of toolBuf) {
        const idx = (started ? 1 : 0) + k++;
        let parsed = {};
        try {
          parsed = JSON.parse(e.args || '{}');
        } catch {}
        send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(parsed) } });
        send('content_block_stop', { type: 'content_block_stop', index: idx });
      }
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens || Math.ceil(text.length / 3) } });
      send('message_stop', { type: 'message_stop' });
      res.end();
      if (logId) reqlog.finish(logId, { output: text, tokens: { completion: outputTokens || Math.ceil(text.length / 3) } });
    } else {
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const [, e] of toolBuf) {
        let parsed = {};
        try {
          parsed = JSON.parse(e.args || '{}');
        } catch {}
        content.push({ type: 'tool_use', id: e.id, name: e.name, input: parsed });
      }
      json(res, 200, {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: outputTokens || Math.ceil(text.length / 3) },
      });
      if (logId) reqlog.finish(logId, { output: text, tokens: { completion: outputTokens || Math.ceil(text.length / 3) } });
    }
    Stats.record({ ok: true, model, prompt: 0, completion: outputTokens || Math.ceil(text.length / 3), stream, account: 'native', tools: toolBuf.size });
  } catch (e) {
    if (e.name === 'AbortError') {
      if (logId) reqlog.finish(logId, { status: 'aborted' });
      return;
    }
    log.error('native messages 失败：', e.message);
    Stats.record({ ok: false, model, account: 'native', error: e.message });
    if (logId) reqlog.finish(logId, { status: 'error', error: e.message });
    if (stream && res.headersSent) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: e.message } })}\n\n`);
        res.end();
      } catch {}
      return;
    }
    json(res, e.status || 502, { type: 'error', error: { type: 'upstream_error', message: e.message } });
  } finally {
    release?.();
  }
}

async function legacyMessages(req, res, body, { limiter }) {
  const stream = body.stream === true;
  const sys = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('\n') : '';
  const messages = (body.messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(''),
  }));
  if (sys) messages.unshift({ role: 'system', content: sys });
  if (!messages.length) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages 不能为空' } });

  const model = models.resolve(body.model || 'workbuddy-default');
  const tools = Array.isArray(body.tools) ? body.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) : undefined;
  const normalized = {
    model,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
    tools,
  };

  const release = await limiter.acquire();
  const id = 'msg_' + randomUUID().replace(/-/g, '');
  const extractor = new ToolCallExtractor({ enabled: !!tools, mode: process.env.TOOL_MODE || 'auto' });
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  let text = '';
  let finish = null;
  let usageU = null;
  const toolCalls = [];

  const send = (event, data) => {
    if (!stream) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
      send('ping', { type: 'ping' });
    }

    let started = false;
    for await (const ev of upstream.streamChat(normalized, { signal: ac.signal })) {
      if (ac.signal.aborted) break;
      if (ev.type === 'text') {
        const { toolCalls: calls, plain } = extractor.push(ev.text);
        if (plain) {
          if (stream) {
            if (!started) {
              send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
              started = true;
            }
            send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: plain } });
          }
          text += plain;
        }
        for (const c of calls) {
          toolCalls.push(c);
          if (stream) {
            let args = {};
            try {
              args = JSON.parse(c.function.arguments || '{}');
            } catch {}
            const idx = toolCalls.length; // 1 起的块索引
            send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: c.id, name: c.function.name, input: {} } });
            send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
            send('content_block_stop', { type: 'content_block_stop', index: idx });
          }
        }
      } else if (ev.type === 'usage') usageU = ev.usage;
      else if (ev.type === 'finish') finish = ev.reason;
    }
    const tail = extractor.flush();
    if (tail.plain && stream) {
      if (!started) {
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        started = true;
      }
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: tail.plain } });
      text += tail.plain;
    }
    toolCalls.push(...tail.toolCalls);

    if (stream && started) send('content_block_stop', { type: 'content_block_stop', index: 0 });

    const stop = toolCalls.length ? 'tool_use' : /length|max/.test(String(finish)) ? 'max_tokens' : 'end_turn';
    const inputTokens = Number(usageU?.prompt_tokens || usageU?.input_tokens) || 0;
    const outputTokens = Number(usageU?.completion_tokens || usageU?.output_tokens) || Math.ceil((text.length || 0) / 3);

    const content = [];
    if (text) content.push({ type: 'text', text });
    for (const c of toolCalls) {
      let args = {};
      try {
        args = JSON.parse(c.function.arguments || '{}');
      } catch {}
      content.push({ type: 'tool_use', id: c.id, name: c.function.name, input: args });
    }

    if (stream) {
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    } else {
      json(res, 200, { id, type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: inputTokens || Math.ceil(text.length / 3), output_tokens: outputTokens } });
    }
    Stats.record({ ok: true, model, prompt: inputTokens, completion: outputTokens, stream, account: auth.current().id, tools: toolCalls.length });
  } catch (e) {
    log.error('messages 失败：', e.message);
    Stats.record({ ok: false, model, account: auth.current().id, error: e.message });
    if (stream && res.headersSent) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: e.message } })}\n\n`);
        res.end();
      } catch {}
      return;
    }
    json(res, e.status || 502, { type: 'error', error: { type: e.auth ? 'authentication_error' : 'upstream_error', message: e.message } });
  } finally {
    release?.();
  }
}
