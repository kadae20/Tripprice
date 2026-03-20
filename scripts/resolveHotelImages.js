#!/usr/bin/env node
'use strict';
/**
 * resolveHotelImages.js
 *
 * 호텔별 이미지를 합법적 소스에서 확보해 assets/processed/{hotel_id}/ 에 저장.
 *
 * 소스 우선순위 (법적/정책 안전):
 *   1) 이미 로컬에 6장 이상 있으면 스킵 (멱등)
 *   2) draft JSON의 remote HTTP 이미지 URL (featured_media_url, content_images)
 *   3) Agoda Affiliate Lite API imageUrl (파트너 API 응답 — AGODA_API_KEY 필요)
 *   4) 모두 실패 시 → 경고 로그만, placeholder fallback, 파이프라인 계속
 *
 * 사용법:
 *   node scripts/resolveHotelImages.js --hotel-id=ibis-myeongdong
 *   node scripts/resolveHotelImages.js --hotel-id=ibis-myeongdong --draft=wordpress/drafts/post-ibis.json
 *
 * 환경변수:
 *   AGODA_API_KEY — 아고다 파트너 API 키 (없으면 Affiliate API 소스 스킵)
 *
 * 주의: 비밀값(API 키/패스워드)은 로그에 절대 출력하지 않음
 */

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const ROOT          = path.resolve(__dirname, '..');
const PROCESSED_DIR = path.join(ROOT, 'assets', 'processed');
const PLACEHOLDER   = path.join(ROOT, 'assets', 'placeholder', 'featured.webp');
const TARGET_COUNT  = 6;   // featured(1) + body(5)
const IMG_EXTS      = new Set(['.webp', '.jpg', '.jpeg', '.png']);
const TIMEOUT_MS    = 15000;

// ── .env.local 자동 로드 (비밀값 로그 출력 없음) ─────────────────────────────
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
    } catch { /* 파일 없음 — 다음 시도 */ }
  }
}());

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const obj = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    obj[k] = v ?? true;
  }
  return obj;
}

// ── 로컬 이미지 파일 수 ───────────────────────────────────────────────────────
function countLocalImages(dir) {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter(f => IMG_EXTS.has(path.extname(f).toLowerCase())).length;
}

// ── 로컬 이미지 경로 목록 ─────────────────────────────────────────────────────
function listLocalImages(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => IMG_EXTS.has(path.extname(f).toLowerCase()))
    .map(f => path.join(dir, f));
}

// ── 원격 이미지 다운로드 (HTTP/HTTPS, 리다이렉트 1회 추적) ───────────────────
function downloadImage(url, destPath, hops) {
  hops = hops || 0;
  if (hops > 3) return Promise.reject(new Error('리다이렉트 최대 횟수 초과'));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Tripprice/1.0 (hotel-image-resolver; +https://tripprice.net)',
        'Accept':     'image/webp,image/*,*/*',
      },
    }, res => {
      // 리다이렉트
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

      // content-type 기반 확장자 결정
      const ct = res.headers['content-type'] || '';
      const ext = ct.includes('webp') ? '.webp'
        : ct.includes('png')  ? '.png'
        : ct.includes('jpeg') || ct.includes('jpg') ? '.jpg'
        : '.jpg';

      // destPath에 이미 확장자가 있으면 유지, 없으면 content-type 기반
      const finalPath = IMG_EXTS.has(path.extname(destPath).toLowerCase())
        ? destPath
        : destPath + ext;

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < 1024) {
          return reject(new Error(`파일 크기 너무 작음 (${buf.length}B) — 이미지 아닌 응답 가능`));
        }
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.writeFileSync(finalPath, buf);
        resolve(finalPath);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('타임아웃')); });
  });
}

