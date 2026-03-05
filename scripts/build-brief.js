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

const hotelIds = (args.hotels || '').split(',').map(h => h.trim()).filter(Boolean);
const lang = args.lang || 'ko';

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
const MIN_COVERAGE = 60;
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
      coverageScore = 0;
    }
  }

  if (coverageScore < MIN_COVERAGE) {
    console.warn(`[BLOCK] ${id} — coverage ${coverageScore}점 (최소 ${MIN_COVERAGE}점 미달)`);
    blocked.push({ hotel_id: id, coverage_score: coverageScore, reason: `coverage ${coverageScore} < ${MIN_COVERAGE}` });
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
function buildSlug(hotels, lang) {
  if (hotels.length === 1) {
    const h = hotels[0];
    const name = (h.hotel_name_en || h.hotel_id).toLowerCase().replace(/\s+/g, '-');
    return `${name}-review`;
  }
  const city = hotels[0].city || 'hotel';
  const category = hotels[0].hotel_category || 'guide';
  return `${city}-${category}-comparison`;
}

function buildTitle(hotels, lang) {
  if (hotels.length === 1) {
    const h = hotels[0];
    if (lang === 'ko') return `${h.hotel_name} 솔직 리뷰 — 추천 대상, 장단점, 가격까지`;
    return `${h.hotel_name_en || h.hotel_name} Review — Who Should Stay Here?`;
  }
  const city = hotels[0].city === 'seoul' ? '서울' : hotels[0].city;
  if (lang === 'ko') return `${city} ${hotels[0].hotel_category === 'luxury' ? '럭셔리' : ''} 호텔 비교 추천`;
  return `${hotels[0].city} Hotel Comparison Guide`;
}

function buildMetaDescription(hotels, lang) {
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
function buildCriteria(hotels) {
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
const slug = buildSlug(hotels, lang);

const brief = {
  brief_id: `brief-${slug}-${today}`,
  created_at: new Date().toISOString(),
  lang,
  post_type: hotels.length === 1 ? 'hotel-review' : 'hotel-comparison',
  slug,
  suggested_title: buildTitle(hotels, lang),
  suggested_meta_description: buildMetaDescription(hotels, lang),
  target_persona: allPersonas,
  selection_criteria: buildCriteria(hotels),
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

// ── 출력 ──────────────────────────────────────────────────────────────────────
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
