#!/usr/bin/env node
/**
 * fetch-hotel-images.js
 *
 * Agoda Content API에서 호텔 이미지 URL 목록을 가져와 캐시합니다.
 *
 * 동작:
 *   - data/processed/{hotel_id}.json → agoda_hotel_id 조회
 *   - cache/agoda-images/{hotel_id}/urls.json 존재 → 캐시 사용 (--force로 갱신)
 *   - Content API 호출 → 이미지 URL 배열 추출 → 캐시 저장
 *   - API 키 없거나 도메인 미승인(로컬) → urls: [] 저장 → 후속 단계 SVG 카드 폴백
 *
 * 제약:
 *   Content API는 tripprice.net 승인 도메인에서만 동작합니다.
 *   로컬에서 AGODA_API_KEY를 설정해도 도메인 미승인 오류가 발생합니다.
 *   서버에서 실행해 cache/agoda-images/{hotel}/urls.json을 채운 뒤
 *   로컬에서 download-images.js를 실행하면 이미지 사용 가능합니다.
 *
 * 사용법:
 *   node scripts/fetch-hotel-images.js --hotel=grand-hyatt-seoul
 *   node scripts/fetch-hotel-images.js --hotel=grand-hyatt-seoul --force
 *
 * 항상 exit(0) — 파이프라인 중단 없음.
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const ROOT      = path.resolve(__dirname, '..');
const DIR_DATA  = path.join(ROOT, 'data', 'processed');
const DIR_CACHE = path.join(ROOT, 'cache', 'agoda-images');

// ── 순수 함수 (테스트 가능) ────────────────────────────────────────────────────

/**
 * Agoda Content API 응답 body에서 이미지 URL 배열을 추출합니다.
 * API 응답 스키마 변동에 대비해 여러 필드 경로를 시도합니다.
 *
 * @param {object} body - JSON.parse된 API 응답
 * @returns {string[]} 이미지 URL 배열 (비어있을 수 있음)
 */
function extractImageUrls(body) {
  if (!body || typeof body !== 'object') return [];

  // property 래퍼 여러 형태 시도
  const prop = body.property || body.hotel || body;

  // 이미지 배열 후보 필드
  const candidates = [
    prop.images,
    prop.photos,
    prop.hotelImages,
    prop.propertyImages,
    prop.mediaList,
    body.images,
    body.photos,
  ];

  for (const arr of candidates) {
    if (!Array.isArray(arr) || arr.length === 0) continue;

    const urls = arr
      .map(img => {
        if (typeof img === 'string') return img;
        if (!img || typeof img !== 'object') return null;
        return img.url || img.imageUrl || img.href || img.src || img.largeSrc || null;
      })
      .filter(u => typeof u === 'string' && u.startsWith('http'));

    if (urls.length > 0) return urls;
  }

  return [];
}

// ── API 호출 ──────────────────────────────────────────────────────────────────

/**
 * Agoda Content API에서 이미지 URL 목록을 가져옵니다.
 * API 키 없거나 도메인 미승인이면 [] 반환 (에러 없음).
 *
 * @param {string|number} agodaHotelId
 * @returns {Promise<string[]>}
 */
function fetchFromApi(agodaHotelId) {
  const API_KEY = process.env.AGODA_API_KEY || '';
  const CID     = process.env.AGODA_CID || '1926938';

  if (!API_KEY) {
    console.log('  ℹ  AGODA_API_KEY 없음 — Content API 건너뜀 (서버 실행 시 채워집니다)');
    return Promise.resolve([]);
  }

  const url = `https://contentapi.agoda.com/api/v1/properties/${agodaHotelId}?languageCode=ko-KR`;

  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'Authorization': `apikey ${API_KEY}`,
        'Accept':        'application/json',
        'X-Site-ID':     CID,
        'User-Agent':    'TrippriceBot/1.0 (+https://tripprice.net)',
      },
    }, res => {
      // 도메인 미승인 = www.agoda.com으로 리다이렉트
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location || '';
        res.resume();
        if (loc.includes('www.agoda.com')) {
          console.warn('  ⚠  Content API: 도메인 미승인 — tripprice.net 서버에서 실행하세요');
        } else {
          console.warn(`  ⚠  Content API: 리다이렉트 → ${loc}`);
        }
        return resolve([]);
      }

      if (res.statusCode === 401) {
        res.resume();
        console.warn('  ⚠  Content API: 인증 실패 (AGODA_API_KEY 확인)');
        return resolve([]);
      }

      if (res.statusCode !== 200) {
        res.resume();
        console.warn(`  ⚠  Content API: HTTP ${res.statusCode}`);
        return resolve([]);
      }

      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        try {
          const body = JSON.parse(d);
          const urls = extractImageUrls(body);
          console.log(`  → API 이미지 URL ${urls.length}개 수집`);
          resolve(urls);
        } catch {
          resolve([]);
        }
      });
    });

    req.on('error', err => {
      console.warn(`  ⚠  Content API 오류: ${err.message}`);
      resolve([]);
    });

    req.setTimeout(12000, () => {
      req.destroy();
      console.warn('  ⚠  Content API 타임아웃 (12초)');
      resolve([]);
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

  const hotelId = rawArgs.hotel;
  const force   = rawArgs.force === true || rawArgs.force === 'true';

  if (!hotelId) {
    console.error('오류: --hotel=<hotel_id> 필요');
    console.error('  예: node scripts/fetch-hotel-images.js --hotel=grand-hyatt-seoul');
    process.exit(0); // non-blocking
  }

  const cacheDir  = path.join(DIR_CACHE, hotelId);
  const cacheFile = path.join(cacheDir, 'urls.json');

  console.log(`\n이미지 URL 수집: ${hotelId}`);

  // 캐시 hit
  if (!force && fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    console.log(`  → 캐시 사용: ${cached.urls.length}개 URL (${new Date(cached.fetched_at).toLocaleString()})`);
    process.exit(0);
  }

  // 호텔 데이터 로드
  const dataPath = path.join(DIR_DATA, `${hotelId}.json`);
  if (!fs.existsSync(dataPath)) {
    console.warn(`  ⚠  호텔 데이터 없음: data/processed/${hotelId}.json — 건너뜀`);
    saveCacheEmpty(cacheDir, cacheFile, hotelId, '');
    process.exit(0);
  }

  const hotel    = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const agodaId  = (hotel.agoda_hotel_id || '').trim();

  if (!agodaId) {
    console.warn(`  ⚠  agoda_hotel_id 없음 — API 호출 불가`);
    saveCacheEmpty(cacheDir, cacheFile, hotelId, '');
    process.exit(0);
  }

  console.log(`  agoda_hotel_id: ${agodaId}`);

  const urls = await fetchFromApi(agodaId);

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    hotel_id:        hotelId,
    agoda_hotel_id:  agodaId,
    urls,
    fetched_at:      new Date().toISOString(),
  }, null, 2));

  if (urls.length === 0) {
    console.log('  → URL 0개 저장 — 하위 단계에서 SVG 카드로 폴백됩니다');
  } else {
    console.log(`  → ${urls.length}개 URL 캐시 저장: cache/agoda-images/${hotelId}/urls.json`);
  }
}

function saveCacheEmpty(cacheDir, cacheFile, hotelId, agodaId) {
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({
    hotel_id:       hotelId,
    agoda_hotel_id: agodaId,
    urls:           [],
    fetched_at:     new Date().toISOString(),
  }, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    console.warn(`⚠  fetch-hotel-images 오류: ${err.message} — 건너뜀`);
    process.exit(0); // 파이프라인 중단 금지
  });
}

module.exports = { extractImageUrls };
