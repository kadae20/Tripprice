#!/usr/bin/env node
/**
 * agoda-report-download.js
 * Playwright로 Agoda Partners 포털에 로그인 후 월별 실적 CSV 다운로드.
 *
 * 출력: downloads/agoda/{YYYY-MM}/report.csv
 *
 * 사용법:
 *   node scripts/agoda-report-download.js --month=2026-02
 *   node scripts/agoda-report-download.js  # 이전 달 기본값
 *
 * 환경변수:
 *   AGODA_PARTNER_EMAIL     — 필수
 *   AGODA_PARTNER_PASSWORD  — 필수
 *
 * 의존성 설치:
 *   npm install --save-dev playwright
 *   npx playwright install chromium
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

// 기본: 이전 달
function prevMonth() {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return d.toISOString().slice(0, 7);
}

const month = args.month || prevMonth();  // YYYY-MM

// 월 → 시작/끝 날짜
const [year, mon] = month.split('-').map(Number);
const startDate   = `${month}-01`;
const endDate     = new Date(year, mon, 0).toISOString().slice(0, 10);  // 말일

const outDir  = path.join(ROOT, 'downloads', 'agoda', month);
const outPath = path.join(outDir, 'report.csv');

// ── 환경변수 확인 ─────────────────────────────────────────────────────────────
const email    = process.env.AGODA_PARTNER_EMAIL;
const password = process.env.AGODA_PARTNER_PASSWORD;

if (!email || !password) {
  console.error('오류: AGODA_PARTNER_EMAIL, AGODA_PARTNER_PASSWORD 환경변수 필요');
  process.exit(1);
}

// ── Playwright 존재 여부 확인 ─────────────────────────────────────────────────
let playwright;
try {
  playwright = require('playwright');
} catch {
  console.error('오류: playwright가 설치되지 않았습니다.');
  console.error('  npm install --save-dev playwright');
  console.error('  npx playwright install chromium');
  process.exit(1);
}

// ── 다운로드 디렉토리 준비 ────────────────────────────────────────────────────
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\nAgoda Partners 리포트 다운로드`);
  console.log(`  월: ${month}  (${startDate} ~ ${endDate})`);
  console.log(`  출력: ${path.relative(ROOT, outPath)}`);

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale:          'ko-KR',
  });
  const page = await context.newPage();

  try {
    // 1) 로그인 페이지
    console.log('  로그인 중...');
    await page.goto('https://partners.agoda.com/en-us/affiliates/login.aspx', {
      waitUntil: 'networkidle', timeout: 30_000,
    });

    await page.fill('input[name="Email"], input[type="email"], #email', email);
    await page.fill('input[name="Password"], input[type="password"], #password', password);
    await page.click('button[type="submit"], input[type="submit"], .login-btn');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30_000 });

    const url = page.url();
    if (url.includes('login') || url.includes('signin')) {
      throw new Error('로그인 실패 — 자격증명 또는 2FA 확인 필요');
    }
    console.log('  로그인 성공');

    // 2) 리포트 페이지 이동
    console.log('  리포트 페이지 이동...');
    await page.goto('https://partners.agoda.com/en-us/affiliates/reports.aspx', {
      waitUntil: 'networkidle', timeout: 30_000,
    });

    // 3) 날짜 범위 설정 — Agoda UI에 따라 선택자가 달라질 수 있음
    // 시작일
    const startSel = 'input[name="startDate"], #startDate, [placeholder*="Start"]';
    if (await page.locator(startSel).count() > 0) {
      await page.fill(startSel, startDate);
    }
    // 종료일
    const endSel = 'input[name="endDate"], #endDate, [placeholder*="End"]';
    if (await page.locator(endSel).count() > 0) {
      await page.fill(endSel, endDate);
    }

    // 4) CSV Export 클릭 + 다운로드 캐치
    console.log('  CSV 내보내기...');
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }),
      page.click('a:has-text("Export"), button:has-text("CSV"), [data-export-type="csv"], .export-csv'),
    ]);

    await download.saveAs(outPath);
    console.log(`  다운로드 완료: ${path.relative(ROOT, outPath)}`);

  } finally {
    await browser.close();
  }

  const stat = fs.statSync(outPath);
  console.log(`  파일 크기: ${(stat.size / 1024).toFixed(1)}KB`);
  console.log(`\n다음 단계:`);
  console.log(`  node scripts/agoda-report-parse.js --month=${month}`);
})().catch(err => {
  console.error('다운로드 실패:', err.message);
  process.exit(1);
});
