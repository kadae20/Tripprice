#!/usr/bin/env node
/**
 * build-brief.js
 * 호텔 데이터(data/processed/) + coverage score 읽어 콘텐츠 브리프 JSON 생성.
 *
 * 사용법:
 *   node scripts/build-brief.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul
 *   node scripts/build-brief.js --hotels=grand-hyatt-seoul --lang=en
 *
 * 출력: wordpress/drafts/brief-[slug]-[date].json
 */

const fs = require('fs');
const path = require('path');

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? true];
    })
);

const hotelIds  = (args.hotels || '').split(',').map(h => h.trim()).filter(Boolean);
const lang      = args.lang || 'ko';
const postTypeArg = args['post-type'] || '';   // top5-list or empty (auto)
const themeArg    = args.theme || 'rating';    // top5-list theme

if (hotelIds.length === 0) {
  console.error('오류: --hotels 옵션이 필요합니다.');
  console.error('  예: node scripts/build-brief.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul');
  process.exit(1);
}

// ── 경로 ─────────────────────────────────────────────────────────────────────
const PROCESSED_DIR = path.join(__dirname, '..', 'data', 'processed');
const COVERAGE_DIR  = path.join(__dirname, '..', 'state', 'coverage');
const DRAFTS_DIR    = path.join(__dirname, '..', 'wordpress', 'drafts');

fs.mkdirSync(DRAFTS_DIR, { recursive: true });

// ── 호텔 데이터 로드 ──────────────────────────────────────────────────────────
// top5-list는 낮은 coverage 허용 (MIN_LIST_SCORE), 그 외는 MIN_COVERAGE
const isTop5List  = postTypeArg === 'top5-list';
const MIN_COVERAGE    = 60;
const MIN_LIST_SCORE  = Math.min(parseInt(process.env.MIN_LIST_SCORE || '25', 10), 100);
const effectiveMinCov = isTop5List ? MIN_LIST_SCORE : MIN_COVERAGE;

const hotels = [];
const blocked = [];

for (const id of hotelIds) {
  const processedPath = path.join(PROCESSED_DIR, `${id}.json`);
  if (!fs.existsSync(processedPath)) {
    console.error(`[SKIP] 데이터 없음: ${id}`);
    blocked.push({ hotel_id: id, reason: '데이터 파일 없음' });
    continue;
  }

  const hotel = JSON.parse(fs.readFileSync(processedPath, 'utf8'));

  // coverage score: processed JSON 우선, 없으면 coverage 파일 참조
  let coverageScore = hotel.coverage_score;
  if (coverageScore == null) {
    const coveragePath = path.join(COVERAGE_DIR, `${id}.json`);
    if (fs.existsSync(coveragePath)) {
      const cov = JSON.parse(fs.readFileSync(coveragePath, 'utf8'));
      coverageScore = cov.coverage_score ?? 0;
    } else {
      coverageScore = isTop5List ? MIN_LIST_SCORE : 0; // top5-list: coverage 파일 없으면 허용
    }
  }

  if (coverageScore < effectiveMinCov) {
    console.warn(`[BLOCK] ${id} — coverage ${coverageScore}점 (최소 ${effectiveMinCov}점 미달)`);
    blocked.push({ hotel_id: id, coverage_score: coverageScore, reason: `coverage ${coverageScore} < ${effectiveMinCov}` });
    continue;
  }

  hotels.push({ ...hotel, coverage_score: coverageScore });
}

if (hotels.length === 0) {
  console.error('\n브리프 생성 불가: 발행 가능한 호텔이 없습니다.');
  if (blocked.length > 0) {
    console.error('차단된 호텔:');
    blocked.forEach(b => console.error(`  - ${b.hotel_id}: ${b.reason}`));
  }
  process.exit(1);
}

// ── 슬러그/제목 자동 생성 ─────────────────────────────────────────────────────
const THEME_LABEL_KO = { rating: '평점높은', reviews: '리뷰많은', stars: '성급높은',
                          photos: '사진많은', checkin: '체크인빠른', city: '추천' };

function buildSlug(hotels, lang, postType, theme) {
  if (postType === 'top5-list') {
    const city  = hotels[0].city || 'hotel';
    const label = THEME_LABEL_KO[theme] || theme;
    return `${city}-${label}-hotel-top5`;
  }
  if (hotels.length === 1) {
    const h = hotels[0];
    const name = (h.hotel_name_en || h.hotel_id).toLowerCase().replace(/\s+/g, '-');
    return `${name}-review`;
  }
  const city = hotels[0].city || 'hotel';
  const category = hotels[0].hotel_category || 'guide';
  return `${city}-${category}-comparison`;
}

