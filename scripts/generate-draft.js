#!/usr/bin/env node
/**
 * generate-draft.js
 * brief JSON → hotel-decision-guide.md 구조 기반 마크다운 초안 생성.
 * 외부 API 없음. 로컬 데이터만 사용.
 *
 * 사용법:
 *   node scripts/generate-draft.js --brief=brief-seoul-luxury-comparison-2026-03-05
 *   node scripts/generate-draft.js --brief=wordpress/drafts/brief-xxx.json
 */

const fs = require('fs');
const path = require('path');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

if (!args.brief) {
  console.error('오류: --brief 옵션이 필요합니다.');
  console.error('  예: node scripts/generate-draft.js --brief=brief-seoul-luxury-comparison-2026-03-05');
  process.exit(1);
}

const DRAFTS_DIR = path.join(__dirname, '..', 'wordpress', 'drafts');

// brief 파일 경로 해석
function resolveBriefPath(input) {
  if (fs.existsSync(input)) return input;
  const withExt = input.endsWith('.json') ? input : `${input}.json`;
  if (fs.existsSync(withExt)) return withExt;
  const inDrafts = path.join(DRAFTS_DIR, withExt);
  if (fs.existsSync(inDrafts)) return inDrafts;
  return null;
}

const briefPath = resolveBriefPath(args.brief);
if (!briefPath) {
  console.error(`브리프 파일을 찾을 수 없습니다: ${args.brief}`);
  process.exit(1);
}

const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
const { hotels, lang, post_type, slug, suggested_title, suggested_meta_description,
        selection_criteria, target_persona } = brief;

const today = new Date().toISOString().split('T')[0];
const isKo = lang === 'ko';

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
const KRW = (n) => n ? `${(n / 10000).toFixed(0)}만원` : '정보 없음';

function coverageNote(score) {
  if (score == null || score >= 80) return '';
  if (score >= 60) return '\n> ⚠️ **일부 정보 보강 필요:** 현재 데이터가 충분하지 않아 일부 항목은 추후 업데이트 예정입니다.\n';
  return '\n> ⚠️ **정보 보강 필요:** 현재 공개된 정보가 제한적입니다. 예약 전 공식 채널에서 직접 확인하세요.\n';
}

// 장점 규칙 기반 도출
function inferPros(h) {
  const pros = [];
  if (h.review_score && h.review_score >= 8.5) pros.push(`아고다 리뷰 ${h.review_score}점 — 투숙객 만족도 높음`);
  if (h.station_walk_min && h.station_walk_min <= 5) pros.push(`${h.nearest_station} 도보 ${h.station_walk_min}분 — 대중교통 접근성 우수`);
  if ((h.amenities || []).includes('수영장')) pros.push('실내/야외 수영장 이용 가능');
  if ((h.amenities || []).includes('조식뷔페')) pros.push('조식뷔페 포함 옵션 선택 가능');
  if ((h.amenities || []).includes('스파')) pros.push('스파·웰니스 시설 완비');
  if (h.star_rating >= 5) pros.push('5성급 수준의 서비스와 시설');
  if (h.photos_count && h.photos_count >= 8) pros.push('공식 사진 자료가 충분히 제공됨');
  if (pros.length === 0) pros.push('상세 장점은 공식 채널 확인 필요');
  return pros.slice(0, 4);
}

// 단점/주의 규칙 기반 도출
function inferCons(h) {
  const cons = [];
  if (h.price_min && h.price_min >= 300000) cons.push(`1박 기준 ${KRW(h.price_min)} 이상 — 예산 부담 가능`);
  if (h.station_walk_min && h.station_walk_min > 10) cons.push(`${h.nearest_station}까지 도보 ${h.station_walk_min}분 — 대중교통 접근 다소 불편`);
  if (h.review_summary && h.review_summary.includes('높다')) cons.push('가격 대비 가치에 대한 의견 엇갈림');
  if (!h.transport_info) cons.push('교통/동선 정보 추가 확인 필요');
  if ((h.amenities || []).length < 5) cons.push('시설 정보가 제한적 — 예약 전 직접 확인 권장');
  if (cons.length === 0) cons.push('주요 단점 정보 수집 중');
  return cons.slice(0, 3);
}

