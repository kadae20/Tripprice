'use strict';
/**
 * lib/agoda-link-builder.js
 *
 * 아고다 CID 포함 링크 생성 유틸리티.
 * 외부 API 없음. 로컬·서버 어디서나 사용 가능.
 *
 * 필수 환경변수:
 *   AGODA_CID          — 아고다 파트너 CID (필수, 기본값 없음)
 *   AGODA_PARTNER_CODE — AGODA_CID의 별칭 (둘 중 하나 필수)
 *
 * 사용법:
 *   const { buildPartnerUrl, buildCitySearchUrl } = require('./lib/agoda-link-builder');
 *   buildPartnerUrl('535922', 'grand-hyatt-seoul')
 *   // → https://www.agoda.com/ko-kr/hotel/535922.html?cid=...&hl=ko&currency=KRW
 */

function getCID() {
  const cid = process.env.AGODA_CID || process.env.AGODA_PARTNER_CODE;
  if (!cid) {
    throw new Error(
      '[agoda-link-builder] AGODA_CID 환경변수가 설정되지 않았습니다.\n' +
      '  .env.local 에 AGODA_CID=<파트너 CID> 를 추가하세요.'
    );
  }
  return cid;
}

// 아고다 도시 ID 맵 (검색 딥링크용)
const CITY_ID_MAP = {
  '서울': 9395, 'seoul': 9395,
  '부산': 9403, 'busan': 9403,
  '제주': 15773, 'jeju': 15773,
  '인천': 17085, 'incheon': 17085,
  '도쿄': 14000, 'tokyo': 14000,
  '오사카': 14001, 'osaka': 14001,
  '방콕': 8,    'bangkok': 8,
  '싱가포르': 9, 'singapore': 9,
};

/**
 * 호텔 예약 페이지 딥링크 (ko-kr + .html + hl=ko + currency=KRW).
 * 함수 시그니처 유지 (기존 호출부 변경 없음).
 * @param {string|number} agodaHotelId  - 아고다 호텔 숫자 ID
 * @param {string}        [tag]         - utm_campaign 태그 (기본: "hotel-{id}")
 * @param {string}        [campaignSlug] - 사용 안 함 (하위호환 유지용)
 * @returns {string}
 */
function buildPartnerUrl(agodaHotelId, tag = '', campaignSlug = '') {
  if (!agodaHotelId) throw new Error('agodaHotelId가 필요합니다');
  const cid = getCID();
  return `https://www.agoda.com/partners/partnersearch.aspx?hid=${agodaHotelId}&cid=${cid}&currency=KRW&hl=ko`;
}

/**
 * 기존 URL에 UTM 파라미터 추가 (없는 경우만).
 * @param {string} url
 * @param {string} [campaignSlug]
 * @returns {string}
 */
function ensureUtm(url, campaignSlug = '') {
  if (!url) return url;
  if (url.includes('utm_source=')) return url;
  const sep      = url.includes('?') ? '&' : '?';
  const campaign = (campaignSlug || 'tripprice')
    .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return `${url}${sep}utm_source=tripprice&utm_medium=affiliate&utm_campaign=${campaign}`;
}

/**
 * 도시 검색 페이지 딥링크 (CID 포함).
 * @param {string} cityName  - 도시명 (한국어 또는 영어)
 * @returns {{ url: string, cityId: number|null }}
 */
function buildCitySearchUrl(cityName) {
  const cid    = getCID();
  const cityId = CITY_ID_MAP[cityName] || CITY_ID_MAP[(cityName || '').toLowerCase()] || null;
  const url = cityId
    ? `https://www.agoda.com/search?cityId=${cityId}&cid=${cid}`
    : `https://www.agoda.com/search?searchText=${encodeURIComponent(cityName)}&cid=${cid}`;
  return { url, cityId };
}

/**
 * 키워드 검색 딥링크 (CID 포함).
 * @param {string} keyword
 * @returns {string}
 */
function buildKeywordSearchUrl(keyword) {
  const cid = getCID();
  return `https://www.agoda.com/search?searchText=${encodeURIComponent(keyword)}&cid=${cid}`;
}

/**
 * 호텔 데이터 객체에서 partner_url 생성/갱신.
 * agoda_hotel_id가 없으면 null 반환.
 * @param {{ agoda_hotel_id?: string, hotel_id?: string, utm_campaign?: string }} hotel
 * @returns {string|null}
 */
function buildPartnerUrlFromHotel(hotel) {
  const agodaId = hotel.agoda_hotel_id || '';
  if (!agodaId) return null;
  const tag = hotel.utm_campaign || hotel.hotel_id || `hotel-${agodaId}`;
  return buildPartnerUrl(agodaId, tag);
}

module.exports = {
  buildPartnerUrl,
  buildCitySearchUrl,
  buildKeywordSearchUrl,
  buildPartnerUrlFromHotel,
  ensureUtm,
  getCID,
  CITY_ID_MAP,
};
