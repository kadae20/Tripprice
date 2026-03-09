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
const SUBSET_CSV    = path.join(ROOT, 'data', 'hotels', 'hotels-subset.csv');
const KEEP          = Math.max(1, parseInt(process.env.HOTELDATA_KEEP || '1', 10));
const LOG_PATH      = path.join(ROOT, 'logs', 'hoteldata-sync.log');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const DRY_RUN   = args['dry-run'] === true;
const FORCE     = args['force']   === true;

// ── 실패 기록 / 텔레그램 알림 ─────────────────────────────────────────────────
function writeFailLog(reason) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] FAIL: ${reason}\n`, 'utf8');
  } catch { /* 로그 실패는 무시 */ }
}

function notifyTelegram(msg) {
  const token  = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID   || '').trim();
  if (!token || !chatId) return Promise.resolve();
  const body = JSON.stringify({ chat_id: chatId, text: msg });
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.telegram.org', port: 443,
      path: `/bot${token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.setTimeout(10_000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

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
        return reject(new Error(`HTTP ${res.statusCode} — URL이 만료되었거나 권한 없음`));
      }

      // Content-Type 검사: zip 또는 octet-stream이어야 함
      const ct = (res.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('zip') && !ct.includes('octet-stream') && !ct.includes('binary')) {
        res.resume();
        return reject(new Error(`Content-Type 불일치: "${ct || '없음'}" (zip/octet-stream 필요) — URL 갱신 필요`));
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

  // 크기 검사: 5MB 미만은 비정상 응답으로 간주
  const zipStat = fs.statSync(zipPath);
  if (zipStat.size < 5 * 1024 * 1024) {
    fs.unlinkSync(zipPath);
    throw new Error(`파일 크기 불충분: ${(zipStat.size / 1024 / 1024).toFixed(2)}MB (최소 5MB) — URL 갱신 필요`);
  }

  return true;
}


// ── subset 추출 실행 ──────────────────────────────────────────────────────────
function runExtract() {
  console.log('\n  hoteldata-extract.js 실행...');
  try {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'hoteldata-extract.js'),
    ], {
      cwd:      ROOT,
      env:      process.env,
      encoding: 'utf8',
      timeout:  600_000,
    });
    out.trim().split('\n').filter(Boolean).slice(-10).forEach(l => console.log(`    ${l}`));
  } catch (err) {
    const output = ((err.stdout || '') + (err.stderr || '')).trim();
    console.warn(`  ⚠  extract 실패 (exit ${err.status ?? '?'})`);
    output.split('\n').slice(-5).forEach(l => console.warn(`     ${l}`));
    throw new Error(`hoteldata-extract 실패 (exit ${err.status ?? '?'})`);
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
  console.log(`  모드     : ${DRY_RUN ? 'dry-run (다운로드 없음)' : '실행'}`);
  console.log('');

  // ── AGODA_HOTELDATA_URL 필수 확인 ────────────────────────────────────────
  if (!hotelDataUrl) {
    const guide = [
      'AGODA_HOTELDATA_URL이 설정되지 않았습니다.',
      '',
      '설정 방법:',
      '  1) Agoda 파트너 허브 접속: https://partners.agoda.com/tools/hotelData',
      '  2) "Download Hotel Data" 버튼 우클릭 → "링크 주소 복사"',
      '  3) .env.local에 추가:',
      '     AGODA_HOTELDATA_URL=https://xml.agoda.com/hoteldatafiles/...zip?token=...',
      '',
      '⚠  URL은 수 주 후 만료됩니다. 만료 시 재설정이 필요합니다.',
    ].join('\n');
    console.error(guide);
    writeFailLog('AGODA_HOTELDATA_URL 미설정');
    await notifyTelegram('⚠ Tripprice hoteldata-sync: AGODA_HOTELDATA_URL 미설정 — 파트너 허브에서 URL 갱신 후 .env.local 업데이트 필요');
    process.exit(1);
  }

  // ── dry-run: 네트워크 요청 없이 경로만 출력 ──────────────────────────────
  if (DRY_RUN) {
    let safeUrl = hotelDataUrl;
    try {
      const u = new URL(hotelDataUrl);
      safeUrl = `${u.protocol}//${u.hostname}${u.pathname}${u.search.length > 1 ? '?[params]' : ''}`;
    } catch {}
    console.log(`  [dry-run] URL    : ${safeUrl}`);
    console.log(`  [dry-run] zip 경로: ${path.relative(ROOT, zipPath)}`);
    console.log(`  [dry-run] latest : ${path.relative(ROOT, LATEST_CSV)}`);
    console.log('\n[dry-run] 완료 — 실제 다운로드 없음');
    process.exit(0);
  }

  // ── 중복 실행 방지 (이번 주차 이미 완료 → skip) ──────────────────────────
  if (!FORCE) {
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

  // ── 다운로드 ─────────────────────────────────────────────────────────────
  await downloadDirect(hotelDataUrl, weekDir, zipPath);

  const zipStat   = fs.statSync(zipPath);
  const zipSizeMB = (zipStat.size / 1024 / 1024).toFixed(1);
  console.log(`  zip 크기: ${zipSizeMB}MB`);

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

  // ── subset 추출 ───────────────────────────────────────────────────────────
  const skipExtract = (process.env.HOTELDATA_SKIP_EXTRACT || '').toLowerCase() === 'true';
  const skipIngest  = (process.env.HOTELDATA_SKIP_INGEST  || '').toLowerCase() === 'true';

  if (skipExtract) {
    console.log('\n  [skip] hoteldata-extract (HOTELDATA_SKIP_EXTRACT=true)');
  } else {
    runExtract();
  }

  // ── ingest 실행 (subset만) ─────────────────────────────────────────────────
  if (skipIngest) {
    console.log('  [skip] ingest (HOTELDATA_SKIP_INGEST=true)');
  } else if (fs.existsSync(SUBSET_CSV)) {
    runIngest(SUBSET_CSV);
  } else {
    console.warn('  ⚠  hotels-subset.csv 없음 — ingest 건너뜀 (HOTELDATA_SKIP_EXTRACT=true 였나요?)');
  }

  // ── 완료 요약 ─────────────────────────────────────────────────────────────
  const latestSizeMB = (fs.statSync(LATEST_CSV).size / 1024 / 1024).toFixed(0);
  const subsetSizeMB = fs.existsSync(SUBSET_CSV)
    ? (fs.statSync(SUBSET_CSV).size / 1024 / 1024).toFixed(1)
    : 'N/A';

  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  완료 요약');
  console.log('══════════════════════════════════════════════════');
  console.log(`  zip 크기  : ${zipSizeMB}MB`);
  console.log(`  latest    : ${path.relative(ROOT, LATEST_CSV)} (${latestSizeMB}MB)`);
  console.log(`  subset    : ${path.relative(ROOT, SUBSET_CSV)} (${subsetSizeMB}MB)`);
  console.log(`  주차      : ${weekLabel}`);
  console.log('══════════════════════════════════════════════════');
})().catch(async err => {
  console.error(`\n실패: ${err.message}`);
  writeFailLog(err.message);
  await notifyTelegram(`⚠ Tripprice hoteldata-sync 실패: ${err.message.slice(0, 300)}`);
  process.exit(1);
});
