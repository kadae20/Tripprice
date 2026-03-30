'use strict';
/**
 * lib/notion-kpi.js
 * Notion "Tripprice Monthly KPI" 데이터베이스 업데이트.
 *
 * 환경변수:
 *   NOTION_API_KEY       — ntn_... 형식 통합 토큰
 *   NOTION_DATABASE_ID   — dae0662b60ad4cb0a53805671acc583d
 *
 * 스키마 (DB 기준):
 *   Month           (title)   — "2026-04"
 *   Posts Published (number)
 *   Clicks          (number)
 *   Visitors        (number)
 *   Revenue USD     (number)
 *   Bookings        (number)
 *   Server Cost KRW (number)
 *   Notes           (text)
 */

const https = require('https');

const NOTION_VERSION = '2022-06-28';

function getEnv() {
  return {
    apiKey: (process.env.NOTION_API_KEY    || '').trim(),
    dbId:   (process.env.NOTION_DATABASE_ID || '').trim(),
  };
}

/** Notion REST API 호출 헬퍼 */
function notionRequest(method, endpoint, body) {
  const { apiKey } = getEnv();
  if (!apiKey) return Promise.resolve(null);

  const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.notion.com',
      port:     443,
      path:     `/v1/${endpoint}`,
      method,
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type':   'application/json',
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Notion API timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 이번 달 행(page) ID 조회. 없으면 null.
 * @param {string} yearMonth  "2026-04"
 */
async function findMonthPage(yearMonth) {
  const { dbId } = getEnv();
  if (!dbId) return null;

  const res = await notionRequest('POST', `databases/${dbId}/query`, {
    filter: {
      property: 'Month',
      title: { equals: yearMonth },
    },
    page_size: 1,
  });
  return res?.results?.[0]?.id || null;
}

/**
 * 이번 달 행 생성.
 * @param {string} yearMonth
 * @param {object} props  초기값 { posts_published, notes, ... }
 */
async function createMonthPage(yearMonth, props = {}) {
  const { dbId } = getEnv();
  if (!dbId) return null;

  const properties = {
    Month: { title: [{ text: { content: yearMonth } }] },
    'Posts Published': { number: props.posts_published || 0 },
  };
  if (props.notes) {
    properties['Notes'] = { rich_text: [{ text: { content: String(props.notes) } }] };
  }

  const res = await notionRequest('POST', 'pages', {
    parent: { database_id: dbId },
    properties,
  });
  return res?.id || null;
}

/**
 * 기존 행 업데이트.
 * @param {string} pageId
 * @param {object} props  { posts_published_delta, notes, ... }
 * @param {number} currentPosts  현재 Posts Published 값 (delta 적용용)
 */
async function updateMonthPage(pageId, currentPosts, props = {}) {
  const delta      = props.posts_published_delta || 0;
  const newCount   = Math.max(0, (currentPosts || 0) + delta);
  const properties = {
    'Posts Published': { number: newCount },
  };
  if (props.notes) {
    properties['Notes'] = { rich_text: [{ text: { content: String(props.notes) } }] };
  }
  return notionRequest('PATCH', `pages/${pageId}`, { properties });
}

/**
 * 이번 달 Posts Published를 +delta 증가.
 * 행이 없으면 자동 생성.
 *
 * @param {number} delta      증가량 (기본 1)
 * @param {string} [yearMonth]  "YYYY-MM" (기본: 현재 달)
 * @returns {Promise<boolean>} 성공 여부
 */
async function incrementPosts(delta = 1, yearMonth) {
  const { apiKey, dbId } = getEnv();
  if (!apiKey || !dbId) return false;

  const ym = yearMonth || new Date().toISOString().slice(0, 7); // "2026-04"

  try {
    const pageId = await findMonthPage(ym);

    if (pageId) {
      // 현재 값 조회
      const page = await notionRequest('GET', `pages/${pageId}`);
      const currentPosts = page?.properties?.['Posts Published']?.number || 0;
      await updateMonthPage(pageId, currentPosts, { posts_published_delta: delta });
    } else {
      // 새 행 생성
      await createMonthPage(ym, { posts_published: delta });
    }
    return true;
  } catch (e) {
    process.stderr.write(`[notion-kpi] 오류 (계속): ${e.message}\n`);
    return false;
  }
}

/**
 * 이번 달 행 전체 업서트 (월말 정산용).
 * @param {string} yearMonth
 * @param {{ posts_published, clicks, visitors, revenue_usd, bookings, server_cost_krw, notes }} data
 */
async function upsertMonthKpi(yearMonth, data) {
  const { apiKey, dbId } = getEnv();
  if (!apiKey || !dbId) return false;

  try {
    const pageId = await findMonthPage(yearMonth);
    const properties = {
      'Month':           { title: [{ text: { content: yearMonth } }] },
    };
    if (data.posts_published != null) properties['Posts Published'] = { number: data.posts_published };
    if (data.clicks         != null) properties['Clicks']           = { number: data.clicks };
    if (data.visitors       != null) properties['Visitors']         = { number: data.visitors };
    if (data.revenue_usd    != null) properties['Revenue USD']      = { number: data.revenue_usd };
    if (data.bookings       != null) properties['Bookings']         = { number: data.bookings };
    if (data.server_cost_krw != null) properties['Server Cost KRW'] = { number: data.server_cost_krw };
    if (data.notes          != null) properties['Notes']            = { rich_text: [{ text: { content: String(data.notes) } }] };

    if (pageId) {
      await notionRequest('PATCH', `pages/${pageId}`, { properties });
    } else {
      const { dbId: database_id } = getEnv();
      await notionRequest('POST', 'pages', { parent: { database_id }, properties });
    }
    return true;
  } catch (e) {
    process.stderr.write(`[notion-kpi] upsert 오류 (계속): ${e.message}\n`);
    return false;
  }
}

module.exports = { incrementPosts, upsertMonthKpi, findMonthPage };
