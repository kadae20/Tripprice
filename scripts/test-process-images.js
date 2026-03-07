'use strict';
/**
 * test-process-images.js
 *
 * process-images.js의 pure-JS 로직 단위 테스트.
 * sharp 설치 없이 로컬에서 실행 가능.
 *
 * 실행: node scripts/test-process-images.js
 */

const path = require('path');
const { generateAltText, parseFilenameFeature, detectImageType } = require('./process-images');

// ──────────────────────────────────────────────
// 테스트 러너
// ──────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        → ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '조건 불충족');
}

function assertEqual(a, b) {
  if (a !== b) throw new Error(`기대값: "${b}", 실제값: "${a}"`);
}

// ──────────────────────────────────────────────
// 1. parseFilenameFeature — 파일명 특징어 추출
// ──────────────────────────────────────────────
console.log('\n[1] parseFilenameFeature — 파일명 특징어 추출\n');

test('pool.jpg → 수영장', () => {
  assertEqual(parseFilenameFeature('pool.jpg'), '수영장');
});

test('grand-hyatt-lobby.jpg → 로비', () => {
  assertEqual(parseFilenameFeature('grand-hyatt-lobby.jpg'), '로비');
});

test('hotel_room_01.png → 객실', () => {
  assertEqual(parseFilenameFeature('hotel_room_01.png'), '객실');
});

test('rooftop-bar.webp → 루프탑', () => {
  assertEqual(parseFilenameFeature('rooftop-bar.webp'), '루프탑');
});

test('restaurant-interior.jpg → 레스토랑', () => {
  assertEqual(parseFilenameFeature('restaurant-interior.jpg'), '레스토랑');
});

test('spa_treatment.jpg → 스파', () => {
  assertEqual(parseFilenameFeature('spa_treatment.jpg'), '스파');
});

test('city-view.jpg → 도심전망 (city가 view보다 먼저 매핑)', () => {
  assertEqual(parseFilenameFeature('city-view.jpg'), '도심전망');
});

test('exterior_shot.png → 외관', () => {
  assertEqual(parseFilenameFeature('exterior_shot.png'), '외관');
});

test('breakfast-buffet.jpg → 조식', () => {
  assertEqual(parseFilenameFeature('breakfast-buffet.jpg'), '조식');
});

test('gym-facilities.jpg → 피트니스', () => {
  assertEqual(parseFilenameFeature('gym-facilities.jpg'), '피트니스');
});

test('매핑 없는 파일명 → null', () => {
  assertEqual(parseFilenameFeature('img_001.jpg'), null);
});

test('확장자 없는 경우도 처리', () => {
  const result = parseFilenameFeature('pool');
  assertEqual(result, '수영장');
});

test('대문자 파일명도 소문자로 처리', () => {
  const result = parseFilenameFeature('POOL.JPG');
  assertEqual(result, '수영장');
});

// ──────────────────────────────────────────────
// 2. generateAltText — alt 텍스트 생성
// ──────────────────────────────────────────────
console.log('\n[2] generateAltText — alt 텍스트 생성\n');

const mockHotel = { hotel_name: '그랜드 하얏트 서울', city: 'seoul' };

test('특징어 있는 파일 → [호텔명] [특징] [도시]', () => {
  const alt = generateAltText('pool.jpg', mockHotel, 0);
  assert(alt.includes('그랜드 하얏트 서울'), '호텔명 없음');
  assert(alt.includes('수영장'), '특징어 없음');
  assert(alt.includes('seoul'), '도시 없음');
});

test('특징어 없는 파일 → [호텔명] [도시] 호텔', () => {
  const alt = generateAltText('img_001.jpg', mockHotel, 0);
  assert(alt.includes('그랜드 하얏트 서울'), '호텔명 없음');
  assert(alt.includes('호텔'), '호텔 텍스트 없음');
});

test('두 번째 이미지(index=1) → 번호 포함', () => {
  const alt = generateAltText('img_002.jpg', mockHotel, 1);
  assert(alt.includes('2'), '번호 없음');
});

test('hotel_name 없으면 hotel_id 사용', () => {
  const alt = generateAltText('lobby.jpg', { hotel_id: 'ibis-myeongdong', city: 'seoul' }, 0);
  assert(alt.includes('ibis-myeongdong'), 'hotel_id 없음');
  assert(alt.includes('로비'), '특징어 없음');
});

