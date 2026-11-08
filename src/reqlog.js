// 请求日志：记录每一次 API 调用（入参/出参/耗时/用量/来源）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LOG_FILE = path.join(DATA_DIR, 'requests.jsonl');
const MAX_MEM = 500;

// 内存环形缓冲（管理台实时看）
let ring = [];
let seq = 0;

// 启动时从文件尾部恢复最近 N 条
try {
  if (fs.existsSync(LOG_FILE)) {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-MAX_MEM);
    for (const l of lines) {
      try {
        const o = JSON.parse(l);
        ring.push(o);
        if (o.id > seq) seq = o.id;
      } catch {}
    }
  }
} catch {}

function truncate(s, n) {
  if (s == null) return s;
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  return str.length > n ? str.slice(0, n) + `…(+${str.length - n})` : str;
}

function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => ({
    role: m.role,
    text: truncate(typeof m.content === 'string' ? m.content : (m.content || []).map((c) => c.text || '').join(''), 2000),
    hasImage: Array.isArray(m.content) && m.content.some((c) => c.type === 'image_url' || c.type === 'image'),
    toolCalls: m.tool_calls ? m.tool_calls.map((t) => t.function?.name) : undefined,
  }));
}

/**
 * 记录一次请求。
 * 返回 id，供流式场景后续 update 补全输出。
 */
export function begin(entry) {
  const id = ++seq;
  const rec = {
    id,
    at: Date.now(),
    protocol: entry.protocol,
    model: entry.model,
    stream: !!entry.stream,
    region: entry.region || 'cn',
    source: entry.source || 'unknown', // 来源：IP / UA 摘要
    ip: entry.ip,
    ua: truncate(entry.ua, 160),
    apiKey: entry.apiKey ? entry.apiKey.slice(0, 8) + '…' : '', // 只存前缀，避免泄露
    messages: summarizeMessages(entry.messages),
    tools: entry.tools?.length || 0,
    status: 'pending',
    tFirstToken: null,
    tDone: null,
    output: '',
    tokens: null,
    error: null,
    bytesIn: entry.bytesIn || 0,
  };
  ring.push(rec);
  if (ring.length > MAX_MEM) ring.shift();
  return id;
}

export function update(id, patch) {
  const rec = ring.find((r) => r.id === id);
  if (!rec) return;
  Object.assign(rec, patch);
  if (patch.output !== undefined) rec.output = truncate(patch.output, 20000);
}

export function finish(id, patch) {
  const rec = ring.find((r) => r.id === id);
  if (!rec) return;
  Object.assign(rec, patch, { status: patch.status || (patch.error ? 'error' : 'ok'), tDone: Date.now() });
  if (patch.output !== undefined) rec.output = truncate(patch.output, 20000);
  rec.durationMs = rec.tDone - rec.at;
  // 落盘（追加）
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch {}
}

export function list({ limit = 100, offset = 0 } = {}) {
  const arr = ring.slice().reverse();
  return arr.slice(offset, offset + limit);
}

export function get(id) {
  return ring.find((r) => r.id === Number(id)) || null;
}

export function clear() {
  ring = [];
  try {
    fs.writeFileSync(LOG_FILE, '', 'utf8');
  } catch {}
}

export function stats() {
  const now = Date.now();
  const last1m = ring.filter((r) => now - r.at < 60000).length;
  const last5m = ring.filter((r) => now - r.at < 300000).length;
  return { total: seq, last1m, last5m, kept: ring.length };
}
