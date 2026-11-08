// 模型目录：上游模型 + 别名映射 + 兜底
import { UPSTREAM, DATA_DIR } from './config.js';
import fs from 'node:fs';
import path from 'node:path';
import log from './logger.js';

const file = path.join(DATA_DIR, 'models.json');

const DEFAULTS = ['workbuddy-default', 'workbuddy-pro', 'workbuddy-fast', 'workbuddy-vision'];

let runtime = { ids: [], aliases: {}, updatedAt: 0, source: 'default' };

export function setAliases(aliases) {
  runtime.aliases = aliases || {};
  save();
}

export function setModels(ids, source = 'upstream') {
  if (Array.isArray(ids) && ids.length) {
    runtime.ids = ids;
    runtime.updatedAt = Date.now();
    runtime.source = source;
    save();
  }
}

export function resetModels() {
  runtime.ids = DEFAULTS.slice();
  runtime.source = 'default';
  runtime.updatedAt = 0;
  save();
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(runtime, null, 2), 'utf8');
  } catch (e) {
    log.warn('模型目录保存失败：', e.message);
  }
}

export function load() {
  try {
    if (fs.existsSync(file)) Object.assign(runtime, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {}
  const aliasEnv = process.env.WB_MODEL_ALIAS;
  if (aliasEnv) {
    try {
      runtime.aliases = { ...runtime.aliases, ...JSON.parse(aliasEnv) };
    } catch {}
  }
  if (!runtime.ids.length) {
    runtime.ids = DEFAULTS.slice();
    runtime.source = 'default';
  }
  return runtime;
}

// 把调用方的 model 映射到上游真实模型 id
export function resolve(model) {
  const m = String(model || '').trim();
  if (!m) return UPSTREAM.defaultModel;
  if (runtime.aliases[m]) return runtime.aliases[m];
  // 精确命中
  if (runtime.ids.includes(m)) return m;
  // 前缀/模糊匹配：gpt-4o -> 命中最相近的上游模型
  const lower = m.toLowerCase();
  const hit = runtime.ids.find((x) => x.toLowerCase() === lower) || runtime.ids.find((x) => x.toLowerCase().includes(lower));
  return hit || m;
}

export function list() {
  const ids = runtime.ids.length ? runtime.ids : DEFAULTS;
  return ids.map((id) => ({ id, object: 'model', created: Math.floor(runtime.updatedAt / 1000) || 1700000000, owned_by: 'workbuddy' }));
}

export function source() {
  return runtime.source || 'default';
}

export function raw() {
  return runtime;
}