function buildTitle(hotels, lang, postType, theme) {
  const cityMap = { seoul: '서울', busan: '부산', jeju: '제주', incheon: '인천' };
  const cityKo  = cityMap[hotels[0].city] || hotels[0].city;
  const year    = new Date().getFullYear();

  if (postType === 'top5-list') {
    const themeLabel = { rating: '평점 높은', reviews: '리뷰 많은', stars: '성급 높은',
                         photos: '사진 많은', checkin: '체크인 빠른', city: '추천' }[theme] || '추천';
    return `${cityKo} ${themeLabel} 호텔 TOP ${hotels.length}선 (${year})`;
  }
  if (hotels.length === 1) {
    const h = hotels[0];
    if (lang === 'ko') return `${h.hotel_name} 솔직 리뷰 — 추천 대상, 장단점, 가격까지`;
    return `${h.hotel_name_en || h.hotel_name} Review — Who Should Stay Here?`;
  }
  if (lang === 'ko') return `${cityKo} ${hotels[0].hotel_category === 'luxury' ? '럭셔리' : ''} 호텔 비교 추천`;
  return `${hotels[0].city} Hotel Comparison Guide`;
}

function buildMetaDescription(hotels, lang, postType, theme) {
  const cityMap = { seoul: '서울', busan: '부산', jeju: '제주', incheon: '인천' };
  const cityKo  = cityMap[hotels[0].city] || hotels[0].city;

  if (postType === 'top5-list') {
    const themeLabel = { rating: '평점', reviews: '리뷰 수', stars: '별점',
                         photos: '사진 수', checkin: '체크인 시간', city: '종합 평가' }[theme] || '평점';
    const names = hotels.slice(0, 3).map(h => h.hotel_name).join(', ');
    return `${cityKo} 호텔 중 ${themeLabel} 기준 상위 ${hotels.length}선을 정리했습니다. ${names} 등 실제 데이터 기반으로 선정한 리스트를 확인하세요.`;
  }
  if (hotels.length === 1) {
    const h = hotels[0];
    if (lang === 'ko') {
      return `${h.hotel_name} 리뷰: 위치(${h.nearest_station} 도보 ${h.station_walk_min}분), 장단점, 추천 대상을 실제 데이터로 정리했습니다. 예약 전 꼭 확인하세요.`;
    }
    return `${h.hotel_name_en || h.hotel_name} review: location, pros and cons, and who it's best for — all based on real data.`;
  }
  const names = hotels.map(h => lang === 'ko' ? h.hotel_name : (h.hotel_name_en || h.hotel_name)).join(', ');
  if (lang === 'ko') return `${names} 비교 — 위치·가격·시설을 기준으로 상황별 최적 호텔을 골라드립니다.`;
  return `Comparing ${names}: find the best hotel by location, price, and amenities.`;
}

// ── 페르소나 합집합 ────────────────────────────────────────────────────────────
const allPersonas = [...new Set(hotels.flatMap(h => h.target_persona || []))];

// ── 선택 기준 자동 제안 ───────────────────────────────────────────────────────
function buildCriteria(hotels, postType, theme) {
  if (postType === 'top5-list') {
    const themeLabel = { rating: '아고다 투숙객 평점', reviews: '리뷰 수(검증된 후기)', stars: '공식 별점 등급',
                         photos: '공식 사진 수', checkin: '체크인 유연성', city: '위치·평점 종합' }[theme] || theme;
    return [themeLabel, '위치 및 교통 접근성', '가격대 정보'];
  }
  const criteria = ['위치 및 교통 접근성'];
  const hasPrice = hotels.some(h => h.price_min != null);
  if (hasPrice) criteria.push('가격대 및 가성비');
  const hasAmenities = hotels.some(h => (h.amenities || []).length > 0);
  if (hasAmenities) criteria.push('주요 시설 및 서비스');
  criteria.push('추천 여행 목적 (커플/출장/가족 등)');
  return criteria;
}

// ── 브리프 JSON 구성 ──────────────────────────────────────────────────────────
const today = new Date().toISOString().split('T')[0];

// post_type: CLI 인수 우선, 없으면 호텔 수 기반 자동
const resolvedPostType = postTypeArg || (hotels.length === 1 ? 'hotel-review' : 'hotel-comparison');
const slug = buildSlug(hotels, lang, resolvedPostType, themeArg);