test('hotelData가 null이면 에러 없이 처리', () => {
  const alt = generateAltText('room.jpg', null, 0);
  assert(typeof alt === 'string', 'alt가 문자열이어야 함');
  assert(alt.length > 0, 'alt가 비어있으면 안 됨');
});

test('alt 텍스트 100자 이하', () => {
  const longNameHotel = { hotel_name: '이름이매우긴호텔입니다이름이매우긴호텔입니다이름이매우긴호텔', city: 'seoul' };
  const alt = generateAltText('swimming-pool-rooftop.jpg', longNameHotel, 0);
  assert(alt.length <= 100, `100자 초과: ${alt.length}자`);
});

test('호텔명, 도시, 특징 모두 없으면 빈 문자열 아님', () => {
  const alt = generateAltText('img.jpg', {}, 0);
  assert(typeof alt === 'string', 'string이어야 함');
});

// ──────────────────────────────────────────────
// 3. detectImageType — 이미지 타입 판별
// ──────────────────────────────────────────────
console.log('\n[3] detectImageType — 이미지 타입 판별\n');

test('featured.jpg → featured', () => {
  assertEqual(detectImageType('featured.jpg'), 'featured');
});

test('main-image.jpg → featured', () => {
  assertEqual(detectImageType('main-image.jpg'), 'featured');
});

test('hero.webp → featured', () => {
  assertEqual(detectImageType('hero.webp'), 'featured');
});

test('thumbnail.png → featured', () => {
  assertEqual(detectImageType('thumbnail.png'), 'featured');
});

test('파일명에 01 포함 → featured', () => {
  assertEqual(detectImageType('hotel-01.jpg'), 'featured');
});

test('pool.jpg → content', () => {
  assertEqual(detectImageType('pool.jpg'), 'content');
});

test('lobby-interior.jpg → content', () => {
  assertEqual(detectImageType('lobby-interior.jpg'), 'content');
});

test('img_005.jpg → content', () => {
  assertEqual(detectImageType('img_005.jpg'), 'content');
});

test('room-view.webp → content', () => {
  assertEqual(detectImageType('room-view.webp'), 'content');
});

// ──────────────────────────────────────────────
// 4. 엣지 케이스 / 통합
// ──────────────────────────────────────────────
console.log('\n[4] 엣지 케이스\n');

test('파일명이 빈 문자열이어도 에러 없음', () => {
  const alt = generateAltText('', mockHotel, 0);
  assert(typeof alt === 'string', 'string이어야 함');
});

test('한국어 호텔명 + 영문 파일명 조합', () => {
  const hotel = { hotel_name: '롯데호텔 서울', city: 'seoul' };
  const alt = generateAltText('restaurant-view.jpg', hotel, 0);
  assert(alt.includes('롯데호텔 서울'), '한국어 호텔명 없음');
  assert(alt.includes('레스토랑'), '레스토랑 특징어 없음');
});

test('detectImageType: 빈 문자열 → content (에러 없음)', () => {
  const type = detectImageType('');
  assertEqual(type, 'content');
});

test('parseFilenameFeature: 빈 문자열 → null', () => {
  const result = parseFilenameFeature('');
  assertEqual(result, null);
});

// ──────────────────────────────────────────────
// 5. make-post-image — 순수 함수 테스트
// ──────────────────────────────────────────────
console.log('\n[5] make-post-image — slugToTitle / buildCardAltText / buildCardSvg\n');

const { buildCardSvg, buildCardAltText, slugToTitle, escapeXml } = require('./make-post-image');

test('slugToTitle: 하이픈 분리 + 대문자화', () => {
  assertEqual(slugToTitle('grand-hyatt-seoul'), 'Grand Hyatt Seoul');
  assertEqual(slugToTitle('seoul-luxury-comparison'), 'Seoul Luxury Comparison');
});

test('slugToTitle: 단일 단어', () => {
  assertEqual(slugToTitle('seoul'), 'Seoul');
});

test('escapeXml: & < > " 이스케이프', () => {
  const result = escapeXml('A & B < C > D "E"');
  assert(result.includes('&amp;'), '& 미이스케이프');
  assert(result.includes('&lt;'),  '< 미이스케이프');
  assert(result.includes('&gt;'),  '> 미이스케이프');
  assert(result.includes('&quot;'), '" 미이스케이프');
});

