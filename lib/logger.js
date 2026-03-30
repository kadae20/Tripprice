'use strict';
/**
 * lib/logger.js
 *
 * 경량 로거. 에러/경고는 logs/errors.log에 기록, 정보 출력은 stdout.
 * console.log 대신 log.info(), 에러는 log.error().
 */

const fs   = require('fs');
const path = require('path');

const LOGS_DIR  = path.join(__dirname, '..', 'logs');
const ERROR_LOG = path.join(LOGS_DIR, 'errors.log');

function timestamp() {
  return new Date().toISOString();
}

function appendErrorLog(level, message, extra) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const line = JSON.stringify({ ts: timestamp(), level, message, ...(extra ? { extra } : {}) });
    fs.appendFileSync(ERROR_LOG, line + '\n', 'utf8');
  } catch { /* 로그 실패는 무시 */ }
}

const log = {
  info(msg)          { process.stdout.write(msg + '\n'); },
  warn(msg, extra)   { process.stderr.write(`[WARN] ${msg}\n`); appendErrorLog('warn', msg, extra); },
  error(msg, extra)  { process.stderr.write(`[ERROR] ${msg}\n`); appendErrorLog('error', msg, extra); },
};

module.exports = log;
