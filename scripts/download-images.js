#!/usr/bin/env node
/**
 * download-images.js
 *
 * 캐시된 이미지 URL을 다운로드·검증하고 assets/raw/{hotel_id}/에 배치합니다.
 *
 * 검증 규칙:
 *   - HTTP status 200 (리다이렉트 1회 추적)
 *   - Content-Type: image/*
 *   - 파일 크기 >= 5KB
 *   실패 시 다음 URL로 계속 시도 (fallback)
 *
 * 동작:
 *   1. cache/agoda-images/{hotel_id}/urls.json 읽기
 *   2. 각 URL → cache/agoda-images/{hotel_id}/original/ 에 다운로드 + 검증
 *   3. assets/raw/{hotel_id}/ 에서 0-byte stub 제거
 *   4. 검증 통과한 파일을 assets/raw/{hotel_id}/ 에 복사
 *
 * 사용법:
 *   node scripts/download-images.js --hotel=grand-hyatt-seoul
 *   node scripts/download-images.js --hotel=grand-hyatt-seoul --max=6 --force
 *
 * 항상 exit(0) — 파이프라인 중단 없음.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const ROOT      = path.resolve(__dirname, '..');
const DIR_CACHE = path.join(ROOT, 'cache', 'agoda-images');
const DIR_RAW   = path.join(ROOT, 'assets', 'raw');

const MIN_SIZE_BYTES = 5 * 1024; // 5KB
const DEFAULT_MAX    = 6;
const DOWNLOAD_TIMEOUT_MS = 30_000;

// ── 순수 함수 (테스트 가능) ────────────────────────────────────────────────────

/**
 * 다운로드된 파일이 품질 기준을 충족하는지 검증합니다.
 *
 * @param {string} filePath  - 검사할 파일 경로
 * @param {string} contentType - HTTP Content-Type 헤더 값
 * @returns {{ ok: boolean, reason?: string }}
 */
function validateDownload(filePath, contentType) {
  if (!contentType || !contentType.startsWith('image/')) {
    return { ok: false, reason: `content-type 오류: "${contentType}"` };
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, reason: '파일 없음' };
  }

  if (stat.size < MIN_SIZE_BYTES) {
    return { ok: false, reason: `파일 크기 부족: ${stat.size}B (최소 ${MIN_SIZE_BYTES}B)` };
  }

  return { ok: true };
}

/**
 * 디렉토리에서 0-byte(~5KB 미만) stub 파일을 제거합니다.
 * 유효한 파일(5KB 이상)은 보존합니다.
 *
 * @param {string} dirPath
 * @returns {string[]} 제거된 파일명 목록
 */
function cleanStubFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];

  const removed = [];
  for (const f of fs.readdirSync(dirPath)) {
    const fp = path.join(dirPath, f);
    try {
      const stat = fs.statSync(fp);
      if (stat.isFile() && stat.size < MIN_SIZE_BYTES) {
        fs.unlinkSync(fp);
        removed.push(f);
      }
    } catch { /* 삭제 실패 무시 */ }
  }
  return removed;
}

/**
 * 이미지 URL에서 특징어를 추출해 파일명을 추론합니다.
 * 특징어를 찾지 못하면 index 0은 "featured", 이후는 "img-NNN" 형식 사용.
 *
 * @param {string} url
 * @param {number} index - 0-based
 * @param {string} ext   - 확장자 (점 포함, e.g. ".jpg")
 * @returns {string}
 */
function inferFilename(url, index, ext) {
  const FEATURE_KEYWORDS = [
    'pool', 'lobby', 'room', 'suite', 'restaurant', 'dining',
    'gym', 'fitness', 'spa', 'bar', 'lounge', 'rooftop',
    'exterior', 'view', 'breakfast', 'bathroom', 'bedroom',
    'terrace', 'balcony', 'garden', 'reception',
  ];

  const urlLower = url.toLowerCase();
  for (const kw of FEATURE_KEYWORDS) {
    if (urlLower.includes(kw)) {
      // 같은 특징어가 중복되면 인덱스 추가
      return index === 0 ? `${kw}${ext}` : `${kw}-${String(index).padStart(2, '0')}${ext}`;
    }
  }

  return index === 0 ? `featured${ext}` : `img-${String(index).padStart(3, '0')}${ext}`;
}

// ── 다운로드 헬퍼 ──────────────────────────────────────────────────────────────

/**
 * URL에서 파일을 다운로드합니다. 1단계 리다이렉트를 추적합니다.
 * 검증 실패(크기/content-type) 시 에러를 throw합니다.
 *
 * @param {string} url
 * @param {string} destPath
 * @param {number} [hops=0]
 * @returns {Promise<{ size: number, contentType: string }>}
 */