// 추천 대상 규칙 기반 도출
function inferTarget(h) {
  const t = [];
  if ((h.target_persona || []).includes('couple')) t.push('커플 여행');
  if ((h.target_persona || []).includes('business')) t.push('출장/비즈니스');
  if ((h.target_persona || []).includes('family')) t.push('가족 여행');
  if ((h.target_persona || []).includes('solo')) t.push('혼자 여행');
  if (h.hotel_category === 'luxury') t.push('특별한 날 기념 숙박');
  if (h.price_min && h.price_min < 100000) t.push('예산 중시 여행자');
  return t.length > 0 ? t.join(', ') : '다양한 여행 목적';
}

// 호텔명 (언어 기반)
function hotelName(h) {
  return isKo ? h.hotel_name : (h.hotel_name_en || h.hotel_name);
}

// 도시명 한국어
function cityKo(city) {
  const map = { seoul: '서울', busan: '부산', jeju: '제주', incheon: '인천' };
  return map[city] || city;
}

// ── SEO 품질 보정 헬퍼 ────────────────────────────────────────────────────────

// ── Yoast SEO 자동 생성 헬퍼 ─────────────────────────────────────────────────

/**
 * Focus keyphrase 자동 생성.
 * 형식: "{도시} {카테고리} 호텔 비교" / "{호텔명} {도시} 후기"
 */
function buildFocusKeyphrase() {
  const city = cityKo(hotels[0].city);
  if (post_type === 'hotel-comparison') {
    const allLuxury = hotels.every(h => h.hotel_category === 'luxury');
    const qualifier = allLuxury ? '럭셔리 ' : '';
    return `${city} ${qualifier}호텔 비교`;
  }
  return `${hotelName(hotels[0])} ${city} 후기`;
}

/**
 * Yoast SEO title 자동 생성 (최대 60자).
 * 형식: "{keyphrase}: {단축호텔명1} vs {단축호텔명2}({연도}) | Tripprice"
 */
function buildYoastSeoTitle(focusKeyphrase) {
  const year = new Date().getFullYear();
  const SITE = 'Tripprice';

  // 호텔명 단축: 도시명 접미어 제거, "그랜드 " 등 선행 수식어 제거
  function shorten(h) {
    const city = cityKo(h.city);
    return h.hotel_name
      .replace(new RegExp(`\\s*${city}$`), '')   // 끝 도시명 제거
      .replace(/^(그랜드|파크|더|롯데)\s+/, ''); // 일반 선행어 제거
  }

  if (post_type === 'hotel-comparison') {
    const names = hotels.map(shorten).join(' vs ');
    const candidate = `${focusKeyphrase}: ${names}(${year}) | ${SITE}`;
    return candidate.length <= 60 ? candidate : candidate.slice(0, 58) + '…';
  }
  const h = hotels[0];
  const candidate = `${hotelName(h)} 리뷰 ${year} — ${focusKeyphrase} | ${SITE}`;
  return candidate.length <= 60 ? candidate : candidate.slice(0, 58) + '…';
}

/**
 * Yoast meta description 자동 생성 (120~155자).
 * 검색 결과 클릭을 유도하는 action-oriented 문장.
 * focus keyphrase를 앞쪽에 배치.
 */
function buildYoastMetaDesc(focusKeyphrase) {
  const city = cityKo(hotels[0].city);
  const year = new Date().getFullYear();
  const names = hotels.map(h => h.hotel_name).join('과 ');

  // selection_criteria에서 비교 기준 추출 (최대 4개)
  const criteria = (selection_criteria || [])
    .map(c => c.replace(/\s*\(.*?\)/g, '').trim())  // 괄호 설명 제거
    .slice(0, 4)
    .join(', ');

  let desc;
  if (post_type === 'hotel-comparison') {
    desc = `${focusKeyphrase} 가이드(${year}). ${names}을 ${criteria} 기준으로 비교해 어떤 여행자에게 맞는지 정리했습니다.`;
  } else {
    const h = hotels[0];
    desc = `${hotelName(h)} ${city} 솔직 리뷰(${year}). 위치, 가격, 시설, 투숙객 후기 기반으로 ${focusKeyphrase}에 대한 장단점을 정리했습니다.`;
  }

  // 120자 미달 시 가격 정보 추가
  if (desc.length < 120) {
    const priceMin = Math.min(...hotels.map(h => h.price_min).filter(Boolean));
    if (priceMin) desc += ` ${(priceMin / 10000).toFixed(0)}만원대부터 예약 가능.`;
  }

  return desc.length > 155 ? desc.slice(0, 153) + '…' : desc;
}

