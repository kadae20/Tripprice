#!/usr/bin/env node
/**
 * agoda-hoteldata-sync.js
 * Agoda 호텔 데이터 파일(zip+csv)을 주 1회 동기화합니다.
 *
 * 실행 우선순위:
 *   A. AGODA_HOTELDATA_URL 설정 시 — 해당 URL로 직접 다운로드 (Playwright 불필요)
 *   B. 미설정 시 — Playwright 로그인 → partners.agoda.com/tools/hotelData 접근
 *                  → xml.agoda.com/hoteldatafiles/…zip 링크 추출 → 다운로드
 *
 * 저장 구조:
 *   downloads/agoda/hoteldata/YYYY-WNN/hoteldata.zip   (zip 원본)
 *   downloads/agoda/hoteldata/YYYY-WNN/hoteldata.csv   (압축 해제)
 *   data/hotels/hotels-latest.csv                       (원자적 교체)
 *
 * 안전 장치:
 *   - 다운로드 중 .part 임시파일 사용, 완료 후 rename (원자적 교체)
 *   - 재시도 3회 + 지수 백오프 (2s / 4s / 8s)
 *   - 보관 정책: 최근 HOTELDATA_KEEP(기본 2)개 주차만 유지
 *
 * 사용법:
 *   node scripts/_run-with-env.js scripts/agoda-hoteldata-sync.js
 *   node scripts/_run-with-env.js scripts/agoda-hoteldata-sync.js --dry-run
 *   node scripts/_run-with-env.js scripts/agoda-hoteldata-sync.js --force
 *
 * 환경변수:
 *   AGODA_HOTELDATA_URL     — (선택) 직접 zip URL
 *   AGODA_PARTNER_EMAIL     — (Mode B 필수)
 *   AGODA_PARTNER_PASSWORD  — (Mode B 필수)
 *   HOTELDATA_DIR           — (선택) 기본: downloads/agoda/hoteldata
 *   HOTELDATA_KEEP          — (선택) 기본: 2
 */

'use strict';

const fs               = require('fs');
const path             = require('path');
const http             = require('http');
const https            = require('https');
const readline         = require('readline');
const { execFileSync } = require('child_process');

const ROOT          = path.resolve(__dirname, '..');
const HOTELDATA_DIR = path.join(ROOT, process.env.HOTELDATA_DIR || 'downloads/agoda/hoteldata');
const LATEST_CSV    = path.join(ROOT, 'data', 'hotels', 'hotels-latest.csv');
const KEEP          = Math.max(1, parseInt(process.env.HOTELDATA_KEEP || '2', 10));

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const DRY_RUN   = args['dry-run'] === true;
const FORCE     = args['force']   === true;