function downloadBinary(url, destPath, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 3) return reject(new Error('리다이렉트 최대 횟수 초과'));

    const proto   = url.startsWith('https://') ? https : http;
    const tmpPath = destPath + '.tmp';

    const req = proto.get(url, {
      headers: {
        'User-Agent': 'TrippriceBot/1.0 (+https://tripprice.net)',
        'Accept':     'image/*',
      },
    }, res => {
      // 리다이렉트 추적
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return downloadBinary(next, destPath, hops + 1).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const contentType = res.headers['content-type'] || '';

      fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
      const file = fs.createWriteStream(tmpPath);

      res.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          try {
            const stat = fs.statSync(tmpPath);
            if (stat.size < MIN_SIZE_BYTES) {
              fs.unlinkSync(tmpPath);
              return reject(new Error(`파일 크기 부족: ${stat.size}B (최소 ${MIN_SIZE_BYTES}B)`));
            }
            if (!contentType.startsWith('image/')) {
              fs.unlinkSync(tmpPath);
              return reject(new Error(`content-type 오류: "${contentType}"`));
            }
            fs.renameSync(tmpPath, destPath);
            resolve({ size: stat.size, contentType });
          } catch (err) {
            try { fs.unlinkSync(tmpPath); } catch {}
            reject(err);
          }
        });
      });

      file.on('error', err => {
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(err);
      });
    });

    req.on('error', err => {
      try { fs.unlinkSync(tmpPath); } catch {}
      reject(err);
    });

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy();
      try { fs.unlinkSync(tmpPath); } catch {}
      reject(new Error(`다운로드 타임아웃 (${DOWNLOAD_TIMEOUT_MS / 1000}초)`));
    });
  });
}

// ── 메인 ──────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
  );

  const hotelId   = rawArgs.hotel;
  const maxImages = parseInt(rawArgs.max || String(DEFAULT_MAX), 10);
  const force     = rawArgs.force === true || rawArgs.force === 'true';

  if (!hotelId) {
    console.error('오류: --hotel=<hotel_id> 필요');
    console.error('  예: node scripts/download-images.js --hotel=grand-hyatt-seoul');
    process.exit(0); // non-blocking
  }

  const cacheFile  = path.join(DIR_CACHE, hotelId, 'urls.json');
  const origDir    = path.join(DIR_CACHE, hotelId, 'original');
  const rawDir     = path.join(DIR_RAW, hotelId);

  console.log(`\n이미지 다운로드: ${hotelId}`);

  // URL 캐시 없음 → 건너뜀
  if (!fs.existsSync(cacheFile)) {
    console.log('  ℹ  URL 캐시 없음 — fetch-hotel-images 먼저 실행 필요');
    process.exit(0);
  }

  const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const urls      = Array.isArray(cacheData.urls) ? cacheData.urls : [];

  if (urls.length === 0) {
    console.log('  ℹ  URL 목록 없음 (API 미사용 또는 도메인 미승인) — 건너뜀');
    process.exit(0);
  }

  console.log(`  대상 ${Math.min(urls.length, maxImages)}/${urls.length}개 URL`);
  fs.mkdirSync(origDir, { recursive: true });

  const downloaded = [];
  let tried = 0;

  for (const url of urls) {
    if (downloaded.length >= maxImages) break;
    tried++;

    // 확장자 추출 (.jpg 기본)
    const extMatch = url.match(/\.(jpg|jpeg|png|webp)/i);
    const ext = extMatch ? extMatch[0].toLowerCase() : '.jpg';

    const filename = inferFilename(url, downloaded.length, ext);
    const destPath = path.join(origDir, filename);

    // 캐시된 파일 재사용 (--force 아닌 경우)
    if (!force && fs.existsSync(destPath) && fs.statSync(destPath).size >= MIN_SIZE_BYTES) {
      console.log(`  ○ 캐시: ${filename}`);
      downloaded.push({ filename, destPath });
      continue;
    }

    try {
      const { size, contentType } = await downloadBinary(url, destPath);
      console.log(`  ✓ ${filename} — ${Math.round(size / 1024)}KB [${contentType}]`);
      downloaded.push({ filename, destPath });
    } catch (err) {
      console.warn(`  ✗ [${tried}/${urls.length}] 실패: ${err.message}`);
    }
  }

  if (downloaded.length === 0) {
    console.log('  → 다운로드 성공 0개 — SVG 카드로 폴백됩니다');
    process.exit(0);
  }

  // 0-byte stub 제거 후 valid 파일 복사
  fs.mkdirSync(rawDir, { recursive: true });
  const removed = cleanStubFiles(rawDir);
  if (removed.length > 0) {
    console.log(`  → stub 파일 ${removed.length}개 제거: ${removed.join(', ')}`);
  }

  let copied = 0;
  for (const { filename, destPath } of downloaded) {
    const rawPath = path.join(rawDir, filename);
    try {
      fs.copyFileSync(destPath, rawPath);
      copied++;
    } catch (err) {
      console.warn(`  ⚠  복사 실패: ${filename} — ${err.message}`);
    }
  }

  console.log(`  → assets/raw/${hotelId}/에 ${copied}장 저장 완료`);
}

if (require.main === module) {
  main().catch(err => {
    console.warn(`⚠  download-images 오류: ${err.message} — 건너뜀`);
    process.exit(0); // 파이프라인 중단 금지
  });
}

module.exports = { validateDownload, cleanStubFiles, inferFilename, downloadBinary };