/**
 * SEO title 최소 30자 확보.
 * 짧으면 호텔명·연도를 자연스럽게 덧붙여 확장한다.
 * 60자 초과 시 말줄임표 처리.
 */
function ensureMinTitle(title) {
  if (title.length >= 30) return title;
  const year = new Date().getFullYear();
  let extended;
  if (post_type === 'hotel-comparison') {
    const names = hotels.map(hotelName).join(' vs ');
    extended = `${title} — ${names} ${year}`;
  } else {
    const h = hotels[0];
    extended = `${title} — ${cityKo(h.city)} ${h.star_rating || ''}성급 솔직 리뷰 ${year}`;
  }
  return extended.length > 60 ? extended.slice(0, 58) + '…' : extended;
}

/**
 * meta_description 최소 120자, 최대 155자 확보.
 * 부족하면 도시·페르소나·가격대 정보를 문장으로 이어붙인다.
 */
function ensureMinMeta(meta) {
  if (meta.length >= 120) return meta.slice(0, 155);
  const cityName = cityKo(hotels[0].city);
  const personas = [...new Set(hotels.flatMap(h => h.target_persona || []))]
    .map(p => ({ couple: '커플', business: '출장', family: '가족', solo: '솔로' }[p] || p))
    .join('·');
  const priceMin = Math.min(...hotels.map(h => h.price_min).filter(Boolean));
  const additions = [];
  if (post_type === 'hotel-comparison') {
    additions.push(
      `${cityName} 여행에서 자주 비교되는 두 호텔을 위치·가격·시설·투숙객 후기 기준으로 직접 분석했습니다.`
    );
    if (personas) additions.push(`${personas} 여행자 각각에게 맞는 선택 기준도 정리했습니다.`);
    if (priceMin) additions.push(`${(priceMin / 10000).toFixed(0)}만원대부터 예약 가능.`);
  } else {
    const h = hotels[0];
    additions.push(`실제 투숙 데이터 기반으로 ${hotelName(h)}의 장단점을 솔직하게 분석합니다.`);
    if (personas) additions.push(`${personas} 여행자에게 적합한지 확인하세요.`);
  }
  let extended = meta;
  for (const a of additions) {
    if (extended.length >= 120) break;
    const sep = extended.match(/[.다]$/) ? ' ' : '. ';
    extended = `${extended}${sep}${a}`;
  }
  return extended.length > 155 ? extended.slice(0, 153) + '…' : extended;
}

/**
 * post_excerpt 자동 생성 (2~3문장, 200자 이내).
 * "누구를 위한 글인지 + 핵심 가치"를 담아 wp-publish의 excerpt 필드로 전달.
 */
function buildExcerpt() {
  const cityName = cityKo(hotels[0].city);
  const personas = [...new Set(hotels.flatMap(h => h.target_persona || []))]
    .map(p => ({ couple: '커플', business: '출장객', family: '가족 여행자', solo: '솔로 여행자' }[p] || p))
    .join(', ');

  let excerpt;
  if (post_type === 'hotel-comparison') {
    const names = hotels.map(hotelName).join(', ');
    excerpt = `${cityName} 여행을 앞두고 ${names} 중 어디가 더 맞는지 고민이라면 이 글이 도움이 됩니다.`;
    if (personas) excerpt += ` ${personas}에게 각각 어떤 호텔이 적합한지, 위치·가격·시설을 기준으로 비교 정리했습니다.`;
  } else {
    const h = hotels[0];
    excerpt = `${hotelName(h)} 예약을 고민 중인 ${personas || '여행자'}를 위한 솔직한 분석 글입니다.`;
    excerpt += ` 위치, 주요 시설, 실제 투숙객 후기 기반 장단점을 정리해 예약 결정을 돕습니다.`;
  }

  return excerpt.length > 200 ? excerpt.slice(0, 198) + '…' : excerpt;
}

