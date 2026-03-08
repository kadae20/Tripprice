#!/usr/bin/env node
/**
 * agoda-hotel-data-download.js
 * Agoda 숙소 데이터 파일(CSV/JSON)을 주 1회 다운로드 후 ingest-hotel-data.js를 실행합니다.
 *
 * 필수 env:
 *   AGODA_HOTEL_DATA_URL  — 파트너 허브에서 발급한 숙소 데이터 파일 다운로드 URL
 *
 * 선택 env:
 *   AGODA_HOTEL_DATA_SKIP_INGEST=true  — 다운로드만 하고 ingest 건너뜀
 *
 * 사용법:
 *   node scripts/_run-with-env.js scripts/agoda-hotel-data-download.js
 *   node scripts/_run-with-env.js scripts/agoda-hotel-data-download.js --dry-run
 *
 * 출력: data/hotels/agoda-feed-{YYYY-MM-DD}.csv (또는 .json)
 *
 * EC2 systemd 주 1회 실행 예시:
 *   /etc/systemd/system/tripprice-hotel-data.service
 *   /etc/systemd/system/tripprice-hotel-data.timer  (OnCalendar=Mon 06:00 KST)
 *
 *   [Service]
 *   WorkingDirectory=/home/ubuntu/tripprice
 *   ExecStart=/usr/local/bin/node scripts/_run-with-env.js scripts/agoda-hotel-data-download.js
 *   EnvironmentFile=/home/ubuntu/tripprice/.env.local
 *   User=ubuntu
 *
 *   [Timer]
 *   OnCalendar=Mon *-*-* 06:00:00
 *   Persistent=true
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http  = require('http');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT       = path.resolve(__dirname, '..');
const HOTELS_DIR = path.join(ROOT, 'data', 'hotels');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const dryRun     = args['dry-run'] === true;
const skipIngest = args['skip-ingest'] === true || process.env.AGODA_HOTEL_DATA_SKIP_INGEST === 'true';

// ── 환경변수 검증 ─────────────────────────────────────────────────────────────
const DATA_URL = (process.env.AGODA_HOTEL_DATA_URL || '').trim();
if (!DATA_URL) {
  console.error('FAIL: AGODA_HOTEL_DATA_URL 환경변수가 설정되지 않았습니다.');
  console.error('  .env.local에 다음 줄 추가 후 재실행하세요:');
  console.error('  AGODA_HOTEL_DATA_URL=https://partners.agoda.com/...(파트너 허브 발급 URL)');
  process.exit(1);
}

// ── 파일 확장자 추론 ──────────────────────────────────────────────────────────
function inferExtension(url, contentType = '') {
  if (url.includes('.csv') || contentType.includes('csv')) return '.csv';
  if (url.includes('.json') || contentType.includes('json')) return '.json';
  if (url.includes('.xml')  || contentType.includes('xml'))  return '.xml';
  return '.csv'; // 기본: CSV
}

// ── HTTP/HTTPS GET (리다이렉트 1회 추적) ──────────────────────────────────────
function download(targetUrl, destPath, hop = 0) {
  return new Promise((resolve, reject) => {
    if (hop > 3) return reject(new Error('리다이렉트 3회 초과'));

    const lib    = targetUrl.startsWith('https') ? https : http;
    const parsed = new URL(targetUrl);
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (targetUrl.startsWith('https') ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'User-Agent': 'TrippriceBot/1.0 (hotel-data-download)', 'Accept': '*/*' },
    };

    const req = lib.request(opts, res => {
      // 리다이렉트
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsed.protocol}//${parsed.host}${res.headers.location}`;
        console.log(`  → 리다이렉트 (${res.statusCode}): ${next.slice(0, 80)}`);
        return download(next, destPath, hop + 1).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const contentType = res.headers['content-type'] || '';
      const ext = inferExtension(targetUrl, contentType);
      // 확장자가 결정되면 destPath 갱신
      const finalPath = destPath.endsWith(ext) ? destPath : destPath.replace(/\.\w+$/, ext);

      if (dryRun) {
        res.resume();
        console.log(`  [dry-run] 저장 경로: ${finalPath}  (content-type: ${contentType})`);
        return resolve(finalPath);
      }

      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      const ws = fs.createWriteStream(finalPath);
      res.pipe(ws);
      ws.on('finish', () => resolve(finalPath));
      ws.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('다운로드 타임아웃 (60초)')); });
    req.end();
  });
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  const today    = new Date().toISOString().split('T')[0];
  const destBase = path.join(HOTELS_DIR, `agoda-feed-${today}.csv`);

  console.log('══════════════════════════════════════════════════');
  console.log('  Agoda 숙소 데이터 파일 다운로드');
  console.log('══════════════════════════════════════════════════');
  console.log(`  URL   : ${DATA_URL.slice(0, 60)}...`);
  console.log(`  출력  : ${path.relative(ROOT, destBase)}`);
  console.log(`  모드  : ${dryRun ? 'dry-run (저장 안 함)' : '실제 저장'}`);
  console.log('');

  let savedPath;
  try {
    savedPath = await download(DATA_URL, destBase);
    const size = dryRun ? 0 : fs.statSync(savedPath).size;
    console.log(`  다운로드 완료: ${path.basename(savedPath)} (${(size / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error(`  FAIL: 다운로드 실패 — ${err.message}`);
    process.exit(1);
  }

  // ── ingest-hotel-data.js 실행 ─────────────────────────────────────────────
  if (!dryRun && !skipIngest && savedPath) {
    console.log('');
    console.log('  ingest-hotel-data.js 실행 중...');
    try {
      const out = execFileSync(process.execPath, [
        path.join(__dirname, 'ingest-hotel-data.js'),
        savedPath,
      ], {
        cwd:      ROOT,
        env:      process.env,
        encoding: 'utf8',
        stdio:    ['ignore', 'pipe', 'pipe'],
      });
      process.stdout.write(out);
      console.log('  ingest 완료');
    } catch (err) {
      process.stderr.write(err.stdout || '');
      process.stderr.write(err.stderr || '');
      console.error(`  ⚠  ingest 실패 (exit ${err.status}) — CSV는 data/hotels/에 보존됨`);
      // ingest 실패해도 다운로드 자체는 성공 → exit(0) 유지
    }
  }

  if (dryRun) {
    console.log('\n[dry-run] 완료 — 실제 파일 저장 없음');
  } else {
    console.log('\n완료');
  }
  process.exit(0);
})();