test('buildCardAltText: ko 비교 카드', () => {
  const alt = buildCardAltText({
    postSlug: 'seoul-luxury-comparison',
    hotelNames: ['그랜드 하얏트 서울', '롯데호텔 서울'],
    lang: 'ko',
    isCard: true,
  });
  assert(alt.includes('그랜드 하얏트 서울'), '첫 번째 호텔명 없음');
  assert(alt.includes('롯데호텔 서울'),      '두 번째 호텔명 없음');
  assert(alt.length <= 100,                  `alt 100자 초과 (${alt.length}자)`);
});

test('buildCardAltText: en 언어', () => {
  const alt = buildCardAltText({
    postSlug: 'seoul-luxury-comparison',
    hotelNames: ['Grand Hyatt Seoul', 'Lotte Hotel Seoul'],
    lang: 'en',
  });
  assert(alt.includes('Featured Image'), 'en alt 텍스트 형식 오류');
});

test('buildCardAltText: 호텔명 3개 이상이면 앞 2개만', () => {
  const alt = buildCardAltText({
    postSlug:   'test-comparison',
    hotelNames: ['A', 'B', 'C'],
    lang: 'ko',
  });
  assert(!alt.includes(' vs C'), '3번째 호텔이 alt에 포함되면 안 됨');
});

test('buildCardSvg: SVG Buffer 반환', () => {
  const svg = buildCardSvg({
    postSlug:   'seoul-luxury-comparison',
    hotelSlugs: ['grand-hyatt-seoul', 'lotte-hotel-seoul'],
  });
  assert(Buffer.isBuffer(svg), 'Buffer여야 함');
  assert(svg.length > 100, 'SVG가 너무 짧음');
});

test('buildCardSvg: svg 태그 포함', () => {
  const svg = buildCardSvg({
    postSlug:   'test-post',
    hotelSlugs: ['hotel-a', 'hotel-b'],
  }).toString();
  assert(svg.includes('<svg'), '<svg> 태그 없음');
  assert(svg.includes('</svg>'), '</svg> 태그 없음');
});

test('buildCardSvg: 호텔명 vs 구분자 포함', () => {
  const svg = buildCardSvg({
    postSlug:   'test-post',
    hotelSlugs: ['hotel-alpha', 'hotel-beta'],
  }).toString();
  assert(svg.includes('Hotel Alpha'), '첫 번째 호텔명 없음');
  assert(svg.includes('Hotel Beta'),  '두 번째 호텔명 없음');
  assert(svg.includes(' vs '),        'vs 구분자 없음');
});

test('buildCardSvg: Tripprice 브랜딩 포함', () => {
  const svg = buildCardSvg({
    postSlug:   'test-post',
    hotelSlugs: ['hotel-a'],
  }).toString();
  assert(svg.includes('Tripprice'), 'Tripprice 브랜딩 없음');
});

test('buildCardSvg: watermark 옵션 opacity 차이', () => {
  const withWm    = buildCardSvg({ postSlug: 'p', hotelSlugs: ['h'], watermark: true  }).toString();
  const withoutWm = buildCardSvg({ postSlug: 'p', hotelSlugs: ['h'], watermark: false }).toString();
  assert(withWm !== withoutWm, 'watermark 옵션이 SVG에 영향 없음');
});

// ──────────────────────────────────────────────
// 6. wp-publish — featured_media 연결 (mock)
// ──────────────────────────────────────────────
console.log('\n[6] wp-publish — featured_media payload 연결\n');

const { buildPayload } = require('./wp-publish');

test('featuredMediaId 전달 시 payload.featured_media 설정', () => {
  const payload = buildPayload(
    { post_title: '글', slug: 's', lang: 'ko', content_html: '<p>x</p>' },
    { featuredMediaId: 42 }
  );
  assertEqual(payload.featured_media, 42, 'featured_media가 42여야 함');
});

test('featuredMediaId 없으면 payload.featured_media 미설정', () => {
  const payload = buildPayload(
    { post_title: '글', slug: 's', lang: 'ko', content_html: '<p>x</p>' }
  );
  assert(payload.featured_media === undefined, 'featured_media가 없어야 함');
});

test('featuredMediaId=null이면 payload.featured_media 미설정', () => {
  const payload = buildPayload(
    { post_title: '글', slug: 's', lang: 'ko', content_html: '<p>x</p>' },
    { featuredMediaId: null }
  );
  assert(payload.featured_media === undefined, 'null이면 featured_media 없어야 함');
});

// ──────────────────────────────────────────────
// 최종 결과
// ──────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const total = passed + failed;
console.log(` 결과: ${passed}/${total} passed${failed > 0 ? `  (${failed} failed)` : ''}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (failed > 0) process.exit(1);