// ── draft JSON에서 원격 이미지 URL 수집 ──────────────────────────────────────
function collectRemoteUrls(draft) {
  const urls = [];
  const fmu = String(draft.featured_media_url || '');
  if (/^https?:\/\//.test(fmu)) urls.push(fmu);
  for (const sec of (draft.content_images || [])) {
    for (const img of (sec.images || [])) {
      const p = img.url || img.local_path || img.src || '';
      if (/^https?:\/\//.test(p)) urls.push(p);
    }
  }
  // images[] 필드 (직접 URL 배열)
  for (const u of (draft.images || [])) {
    if (/^https?:\/\//.test(u)) urls.push(u);
  }
  return [...new Set(urls)];
}

// ── draft JSON에서 Agoda 호텔 ID 추출 ────────────────────────────────────────
function extractAgodaHotelId(draft) {
  for (const link of (draft.affiliate_links || [])) {
    const m = (link.url || '').match(/agoda\.com\/(?:hotel|property)\/(\d+)/);
    if (m) return m[1];
    if (link.agoda_hotel_id) return String(link.agoda_hotel_id);
    if (link.hotel_id && /^\d+$/.test(link.hotel_id)) return link.hotel_id;
  }
  if (draft.agoda_hotel_id) return String(draft.agoda_hotel_id);
  return null;
}

// ── Agoda Affiliate Lite API → imageUrl 1개 취득 ─────────────────────────────
async function fetchAgodaImageUrl(agodaHotelId) {
  if (!agodaHotelId || !process.env.AGODA_API_KEY) return null;
  try {
    const affiliateLite = require('../lib/agoda-affiliate-lite');
    const results = await affiliateLite.search(agodaHotelId, { currency: 'KRW' });
    if (Array.isArray(results) && results.length > 0) {
      const imageUrl = results[0].imageUrl || results[0].ImageURL || results[0].image_url;
      if (imageUrl && /^https?:\/\//.test(imageUrl)) return imageUrl;
    }
  } catch (err) {
    console.warn(`  ⚠  Affiliate API 오류 (hotel ${agodaHotelId}): ${err.message}`);
  }
  return null;
}

// ── draft 파일 탐색 (hotel_id 기반 와일드카드 검색) ──────────────────────────
function findDraftFile(hotelId) {
  for (const dir of ['wordpress/drafts', 'wordpress/published', 'wordpress/failed']) {
    const fullDir = path.join(ROOT, dir);
    if (!fs.existsSync(fullDir)) continue;
    const match = fs.readdirSync(fullDir).find(f =>
      f.includes(hotelId) && f.endsWith('.json') && !f.endsWith('.qa.json')
    );
    if (match) return path.join(fullDir, match);
  }
  return null;
}

// ── 핵심: 호텔 이미지 확보 ────────────────────────────────────────────────────
/**
 * @param {string} hotelId  처리 대상 hotel_id (= assets/processed/ 폴더명)
 * @param {string|null} draftPath  draft JSON 경로 (null이면 자동 탐색)
 * @returns {Promise<{hotelId, skipped, downloaded, total, realImages, usedPlaceholder}>}
 */
async function resolve(hotelId, draftPath) {
  if (!hotelId || typeof hotelId !== 'string') {
    throw new Error('hotel_id (문자열)가 필요합니다');
  }

  const outDir = path.join(PROCESSED_DIR, hotelId);

  // 1) 이미 충분히 있으면 스킵 (멱등)
  const existingCount = countLocalImages(outDir);
  if (existingCount >= TARGET_COUNT) {
    console.log(`  ✓ [${hotelId}] 이미지 ${existingCount}장 이미 존재 — 스킵`);
    return { hotelId, skipped: true, count: existingCount };
  }
  console.log(`  🔍 [${hotelId}] 이미지 ${existingCount}장 → ${TARGET_COUNT}장 확보 시도`);

  // Draft 로드
  let draft = null;
  const resolvedDraftPath = draftPath || findDraftFile(hotelId);
  if (resolvedDraftPath && fs.existsSync(resolvedDraftPath)) {
    try { draft = JSON.parse(fs.readFileSync(resolvedDraftPath, 'utf8')); }
    catch (e) { console.warn(`  ⚠  draft 파싱 실패: ${e.message}`); }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const downloaded = [];
  let idxCounter = existingCount;

  // ── 소스 2: draft의 remote URL 다운로드 ──────────────────────────────────
  if (draft) {
    const remoteUrls = collectRemoteUrls(draft);
    for (const url of remoteUrls) {
      if (idxCounter >= TARGET_COUNT) break;
      const fname = idxCounter === 0 ? 'featured' : `image-${idxCounter}`;
      try {
        const saved = await downloadImage(url, path.join(outDir, fname));
        downloaded.push(saved);
        console.log(`  ↓ draft URL → ${path.relative(ROOT, saved)}`);
        idxCounter++;
      } catch (err) {
        console.warn(`  ⚠  다운로드 실패 (${url.slice(0, 70)}…): ${err.message}`);
      }
    }
  }

  // ── 소스 3: Agoda Affiliate Lite API ────────────────────────────────────
  if (idxCounter < TARGET_COUNT && draft) {
    const agodaId = extractAgodaHotelId(draft);
    if (agodaId) {
      const imageUrl = await fetchAgodaImageUrl(agodaId);
      if (imageUrl) {
        const fname = idxCounter === 0 ? 'featured' : `image-${idxCounter}`;
        try {
          const saved = await downloadImage(imageUrl, path.join(outDir, fname));
          downloaded.push(saved);
          console.log(`  ↓ [agoda:${agodaId}] → ${path.relative(ROOT, saved)}`);
          idxCounter++;
        } catch (err) {
          console.warn(`  ⚠  Agoda 이미지 다운로드 실패: ${err.message}`);
        }
      } else if (!process.env.AGODA_API_KEY) {
        console.log(`  ℹ  AGODA_API_KEY 없음 — Affiliate API 스킵`);
      }
    }
  }

  // ── featured.webp 보장 ───────────────────────────────────────────────────
  const featuredWebp = path.join(outDir, 'featured.webp');
  const featuredExists = fs.existsSync(featuredWebp);
  if (!featuredExists) {
    // 다운로드된 첫 번째 파일을 featured.webp로 복사
    const firstReal = listLocalImages(outDir).find(p => !p.includes('featured'));
    if (firstReal) {
      fs.copyFileSync(firstReal, featuredWebp);
      console.log(`  → ${path.basename(firstReal)} → featured.webp`);
    } else if (fs.existsSync(PLACEHOLDER)) {
      fs.copyFileSync(PLACEHOLDER, featuredWebp);
      console.log(`  ⚠  featured.webp: placeholder 사용 (실제 이미지 없음)`);
    }
  }

  const finalCount = countLocalImages(outDir);
  const realCount  = finalCount - (fs.existsSync(featuredWebp) && featuredExists === false ? 0 : 0);
  const usedPlaceholder = !downloaded.length;

  if (usedPlaceholder) {
    console.log(`  ⚠  [${hotelId}] 실제 이미지 0장 — placeholder 유지`);
  } else {
    console.log(`  ✓ [${hotelId}] ${downloaded.length}장 다운로드, 총 ${finalCount}장`);
  }

  return { hotelId, skipped: false, downloaded: downloaded.length, total: finalCount, usedPlaceholder };
}

// ── CLI 실행 ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args    = parseArgs();
  const hotelId = args['hotel-id'] || args['hotel'];
  const draft   = args['draft'] ? path.resolve(ROOT, args['draft']) : null;

  if (!hotelId) {
    console.error(
      '사용법: node scripts/resolveHotelImages.js --hotel-id=<id> [--draft=<path>]\n' +
      '예시:   node scripts/resolveHotelImages.js --hotel-id=ibis-myeongdong'
    );
    process.exit(1);
  }

  resolve(hotelId, draft)
    .then(() => process.exit(0))
    .catch(err => {
      console.error(`오류: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { resolve };
