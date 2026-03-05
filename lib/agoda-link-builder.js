'use strict';
/**
 * lib/agoda-link-builder.js
 *
 * 아고다 CID 포함 링크 생성 유틸리티.
 * 외부 API 없음. 로컬·서버 어디서나 사용 가능.
 *
 * 사용법:
 *   const { buildPartnerUrl, buildCitySearchUrl } = require('./lib/agoda-link-builder');
 *   buildPartnerUrl('535922', 'grand-hyatt-seoul')
 *   // → https://www.agoda.com/hotel/535922?cid=1926938&tag=grand-hyatt-seoul
 */

const CID = process.env.AGODA_CID || '1926938';

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
 * 호텔 예약 페이지 링크 (CID + UTM tag 포함).
 * @param {string|number} agodaHotelId  - 아고다 호텔 숫자 ID
 * @param {string}        [tag]         - UTM tag (기본: "hotel-{id}")
 * @returns {string}
 */
function buildPartnerUrl(agodaHotelId, tag = '') {
  if (!agodaHotelId) throw new Error('agodaHotelId가 필요합니다');
  const utmTag = (tag || `hotel-${agodaHotelId}`)
    .toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  return `https://www.agoda.com/hotel/${agodaHotelId}?cid=${CID}&tag=${utmTag}`;
}

/**
 * 도시 검색 페이지 딥링크 (CID 포함).
 * @param {string} cityName  - 도시명 (한국어 또는 영어)
 * @returns {{ url: string, cityId: number|null }}
 */
function buildCitySearchUrl(cityName) {
  const cityId = CITY_ID_MAP[cityName] || CITY_ID_MAP[(cityName || '').toLowerCase()] || null;
  const url = cityId
    ? `https://www.agoda.com/search?cityId=${cityId}&cid=${CID}`
    : `https://www.agoda.com/search?searchText=${encodeURIComponent(cityName)}&cid=${CID}`;
  return { url, cityId };
}

/**
 * 키워드 검색 딥링크 (CID 포함).
 * @param {string} keyword
 * @returns {string}
 */
function buildKeywordSearchUrl(keyword) {
  return `https://www.agoda.com/search?searchText=${encodeURIComponent(keyword)}&cid=${CID}`;
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

/** 현재 적용 중인 CID 반환 */
function getCID() { return CID; }

module.exports = {
  buildPartnerUrl,
  buildCitySearchUrl,
  buildKeywordSearchUrl,
  buildPartnerUrlFromHotel,
  getCID,
  CITY_ID_MAP,
};
