'use strict';
/**
 * agoda-affiliate-lite.js
 * Agoda Affiliate Lite API 클라이언트.
 *
 * Env:
 *   AGODA_API_KEY  — 필수. 형식: "{CID}:{secret}" (예: 1926938:abcdef...)
 *   AGODA_CID      — 기본: 1926938
 *
 * Endpoint (HTTP):
 *   POST http://affiliateapi7643.agoda.com/affiliateservice/lt_v1
 *   Authorization: {CID}:{secret}   ← Content API와 다른 형식
 *
 * 주요 반환 필드: hotelId / hotelName / imageUrl / landingUrl / dailyRate
 */

const http = require('http');
const { gunzipSync, inflateSync } = require('zlib');

const ENDPOINT    = 'http://affiliateapi7643.agoda.com/affiliateservice/lt_v1';
const CID_DEFAULT = '1926938';
const TIMEOUT_MS  = 12000;

// ── 응답 필드 정규화 ─────────────────────────────────────────────────────────

/**
 * Agoda Lite API 응답 항목 → 정규화된 객체.
 * 필드명 대소문자 변형을 모두 흡수한다.
 */
function normalizeResult(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    hotelId:     item.HotelId      || item.hotelId      || item.ObjectId     || item.objectId     || 0,
    hotelName:   item.HotelName    || item.hotelName    || '',
    imageUrl:    item.ImageURL     || item.imageURL     || item.ImageUrl     || item.imageUrl
               || item.Image       || item.image        || '',
    landingUrl:  item.LandingURL   || item.landingURL   || item.LandingUrl   || item.landingUrl
               || item.HotelURL    || item.hotelURL     || item.HotelUrl     || item.hotelUrl
               || item.PropertyURL || item.propertyURL  || '',
    dailyRate:   item.DailyRate    || item.dailyRate    || item.Price        || item.price        || 0,
    currency:    item.Currency     || item.currency     || 'KRW',
    reviewScore: item.ReviewScore  || item.reviewScore  || item.Rating       || item.rating       || 0,
    starRating:  item.StarRating   || item.starRating   || item.Stars        || item.stars        || 0,
  };
}

/**
 * 응답 버퍼 decompress.
 */
function decompress(buf, encoding) {
  const enc = (encoding || '').toLowerCase();
  try {
    if (enc.includes('gzip'))    return gunzipSync(buf);
    if (enc.includes('deflate')) return inflateSync(buf);
  } catch { /* fall through: try raw */ }
  return buf;
}

// ── 핵심 API 호출 ─────────────────────────────────────────────────────────────

/**
 * Affiliate Lite API 호출 → 호텔 데이터 배열 반환.
 * API 키 없거나 오류 시 [] 반환 (파이프라인 중단 없음).
 *
 * @param {number|string|Array} hotelIds  Agoda 호텔 ID (단일 또는 배열)
 * @param {Object} [opts]
 * @param {string} [opts.currency]  기본 'KRW'
 * @param {string} [opts.checkIn]   YYYY-MM-DD (기본: 내일)
 * @param {string} [opts.checkOut]  YYYY-MM-DD (기본: 모레)
 * @returns {Promise<Object[]>}
 */
function search(hotelIds, opts = {}) {
  const rawKey = process.env.AGODA_API_KEY || '';
  if (!rawKey) {
    return Promise.resolve([]);
  }

  const ids    = Array.isArray(hotelIds) ? hotelIds : [hotelIds];
  const numIds = ids.map(id => parseInt(id, 10)).filter(id => id > 0);
  if (numIds.length === 0) return Promise.resolve([]);

  // AGODA_API_KEY가 "CID:secret" 형식이면 그대로 사용,
  // 아니면 CID를 앞에 붙인다.
  const CID       = process.env.AGODA_CID || CID_DEFAULT;
  const authValue = rawKey.includes(':') ? rawKey : `${CID}:${rawKey}`;

  // 날짜 기본값: 내일/모레 (가용성 필터 OFF이므로 날짜 무관하지만 필드 필수)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 1);
  const fmt = d => d.toISOString().split('T')[0];

  const body = JSON.stringify({
    criteria: {
      additional: {
        currency:             opts.currency || 'KRW',
        discountOnly:         false,
        extraBedIncluded:     false,
        filterByAvailability: false,
      },
      checkIn:   opts.checkIn  || fmt(tomorrow),
      checkOut:  opts.checkOut || fmt(dayAfter),
      rooms:     [{ adults: 2, children: [] }],
      objectids: numIds,
    },
  });

  const urlObj = new URL(ENDPOINT);

  return new Promise((resolve) => {
    const req = http.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || 80,
      path:     urlObj.pathname,
      method:   'POST',
      headers: {
        'Content-Type':    'application/json',
        'Content-Length':  Buffer.byteLength(body),
        'Authorization':   authValue,
        'Accept-Encoding': 'gzip, deflate',
        'Accept':          'application/json',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const raw    = decompress(Buffer.concat(chunks), res.headers['content-encoding']);
          const parsed = JSON.parse(raw.toString('utf8'));

          // 응답 루트 구조 후보
          const list =
            parsed.SearchResultList  ||
            parsed.searchResultList  ||
            parsed.SearchResult      ||
            parsed.searchResult      ||
            parsed.results           ||
            parsed.hotels            ||
            (Array.isArray(parsed) ? parsed : null);

          if (!Array.isArray(list)) {
            console.warn('  ⚠  Affiliate Lite: 응답에 리스트 없음');
            return resolve([]);
          }
          resolve(list.map(normalizeResult).filter(Boolean));
        } catch (e) {
          console.warn(`  ⚠  Affiliate Lite 파싱 실패: ${e.message}`);
          resolve([]);
        }
      });
    });

    req.on('error', err => {
      console.warn(`  ⚠  Affiliate Lite 네트워크 오류: ${err.message}`);
      resolve([]);
    });
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      console.warn(`  ⚠  Affiliate Lite 타임아웃 (${TIMEOUT_MS / 1000}초)`);
      resolve([]);
    });

    req.write(body);
    req.end();
  });
}

/**
 * 단일 호텔 조회.
 * @param {number|string} hotelId
 * @returns {Promise<Object|null>}
 */
async function getHotel(hotelId) {
  const results = await search([hotelId]);
  const id = String(hotelId);
  return results.find(r => String(r.hotelId) === id) || results[0] || null;
}

module.exports = { search, getHotel, normalizeResult };
