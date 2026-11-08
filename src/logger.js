// 轻量日志：INFO / WARN / ERROR + 环形缓冲（供管理台实时查看）
const RING_SIZE = Number.parseInt(process.env.LOG_RING || '500', 10);
const ring = [];

function stamp() {
  return new Date().toISOString();
}
function push(level, args) {
  const line = `[${stamp()}] [${level}] ` + args.map((a) => (typeof a === 'string' ? a : safe(a))).join(' ');
  ring.push({ ts: Date.now(), level, line });
  if (ring.length > RING_SIZE) ring.shift();
  const out = level === 'ERROR' ? console.error : console.log;
  out(line);
  return line;
}
function safe(a) {
  try {
    return JSON.stringify(a, (k, v) => (k.toLowerCase().includes('cookie') || k.toLowerCase().includes('authorization') ? '***' : v));
  } catch {
    return String(a);
  }
}

export const log = {
  info: (...a) => push('INFO', a),
  warn: (...a) => push('WARN', a),
  error: (...a) => push('ERROR', a),
  debug: (...a) => {
    if (process.env.DEBUG) push('DEBUG', a);
  },
  ring: () => ring.slice(),
};

export default log;
