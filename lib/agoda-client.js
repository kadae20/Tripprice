'use strict';
/**
 * lib/agoda-client.js
 *
 * 아고다 Content API 클라이언트 (서버 전용).
 *
 * ⚠️  제약사항:
 *   Content API는 아고다 파트너 허브에 등록된 도메인에서만 응답합니다.
 *   로컬 개발 환경(localhost, CLI)에서는 www.agoda.com으로 리다이렉트됩니다.
 *   반드시 tripprice.net 서버(또는 승인된 도메인) 에서 호출하세요.
 *
 * 필수 환경변수:
 *   AGODA_API_KEY  — 파트너 허브 API 키 (CID:secret 형식)
 *   AGODA_CID      — 파트너 CID
 *
 * 사용법:
 *   const client = require('./lib/agoda-client');
 *   const hotels = await client.searchByCity('서울');
 */

const https = require('https');
const { buildPartnerUrl, getCID, CITY_ID_MAP } = require('./agoda-link-builder');

const API_KEY_RAW = process.env.AGODA_API_KEY || '';
const API_SECRET  = API_KEY_RAW.includes(':') ? API_KEY_RAW.split(':').slice(1).join(':') : API_KEY_RAW;
const API_BASE    = 'https://contentapi.agoda.com';

// 환경 체크 — 서버 환경이 아니면 명확히 경고
function assertServerEnv() {
  if (!API_SECRET) {
    throw new Error(
      'AGODA_API_KEY 환경변수가 없습니다.\n' +
      '  Content API는 서버 배포 환경에서만 사용 가능합니다.'
    );
  }
}

// HTTP GET (리다이렉트 추적)
function httpGet(url, headers = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 3) return reject(new Error('리다이렉트 최대 횟수 초과'));
    https.get(url, { headers }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        // agoda.com으로 리다이렉트 = 도메인 미승인
        if (next.includes('www.agoda.com')) {
          res.resume();
          return reject(new Error(
            'Content API 접근 거부: 현재 호출 도메인이 승인되지 않았습니다.\n' +
            '  → tripprice.net 서버에서 호출하거나, 파트너 허브에서 Approval Site를 확인하세요.'
          ));
        }
        res.resume();
        return resolve(httpGet(next, headers, hops + 1));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    })
      .on('error', reject)
      .setTimeout(12000, function () { this.destroy(); reject(new Error('API 타임아웃 (12초)')); });
  });
}

function buildHeaders() {
  return {
    'Authorization': `apikey ${API_KEY_RAW}`,
    'Accept': 'application/json',
    'X-Site-ID': getCID(),
  };
}

function normalizeHotel(h) {
  const id = h.propertyId || h.id || h.hotelId;
  return {
    agoda_hotel_id: String(id),
    hotel_name:     h.propertyName || h.name || h.hotelName || '',
    city:           h.cityName || h.city || '',
    star_rating:    h.starRating || h.stars,
    address:        h.address || h.addressLine1 || '',
    partner_url:    id ? buildPartnerUrl(id, `api-${id}`) : null,
  };
}

/**
 * 도시 이름으로 호텔 검색.
 * @param {string} cityName
 * @param {number} [pageSize=10]
 * @returns {Promise<Array>}
 */
async function searchByCity(cityName, pageSize = 10) {
  assertServerEnv();
  const cityId = CITY_ID_MAP[cityName] || CITY_ID_MAP[(cityName || '').toLowerCase()];
  const url = cityId
    ? `${API_BASE}/api/v1/properties?cityId=${cityId}&pageSize=${pageSize}&languageCode=ko-KR`
    : `${API_BASE}/api/v1/properties?cityName=${encodeURIComponent(cityName)}&pageSize=${pageSize}&languageCode=ko-KR`;
  const res = await httpGet(url, buildHeaders());
  if (res.status === 401) throw new Error('인증 실패 — AGODA_API_KEY를 확인하세요');
  if (res.status !== 200) throw new Error(`API 오류 HTTP ${res.status}`);
  const list = Array.isArray(res.body) ? res.body : (res.body?.properties || res.body?.hotels || []);
  return list.map(normalizeHotel);
}

/**
 * 아고다 호텔 ID로 단일 호텔 조회.
 * @param {string|number} agodaHotelId
 * @returns {Promise<Object>}
 */
async function getHotelById(agodaHotelId) {
  assertServerEnv();
  const url = `${API_BASE}/api/v1/properties/${agodaHotelId}?languageCode=ko-KR`;
  const res = await httpGet(url, buildHeaders());
  if (res.status === 404) throw new Error(`호텔 ID ${agodaHotelId}를 찾을 수 없습니다`);
  if (res.status !== 200) throw new Error(`API 오류 HTTP ${res.status}`);
  return normalizeHotel(res.body?.property || res.body?.hotel || res.body);
}

/**
 * 키워드로 호텔 검색.
 * @param {string} keyword
 * @param {number} [pageSize=10]
 * @returns {Promise<Array>}
 */
async function searchByKeyword(keyword, pageSize = 10) {
  assertServerEnv();
  const url = `${API_BASE}/api/v1/properties?keyword=${encodeURIComponent(keyword)}&pageSize=${pageSize}&languageCode=ko-KR`;
  const res = await httpGet(url, buildHeaders());
  if (res.status !== 200) throw new Error(`API 오류 HTTP ${res.status}`);
  const list = Array.isArray(res.body) ? res.body : (res.body?.properties || res.body?.hotels || []);
  return list.map(normalizeHotel);
}

module.exports = { searchByCity, getHotelById, searchByKeyword };