/**
 * featured_image_url 결정:
 * 1) assets/processed/{hotel_id}/ 에 webp/jpg 파일이 있으면 그것을 사용
 * 2) 없으면 null (build-wp-post가 front-matter에 빈 필드로 포함 → wp-publish 건너뜀)
 */
function resolveFeaturedImageUrl() {
  const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'processed');
  for (const h of hotels) {
    const dir = path.join(ASSETS_DIR, h.hotel_id);
    if (!fs.existsSync(dir)) continue;
    const images = fs.readdirSync(dir).filter(f => /\.(webp|jpg|jpeg|png)$/i.test(f));
    if (images.length === 0) continue;
    const preferred = images.find(f => /featured|main|hero|01/.test(f)) || images[0];
    return path.posix.join('assets/processed', h.hotel_id, preferred);
  }
  return null;
}

// ── 섹션 빌더 ─────────────────────────────────────────────────────────────────

function buildFrontMatter() {
  const title             = ensureMinTitle(suggested_title);
  const metaDesc          = ensureMinMeta(suggested_meta_description);
  const featuredImageUrl  = resolveFeaturedImageUrl();
  const excerpt           = buildExcerpt();
  const focusKeyphrase    = buildFocusKeyphrase();
  const yoastSeoTitle     = buildYoastSeoTitle(focusKeyphrase);
  const yoastMetaDesc     = buildYoastMetaDesc(focusKeyphrase);

  return [
    '---',
    `title: "${title}"`,
    `slug: "${slug}"`,
    `meta_description: "${metaDesc}"`,
    `excerpt: "${excerpt}"`,
    `focus_keyphrase: "${focusKeyphrase}"`,
    `yoast_seo_title: "${yoastSeoTitle}"`,
    `yoast_meta_description: "${yoastMetaDesc}"`,
    `lang: ${lang}`,
    `post_type: ${post_type}`,
    `created_at: ${today}`,
    `workflow_state: brief_done`,
    `featured_image_url: ${featuredImageUrl ? `"${featuredImageUrl}"` : ''}`,
    '---',
    '',
  ].join('\n');
}

function buildQuickSummary() {
  const lines = ['## 빠른 결론 요약', ''];
  lines.push('> **이 글의 핵심 결론**');
  lines.push('>');

  if (post_type === 'hotel-comparison') {
    const sorted = [...hotels].sort((a, b) => (b.review_score || 0) - (a.review_score || 0));
    const byPrice = [...hotels].sort((a, b) => (a.price_min || 0) - (b.price_min || 0));
    lines.push(`> - 서비스·리뷰 우선이라면: **${hotelName(sorted[0])}**`);
    if (byPrice[0].hotel_id !== sorted[0].hotel_id) {
      lines.push(`> - 가격 우선이라면: **${hotelName(byPrice[0])}**`);
    }
    // 호텔별 대표 페르소나 기준으로 요약 (중복 제거)
    const seen = new Set();
    hotels.forEach(h => {
      const personas = h.target_persona || [];
      const unique = personas.filter(p => !seen.has(p));
      unique.forEach(p => seen.add(p));
      if (unique.length === 0) return;
      const label = unique.map(p => ({ couple: '커플', business: '출장', family: '가족', solo: '혼자 여행' }[p] || p)).join('/');
      lines.push(`> - ${label} 우선이라면: **${hotelName(h)}**`);
    });
  } else {
    const h = hotels[0];
    lines.push(`> - **${hotelName(h)}**는 ${inferTarget(h)}에게 적합합니다.`);
    lines.push(`> - 위치: ${h.nearest_station || '정보 없음'} 도보 ${h.station_walk_min || '?'}분`);
    lines.push(`> - 가격대: ${KRW(h.price_min)} ~ ${KRW(h.price_max)}`);
  }

  lines.push('>');
  lines.push('> 아래에서 선택 기준과 상세 분석을 확인하세요.');
  lines.push('');
  return lines.join('\n');
}

