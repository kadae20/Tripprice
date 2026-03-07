#!/usr/bin/env node
/**
 * agoda-report-parse.js
 * Agoda Partners CSV → KPI JSON 파싱.
 *
 * 입력: downloads/agoda/{YYYY-MM}/report.csv
 * 출력: downloads/agoda/{YYYY-MM}/kpi.json
 *
 * 사용법:
 *   node scripts/agoda-report-parse.js --month=2026-02
 *   node scripts/agoda-report-parse.js --file=downloads/agoda/2026-02/report.csv
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const month   = args.month || new Date().toISOString().slice(0, 7);
const csvPath = args.file
  ? path.resolve(ROOT, args.file)
  : path.join(ROOT, 'downloads', 'agoda', month, 'report.csv');

if (!fs.existsSync(csvPath)) {
  console.error(`CSV 파일 없음: ${csvPath}`);
  console.error(`  먼저 agoda-report-download.js --month=${month} 실행`);
  process.exit(1);
}

// ── CSV 파서 (의존성 없음) ────────────────────────────────────────────────────
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));

  return lines.slice(1).map(line => {
    const vals = splitCsvLine(line);
    const row  = {};
    headers.forEach((h, i) => { row[h] = vals[i] ? vals[i].trim().replace(/^"|"$/g, '') : ''; });
    return row;
  });
}

function splitCsvLine(line) {
  const result = [];
  let   cur    = '';
  let   inQ    = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (ch === ',' && !inQ) {
      result.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function toNum(v) {
  if (!v) return 0;
  const n = parseFloat(String(v).replace(/,/g, '').replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ── Agoda CSV 컬럼 매핑 (파트너스 리포트 기준) ────────────────────────────────
// Agoda 리포트 컬럼명은 계정/설정에 따라 다를 수 있음.
// 일반적 컬럼: clicks, bookings, commission, revenue, cancellations 등
const COLUMN_CANDIDATES = {
  clicks:    ['clicks', 'click', 'total_clicks'],
  bookings:  ['bookings', 'booking', 'confirmed_bookings', 'total_bookings'],
  revenue:   ['commission', 'total_commission', 'revenue', 'estimated_revenue', 'net_revenue'],
  cancels:   ['cancellations', 'cancelled', 'cancelled_bookings'],
};

function resolveColumn(headers, candidates) {
  for (const c of candidates) {
    const found = headers.find(h => h === c || h.includes(c));
    if (found) return found;
  }
  return null;
}

// ── 파싱 ──────────────────────────────────────────────────────────────────────
const csvText = fs.readFileSync(csvPath, 'utf8');
const rows    = parseCsv(csvText);

if (rows.length === 0) {
  console.error('CSV 데이터 없음 또는 헤더만 있음');
  process.exit(1);
}

const headers = Object.keys(rows[0]);
const colMap  = {
  clicks:   resolveColumn(headers, COLUMN_CANDIDATES.clicks),
  bookings: resolveColumn(headers, COLUMN_CANDIDATES.bookings),
  revenue:  resolveColumn(headers, COLUMN_CANDIDATES.revenue),
  cancels:  resolveColumn(headers, COLUMN_CANDIDATES.cancels),
};

// 합산
let totalClicks   = 0;
let totalBookings = 0;
let totalRevenue  = 0;
let totalCancels  = 0;

for (const row of rows) {
  totalClicks   += colMap.clicks   ? toNum(row[colMap.clicks])   : 0;
  totalBookings += colMap.bookings ? toNum(row[colMap.bookings]) : 0;
  totalRevenue  += colMap.revenue  ? toNum(row[colMap.revenue])  : 0;
  totalCancels  += colMap.cancels  ? toNum(row[colMap.cancels])  : 0;
}

const serverCost = parseInt(process.env.SERVER_COST_MONTHLY_KRW || '20000', 10);

const kpi = {
  month,
  parsed_at:        new Date().toISOString(),
  rows:             rows.length,
  clicks:           Math.round(totalClicks),
  bookings:         Math.round(totalBookings),
  cancels:          Math.round(totalCancels),
  revenue_raw:      totalRevenue,
  revenue_krw:      Math.round(totalRevenue),  // USD → KRW 변환 필요 시 환율 추가
  server_cost_krw:  serverCost,
  net_krw:          Math.round(totalRevenue) - serverCost,
  column_mapping:   colMap,
  source_file:      path.relative(ROOT, csvPath),
};

// ── 출력 저장 ─────────────────────────────────────────────────────────────────
const outDir  = path.dirname(csvPath);
const outPath = path.join(outDir, 'kpi.json');
fs.writeFileSync(outPath, JSON.stringify(kpi, null, 2), 'utf8');

console.log(`\nAgoda 리포트 파싱 완료`);
console.log(`  월: ${month}  |  행: ${rows.length}`);
console.log(`  클릭: ${kpi.clicks}  |  예약: ${kpi.bookings}  |  취소: ${kpi.cancels}`);
console.log(`  수익: ${kpi.revenue_krw.toLocaleString()}원  |  서버: ${serverCost.toLocaleString()}원  |  순이익: ${kpi.net_krw.toLocaleString()}원`);
console.log(`  파일: ${path.relative(ROOT, outPath)}`);
