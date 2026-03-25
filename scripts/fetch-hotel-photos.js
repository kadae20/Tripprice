#!/usr/bin/env node
'use strict';
/**
 * fetch-hotel-photos.js
 *
 * Agoda CDN photo1~photo5 URL → 다운로드 → WebP 변환 → 워터마크(옵션) 파이프라인
 *
 * 사용법:
 *   node scripts/fetch-hotel-photos.js --hotel-id=xxx
 *   node scripts/fetch-hotel-photos.js --batch=20 --watermark
 *   node scripts/fetch-hotel-photos.js --all --dry-run
 *   node scripts/fetch-hotel-photos.js --batch=3 --dry-run
 *
 * 옵션:
 *   --hotel-id=xxx    단일 호텔 처리
 *   --batch=N         photo URL 있지만 WebP 미처리된 호텔 N개 처리 (기본: 50)
 *   --all             photo URL 있는 모든 호텔 처리
 *   --watermark       워터마크 적용
 *   --dry-run         파일 저장 없이 처리 대상만 출력
 *   --concurrency=N   병렬 다운로드 수 (기본: 5, 최대: 10)
 */

const fs   = require('fs');
const path = require('path');
const http  = require('http');
const https = require('https');

const ROOT              = path.resolve(__dirname, '..');
const DIR_RAW           = path.join(ROOT, 'assets', 'raw');
const DIR_PROCESSED     = path.join(ROOT, 'assets', 'processed');
const DIR_HOTEL_DATA    = path.join(ROOT, 'data', 'processed');

const DOWNLOAD_TIMEOUT_MS = 20000;
const MIN_FILE_SIZE_BYTES = 5120; // 5KB
const USER_AGENT          = 'Tripprice/1.0 (+https://tripprice.net)';

// ── .env.local 자동 로드 ──────────────────────────────────────────────────────
;(function loadEnv() {
  for (const fname of ['.env.local', '.env']) {
    const fp = path.join(ROOT, fname);
    try {
      const lines = fs.readFileSync(fp, 'utf8').split('\n');
      let loaded = 0;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx < 1) continue;
        const key = line.slice(0, eqIdx).trim();
        let val = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key && !(key in process.env)) { process.env[key] = val; loaded++; }
      }
      if (loaded > 0) break;
    } catch { /* 파일 없음 */ }
  }
}());

// ── sharp 로드 ────────────────────────────────────────────────────────────────
function requireSharp() {
  try {
    return require('sharp');
  } catch {
    console.error('[오류] sharp 패키지가 설치되어 있지 않습니다. npm install sharp');
    process.exit(1);
  }
}

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const obj = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    obj[k] = v !== undefined ? v : true;
  }
  return obj;
}

// ── URL 품질 업그레이드: s=312x → s=1024x ────────────────────────────────────
function upgradePhotoUrl(url) {
  if (!url) return url;
  return url.replace(/s=312x/g, 's=1024x');
}

// ── data/processed/{hotel_id}.json 에서 photo1~photo5 URL 추출 ───────────────
function getPhotoUrls(hotelId) {
  const dataFile = path.join(DIR_HOTEL_DATA, `${hotelId}.json`);
  if (!fs.existsSync(dataFile)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return [data.photo1, data.photo2, data.photo3, data.photo4, data.photo5]
      .filter(u => u && /^https?:\/\//.test(u))
      .map(upgradePhotoUrl);
  } catch {
    return [];
  }
}

// ── 호텔 메타데이터 로드 ──────────────────────────────────────────────────────
function getHotelMeta(hotelId) {
  const dataFile = path.join(DIR_HOTEL_DATA, `${hotelId}.json`);
  if (!fs.existsSync(dataFile)) return { hotel_id: hotelId, hotel_name: hotelId, city: '' };
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch {
    return { hotel_id: hotelId, hotel_name: hotelId, city: '' };
  }
}

// ── WebP 파일 수 카운트 ───────────────────────────────────────────────────────
function countWebpFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => f.endsWith('.webp')).length;
}