// ── ISO 주차 레이블 ───────────────────────────────────────────────────────────
// 예: 2026-W10 (ISO 8601 주차, 월요일 기준)
function isoWeekLabel(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const yearStart = new Date(d.getFullYear(), 0, 4);
  const weekNum   = 1 + Math.round(
    ((d.getTime() - yearStart.getTime()) / 86400000 - 3 + (yearStart.getDay() + 6) % 7) / 7
  );
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ── HTTP/HTTPS GET → 파일 저장 (리다이렉트 추적) ─────────────────────────────
function downloadToFile(url, destPath, hop = 0) {
  return new Promise((resolve, reject) => {
    if (hop > 5) return reject(new Error('리다이렉트 5회 초과'));

    const lib    = url.startsWith('https') ? https : http;
    const parsed = new URL(url);
    const req    = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (url.startsWith('https') ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent': 'TrippriceBot/1.0 (hoteldata-sync)',
        'Accept':     '*/*',
      },
    }, res => {
      // 리다이렉트 추적
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        console.log(`  → 리다이렉트: ${next.slice(0, 70)}`);
        return downloadToFile(next, destPath, hop + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const ws = fs.createWriteStream(destPath);

      let received = 0;
      res.on('data', chunk => {
        received += chunk.length;
        // 5MB 단위 진행 표시
        if (received % (5 * 1024 * 1024) < chunk.length) {
          process.stdout.write(`\r  다운로드: ${(received / 1024 / 1024).toFixed(1)}MB`);
        }
      });
      res.pipe(ws);
      ws.on('finish', () => { process.stdout.write('\n'); resolve(); });
      ws.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(300_000, () => {
      req.destroy();
      reject(new Error('다운로드 타임아웃 (5분)'));
    });
    req.end();
  });
}

// ── 재시도 + 지수 백오프 (.part 임시파일) ─────────────────────────────────────
async function downloadWithRetry(url, zipPath, maxRetries = 3) {
  const partPath = zipPath + '.part';

  // 이전 잔여 .part 정리
  if (fs.existsSync(partPath)) {
    try { fs.unlinkSync(partPath); } catch {}
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await downloadToFile(url, partPath);
      // 완료 → 원자적 rename
      fs.renameSync(partPath, zipPath);
      return;
    } catch (err) {
      if (fs.existsSync(partPath)) {
        try { fs.unlinkSync(partPath); } catch {}
      }
      if (attempt >= maxRetries) {
        throw new Error(`다운로드 ${maxRetries + 1}회 실패: ${err.message}`);
      }
      const delay = 2000 * Math.pow(2, attempt); // 2s / 4s / 8s
      console.warn(`  ⚠  재시도 ${attempt + 1}/${maxRetries} — ${delay / 1000}초 후 (${err.message.slice(0, 60)})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── ZIP 압축 해제 → CSV 경로 반환 ────────────────────────────────────────────
function extractCsv(zipPath, destDir) {
  console.log('  압축 해제 중...');
  try {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], {
      cwd:     ROOT,
      timeout: 300_000,
      stdio:   ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const msg = (err.stderr || Buffer.alloc(0)).toString() || err.message;
    if (err.status === 127 || msg.includes('not found') || msg.includes('No such file')) {
      throw new Error('unzip 명령 없음 — EC2: sudo apt install unzip -y');
    }
    throw new Error(`unzip 실패: ${msg.slice(0, 200)}`);
  }

  // 가장 큰 CSV 파일 선택 (실제 데이터)
  const csvFiles = fs.readdirSync(destDir)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .map(f => ({ f, size: fs.statSync(path.join(destDir, f)).size }))
    .sort((a, b) => b.size - a.size);

  if (csvFiles.length === 0) {
    throw new Error('zip 내 CSV 파일 없음 — 파일 구조 확인 필요');
  }

  const csvPath = path.join(destDir, csvFiles[0].f);
  console.log(`  CSV: ${csvFiles[0].f} (${(csvFiles[0].size / 1024 / 1024).toFixed(1)}MB)`);
  return csvPath;
}

// ── CSV 행 수 카운트 (스트리밍 — 대용량 대응) ────────────────────────────────
function countLines(filePath) {
  return new Promise(resolve => {
    let count = 0;
    const rl = readline.createInterface({
      input:     fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.on('line', () => count++);
    rl.on('close', () => resolve(count));
    rl.on('error', () => resolve(-1));
  });
}

// ── 보관 정책: 오래된 주차 디렉토리 삭제 ────────────────────────────────────
function cleanup(hotelDataDir, keep) {
  if (!fs.existsSync(hotelDataDir)) return;

  const dirs = fs.readdirSync(hotelDataDir)
    .filter(d => /^\d{4}-W\d{2}$/.test(d))
    .sort(); // 이름 순 = 시간 순

  const toDelete = dirs.slice(0, Math.max(0, dirs.length - keep));
  for (const d of toDelete) {
    const full = path.join(hotelDataDir, d);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      console.log(`  정리: ${path.relative(ROOT, full)}`);
    } catch (e) {
      console.warn(`  ⚠  정리 실패: ${d} — ${e.message}`);
    }
  }
  if (toDelete.length === 0) {
    console.log(`  보관 정책: ${dirs.length}/${keep}개 — 삭제 없음`);
  }
}

// ── Mode A: 직접 URL 다운로드 ────────────────────────────────────────────────
async function downloadDirect(url, weekDir, zipPath) {
  if (DRY_RUN) {
    // URL에 시크릿 포함 가능성 → 경로 부분만 출력
    let safeUrl = url;
    try {
      const u = new URL(url);
      safeUrl = `${u.protocol}//${u.hostname}${u.pathname}${u.search.length > 1 ? '?[params]' : ''}`;
    } catch {}
    console.log(`  [dry-run] URL    : ${safeUrl}`);
    console.log(`  [dry-run] zip 경로: ${path.relative(ROOT, zipPath)}`);
    console.log(`  [dry-run] latest : ${path.relative(ROOT, LATEST_CSV)}`);
    return false;
  }

  fs.mkdirSync(weekDir, { recursive: true });
  console.log('  다운로드 시작 (직접 URL)...');
  await downloadWithRetry(url, zipPath);
  return true;
}

// ── Mode B: Playwright 로그인 → 링크 추출 → 다운로드 ────────────────────────
async function downloadViaPlaywright(weekDir, zipPath) {
  const email    = process.env.AGODA_PARTNER_EMAIL    || '';
  const password = process.env.AGODA_PARTNER_PASSWORD || '';

  if (!email || !password) {
    throw new Error(
      'AGODA_PARTNER_EMAIL / AGODA_PARTNER_PASSWORD 환경변수 필요 (Mode B)'
    );
  }

  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    if (DRY_RUN) {
      // dry-run 시 Playwright 없어도 경로 정보만 출력하고 종료
      console.log('  [dry-run] URL 방식: Playwright (Mode B, playwright 미설치)');
      console.log(`  [dry-run] zip 경로: ${path.relative(ROOT, zipPath)}`);
      console.log(`  [dry-run] latest  : ${path.relative(ROOT, LATEST_CSV)}`);
      console.log('');
      console.log('  실제 실행 전 설치:');
      console.log('    npm install --save-dev playwright');
      console.log('    npx playwright install chromium');
      return false;
    }
    throw new Error(
      'playwright 미설치:\n  npm install --save-dev playwright\n  npx playwright install chromium'
    );
  }

  console.log(`  Playwright 모드 (email: [${email.length}자], pwd: [${password.length}자])`);

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, locale: 'ko-KR' });
  const page    = await context.newPage();

  try {
    // 1) 로그인 (SPA — agoda-universal-login.js 동적 렌더링)
    // partners.agoda.com/signin 직접 접근 후 SPA 렌더 대기
    console.log('  로그인 중...');
    await page.goto('https://partners.agoda.com/signin', {
      waitUntil: 'domcontentloaded', timeout: 30_000,
    });

    // SPA가 이메일 입력창 렌더링할 때까지 대기
    const emailSelector = 'input[type="email"], input[autocomplete="email"], input[name="email"], input[name="Email"], input[name="username"]';
    await page.waitForSelector(emailSelector, { timeout: 30_000 });
    await page.fill(emailSelector, email);

    // 일부 SPA는 이메일 입력 후 "Next" 버튼으로 비밀번호 창 전환
    const nextBtn = await page.$('button[data-element-name="login-next"], button:has-text("Next"), button:has-text("다음"), button:has-text("Continue")');
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForTimeout(1500); // SPA 전환 대기
    }

    // 비밀번호 필드 대기 + 입력
    const pwSelector = 'input[type="password"], input[name="password"], input[name="Password"]';
    await page.waitForSelector(pwSelector, { timeout: 20_000 });
    await page.fill(pwSelector, password);

    // 제출
    const submitSel = 'button[type="submit"], button[data-element-name="login-submit"], input[type="submit"]';
    await page.click(submitSel);

    // 네트워크 안정화 대기 (SPA 네비게이션)
    await page.waitForLoadState('networkidle', { timeout: 30_000 });

    const loginUrl = page.url();
    // 성공 시 /signin, /login, /ul/login 모두 벗어나야 함
    if (/\/(signin|login)/.test(new URL(loginUrl).pathname)) {
      // 로그인 실패 가능성: 페이지에서 오류 메시지 추출
      const errText = await page.evaluate(() => {
        const el = document.querySelector('[class*="error"], [class*="alert"], [role="alert"]');
        return el ? el.innerText.trim().slice(0, 120) : '';
      });
      throw new Error(`로그인 실패${errText ? ` — ${errText}` : ' — 자격증명 또는 2FA 확인 필요'}`);
    }
    console.log('  로그인 성공');

    // 2) 호텔 데이터 페이지 접근 (URL 후보 순서대로 시도)
    const hdPages = [
      'https://partners.agoda.com/en-us/affiliates/tools/hoteldata.aspx',
      'https://partners.agoda.com/tools/hotelData',
      'https://partners.agoda.com/en-us/affiliates/tools.aspx',
    ];

    let zipUrl = '';
    for (const hdUrl of hdPages) {
      console.log(`  호텔 데이터 페이지: ${hdUrl}`);
      await page.goto(hdUrl, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => null);

      // zip 링크 탐색 (xml.agoda.com/hoteldatafiles/ 또는 .zip 포함)
      zipUrl = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        const match = anchors.find(a =>
          a.href.includes('hoteldatafiles') ||
          (a.href.includes('agoda') && a.href.endsWith('.zip')) ||
          a.href.endsWith('.zip')
        );
        return match ? match.href : '';
      });

      if (zipUrl) break;
    }

    if (!zipUrl) {
      throw new Error(
        'zip 다운로드 링크를 찾지 못했습니다.\n' +
        '  → 페이지 구조가 변경되었거나 계정 권한이 없을 수 있습니다.\n' +
        '  → AGODA_HOTELDATA_URL을 직접 설정하면 Playwright 없이 실행 가능합니다.'
      );
    }

    // dry-run: URL만 출력, 다운로드 없음
    if (DRY_RUN) {
      const safeZipUrl = zipUrl.replace(/[?#].*$/, '?[params]');
      console.log(`  [dry-run] 발견된 URL: ${safeZipUrl}`);
      console.log(`  [dry-run] zip 경로  : ${path.relative(ROOT, zipPath)}`);
      console.log(`  [dry-run] latest    : ${path.relative(ROOT, LATEST_CSV)}`);
      return false;
    }

    // 3) 다운로드 (Playwright download API — 세션 쿠키 자동 활용)
    console.log('  zip 다운로드 중 (Playwright)...');
    fs.mkdirSync(weekDir, { recursive: true });
    const partPath = zipPath + '.part';

    // 이전 .part 정리
    if (fs.existsSync(partPath)) {
      try { fs.unlinkSync(partPath); } catch {}
    }

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 300_000 }),
      page.evaluate(url => { window.location.href = url; }, zipUrl),
    ]);
    await download.saveAs(partPath);
    fs.renameSync(partPath, zipPath);
    console.log('  다운로드 완료 (Playwright)');

    return true;
  } finally {
    await browser.close();
  }
}