function buildTargetReader() {
  const cityName = cityKo(hotels[0].city);
  const personas = [...new Set(hotels.flatMap(h => h.target_persona || []))];
  const personaStr = personas.map(p => ({ couple: '커플', business: '출장객', family: '가족 여행자', solo: '혼자 여행자' }[p] || p)).join(', ');

  const lines = ['## 이 글이 필요한 사람', ''];
  if (post_type === 'hotel-comparison') {
    const personaPart = personaStr ? `특히 ${personaStr}으로 방문 예정이며, ` : '';
    lines.push(`${cityName}에서 호텔을 고르는 중인데 어디가 더 나은지 판단이 서지 않는 분을 위한 글입니다. ${personaPart}각 호텔의 장단점을 직접 비교해 상황에 맞는 선택을 하고 싶은 분께 도움이 됩니다.`);
  } else {
    const h = hotels[0];
    lines.push(`${hotelName(h)} 예약을 고민 중인 ${personaStr}을 위한 글입니다. 위치, 시설, 실제 투숙 후기 기반 장단점을 정리해 예약 전 의사결정을 돕습니다.`);
  }
  lines.push('');
  return lines.join('\n');
}

function buildCriteria() {
  const lines = ['## 선택 기준', ''];
  lines.push('이 글에서 호텔을 비교할 때 사용한 기준:');
  lines.push('');
  (selection_criteria || []).forEach((c, i) => {
    lines.push(`${i + 1}. **${c}**`);
  });
  lines.push('');
  return lines.join('\n');
}

function buildComparisonTable() {
  if (post_type !== 'hotel-comparison' || hotels.length < 2) return '';

  const lines = ['## 한눈에 비교', ''];
  const header = ['기준', ...hotels.map(hotelName)].join(' | ');
  const sep    = ['------', ...hotels.map(() => '------')].join(' | ');
  lines.push(`| ${header} |`);
  lines.push(`| ${sep} |`);

  const rows = [
    ['위치',     h => h.nearest_station ? `${h.nearest_station} 도보 ${h.station_walk_min}분` : '정보 없음'],
    ['가격대',   h => `${KRW(h.price_min)} ~`],
    ['별점',     h => h.star_rating ? `${h.star_rating}성급` : '정보 없음'],
    ['리뷰점수', h => h.review_score ? `${h.review_score}점` : '정보 없음'],
    ['조식',     h => (h.amenities || []).includes('조식뷔페') ? '포함 옵션' : '별도 확인'],
    ['추천 대상', h => inferTarget(h)],
  ];

  rows.forEach(([label, fn]) => {
    const cells = [label, ...hotels.map(fn)].join(' | ');
    lines.push(`| ${cells} |`);
  });

  lines.push('');
  return lines.join('\n');
}

function buildHotelSection(h) {
  const lines = [];
  const name = hotelName(h);
  const pros = inferPros(h);
  const cons = inferCons(h);
  const target = inferTarget(h);

  lines.push(`## ${name} — ${h.location_description || h.district || h.city}`);
  lines.push('');
  lines.push(coverageNote(h.coverage_score));

  lines.push(`**추천 대상:** ${target}`);
  lines.push('');

  lines.push('**장점:**');
  pros.forEach(p => lines.push(`- ${p}`));
  lines.push('');

  lines.push('**아쉬운 점 / 주의사항:**');
  cons.forEach(c => lines.push(`- ${c}`));
  lines.push('');

  if (h.transport_info) {
    lines.push(`**위치 & 동선:** ${h.transport_info}`);
  } else {
    lines.push(`**위치 & 동선:** ${h.nearest_station || '정보 없음'} 도보 ${h.station_walk_min || '?'}분`);
  }
  lines.push('');

  lines.push(`**가격대:** ${KRW(h.price_min)} ~ ${KRW(h.price_max)} *(실제 가격은 예약 페이지 기준)*`);
  lines.push('');

  if (h.review_score && h.review_count) {
    lines.push(`**투숙객 리뷰:** ${h.review_score}점 (${h.review_count.toLocaleString()}개 기준)`);
    if (h.review_summary) lines.push(`> ${h.review_summary}`);
    lines.push('');
  }

  // CTA
  const ctaText = isKo ? `${name} 현재 가격 확인하기 →` : `Check current prices for ${name} →`;
  const ctaUrl = h.partner_url || `https://www.agoda.com/hotel/${h.agoda_hotel_id}`;
  lines.push(`> **[${ctaText}](${ctaUrl})**`);
  lines.push('> *(아고다 파트너 링크 | rel="sponsored")*');
  lines.push('');
  lines.push('---');
  lines.push('');

  return lines.join('\n');
}

