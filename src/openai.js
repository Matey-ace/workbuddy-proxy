// OpenAI 兼容层（/v1/chat/completions）
// 原生模式：直连 WorkBuddy 的 /v2/chat/completions（本身就是 OpenAI SSE），薄转发。
// 兼容模式：走网页端适配层 + 伪 function calling。
import { randomUUID } from 'node:crypto';
import { ToolCallExtractor } from './toolParser.js';
import * as upstream from './upstream.js';
import * as wb from './workbuddy.js';
import * as auth from './auth.js';
import * as models from './models.js';
import { Stats } from './stats.js';
import * as reqlog from './reqlog.js';
import log from './logger.js';

function guessTokens(s) {
  if (!s) return 0;
  const cjk = (s.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  return Math.ceil(cjk * 1.0 + Math.max(0, s.length - cjk) / 4);
}

function promptTokens(messages) {
  let n = 0;
  for (const m of messages || []) {
    n += 4;
    const c = typeof m.content === 'string' ? m.content : (m.content || []).map((x) => x.text || '').join('');
    n += guessTokens(c);
  }
  return n;
}

// 判断走哪条上游；同时决定用国内版还是国际版
async function pickMode() {
  const mode = process.env.WB_UPSTREAM_MODE || 'auto';
  if (mode === 'native') return 'native';
  if (mode === 'web') return 'web';
  const cred = await wb.getCredentials(pickRegion());
  return cred.ok ? 'native' : 'web';
}

// 区域：默认国内版；WB_REGION=ai/global 用国际版
export function pickRegion() {
  const r = (process.env.WB_REGION || 'cn').toLowerCase();
  return r === 'ai' || r === 'global' ? 'global' : 'cn';
}

export async function handleChatCompletions(req, res, body, ctx) {
  const stream = body.stream === true || body.stream === 'true';
  const mode = await pickMode();
  const region = pickRegion();
  // 记录请求
  const logId = reqlog.begin({
    protocol: 'openai',
    model: models.resolve(body.model || 'glm-5.3'),
    stream,
    region: region === 'global' ? 'ai' : 'cn',
    ip: clientIp(req),
    ua: req.headers['user-agent'],
    apiKey: extractKey(req),
    messages: body.messages,
    tools: body.tools,
    bytesIn: Number(req.headers['content-length']) || 0,
  });
  ctx = { ...ctx, logId };
  if (mode === 'native') return nativeChat(req, res, body, { ...ctx, stream, region });
  return legacyChat(req, res, body, { ...ctx, stream });
}

export function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

export function extractKey(req) {
  const h = req.headers.authorization || '';
  const k = h.replace(/^Bearer\s+/i, '').trim() || req.headers['x-api-key'] || '';
  return typeof k === 'string' ? k : '';
}

// ---------------- 原生模式：薄转发 ----------------
async function nativeChat(req, res, body, { limiter, stream, region, logId }) {
  const model = models.resolve(body.model || 'glm-5.3');
  const release = await limiter.acquire();
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  // 直接透传上游支持的标准字段；国际版约束由 prepareBody 处理
  const payload = {
    model,
    messages: body.messages,
    stream: true, // 上游统一用流，非流式由我们聚合（国际版也只支持流）
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens ?? body.max_completion_tokens,
    tools: body.tools,
    tool_choice: body.tool_choice,
    reasoning_effort: body.reasoning_effort,
  };
  for (const k of Object.keys(payload)) if (payload[k] === undefined) delete payload[k];

  const id = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24);
  const created = Math.floor(Date.now() / 1000);
  let accText = ''; // 累积输出，用于日志
  let firstTokenAt = null;

  try {
    const up = await wb.chatCompletions(payload, { signal: ac.signal, region });
    if (!up.ok) {
      const txt = await up.text().catch(() => '');
      log.error(`WorkBuddy 上游 ${up.status}: ${txt.slice(0, 300)}`);
      Stats.record({ ok: false, model, account: 'native', error: `upstream ${up.status}` });
      if (logId) reqlog.finish(logId, { status: 'error', error: `上游 ${up.status}: ${txt.slice(0, 300)}` });
      return json(res, up.status === 401 ? 401 : 502, {
        error: { message: `WorkBuddy 上游返回 ${up.status}`, type: 'upstream_error', detail: txt.slice(0, 500) },
      });
    }

    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      // 原样管道转发（上游已是 OpenAI SSE 格式）
      const reader = up.body.getReader();
      const dec = new TextDecoder();
      let prompt = promptTokens(body.messages);
      let completion = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value, { stream: true });
        // 过滤心跳注释行
        const cleaned = chunk
          .split('\n')
          .filter((l) => !/^:\s*heartbeat/.test(l.trim()) && l.trim() !== ':')
          .join('\n');
        if (cleaned.trim()) {
          if (!firstTokenAt) {
            firstTokenAt = Date.now();
            if (logId) reqlog.update(logId, { tFirstToken: firstTokenAt - (reqlog.get(logId)?.at || firstTokenAt) });
          }
          // 收集正文用于日志
          for (const l of cleaned.split('\n')) {
            const t = l.trim();
            if (!t.startsWith('data:')) continue;
            const d = t.slice(5).trim();
            if (!d || d === '[DONE]') continue;
            try {
              const j = JSON.parse(d);
              const c = j.choices?.[0]?.delta?.content;
              if (c) accText += c;
            } catch {}
          }
          completion += guessTokens(cleaned);
          res.write(cleaned.endsWith('\n') ? cleaned : cleaned + '\n');
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
      Stats.record({ ok: true, model, prompt, completion: Math.ceil(completion / 6), stream: true, account: 'native' });
      if (logId) reqlog.finish(logId, { output: accText, tokens: { prompt, completion: Math.ceil(completion / 6) } });
      return;
    }

    // 非流式：聚合上游 SSE
    const text = await up.text();
    let content = '';
    let reasoning = '';
    let finish = 'stop';
    let toolCalls = [];
    let usage = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const d = t.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try {
        const j = JSON.parse(d);
        const ch = j.choices?.[0];
        if (ch?.delta?.content) content += ch.delta.content;
        if (ch?.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
        if (ch?.delta?.tool_calls) toolCalls = toolCalls.concat(ch.delta.tool_calls);
        if (ch?.finish_reason) finish = ch.finish_reason;
        if (j.usage) usage = j.usage;
      } catch {}
    }
    const prompt = promptTokens(body.messages);
    const completion = guessTokens(content + reasoning);
    const msg = { role: 'assistant', content: content || null };
    if (reasoning) msg.reasoning_content = reasoning;
    if (toolCalls.length) {
      msg.tool_calls = toolCalls;
      finish = 'tool_calls';
    }
    json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{ index: 0, message: msg, logprobs: null, finish_reason: finish }],
      usage: usage || { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
      system_fingerprint: 'workbuddy-native',
    });
    Stats.record({ ok: true, model, prompt, completion, stream: false, account: 'native', tools: toolCalls.length });
    if (logId) reqlog.finish(logId, { output: content, reasoning, toolCalls: toolCalls.length ? toolCalls : undefined, tokens: { prompt, completion } });
  } catch (e) {
    if (e.name === 'AbortError') {
      if (logId) reqlog.finish(logId, { status: 'aborted', output: accText });
      return;
    }
    log.error('原生转发失败：', e.message);
    Stats.record({ ok: false, model, account: 'native', error: e.message });
    if (logId) reqlog.finish(logId, { status: 'error', error: e.message, output: accText });
    if (!res.headersSent) {
      json(res, e.status || 502, { error: { message: e.message, type: e.auth ? 'authentication_error' : 'upstream_error' } });
    } else {
      try {
        res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\ndata: [DONE]\n\n`);
        res.end();
      } catch {}
    }
  } finally {
    release?.();
  }
}

// ---------------- 兼容模式：网页端 + 伪工具调用 ----------------
async function legacyChat(req, res, body, { limiter, stream }) {
  const model = models.resolve(body.model || 'workbuddy-default');
  const normalized = {
    model,
    messages: Array.isArray(body.messages) ? body.messages : [],
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
  };
  if (normalized.messages.length === 0) {
    return json(res, 400, { error: { message: 'messages 不能为空', type: 'invalid_request_error' } });
  }
  const sessionKey = body.user || body.session_id || body.conversation_id || '';
  let convId = sessionKey ? upstream.getConvId(sessionKey) : null;

  const release = await limiter.acquire();
  const id = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24);
  const created = Math.floor(Date.now() / 1000);
  const extractor = new ToolCallExtractor({ enabled: !!normalized.tools, mode: process.env.TOOL_MODE || 'auto' });
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  let fullText = '';
  let reasoningText = '';
  let finishReason = null;
  let usageFromUpstream = null;
  const toolCalls = [];

  const chunk = (obj) => {
    if (!stream) return;
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, ...obj })}\n\n`);
  };
  const emit = (text, isReasoning = false) => {
    if (!text || !stream) return;
    chunk({ choices: [{ index: 0, delta: isReasoning ? { reasoning_content: text } : { content: text }, finish_reason: null }] });
  };

  try {
    if (stream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
    }
    for await (const ev of upstream.streamChat(normalized, { convId, signal: ac.signal })) {
      if (ac.signal.aborted) break;
      if (ev.type === 'conv' && sessionKey) upstream.setConvId(sessionKey, ev.id);
      else if (ev.type === 'reasoning') {
        reasoningText += ev.text;
        emit(ev.text, true);
      } else if (ev.type === 'text') {
        fullText += ev.text;
        const { toolCalls: calls, plain } = extractor.push(ev.text);
        if (plain) emit(plain);
        if (calls.length) {
          toolCalls.push(...calls);
          if (stream) for (const c of calls) chunk({ choices: [{ index: 0, delta: { tool_calls: [c] }, finish_reason: null }] });
        }
      } else if (ev.type === 'usage') usageFromUpstream = ev.usage;
      else if (ev.type === 'finish') finishReason = ev.reason;
    }
    const tail = extractor.flush();
    if (tail.plain) {
      fullText += tail.plain;
      emit(tail.plain);
    }
    if (tail.toolCalls.length) {
      toolCalls.push(...tail.toolCalls);
      if (stream) for (const c of tail.toolCalls) chunk({ choices: [{ index: 0, delta: { tool_calls: [c] }, finish_reason: null }] });
    }
    if (toolCalls.length) finishReason = 'tool_calls';
    if (!finishReason) finishReason = 'stop';

    const prompt = promptTokens(normalized.messages);
    const completion = guessTokens(fullText + reasoningText);
    const usage = usageFromUpstream || { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };

    if (stream) {
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage });
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const msg = { role: 'assistant', content: fullText || null };
      if (reasoningText) msg.reasoning_content = reasoningText;
      if (toolCalls.length) msg.tool_calls = toolCalls;
      json(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message: msg, logprobs: null, finish_reason: finishReason }],
        usage,
        system_fingerprint: 'wb-proxy',
      });
    }
    Stats.record({ ok: true, model, prompt: usage.prompt_tokens, completion: usage.completion_tokens, stream, account: auth.current().id, tools: toolCalls.length });
  } catch (e) {
    log.error('legacy chat 失败：', e.message);
    Stats.record({ ok: false, model, account: auth.current().id, error: e.message });
    if (stream && res.headersSent) {
      try {
        res.write(`data: ${JSON.stringify({ error: { message: e.message, type: 'upstream_error' } })}\n\ndata: [DONE]\n\n`);
        res.end();
      } catch {}
      return;
    }
    json(res, e.status || 502, { error: { message: e.message, type: e.auth ? 'authentication_error' : 'upstream_error' } });
  } finally {
    release?.();
  }
}

export function json(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}
