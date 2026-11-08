// 用量统计：内存计数 + 落盘（data/stats.json）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const file = path.join(DATA_DIR, 'stats.json');
const DAY = 86400000;

function today() {
  return new Date().toISOString().slice(0, 10);
}

let state = {
  total: { requests: 0, ok: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0 },
  byDay: {},
  byModel: {},
  byAccount: {},
  startedAt: Date.now(),
  lastError: null,
};

class Stats {
  static load() {
    try {
      if (fs.existsSync(file)) {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        state = { ...state, ...j };
      }
    } catch {}
    // 运行时长只统计本次进程，不从历史文件继承
    state.startedAt = Date.now();
    return state;
  }
  static snapshot() {
    return { ...state, uptimeMs: Date.now() - state.startedAt, queue: Stats.queue || null };
  }
  static record({ ok = true, model = 'unknown', prompt = 0, completion = 0, stream = false, account = 'none', tools = 0, error = null }) {
    const d = today();
    state.total.requests++;
    if (ok) state.total.ok++;
    else state.total.failed++;
    state.total.prompt_tokens += prompt || 0;
    state.total.completion_tokens += completion || 0;
    state.byDay[d] = state.byDay[d] || { requests: 0, ok: 0, failed: 0, tokens: 0 };
    state.byDay[d].requests++;
    ok ? state.byDay[d].ok++ : state.byDay[d].failed++;
    state.byDay[d].tokens += (prompt || 0) + (completion || 0);
    state.byModel[model] = state.byModel[model] || { requests: 0, tokens: 0, tools: 0 };
    state.byModel[model].requests++;
    state.byModel[model].tokens += (prompt || 0) + (completion || 0);
    state.byModel[model].tools += tools || 0;
    state.byAccount[account] = state.byAccount[account] || { requests: 0, ok: 0, failed: 0 };
    state.byAccount[account].requests++;
    ok ? state.byAccount[account].ok++ : state.byAccount[account].failed++;
    if (!ok) state.lastError = { at: Date.now(), model, account, error };
    Stats.maybeSave();
  }
  static maybeSave() {
    if (!Stats._t) {
      Stats._t = setTimeout(() => {
        Stats._t = null;
        Stats.save();
      }, 5000);
      Stats._t.unref?.();
    }
  }
  static save() {
    try {
      fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    } catch {}
  }
  static reset() {
    state = { total: { requests: 0, ok: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0 }, byDay: {}, byModel: {}, byAccount: {}, startedAt: Date.now(), lastError: null };
    Stats.save();
  }
}
Stats.load();
export { Stats };
export default Stats;