// ── ingest 실행 ───────────────────────────────────────────────────────────────
function runIngest(csvPath) {
  console.log('\n  ingest-hotel-data.js 실행...');
  try {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'ingest-hotel-data.js'),
      csvPath,
    ], {
      cwd:      ROOT,
      env:      process.env,
      encoding: 'utf8',
      timeout:  600_000, // 대용량 CSV는 10분까지 허용
    });
    // 마지막 8줄만 출력 (요약 정보)
    const lines = out.trim().split('\n').filter(Boolean);
    lines.slice(-8).forEach(l => console.log(`    ${l}`));
  } catch (err) {
    const output = ((err.stdout || '') + (err.stderr || '')).trim();
    console.warn(`  ⚠  ingest 실패 (exit ${err.status ?? '?'})`);
    output.split('\n').slice(-5).forEach(l => console.warn(`     ${l}`));
    console.warn('  → hotels-latest.csv는 정상 저장됨. ingest는 수동 재실행 가능:');
    console.warn(`     node scripts/ingest-hotel-data.js ${path.relative(ROOT, csvPath)}`);
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  const weekLabel    = isoWeekLabel();
  const weekDir      = path.join(HOTELDATA_DIR, weekLabel);
  const zipPath      = path.join(weekDir, 'hoteldata.zip');
  const hotelDataUrl = (process.env.AGODA_HOTELDATA_URL || '').trim();

  console.log('══════════════════════════════════════════════════');
  console.log('  Agoda 호텔 데이터 주간 동기화');
  console.log('══════════════════════════════════════════════════');
  console.log(`  주차     : ${weekLabel}`);
  console.log(`  저장경로 : ${path.relative(ROOT, weekDir)}`);
  console.log(`  최신 CSV : ${path.relative(ROOT, LATEST_CSV)}`);
  console.log(`  보관     : 최근 ${KEEP}주`);
  console.log(`  URL 방식 : ${hotelDataUrl ? `직접 URL (${hotelDataUrl.length}자)` : 'Playwright 자동 추출'}`);
  console.log(`  모드     : ${DRY_RUN ? 'dry-run (다운로드 없음)' : '실행'}`);
  console.log('');

  // ── 중복 실행 방지 (이번 주차 이미 완료 → skip) ──────────────────────────
  if (!DRY_RUN && !FORCE) {
    const csvInWeek = fs.existsSync(weekDir)
      ? fs.readdirSync(weekDir).find(f => f.toLowerCase().endsWith('.csv'))
      : null;
    if (csvInWeek && fs.existsSync(LATEST_CSV)) {
      const latestStat = fs.statSync(LATEST_CSV);
      console.log(`  이미 ${weekLabel} 데이터 완료 (latest: ${(latestStat.size / 1024 / 1024).toFixed(1)}MB)`);
      console.log('  건너뜀 — 재실행: --force');
      process.exit(0);
    }
  }

  // FORCE 시 기존 zip 삭제 (재다운로드)
  if (FORCE && fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
    console.log('  기존 zip 삭제 (--force)');
  }

  // ── dry-run + Mode B 자격증명 없는 경우: 경로만 출력 ────────────────────
  if (DRY_RUN && !hotelDataUrl) {
    const email = process.env.AGODA_PARTNER_EMAIL || '';
    if (!email) {
      console.log('  [dry-run] URL 방식: Playwright (Mode B)');
      console.log(`  [dry-run] zip 경로: ${path.relative(ROOT, zipPath)}`);
      console.log(`  [dry-run] latest  : ${path.relative(ROOT, LATEST_CSV)}`);
      console.log('');
      console.log('  AGODA_PARTNER_EMAIL/PASSWORD 또는 AGODA_HOTELDATA_URL 설정 후');
      console.log('  Playwright로 링크를 자동 추출합니다.');
      console.log('\n[dry-run] 완료');
      process.exit(0);
    }
  }

  // ── A 또는 B: 다운로드 ───────────────────────────────────────────────────
  let downloaded;
  if (hotelDataUrl) {
    downloaded = await downloadDirect(hotelDataUrl, weekDir, zipPath);
  } else {
    downloaded = await downloadViaPlaywright(weekDir, zipPath);
  }

  // dry-run: 여기서 종료
  if (DRY_RUN || !downloaded) {
    console.log('\n[dry-run] 완료 — 실제 다운로드 없음');
    process.exit(0);
  }

  // ── ZIP 크기 확인 ──────────────────────────────────────────────────────────
  const zipStat   = fs.statSync(zipPath);
  const zipSizeMB = (zipStat.size / 1024 / 1024).toFixed(1);
  console.log(`  zip 크기: ${zipSizeMB}MB`);

  if (zipStat.size < 1024) {
    throw new Error(`zip 파일이 너무 작음 (${zipStat.size}bytes) — 다운로드 실패 가능성`);
  }

  // ── 압축 해제 ─────────────────────────────────────────────────────────────
  const csvPath = extractCsv(zipPath, weekDir);

  // ── 원자적 교체: hotels-latest.csv ───────────────────────────────────────
  // 1) 같은 디렉토리 내 .tmp 파일로 복사
  // 2) .tmp → hotels-latest.csv rename (같은 디렉토리 내 → 원자적)
  fs.mkdirSync(path.dirname(LATEST_CSV), { recursive: true });
  const latestTmp = LATEST_CSV + '.tmp';
  fs.copyFileSync(csvPath, latestTmp);
  fs.renameSync(latestTmp, LATEST_CSV);
  console.log(`  latest 교체: ${path.relative(ROOT, LATEST_CSV)}`);

  // ── 보관 정책 ─────────────────────────────────────────────────────────────
  cleanup(HOTELDATA_DIR, KEEP);

  // ── ingest 실행 ───────────────────────────────────────────────────────────
  runIngest(LATEST_CSV);

  // ── 완료 요약 ─────────────────────────────────────────────────────────────
  const rowCount = await countLines(LATEST_CSV);
  const csvStat  = fs.statSync(LATEST_CSV);

  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  완료 요약');
  console.log('══════════════════════════════════════════════════');
  console.log(`  zip 크기 : ${zipSizeMB}MB`);
  console.log(`  CSV 크기 : ${(csvStat.size / 1024 / 1024).toFixed(1)}MB`);
  console.log(`  CSV 행 수: ${rowCount > 0 ? `${(rowCount - 1).toLocaleString()}행 (헤더 제외)` : '카운트 불가'}`);
  console.log(`  latest   : ${path.relative(ROOT, LATEST_CSV)}`);
  console.log(`  주차     : ${weekLabel}`);
  console.log('══════════════════════════════════════════════════');
})().catch(err => {
  console.error(`\n실패: ${err.message}`);
  process.exit(1);
});