function buildFAQ() {
  const cityName = cityKo(hotels[0].city);
  const h1 = hotels[0];
  const lines = ['## 자주 묻는 질문 (FAQ)', ''];

  if (post_type === 'hotel-comparison') {
    lines.push(`**Q. ${hotels.map(hotelName).join('과 ')} 중 어디가 더 낫나요?**`);
    lines.push(`A. 목적에 따라 다릅니다. ${inferTarget(hotels[0])}이라면 ${hotelName(hotels[0])}를, ${inferTarget(hotels[1] || hotels[0])}이라면 ${hotelName(hotels[1] || hotels[0])}를 추천합니다. 위의 비교표를 참고해 우선순위에 맞는 선택을 하세요.`);
    lines.push('');
    lines.push(`**Q. ${cityName} 호텔은 얼마나 일찍 예약해야 하나요?**`);
    lines.push(`A. 성수기(봄·가을 연휴, 연말)에는 최소 4~6주 전 예약을 권장합니다. 비수기에는 2주 전도 충분한 경우가 많습니다.`);
    lines.push('');
    lines.push(`**Q. 체크인·체크아웃 시간은 어떻게 되나요?**`);
    const checkinInfo = hotels.map(h => `${hotelName(h)}: 체크인 ${h.checkin_time || '15:00'}, 체크아웃 ${h.checkout_time || '12:00'}`).join(' / ');
    lines.push(`A. ${checkinInfo}. 조기 체크인·레이트 체크아웃은 사전 요청 및 추가 요금이 발생할 수 있습니다.`);
  } else {
    lines.push(`**Q. ${hotelName(h1)}는 어떤 여행자에게 적합한가요?**`);
    lines.push(`A. ${inferTarget(h1)}에게 특히 추천합니다. ${h1.location_description || '위치와 시설이 잘 갖춰져 있습니다.'}`);
    lines.push('');
    lines.push(`**Q. ${hotelName(h1)} 주변 관광지는 어떻게 되나요?**`);
    lines.push(`A. ${h1.transport_info || `${h1.nearest_station || '인근 역'}에서 접근 가능하며, 주변 관광 동선 정보는 추후 업데이트 예정입니다.`}`);
    lines.push('');
    lines.push(`**Q. 가격은 어느 시기가 가장 저렴한가요?**`);
    lines.push(`A. 비수기(1~2월, 6~8월 평일)에 상대적으로 저렴한 요금을 기대할 수 있습니다. 실시간 가격은 예약 페이지에서 확인하세요.`);
  }

  lines.push('');
  return lines.join('\n');
}

function buildInternalLinks() {
  const cityName = cityKo(hotels[0].city);
  const lines = ['## 내부 링크 제안 (발행 전 삽입)', ''];
  lines.push(`- [${cityName} 호텔 완전 가이드](/ko/${hotels[0].city}-hotel-guide) — 허브 글 연결 필수`);
  lines.push(`- [${cityName} 지역별 호텔 추천](/ko/${hotels[0].city}-hotel-by-area) — 동선 가이드`);
  if (hotels.length > 1) {
    lines.push(`- [${hotelName(hotels[0])} 단독 리뷰](/ko/${hotels[0].hotel_id}-review) — 스포크 글 (추후 발행 예정)`);
  }
  lines.push('');
  lines.push('> 위 URL은 예시입니다. 실제 발행 후 정확한 URL로 교체하세요.');
  lines.push('');
  return lines.join('\n');
}

function buildFooter() {
  return [
    '---',
    '',
    '*이 글에는 아고다 파트너 링크가 포함되어 있습니다. 링크를 통해 예약하시면 추가 비용 없이 운영에 도움이 됩니다.*',
    '',
    '> 가격·혜택·환불 규정은 시기에 따라 변동될 수 있으며,',
    '> 최종 조건은 예약 페이지에서 직접 확인하시기 바랍니다.',
    '',
  ].join('\n');
}

