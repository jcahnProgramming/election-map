const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const min = LEVELS[process.env.LOG_LEVEL ?? 'info'] ?? 20;

function emit(level, scope, msg, extra) {
  if (LEVELS[level] < min) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  extra === undefined ? out(line) : out(line, extra);
}

export const logger = (scope) => ({
  debug: (m, x) => emit('debug', scope, m, x),
  info: (m, x) => emit('info', scope, m, x),
  warn: (m, x) => emit('warn', scope, m, x),
  error: (m, x) => emit('error', scope, m, x),
});