// ── 원격 이미지 다운로드 (http, 리다이렉트 최대 3회, 20s 타임아웃) ───────────
function downloadImage(url, destPath, hops) {
  hops = hops || 0;
  if (hops > 3) return Promise.reject(new Error('리다이렉트 최대 횟수(3) 초과'));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'image/webp,image/*,*/*',
      },
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return downloadImage(next, destPath, hops + 1).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < MIN_FILE_SIZE_BYTES) {
          return reject(new Error(`파일 크기 너무 작음 (${buf.length}B < ${MIN_FILE_SIZE_BYTES}B)`));
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, buf);
        resolve(destPath);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error('다운로드 타임아웃 (20s)'));
    });
  });
}

// ── 워터마크 SVG 생성 ─────────────────────────────────────────────────────────
function createWatermarkSVG(imageWidth) {
  const text     = 'tripprice.net';
  const fontSize = Math.round(imageWidth * 0.07);  // 7% of image width
  const padding  = 10;
  const textWidth = fontSize * text.length * 0.6;
  const svgWidth  = Math.round(textWidth + padding * 2);
  const svgHeight = Math.round(fontSize + padding * 2);

  return Buffer.from(
    `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${svgWidth}" height="${svgHeight}" fill="rgba(0,0,0,0.65)" rx="6"/>` +
    `<text x="${padding}" y="${fontSize + padding / 2}" ` +
    `font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" ` +
    `fill="rgba(255,255,255,0.95)" letter-spacing="1">${text}</text>` +
    `</svg>`
  );
}

// ── alt 텍스트 생성 ───────────────────────────────────────────────────────────
function generateAltText(filename, hotelMeta, index) {
  const hotelName = hotelMeta.hotel_name || hotelMeta.hotel_id || '';
  const city      = hotelMeta.city || '';

  if (filename === 'featured.webp') {
    return [hotelName, '대표이미지', city].filter(Boolean).join(' ');
  }
  const num = index + 1;
  return [hotelName, city, `호텔 ${num}`].filter(Boolean).join(' ');
}