// ── 템플릿 본문 빌더 (Z.ai 폴백용) ──────────────────────────────────────────
function buildTemplateBody() {
  const parts = [];
  parts.push(`# ${ensureMinTitle(suggested_title)}\n`);
  parts.push(buildQuickSummary());
  parts.push(buildTargetReader());
  parts.push(buildCriteria());
  if (post_type === 'hotel-comparison') {
    parts.push(buildComparisonTable());
  }
  hotels.forEach(h => parts.push(buildHotelSection(h)));
  parts.push(buildFAQ());
  parts.push(buildInternalLinks());
  parts.push(buildFooter());
  return parts.join('\n');
}

function validateAiBody(text) {
  if (!text || text.length < 800)                      return false;
  if (!/^#\s/.test(text.trim()))                       return false;
  if (!/##\s*(자주\s*묻는|FAQ)/i.test(text))           return false;
  if (!/현재\s*가격\s*확인하기/.test(text))             return false;
  if (!/가격·혜택·환불/.test(text))                    return false;
  // FAQ 3개 이상 검증
  const faqCount = (text.match(/\*\*Q[.:]/g) || []).length;
  if (faqCount < 3)                                    return false;
  return true;
}

// ── 마크다운 조립 (async: Z.ai 우선, 실패 시 템플릿 폴백) ─────────────────────
(async () => {
  const frontMatter = buildFrontMatter();
  let body;
  let source = 'template';

  try {
    const zai    = require('../lib/zai-client');
    const aiBody = await zai.generateHotelDraft(brief);
    if (validateAiBody(aiBody)) {
      body   = aiBody;
      source = 'z.ai';
    } else {
      console.error('  ⚠  Z.ai 응답 검증 실패 → 템플릿 폴백');
      body = buildTemplateBody();
    }
  } catch (err) {
    const reason = process.env.ZAI_API_KEY ? err.message : 'ZAI_API_KEY 없음';
    console.error(`  ⚠  Z.ai 건너뜀 (${reason}) → 템플릿 폴백`);
    body = buildTemplateBody();
  }

  const markdown = frontMatter + '\n' + body;

  // ── 출력 ──────────────────────────────────────────────────────────────────
  const outFilename = `draft-${slug}-${today}.md`;
  const outPath = path.join(DRAFTS_DIR, outFilename);
  fs.writeFileSync(outPath, markdown, 'utf8');

  // 섹션 목록 추출 (H2 헤더)
  const sectionList = markdown.split('\n')
    .filter(l => l.startsWith('## '))
    .map(l => l.replace('## ', '').trim());

  const finalTitle       = ensureMinTitle(suggested_title);
  const finalMeta        = ensureMinMeta(suggested_meta_description);
  const finalFeaturedUrl = resolveFeaturedImageUrl();
  const finalKeyphrase   = buildFocusKeyphrase();
  const finalYoastTitle  = buildYoastSeoTitle(finalKeyphrase);
  const finalYoastMeta   = buildYoastMetaDesc(finalKeyphrase);

  console.log('\n초안 생성 완료');
  console.log(`  파일: ${outPath}`);
  console.log(`  초안 생성: ${source}`);
  console.log(`  제목: ${finalTitle} (${finalTitle.length}자)`);
  console.log(`  슬러그: ${slug}`);
  console.log(`  호텔: ${hotels.map(hotelName).join(', ')}`);
  console.log(`  meta_desc: ${finalMeta.length}자`);
  console.log(`  focus_keyphrase:    "${finalKeyphrase}"`);
  console.log(`  yoast_seo_title:    "${finalYoastTitle}" (${finalYoastTitle.length}자)`);
  console.log(`  yoast_meta_desc:    ${finalYoastMeta.length}자`);
  console.log(`  featured_image_url: ${finalFeaturedUrl || '없음 (assets/processed 이미지 없음)'}`);
  console.log(`\n포함된 섹션:`);
  sectionList.forEach(s => console.log(`  - ${s}`));
  console.log(`\n다음 단계:`);
  console.log(`  node scripts/seo-qa.js --draft=${outFilename.replace('.md', '')}`);
})().catch(err => {
  console.error('초안 생성 실패:', err.message);
  process.exit(1);
});
