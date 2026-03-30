'use strict';
/**
 * lib/notify.js
 * Telegram 알림 공유 헬퍼.
 * 환경변수: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * 미설정 시 조용히 스킵 (에러 없음).
 */

const https = require('https');

/**
 * 텍스트 메시지를 Telegram으로 전송.
 * parse_mode: HTML 지원 (<b>, <i>, <code> 등).
 * @param {string} text
 * @returns {Promise<void>}
 */
function send(text) {
  const token  = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID   || '').trim();
  if (!token || !chatId) return Promise.resolve();

  const body = JSON.stringify({
    chat_id:    chatId,
    text:       String(text).slice(0, 4096),
    parse_mode: 'HTML',
  });

  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org',
      port:     443,
      path:     `/bot${token}/sendMessage`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.setTimeout(10_000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

/**
 * 발행 성공 알림.
 * @param {{ title, url, focuskw, postId, slug }} info
 */
function publishAlert(info) {
  const { title, url, focuskw, postId } = info || {};
  const lines = [
    '✅ <b>발행 완료</b>',
    `📄 ${title || '(제목 없음)'}`,
    focuskw ? `🔑 키프레이즈: <code>${focuskw}</code>` : '',
    url     ? `🔗 ${url}` : '',
    postId  ? `🆔 post_id: ${postId}` : '',
  ].filter(Boolean);
  return send(lines.join('\n'));
}

/**
 * 오류 알림.
 * @param {string} context  어느 단계에서 발생한 오류인지
 * @param {string} message  오류 메시지
 */
function errorAlert(context, message) {
  const text = `⚠️ <b>오류: ${context}</b>\n<code>${String(message).slice(0, 300)}</code>`;
  return send(text);
}

/**
 * 일일 KPI 요약 알림.
 * @param {{ date, published, totalPosts, hotels }} summary
 */
function dailyKpi(summary) {
  const { date, published = 0, totalPosts = 0, hotels = [] } = summary || {};
  const lines = [
    `📊 <b>Tripprice 일일 KPI — ${date || new Date().toISOString().slice(0,10)}</b>`,
    ``,
    `📝 오늘 발행: <b>${published}편</b>`,
    `📚 전체 발행: ${totalPosts}편`,
  ];
  if (hotels.length > 0) {
    lines.push('');
    lines.push('🏨 발행 목록:');
    for (const h of hotels) {
      lines.push(`  • ${h.title || h.slug}`);
    }
  }
  lines.push('');
  lines.push('🌐 https://tripprice.net');
  return send(lines.join('\n'));
}

module.exports = { send, publishAlert, errorAlert, dailyKpi };