// ── 단일 이미지 처리 (sharp: 리사이즈 + 워터마크 + WebP 변환) ────────────────
async function processRawImage(sharp, rawPath, outPath, { isFeatured, applyWatermark }) {
  let pipeline = sharp(rawPath).rotate(); // EXIF auto-rotate

  if (isFeatured) {
    pipeline = pipeline.resize(1200, 630, { fit: 'cover' });
  } else {
    pipeline = pipeline.resize(1080, null, { fit: 'inside', withoutEnlargement: true });
  }

  if (applyWatermark) {
    const metadata = await sharp(rawPath).metadata();
    const imgWidth = metadata.width || (isFeatured ? 1200 : 1080);
    const wSvg = createWatermarkSVG(imgWidth);
    pipeline = pipeline.composite([{ input: wSvg, gravity: 'southeast' }]);
  }

  let buf = await pipeline.webp({ quality: 80 }).toBuffer();

  // 용량 초과 시 quality 낮춤
  const maxKB = 200;
  if (buf.length > maxKB * 1024) {
    let p2 = sharp(rawPath).rotate();
    if (isFeatured) {
      p2 = p2.resize(1200, 630, { fit: 'cover' });
    } else {
      p2 = p2.resize(1080, null, { fit: 'inside', withoutEnlargement: true });
    }
    buf = await p2.webp({ quality: 60 }).toBuffer();
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return Math.round(buf.length / 1024);
}

// ── 병렬 실행 헬퍼 ───────────────────────────────────────────────────────────
async function runConcurrent(tasks, concurrency) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── 핵심: 단일 호텔 처리 ─────────────────────────────────────────────────────
/**
 * @param {string} hotelId
 * @param {object} opts
 * @param {boolean} [opts.watermark=false]
 * @param {boolean} [opts.dryRun=false]
 * @param {number}  [opts.concurrency=5]
 * @returns {Promise<{hotelId, skipped, downloaded, processed, errors}>}
 */
async function fetchAndProcess(hotelId, opts = {}) {
  const {
    watermark    = false,
    dryRun       = false,
    concurrency  = 5,
  } = opts;

  const photoUrls  = getPhotoUrls(hotelId);
  const outDir     = path.join(DIR_PROCESSED, hotelId);
  const rawDir     = path.join(DIR_RAW, hotelId);

  if (photoUrls.length === 0) {
    return { hotelId, skipped: true, reason: 'photo URL 없음', downloaded: 0, processed: 0, errors: [] };
  }

  // 멱등성: processed에 WebP 5개 이상이면 스킵
  const existingWebps = countWebpFiles(outDir);
  if (existingWebps >= 5) {
    return { hotelId, skipped: true, reason: `WebP ${existingWebps}개 이미 존재`, downloaded: 0, processed: 0, errors: [] };
  }

  if (dryRun) {
    console.log(`  [dry-run] ${hotelId}: photo URL ${photoUrls.length}개 → 처리 예정`);
    for (let i = 0; i < photoUrls.length; i++) {
      const label = i === 0 ? 'featured.webp' : `image-${i}.webp`;
      console.log(`    ${label} ← ${photoUrls[i].slice(0, 80)}${photoUrls[i].length > 80 ? '…' : ''}`);
    }
    return { hotelId, skipped: false, dryRun: true, downloaded: 0, processed: photoUrls.length, errors: [] };
  }

  // sharp 로드 (실제 처리 시에만)
  const sharp = requireSharp();

  fs.mkdirSync(rawDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const hotelMeta = getHotelMeta(hotelId);
  const downloaded = [];
  const processed  = [];
  const errors     = [];

  // 다운로드 태스크 빌드
  const downloadTasks = photoUrls.map((url, i) => async () => {
    const rawFilename = `photo-${i + 1}.jpg`;
    const rawPath     = path.join(rawDir, rawFilename);

    // 이미 다운로드된 경우 스킵
    if (fs.existsSync(rawPath)) {
      return { i, rawPath, skipped: true };
    }

    try {
      await downloadImage(url, rawPath);
      return { i, rawPath, skipped: false };
    } catch (err) {
      return { i, rawPath: null, skipped: false, error: err.message };
    }
  });

  // 병렬 다운로드 실행
  const dlResults = await runConcurrent(downloadTasks, Math.min(concurrency, 10));

  for (const r of dlResults) {
    if (r.error) {
      errors.push(`photo-${r.i + 1}: ${r.error}`);
      console.warn(`    ⚠  다운로드 실패 photo-${r.i + 1}: ${r.error}`);
    } else if (!r.skipped) {
      downloaded.push(r.rawPath);
      console.log(`    ↓  photo-${r.i + 1}.jpg 다운로드 완료`);
    } else {
      console.log(`    →  photo-${r.i + 1}.jpg 이미 존재, 스킵`);
    }
  }

  // WebP 변환
  const altTexts = {};
  let procCount  = 0;

  for (let i = 0; i < photoUrls.length; i++) {
    const rawPath = path.join(rawDir, `photo-${i + 1}.jpg`);
    if (!fs.existsSync(rawPath)) continue;

    const isFeatured  = (i === 0);
    const outFilename = isFeatured ? 'featured.webp' : `image-${i}.webp`;
    const outPath     = path.join(outDir, outFilename);

    // 이미 변환된 경우 스킵
    if (fs.existsSync(outPath)) {
      console.log(`    →  ${outFilename} 이미 존재, 스킵`);
      const alt = generateAltText(outFilename, hotelMeta, i);
      altTexts[outFilename] = alt;
      procCount++;
      continue;
    }

    try {
      const sizeKB = await processRawImage(sharp, rawPath, outPath, {
        isFeatured,
        applyWatermark: watermark,
      });
      const alt = generateAltText(outFilename, hotelMeta, i);
      altTexts[outFilename] = alt;
      processed.push(outPath);
      procCount++;
      console.log(`    ✓  ${outFilename} [${sizeKB}KB]`);
    } catch (err) {
      errors.push(`${outFilename}: ${err.message}`);
      console.warn(`    ⚠  WebP 변환 실패 ${outFilename}: ${err.message}`);
    }
  }

  // alt-texts.json 저장
  if (Object.keys(altTexts).length > 0) {
    fs.writeFileSync(
      path.join(outDir, 'alt-texts.json'),
      JSON.stringify(altTexts, null, 2),
      'utf8'
    );
  }

  return {
    hotelId,
    skipped: false,
    dryRun: false,
    downloaded: downloaded.length,
    processed: procCount,
    errors,
  };
}

// ── 전체 호텔 목록 수집 (photo URL 있는 것만) ────────────────────────────────
function collectHotelsWithPhotos() {
  if (!fs.existsSync(DIR_HOTEL_DATA)) return [];
  const files = fs.readdirSync(DIR_HOTEL_DATA).filter(f => f.endsWith('.json'));
  const result = [];
  for (const file of files) {
    const hotelId = path.basename(file, '.json');
    const urls    = getPhotoUrls(hotelId);
    if (urls.length > 0) {
      result.push(hotelId);
    }
  }
  return result;
}

// ── 처리 안 된 호텔 필터링 ────────────────────────────────────────────────────
function filterUnprocessed(hotelIds) {
  return hotelIds.filter(id => {
    const outDir = path.join(DIR_PROCESSED, id);
    return countWebpFiles(outDir) < 5;
  });
}

// ── 배치 처리 ─────────────────────────────────────────────────────────────────
async function runBatch(opts = {}) {
  const {
    hotelId     = null,
    batch       = 50,
    all         = false,
    watermark   = false,
    dryRun      = false,
    concurrency = 5,
  } = opts;

  let targetIds = [];

  if (hotelId) {
    targetIds = [hotelId];
  } else {
    const allWithPhotos = collectHotelsWithPhotos();
    const unprocessed   = filterUnprocessed(allWithPhotos);
    targetIds = all ? unprocessed : unprocessed.slice(0, Number(batch) || 50);
  }

  if (targetIds.length === 0) {
    console.log('처리할 호텔이 없습니다.');
    return { totalHotels: 0, processed: 0, downloaded: 0, skipped: 0, errors: 0 };
  }

  console.log(`\n대상 호텔: ${targetIds.length}개${dryRun ? ' (dry-run)' : ''}`);

  let totalProcessed = 0;
  let totalDownloaded = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const id of targetIds) {
    console.log(`\n[${id}]`);
    try {
      const result = await fetchAndProcess(id, { watermark, dryRun, concurrency });
      if (result.skipped) {
        console.log(`  → 스킵: ${result.reason}`);
        totalSkipped++;
      } else {
        totalDownloaded += result.downloaded || 0;
        totalProcessed  += result.processed  || 0;
        totalErrors     += (result.errors || []).length;
      }
    } catch (err) {
      console.error(`  ✗ [${id}] 오류: ${err.message}`);
      totalErrors++;
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` 완료 | 호텔 ${targetIds.length}개 | 다운로드 ${totalDownloaded}장 | WebP 변환 ${totalProcessed}장 | 스킵 ${totalSkipped} | 오류 ${totalErrors}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  return {
    totalHotels: targetIds.length,
    processed: totalProcessed,
    downloaded: totalDownloaded,
    skipped: totalSkipped,
    errors: totalErrors,
  };
}

// ── CLI 실행 ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = parseArgs();

  const opts = {
    hotelId     : args['hotel-id'] || args['hotel'] || null,
    batch       : args['batch']       || 50,
    all         : !!args['all'],
    watermark   : !!args['watermark'],
    dryRun      : !!args['dry-run'],
    concurrency : Math.min(Number(args['concurrency'] || 5), 10),
  };

  if (!opts.hotelId && !opts.all && !args['batch']) {
    // 기본: batch=50
  }

  runBatch(opts)
    .then(summary => {
      process.exit(summary.errors > 0 ? 1 : 0);
    })
    .catch(err => {
      console.error(`치명적 오류: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { fetchAndProcess, runBatch };
