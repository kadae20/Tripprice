#!/usr/bin/env node
/**
 * notion-upsert-kpi.js
 * Notion 데이터베이스에 월간 KPI 페이지를 생성하거나 업데이트.
 *
 * 입력: downloads/agoda/{YYYY-MM}/kpi.json
 * 동작: 같은 month 페이지가 있으면 업데이트, 없으면 생성
 *
 * 사용법:
 *   node scripts/notion-upsert-kpi.js --month=2026-02
 *
 * 환경변수:
 *   NOTION_API_KEY       — 필수 (Integration token)
 *   NOTION_DATABASE_ID   — 필수 (KPI 데이터베이스 ID)
 *
 * Notion DB 컬럼 (Name 타입으로 생성):
 *   Month (title), Clicks (number), Bookings (number), Revenue (number),
 *   ServerCost (number), NetProfit (number), Posts (number), UpdatedAt (rich_text)
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const ROOT = path.join(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const month = args.month || new Date().toISOString().slice(0, 7);

// ── 환경변수 ──────────────────────────────────────────────────────────────────
const NOTION_KEY = process.env.NOTION_API_KEY;
const DB_ID      = process.env.NOTION_DATABASE_ID;

if (!NOTION_KEY || !DB_ID) {
  console.error('오류: NOTION_API_KEY, NOTION_DATABASE_ID 환경변수 필요');
  process.exit(1);
}

// ── KPI 파일 로드 ─────────────────────────────────────────────────────────────
const kpiPath = path.join(ROOT, 'downloads', 'agoda', month, 'kpi.json');
if (!fs.existsSync(kpiPath)) {
  console.error(`KPI 파일 없음: ${kpiPath}`);
  console.error(`  먼저 agoda-report-parse.js --month=${month} 실행`);
  process.exit(1);
}
const kpi = JSON.parse(fs.readFileSync(kpiPath, 'utf8'));

// ── 발행 글 수 (newsroom 로그에서 파싱) ──────────────────────────────────────
function countPublishedPosts(month) {
  const logDir = path.join(ROOT, 'state');
  if (!fs.existsSync(logDir)) return 0;
  const logs = fs.readdirSync(logDir)
    .filter(f => f.startsWith(`newsroom-log-${month}`))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(logDir, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean);
  return logs.reduce((sum, l) => sum + (l.summary?.published || 0), 0);
}

// ── Notion API 헬퍼 ───────────────────────────────────────────────────────────
function notionRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.notion.com',
      path:     `/v1${endpoint}`,
      method,
      headers: {
        'Authorization':  `Bearer ${NOTION_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type':   'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            return reject(new Error(`Notion API ${res.statusCode}: ${JSON.stringify(parsed)}`));
          }
          resolve(parsed);
        } catch {
          reject(new Error(`Notion 응답 파싱 실패: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(new Error('Notion 타임아웃')); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Properties 빌더 ───────────────────────────────────────────────────────────
function buildProperties(kpi, postsPublished) {
  return {
    'Month':       { title:     [{ text: { content: kpi.month } }] },
    'Clicks':      { number:    kpi.clicks },
    'Bookings':    { number:    kpi.bookings },
    'Revenue':     { number:    kpi.revenue_krw },
    'ServerCost':  { number:    kpi.server_cost_krw },
    'NetProfit':   { number:    kpi.net_krw },
    'Posts':       { number:    postsPublished },
    'UpdatedAt':   { rich_text: [{ text: { content: new Date().toISOString() } }] },
  };
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  const postsPublished = countPublishedPosts(month);

  console.log(`\nNotion KPI 업서트`);
  console.log(`  월: ${month}  |  클릭: ${kpi.clicks}  |  예약: ${kpi.bookings}  |  수익: ${kpi.revenue_krw.toLocaleString()}원`);
  console.log(`  발행 글: ${postsPublished}  |  서버비: ${kpi.server_cost_krw.toLocaleString()}원  |  순이익: ${kpi.net_krw.toLocaleString()}원`);

  // 기존 페이지 조회 (Month 필터)
  const query = await notionRequest('POST', `/databases/${DB_ID}/query`, {
    filter: {
      property: 'Month',
      title:    { equals: month },
    },
  });

  const properties = buildProperties(kpi, postsPublished);

  if (query.results && query.results.length > 0) {
    // 업데이트
    const pageId = query.results[0].id;
    await notionRequest('PATCH', `/pages/${pageId}`, { properties });
    console.log(`  업데이트 완료 (페이지 ID: ${pageId})`);
  } else {
    // 생성
    const newPage = await notionRequest('POST', '/pages', {
      parent:     { database_id: DB_ID },
      properties,
    });
    console.log(`  생성 완료 (페이지 ID: ${newPage.id})`);
  }
})().catch(err => {
  console.error('Notion 업서트 실패:', err.message);
  process.exit(1);
});