const brief = {
  brief_id: `brief-${slug}-${today}`,
  created_at: new Date().toISOString(),
  lang,
  post_type: resolvedPostType,
  theme:     isTop5List ? themeArg : undefined,
  slug,
  suggested_title: buildTitle(hotels, lang, resolvedPostType, themeArg),
  suggested_meta_description: buildMetaDescription(hotels, lang, resolvedPostType, themeArg),
  target_persona: allPersonas,
  selection_criteria: buildCriteria(hotels, resolvedPostType, themeArg),
  hotels: hotels.map(h => ({
    hotel_id: h.hotel_id,
    hotel_name: h.hotel_name,
    hotel_name_en: h.hotel_name_en,
    city: h.city,
    district: h.district,
    star_rating: h.star_rating,
    hotel_category: h.hotel_category,
    price_min: h.price_min,
    price_max: h.price_max,
    currency: h.currency,
    nearest_station: h.nearest_station,
    station_walk_min: h.station_walk_min,
    amenities: h.amenities || [],
    room_types: h.room_types || [],
    location_description: h.location_description || '',
    transport_info: h.transport_info || '',
    review_summary: h.review_summary || '',
    review_score: h.review_score,
    review_count: h.review_count,
    photos_count: h.photos_count || 0,
    agoda_hotel_id: h.agoda_hotel_id,
    partner_url: h.partner_url,
    utm_campaign: h.utm_campaign,
    coverage_score: h.coverage_score,
  })),
  blocked_hotels: blocked.length > 0 ? blocked : undefined,
  workflow_state: {
    plan: false,
    brief: true,
    draft: false,
    fact_check: false,
    seo_qa: false,
    humanize: false,
    cta: false,
    internal_links: false,
    wp_draft: false,
    human_review: false,
  },
};

// theme가 undefined면 JSON에서 키 제거
if (brief.theme === undefined) delete brief.theme;

// ── Affiliate Lite API 보강 (landing_url / image_url_lite / daily_rate_krw) ──
/**
 * Affiliate Lite API를 호출해 brief의 각 호텔에 landing_url 등을 주입한다.
 * API 키 없거나 오류 시 조용히 건너뜀 — 파이프라인 중단 없음.
 */
async function enrichWithAffiliateLite(hotelList) {
  const apiKey = process.env.AGODA_API_KEY || '';
  if (!apiKey) return; // API 키 없으면 skip

  const agodaIds = hotelList.map(h => h.agoda_hotel_id).filter(Boolean);
  if (agodaIds.length === 0) return;

  const lite = require('../lib/agoda-affiliate-lite');
  const results = await lite.search(agodaIds);
  if (results.length === 0) return;

  for (const hotel of hotelList) {
    if (!hotel.agoda_hotel_id) continue;
    const liteData = results.find(r => String(r.hotelId) === String(hotel.agoda_hotel_id));
    if (!liteData) continue;

    if (liteData.landingUrl && liteData.landingUrl.startsWith('http')) {
      hotel.landing_url = liteData.landingUrl;
    }
    if (liteData.imageUrl && liteData.imageUrl.startsWith('http')) {
      hotel.image_url_lite = liteData.imageUrl;
    }
    if (liteData.dailyRate > 0) {
      hotel.daily_rate_krw = liteData.dailyRate;
    }
  }

  const enriched = hotelList.filter(h => h.landing_url).length;
  if (enriched > 0) {
    console.log(`  → Affiliate Lite 보강: ${enriched}개 호텔 landing_url/image_url 주입 완료`);
  }
}

// ── 출력 (async IIFE: Lite API 보강 후 저장) ─────────────────────────────────
(async () => {
  await enrichWithAffiliateLite(brief.hotels);

  const outPath = path.join(DRAFTS_DIR, `${brief.brief_id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(brief, null, 2), 'utf8');

  console.log(`\n브리프 생성 완료`);
  console.log(`  파일: ${outPath}`);
  console.log(`  슬러그: ${slug}`);
  console.log(`  호텔: ${hotels.map(h => h.hotel_name).join(', ')}`);
  if (blocked.length > 0) {
    console.log(`  차단: ${blocked.map(b => b.hotel_id).join(', ')} (coverage 미달)`);
  }
  console.log(`\n다음 단계:`);
  console.log(`  node scripts/generate-draft.js --brief=${brief.brief_id}`);
})().catch(err => {
  console.error(`브리프 저장 오류: ${err.message}`);
  process.exit(1);
});
