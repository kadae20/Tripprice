#!/usr/bin/env node
/**
 * telegram-send.js
 * Telegram Bot API로 메시지 전송.
 *
 * CLI:
 *   node scripts/telegram-send.js --message="텍스트"
 *   node scripts/telegram-send.js --file=path/to/message.txt
 *
 * 모듈:
 *   const { sendMessage } = require('./telegram-send');
 *   await sendMessage('텍스트');
 *
 * 환경변수:
 *   TELEGRAM_BOT_TOKEN  — 필수
 *   TELEGRAM_CHAT_ID    — 필수
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

function sendMessage(text) {
  return new Promise((resolve, reject) => {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      return reject(new Error('TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수 없음'));
    }

    const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) return reject(new Error(`Telegram 오류: ${JSON.stringify(parsed)}`));
          resolve(parsed);
        } catch {
          reject(new Error(`Telegram 응답 파싱 실패: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('Telegram 타임아웃')); });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendMessage };

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => {
        const eq  = a.indexOf('=');
        const key = a.slice(2, eq > 0 ? eq : undefined);
        const val = eq > 0 ? a.slice(eq + 1) : true;
        return [key, val];
      })
  );

  let text = args.message || '';
  if (!text && args.file) {
    const filePath = path.isAbsolute(args.file)
      ? args.file
      : path.join(process.cwd(), args.file);
    text = fs.readFileSync(filePath, 'utf8').trim();
  }

  if (!text) {
    console.error('오류: --message="텍스트" 또는 --file=경로 옵션 필요');
    process.exit(1);
  }

  sendMessage(text)
    .then(() => { console.log('Telegram 전송 완료'); })
    .catch(err => { console.error('Telegram 전송 실패:', err.message); process.exit(1); });
}
