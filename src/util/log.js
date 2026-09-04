'use strict';

const COLORS = { info: '', warn: '\x1b[33m', error: '\x1b[31m', ok: '\x1b[32m', dim: '\x1b[2m' };
const RESET = '\x1b[0m';

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, scope, ...args) {
  const c = COLORS[level] || '';
  const head = `${stamp()} [${scope}]`;
  console.log(c ? `${c}${head}${RESET}` : head, ...args);
}

function logger(scope) {
  return {
    info: (...a) => emit('info', scope, ...a),
    ok: (...a) => emit('ok', scope, ...a),
    warn: (...a) => emit('warn', scope, ...a),
    error: (...a) => emit('error', scope, ...a),
    dim: (...a) => emit('dim', scope, ...a),
  };
}

module.exports = { logger };
