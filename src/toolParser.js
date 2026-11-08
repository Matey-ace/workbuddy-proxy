// 把模型输出的伪 function-calling（提示词注入的 JSON）解析成 OpenAI tool_calls
let seq = 0;
function nextId(prefix = 'call') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

function tryParse(s) {
  if (!s) return null;
  // 容忍尾随逗号
  try {
    return JSON.parse(s);
  } catch {}
  try {
    return JSON.parse(s.replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return null;
  }
}

const MAX_BUFFER = 256 * 1024;

/**
 * 增量解析器：喂入文本分片，返回 { toolCalls, plain }
 * 只有完整闭合的 JSON / ```json 代码块才会触发工具调用。
 */
export class ToolCallExtractor {
  constructor({ enabled = false, mode = 'auto' } = {}) {
    this.enabled = enabled;
    this.mode = mode; // fence | json | auto
    this.buffer = '';
    this.emitted = 0;
  }

  push(text) {
    if (!this.enabled) return { toolCalls: [], plain: text };
    this.buffer += text;
    const toolCalls = [];
    this.buffer = this.#extractFences(this.buffer, toolCalls);
    this.buffer = this.#extractJson(this.buffer, toolCalls);
    const hold = pendingPrefix(this.buffer);
    const cut = Math.max(0, this.buffer.length - hold);
    const plain = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    if (this.buffer.length > MAX_BUFFER) {
      // 防御：长时间等不到闭合，直接当普通文本吐出
      const dump = this.buffer;
      this.buffer = '';
      return { toolCalls, plain: plain + dump };
    }
    this.emitted += toolCalls.length;
    return { toolCalls, plain };
  }

  flush() {
    if (!this.enabled) {
      const p = this.buffer;
      this.buffer = '';
      return { toolCalls: [], plain: p };
    }
    const obj = tryParse(this.buffer);
    const calls = obj ? normalize(obj) : [];
    const plain = calls.length ? '' : this.buffer;
    this.buffer = '';
    this.emitted += calls.length;
    return { toolCalls: calls, plain };
  }

  #extractFences(buf, out) {
    if (this.mode === 'json') return buf;
    const re = /```(?:json|jsonc)?\s*([\s\S]*?)```/g;
    let res = '';
    let last = 0;
    let m;
    while ((m = re.exec(buf))) {
      const obj = tryParse(m[1].trim());
      const calls = obj ? normalize(obj) : [];
      if (calls.length) {
        res += buf.slice(last, m.index);
        out.push(...calls);
        last = re.lastIndex;
      }
      // 非工具调用的代码块保持原样
    }
    res += buf.slice(last);
    return res;
  }

  #extractJson(buf, out) {
    if (this.mode === 'fence') return buf;
    let guard = 0;
    while (guard++ < 200) {
      const start = buf.indexOf('{');
      if (start < 0) break;
      const end = findClose(buf, start);
      if (end < 0) break; // 未闭合，等下一片
      const slice = buf.slice(start, end + 1);
      const calls = normalize(tryParse(slice));
      if (calls.length) {
        out.push(...calls);
        buf = buf.slice(0, start) + buf.slice(end + 1);
      } else {
        // 不是工具调用：把这一段原样保护起来，继续往后找
        buf = buf.slice(0, start) + '\u0000' + buf.slice(start + 1);
        if (buf.indexOf('{') < 0) break;
      }
    }
    return buf.replace(/\u0000/g, '{');
  }
}

function findClose(buf, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 尾部是否可能是一个尚未完整到达的 JSON / 代码块前缀
function pendingPrefix(buf) {
  if (!buf) return 0;
  const t = buf.trimEnd();
  const ws = buf.length - t.length;
  const fence = t.lastIndexOf('```');
  if (fence >= 0 && !t.slice(fence + 3).includes('```')) {
    return t.length - fence + ws;
  }
  const brace = t.lastIndexOf('{');
  if (brace >= 0) {
    const s = t.slice(brace);
    if (s.length < 8192 && !s.includes('}')) return s.length + ws;
  }
  return 0;
}

function normalize(obj) {
  if (!obj || typeof obj !== 'object') return [];
  let calls = null;
  if (Array.isArray(obj.tool_calls)) calls = obj.tool_calls;
  else if (Array.isArray(obj.toolCalls)) calls = obj.toolCalls;
  else if (obj.function_call) calls = [obj.function_call];
  else if (obj.name && (obj.arguments !== undefined || obj.parameters !== undefined || obj.args !== undefined)) calls = [obj];
  else if (obj.function && obj.function.name) calls = [obj];
  if (!calls) return [];
  return calls
    .filter(Boolean)
    .map((c) => {
      if (c.function) {
        const f = c.function;
        return { id: c.id || nextId(), type: 'function', function: { name: f.name, arguments: stringifyArgs(f.arguments ?? f.parameters) } };
      }
      return { id: c.id || nextId(), type: 'function', function: { name: c.name, arguments: stringifyArgs(c.arguments ?? c.parameters ?? c.args) } };
    })
    .filter((c) => c.function && c.function.name);
}

function stringifyArgs(a) {
  if (a === undefined || a === null) return '{}';
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return '{}';
  }
}

export const __test = { tryParse, normalize, pendingPrefix, findClose };
