// Ollama 兼容层：/api/chat /api/generate /api/tags /api/version
import { randomUUID } from 'node:crypto';
import * as upstream from './upstream.js';
import * as wb from './workbuddy.js';
import * as models from './models.js';
import * as auth from './auth.js';
import { Stats } from './stats.js';
import { json, clientIp, extractKey } from './openai.js';
import * as reqlog from './reqlog.js';
import log from './logger.js';

async function* ndjson(req, res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const c of req) {
    buf += decoder.decode(c, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try {
          yield JSON.parse(line);
        } catch {}
      }
    }
  }
}

function pickRegion() {
  const r = (process.env.WB_REGION || 'cn').toLowerCase();
  return r === 'ai' || r === 'global' ? 'global' : 'cn';
}

async function useNative() {
  const mode = process.env.WB_UPSTREAM_MODE || 'auto';
  if (mode === 'native') return true;
  if (mode === 'web') return false;
  const cred = await wb.getCredentials(pickRegion());
  return cred.ok;
}

export async function handleOllamaChat(req, res, body, ctx) {
  const logId = reqlog.begin({
    protocol: 'ollama',
    model: models.resolve(body.model || 'glm-5.3'),
    stream: body.stream !== false,
    region: pickRegion() === 'global' ? 'ai' : 'cn',
    ip: clientIp(req),
    ua: req.headers['user-agent'],
    apiKey: extractKey(req),
    messages: body.messages,
    bytesIn: Number(req.headers['content-length']) || 0,
  });
  ctx = { ...ctx, logId };
  if (await useNative()) return nativeOllamaChat(req, res, body, ctx);
  return legacyOllamaChat(req, res, body, ctx);
}

async function nativeOllamaChat(req, res, body, { limiter, logId }) {
  const messages = (body.messages || []).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content ?? '') }));
  if (body.system) messages.unshift({ role: 'system', content: body.system });
  if (!messages.length) return json(res, 400, { error: 'messages 不能为空' });

  const model = models.resolve(body.model || 'glm-5.3');
  const stream = body.stream !== false;
  const release = await limiter.acquire();
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  try {
    const up = await wb.chatCompletions({ model, messages, stream: true }, { signal: ac.signal, region: pickRegion() });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      if (logId) reqlog.finish(logId, { status: 'error', error: `上游 ${up.status}: ${t.slice(0, 200)}` });
      return json(res, up.status === 401 ? 401 : 502, { error: `上游 ${up.status}: ${t.slice(0, 200)}` });
    }
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    }
    const started = Date.now();
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    const feed = (line) => {
      const t = line.trim();
      if (!t.startsWith('data:')) return;
      const d = t.slice(5).trim();
      if (!d || d === '[DONE]') return;
      try {
        const j = JSON.parse(d);
        const c = j.choices?.[0]?.delta?.content;
        if (c) {
          text += c;
          if (stream) res.write(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: c }, done: false }) + '\n');
        }
      } catch {}
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
    const dur = Date.now() - started;
    const fin = { model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: dur * 1e6, load_duration: 0, prompt_eval_count: 0, eval_count: Math.ceil(text.length / 3) };
    if (stream) {
      res.write(JSON.stringify(fin) + '\n');
      res.end();
    } else {
      json(res, 200, { ...fin, message: { role: 'assistant', content: text } });
    }
    Stats.record({ ok: true, model, prompt: 0, completion: Math.ceil(text.length / 3), stream, account: 'native' });
    if (logId) reqlog.finish(logId, { output: text, tokens: { completion: Math.ceil(text.length / 3) } });
  } catch (e) {
    if (e.name === 'AbortError') {
      if (logId) reqlog.finish(logId, { status: 'aborted' });
      return;
    }
    log.error('native ollama 失败：', e.message);
    Stats.record({ ok: false, model, account: 'native', error: e.message });
    if (logId) reqlog.finish(logId, { status: 'error', error: e.message });
    if (stream && res.headersSent) {
      try {
        res.write(JSON.stringify({ error: e.message, done: true }) + '\n');
        res.end();
      } catch {}
      return;
    }
    json(res, 502, { error: e.message });
  } finally {
    release?.();
  }
}

async function legacyOllamaChat(req, res, body, { limiter }) {
  const messages = (body.messages || []).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content ?? '') }));
  if (body.system) messages.unshift({ role: 'system', content: body.system });
  if (!messages.length) return json(res, 400, { error: 'messages 不能为空' });

  const model = models.resolve(body.model || 'workbuddy-default');
  const stream = body.stream !== false; // Ollama 默认流式
  const release = await limiter.acquire();
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  let text = '';
  let done = null;
  try {
    if (stream) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const started = Date.now();
    for await (const ev of upstream.streamChat({ model, messages, options: body.options }, { signal: ac.signal })) {
      if (ac.signal.aborted) break;
      if (ev.type === 'text') {
        text += ev.text;
        if (stream) res.write(JSON.stringify({ model, created_at: new Date().toISOString(), message: { role: 'assistant', content: ev.text }, done: false }) + '\n');
      } else if (ev.type === 'finish') done = ev.reason;
    }
    const dur = Date.now() - started;
    if (stream) {
      res.write(
        JSON.stringify({
          model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: /length|max/.test(String(done)) ? 'length' : 'stop',
          total_duration: dur * 1e6,
          load_duration: 0,
          prompt_eval_count: 0,
          eval_count: Math.ceil(text.length / 3),
        }) + '\n'
      );
      res.end();
    } else {
      json(res, 200, {
        model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: text },
        done: true,
        done_reason: /length|max/.test(String(done)) ? 'length' : 'stop',
        total_duration: dur * 1e6,
        eval_count: Math.ceil(text.length / 3),
      });
    }
    Stats.record({ ok: true, model, prompt: 0, completion: Math.ceil(text.length / 3), stream, account: auth.current().id });
  } catch (e) {
    log.error('ollama chat 失败：', e.message);
    Stats.record({ ok: false, model, account: auth.current().id, error: e.message });
    if (stream && res.headersSent) {
      try {
        res.write(JSON.stringify({ error: e.message, done: true }) + '\n');
        res.end();
      } catch {}
      return;
    }
    json(res, e.status || 502, { error: e.message });
  } finally {
    release?.();
  }
}

export async function handleOllamaGenerate(req, res, body, ctx) {
  const prompt = body.prompt || '';
  return handleOllamaChat(req, res, { ...body, messages: [{ role: 'user', content: prompt }] }, ctx);
}

export function handleOllamaTags(res) {
  const list = models.list();
  json(res, 200, {
    models: list.map((m) => ({
      name: m.id,
      model: m.id,
      modified_at: new Date().toISOString(),
      size: 0,
      digest: 'sha256:' + '0'.repeat(12),
      details: { family: 'workbuddy', parameter_size: 'unknown', quantization_level: 'none' },
    })),
  });
}

export function handleOllamaVersion(res) {
  json(res, 200, { version: '0.5.0-workbuddy-proxy' });
}
