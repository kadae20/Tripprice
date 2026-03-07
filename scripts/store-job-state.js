#!/usr/bin/env node
/**
 * store-job-state.js
 * Supabase REST API를 통해 편집국 작업 상태 기록 (선택 모듈).
 *
 * 테이블 DDL (Supabase 대시보드에서 직접 실행):
 *   create table editorial_jobs (
 *     id          bigserial primary key,
 *     date        date        not null,
 *     slug        text        not null,
 *     status      text        not null,  -- 'approved','published','rejected','failed'
 *     lang        text        default 'ko',
 *     source      text,                  -- 'z.ai' or 'template'
 *     score       integer,
 *     created_at  timestamptz default now()
 *   );
 *   create table kpi_monthly (
 *     id              bigserial primary key,
 *     month           text unique not null,  -- YYYY-MM
 *     clicks          integer,
 *     bookings        integer,
 *     revenue_krw     integer,
 *     server_cost_krw integer,
 *     net_krw         integer,
 *     posts_published integer,
 *     updated_at      timestamptz default now()
 *   );
 *
 * 환경변수:
 *   SUPABASE_URL              — 필수
 *   SUPABASE_SERVICE_ROLE_KEY — 필수
 *
 * 모듈 사용:
 *   const { upsertJob, upsertKpi } = require('./store-job-state');
 *   await upsertJob({ date, slug, status, lang, source, score });
 *   await upsertKpi({ month, clicks, bookings, revenue_krw, server_cost_krw, net_krw, posts_published });
 */

'use strict';

const https = require('https');
const http  = require('http');
const { URL } = require('url');

function supabaseRequest(method, table, body, params = '') {
  return new Promise((resolve, reject) => {
    const base   = process.env.SUPABASE_URL;
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !apiKey) {
      return reject(new Error('SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 없음'));
    }

    const fullUrl = new URL(`${base}/rest/v1/${table}${params}`);
    const isHttps = fullUrl.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const options = {
      hostname: fullUrl.hostname,
      port:     fullUrl.port || (isHttps ? 443 : 80),
      path:     fullUrl.pathname + fullUrl.search,
      method,
      headers: {
        'apikey':         apiKey,
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Type':   'application/json',
        'Prefer':         'return=minimal,resolution=merge-duplicates',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Supabase ${res.statusCode}: ${data.slice(0, 200)}`));
        }
        try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
      });
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('Supabase 타임아웃')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function upsertJob({ date, slug, status, lang = 'ko', source = null, score = null }) {
  return supabaseRequest('POST', 'editorial_jobs', { date, slug, status, lang, source, score });
}

async function upsertKpi({ month, clicks, bookings, revenue_krw, server_cost_krw, net_krw, posts_published }) {
  return supabaseRequest('POST', 'kpi_monthly', {
    month, clicks, bookings, revenue_krw, server_cost_krw, net_krw, posts_published,
    updated_at: new Date().toISOString(),
  });
}

module.exports = { upsertJob, upsertKpi };

// ── CLI (테스트용) ────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const today = new Date().toISOString().slice(0, 10);
    await upsertJob({ date: today, slug: 'test-slug', status: 'approved', source: 'z.ai', score: 90 });
    console.log('upsertJob 성공');
    const month = today.slice(0, 7);
    await upsertKpi({ month, clicks: 0, bookings: 0, revenue_krw: 0, server_cost_krw: 20000, net_krw: -20000, posts_published: 0 });
    console.log('upsertKpi 성공');
  })().catch(err => { console.error(err.message); process.exit(1); });
}
