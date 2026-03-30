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
const { getCID } = require('../lib/agoda-link-builder');

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
  const CID     = getCID();

  if (!API_KEY) {
    console.log('  ℹ  AGODA_API_KEY 없음 — Content API 건너뜀 (서버 실행 시 채워집니다)');
    return Promise.resolve([]);
  }

  const url = `https://contentapi.agoda.com/api/v1/properties/${agodaHotelId}?languageCode=ko-KR`;

  return new Promise((resolve) => {
    const siteUrl  = process.env.SITE_URL || 'https://tripprice.net';
    const hostname = (() => { try { return new URL(siteUrl).hostname; } catch { return 'tripprice.net'; } })();

    const req = https.get(url, {
      headers: {
        'Authorization':    `apikey ${API_KEY}`,
        'Accept':           'application/json',
        'X-Site-ID':        CID,
        'User-Agent':       `TrippriceBot/1.0 (+${siteUrl})`,
        'Origin':           siteUrl,
        'Referer':          `${siteUrl}/`,
        'X-Forwarded-Host': hostname,
      },
    }, res => {
      const statusCode  = res.statusCode;
      const contentType = res.headers['content-type'] || '';
      const location    = res.headers['location']     || '';

      // ── 리다이렉트: 파트너 허브 미승인 또는 API 키 권한 없음 ──────────────
      if ([301, 302, 307, 308].includes(statusCode)) {
        res.resume();
        if (location.includes('www.agoda.com') || location.includes('agoda.com')) {
          console.warn('  ⚠  Content API 진단:');
          console.warn(`       status       : ${statusCode} Redirect`);
          console.warn(`       location     : ${location.slice(0, 80)}`);
          console.warn(`       SITE_URL     : ${siteUrl}`);
          console.warn('');
          console.warn('  → 원인 분류: 코드 문제 아님 — Agoda 파트너 허브 권한/도메인 미설정');
          console.warn('  → 해결 방법:');
          console.warn('       1) partners.agoda.com 로그인');
          console.warn('       2) Tools > API > Content API 활성화 신청');
          console.warn(`       3) Approval Sites에 "${hostname}" 등록`);
          console.warn('       4) 승인 완료 후 --force 플래그로 재실행');
        } else {
          console.warn(`  ⚠  Content API: ${statusCode} 리다이렉트 → ${location.slice(0, 100)}`);
        }
        return resolve([]);
      }

      // ── 인증 실패 ────────────────────────────────────────────────────────────
      if (statusCode === 401 || statusCode === 403) {
        res.resume();
        console.warn(`  ⚠  Content API: HTTP ${statusCode} 인증/권한 오류`);
        console.warn('       AGODA_API_KEY 형식 확인: CID:secret (예: 1926938:xxxx)');
        return resolve([]);
      }

      // ── 200이지만 HTML 응답 (투명 리다이렉트 후 agoda 홈) ───────────────────
      if (statusCode === 200 && contentType.includes('text/html')) {
        let d = '';
        res.on('data', c => { if (d.length < 200) d += c; });
        res.on('end', () => {
          console.warn('  ⚠  Content API 진단:');
          console.warn(`       status       : 200 OK (HTML — JSON 아님)`);
          console.warn(`       content-type : ${contentType}`);
          console.warn(`       body 앞 100자: ${d.slice(0, 100).replace(/\s+/g, ' ')}`);
          console.warn('');
          console.warn('  → 원인 분류: API 키가 Content API에 미등록되어 Agoda 홈으로 투명 리다이렉트됨');
          console.warn('  → 해결 방법:');
          console.warn('       1) partners.agoda.com > Tools > API > Content API 활성화');
          console.warn(`       2) Approval Sites에 "${hostname}" 등록`);
          resolve([]);
        });
        return;
      }

      // ── 기타 오류 ────────────────────────────────────────────────────────────
      if (statusCode !== 200) {
        res.resume();
        console.warn(`  ⚠  Content API: HTTP ${statusCode}`);
        return resolve([]);
      }

      // ── 정상 JSON 응답 ───────────────────────────────────────────────────────
      let d = '';
      res.on('data', c => (d += c));
      res.on('end', () => {
        try {
          const body = JSON.parse(d);
          const urls = extractImageUrls(body);
          console.log(`  → API 이미지 URL ${urls.length}개 수집`);
          resolve(urls);
        } catch {
          console.warn('  ⚠  Content API: JSON 파싱 실패');
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

  // ① Content API 시도
  let urls = await fetchFromApi(agodaId);

  // ② Content API 실패 시 Affiliate Lite API로 폴백
  if (urls.length === 0) {
    urls = await fetchFromAffiliateLite(agodaId);
  }

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

// ── Affiliate Lite 폴백 ────────────────────────────────────────────────────────

/**
 * Affiliate Lite API에서 imageUrl 1개 이상 확보.
 * Content API가 redirect/권한 오류로 실패했을 때만 호출.
 *
 * @param {string|number} agodaHotelId
 * @returns {Promise<string[]>}
 */
async function fetchFromAffiliateLite(agodaHotelId) {
  const lite = require('../lib/agoda-affiliate-lite');
  try {
    const hotel = await lite.getHotel(agodaHotelId);
    if (!hotel) {
      console.log('  ℹ  Affiliate Lite: 응답 없음 — SVG 카드로 폴백');
      return [];
    }
    const urls = [hotel.imageUrl].filter(u => typeof u === 'string' && u.startsWith('http'));
    if (urls.length > 0) {
      console.log(`  → Affiliate Lite 이미지 URL ${urls.length}개 확보`);
    } else {
      console.log('  ℹ  Affiliate Lite: imageUrl 없음 — SVG 카드로 폴백');
    }
    return urls;
  } catch (e) {
    console.warn(`  ⚠  Affiliate Lite 폴백 실패: ${e.message}`);
    return [];
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
