#!/usr/bin/env node
/**
 * agoda-search.js
 * 아고다 CID 포함 링크 생성 + 로컬 호텔 데이터 검색.
 *
 * 동작 모드
 * ─────────
 *  1) 로컬 모드 (기본): data/processed/ 파일 검색 + CID 포함 링크 생성
 *  2) API 모드 (--api): 아고다 Content API 호출 (tripprice.net 서버에서만 동작)
 *
 * Content API 제약
 * ─────────────────
 *  아고다 Content API는 파트너 허브에 등록된 도메인(승인 사이트)에서만
 *  호출 가능합니다. 로컬 CLI에서는 www.agoda.com으로 리다이렉트됩니다.
 *  서버 배포 후 서버사이드(Node/Next.js 등)에서 호출하세요.
 *
 * 필수 환경변수:
 *   AGODA_CID      — 아고다 파트너 CID (기본값: 1926938)
 *   AGODA_API_KEY  — Content API 키 (--api 모드에서만 필요)
 *
 * 사용법:
 *   node scripts/agoda-search.js --city=서울
 *   node scripts/agoda-search.js --hotel-id=grand-hyatt-seoul
 *   node scripts/agoda-search.js --keyword=롯데
 *   node scripts/agoda-search.js --all
 *   node scripts/agoda-search.js --city=서울 --json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const API_KEY_RAW = process.env.AGODA_API_KEY || '';
const API_SECRET  = API_KEY_RAW.includes(':') ? API_KEY_RAW.split(':').slice(1).join(':') : API_KEY_RAW;

const PROCESSED_DIR = path.join(__dirname, '..', 'data', 'processed');
const CAMPAIGN_DIR  = path.join(__dirname, '..', 'state', 'campaigns');

const {
  buildPartnerUrl,
  buildCitySearchUrl,
  buildKeywordSearchUrl,
  getCID,
} = require('../lib/agoda-link-builder');

// ── 로컬 데이터 검색 ─────────────────────────────────────────────────────────
function loadAllHotels() {
  if (!fs.existsSync(PROCESSED_DIR)) return [];
  return fs.readdirSync(PROCESSED_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

function searchLocal({ city, keyword, hotelId, all }) {
  const hotels = loadAllHotels();
  let results = hotels;

  if (hotelId) {
    results = hotels.filter(h => h.hotel_id === hotelId);
  } else if (city) {
    const q = city.toLowerCase();
    results = hotels.filter(h =>
      (h.city || '').toLowerCase().includes(q) ||
      (h.hotel_name || '').includes(city) ||
      (h.address || '').includes(city)
    );
  } else if (keyword) {
    const q = keyword.toLowerCase();
    results = hotels.filter(h =>
      (h.hotel_name || '').toLowerCase().includes(q) ||
      (h.hotel_name_en || '').toLowerCase().includes(q) ||
      (h.district || '').toLowerCase().includes(q) ||
      (h.review_summary || '').toLowerCase().includes(q)
    );
  } else if (!all) {
    results = [];
  }

  return results.map(h => ({
    hotel_id:    h.hotel_id,
    hotel_name:  h.hotel_name,
    hotel_name_en: h.hotel_name_en || '',
    city:        h.city,
    district:    h.district || '',
    star_rating: h.star_rating,
    price_min:   h.price_min,
    review_score: h.review_score,
    coverage_score: h.coverage_score,
    agoda_hotel_id: h.agoda_hotel_id || '',
    // 기존 partner_url이 있으면 사용, 없으면 agoda_hotel_id로 생성
    partner_url: h.partner_url && h.partner_url.includes('cid=')
      ? h.partner_url
      : h.agoda_hotel_id
        ? buildPartnerUrl(h.agoda_hotel_id, h.utm_campaign || h.hotel_id)
        : null,
  }));
}

// ── Content API 호출 (서버 전용) ──────────────────────────────────────────────
const CITY_ID_MAP = {
  '서울': 9395, 'seoul': 9395,
  '부산': 9403, 'busan': 9403,
  '제주': 15773, 'jeju': 15773,
  '인천': 17085, 'incheon': 17085,
};

function httpGetFollow(url, headers = {}, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 3) return reject(new Error('리다이렉트 초과'));
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, { headers }, res => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location : new URL(res.headers.location, url).href;
        res.resume();
        return resolve(httpGetFollow(next, headers, hops + 1));
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    }).on('error', reject)
      .setTimeout(10000, function(){ this.destroy(); reject(new Error('API 타임아웃')); });
  });
}

async function searchViaApi(query) {
  if (!API_SECRET) {
    return { error: 'AGODA_API_KEY 환경변수가 없습니다. API 모드는 서버 전용입니다.' };
  }
  const cityKey = (query.city || '').toLowerCase();
  const cityId  = CITY_ID_MAP[cityKey] || CITY_ID_MAP[query.city] || null;
  const url = cityId
    ? `https://contentapi.agoda.com/api/v1/properties?cityId=${cityId}&pageSize=10&languageCode=ko-KR`
    : `https://contentapi.agoda.com/api/v1/properties?keyword=${encodeURIComponent(query.keyword||query.city||'')}&pageSize=10`;
  const headers = {
    'Authorization': `apikey ${API_KEY_RAW}`,
    'Accept': 'application/json',
  };
  try {
    const res = await httpGetFollow(url, headers);
    if (res.status === 301 || (typeof res.body === 'string' && res.body.includes('www.agoda.com'))) {
      return { error: 'Content API는 등록된 서버 도메인에서만 호출 가능합니다.\n  → tripprice.net 서버에 배포 후 사용하세요.' };
    }
    if (res.status === 401) return { error: '인증 실패 — AGODA_API_KEY를 확인하세요.' };
    if (res.status !== 200) return { error: `API HTTP ${res.status}` };
    const list = Array.isArray(res.body) ? res.body : (res.body?.properties || res.body?.hotels || []);
    return { hotels: list.map(h => ({
      hotel_id: String(h.propertyId || h.id),
      hotel_name: h.propertyName || h.name,
      star_rating: h.starRating,
      city: h.cityName,
      partner_url: buildPartnerUrl(h.propertyId || h.id, `api-${h.propertyId || h.id}`),
    }))};
  } catch (err) {
    return { error: err.message };
  }
}

// ── 출력 포매터 ───────────────────────────────────────────────────────────────
function printHotel(h, idx) {
  const price = h.price_min ? `${(h.price_min/10000).toFixed(0)}만원~` : '-';
  const score = h.review_score ? `${h.review_score}점` : '-';
  const cov   = h.coverage_score != null ? `커버리지 ${h.coverage_score}점` : '';
  console.log(`\n  [${idx}] ${h.hotel_name}${h.hotel_name_en ? ' / '+h.hotel_name_en : ''}`);
  console.log(`      ${h.city} ${h.district} | ⭐${h.star_rating || '-'} | ${price} | 리뷰 ${score} ${cov}`);
  if (h.partner_url) {
    console.log(`      🔗 ${h.partner_url}`);
  } else {
    console.log(`      ⚠️  agoda_hotel_id 없음 — 링크 생성 불가`);
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!args.city && !args['hotel-id'] && !args.keyword && !args.all) {
    console.error('오류: --city, --hotel-id, --keyword, --all 중 하나를 지정하세요.');
    process.exit(1);
  }

  const isApi = args.api === true;
  const query = { city: args.city, hotelId: args['hotel-id'], keyword: args.keyword, all: args.all };

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` 아고다 검색  CID: ${getCID()}  모드: ${isApi ? 'Content API' : '로컬 데이터'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  let hotels, error;

  if (isApi) {
    const r = await searchViaApi(query);
    if (r.error) { error = r.error; } else { hotels = r.hotels; }
  } else {
    hotels = searchLocal(query);
  }

  if (error) {
    console.error(`\n❌ ${error}`);
    process.exit(1);
  }

  // 딥링크 URL 출력
  if (query.city) {
    const { url: searchLink } = buildCitySearchUrl(query.city);
    console.log(`\n  📍 ${query.city} 전체 검색 링크 (CID 포함):`);
    console.log(`     ${searchLink}`);
  }
  if (query.keyword) {
    console.log(`\n  🔍 키워드 검색 링크 (CID 포함):`);
    console.log(`     ${buildKeywordSearchUrl(query.keyword)}`);
  }

  if (hotels.length === 0) {
    console.log(`\n  검색 결과 없음.`);
    if (!isApi) console.log('  → data/processed/ 에 해당 호텔 데이터가 없습니다. ingest-hotel-data.js로 먼저 등록하세요.');
  } else {
    console.log(`\n  검색 결과: ${hotels.length}개`);
    hotels.forEach((h, i) => printHotel(h, i + 1));
  }

  // JSON 저장
  if (args.json) {
    fs.mkdirSync(CAMPAIGN_DIR, { recursive: true });
    const outPath = path.join(CAMPAIGN_DIR, `agoda-search-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify({ cid: CID, query, hotels }, null, 2));
    console.log(`\n  결과 저장: ${outPath}`);
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  ※ Content API(--api)는 tripprice.net 서버 배포 후 사용 가능합니다.');
  console.log('  ※ CID 포함 링크는 로컬 모드에서도 정상 생성됩니다.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(err => { console.error(err.message); process.exit(1); });
