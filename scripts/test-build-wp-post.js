'use strict';
/**
 * test-build-wp-post.js
 * build-wp-post.js 핵심 함수 단위 테스트.
 * 실행: node scripts/test-build-wp-post.js
 */

const {
  parseFrontMatter,
  extractAffiliateLinks,
  extractInternalLinks,
  extractFAQ,
  minimalMdToHtml,
  resolveHotelImages,
  buildContentImages,
  getFilenameFeatureKo,
} = require('./build-wp-post');

// ── 테스트 러너 ───────────────────────────────────────────────────────────────
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

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `기대: ${JSON.stringify(b)}, 실제: ${JSON.stringify(a)}`);
}

// ── 1. parseFrontMatter ───────────────────────────────────────────────────────
console.log('\n[1] parseFrontMatter\n');

test('title/slug/lang 파싱', () => {
  const md = '---\ntitle: "테스트 제목"\nslug: "test-slug"\nlang: ko\n---\n\n본문';
  const { fm, body } = parseFrontMatter(md);
  assertEqual(fm.title, '테스트 제목');
  assertEqual(fm.slug, 'test-slug');
  assertEqual(fm.lang, 'ko');
  assert(body.includes('본문'), '본문 포함');
});

test('front-matter 없으면 빈 객체 반환', () => {
  const { fm, body } = parseFrontMatter('그냥 본문입니다');
  assertEqual(Object.keys(fm).length, 0, 'fm은 빈 객체');
  assert(body.includes('그냥'), '본문 그대로');
});

test('큰따옴표 제거', () => {
  const md = '---\ntitle: "따옴표 있는 제목"\n---\n';
  const { fm } = parseFrontMatter(md);
  assertEqual(fm.title, '따옴표 있는 제목');
});

test('값에 콜론 포함된 경우 첫 번째 콜론만 구분자', () => {
  const md = '---\nmeta_description: "서울 비교: 최고의 선택"\n---\n';
  const { fm } = parseFrontMatter(md);
  assert(fm.meta_description.includes('서울 비교'), '콜론 이후 값 보존');
});

// ── 2. extractAffiliateLinks ──────────────────────────────────────────────────
console.log('\n[2] extractAffiliateLinks\n');

const sampleMd = `
> **[그랜드 하얏트 서울 현재 가격 확인하기 →](https://www.agoda.com/hotel/535922?cid=1926938&tag=grand-hyatt-seoul)**
> **[롯데호텔 서울 현재 가격 확인하기 →](https://www.agoda.com/hotel/68689?cid=1926938&tag=lotte-hotel-seoul)**
`;

test('CTA 링크 2개 추출', () => {
  const links = extractAffiliateLinks(sampleMd);
  assertEqual(links.length, 2, '링크 2개');
});

test('첫 번째 링크 hotel_id 추출 (tag= 기준)', () => {
  const links = extractAffiliateLinks(sampleMd);
  assertEqual(links[0].hotel_id, 'grand-hyatt-seoul');
});

test('utm_source는 tripprice', () => {
  const links = extractAffiliateLinks(sampleMd);
  links.forEach(l => assertEqual(l.utm_source, 'tripprice'));
});

test('CTA 없는 경우 빈 배열', () => {
  const links = extractAffiliateLinks('링크 없는 본문');
  assertEqual(links.length, 0);
});

// ── 3. extractInternalLinks ───────────────────────────────────────────────────
console.log('\n[3] extractInternalLinks\n');

const internalMd = `
## 내부 링크 제안 (발행 전 삽입)

- [서울 호텔 완전 가이드](/ko/seoul-hotel-guide)
- [서울 지역별 호텔 추천](/ko/seoul-hotel-by-area)
- [그랜드 하얏트 서울 단독 리뷰](/ko/grand-hyatt-seoul-review)

> 위 URL은 예시입니다.
`;

test('내부 링크 3개 추출', () => {
  const links = extractInternalLinks(internalMd);
  assertEqual(links.length, 3);
});

test('첫 번째 링크 url 확인', () => {
  const links = extractInternalLinks(internalMd);
  assertEqual(links[0].url, '/ko/seoul-hotel-guide');
});

test('섹션 없으면 빈 배열', () => {
  const links = extractInternalLinks('내부 링크 섹션 없음');
  assertEqual(links.length, 0);
});

// ── 4. extractFAQ ─────────────────────────────────────────────────────────────
console.log('\n[4] extractFAQ\n');

const faqMd = `
**Q. 그랜드 하얏트와 롯데호텔 중 어디가 더 낫나요?**
A. 목적에 따라 다릅니다. 서비스 우선이라면 하얏트를 추천합니다.

**Q. 서울 호텔 예약은 얼마나 일찍 해야 하나요?**
A. 성수기에는 4~6주 전을 권장합니다.

**Q. 체크인 시간은?**
A. 보통 15:00입니다.
`;

test('FAQ 3개 추출', () => {
  const faqs = extractFAQ(faqMd);
  assertEqual(faqs.length, 3);
});

test('첫 번째 FAQ question 확인', () => {
  const faqs = extractFAQ(faqMd);
  assert(faqs[0].question.includes('그랜드 하얏트'), `question: ${faqs[0].question}`);
});

test('FAQ 없으면 빈 배열', () => {
  const faqs = extractFAQ('FAQ 없는 본문');
  assertEqual(faqs.length, 0);
});

// ── 5. minimalMdToHtml ────────────────────────────────────────────────────────
console.log('\n[5] minimalMdToHtml\n');

test('H1 변환', () => {
  const html = minimalMdToHtml('# 제목');
  assert(html.includes('<h1>제목</h1>'), `변환 결과: ${html}`);
});

test('H2 변환', () => {
  const html = minimalMdToHtml('## 소제목');
  assert(html.includes('<h2>소제목</h2>'));
});

test('bold 변환', () => {
  const html = minimalMdToHtml('**굵게**');
  assert(html.includes('<strong>굵게</strong>'));
});

test('링크 변환', () => {
  const html = minimalMdToHtml('[텍스트](https://example.com)');
  assert(html.includes('<a href="https://example.com">텍스트</a>'));
});

test('HR 변환', () => {
  const html = minimalMdToHtml('---');
  assert(html.includes('<hr>'));
});

// ── getFilenameFeatureKo ──────────────────────────────────────────────────────
console.log('\n[6] getFilenameFeatureKo\n');

test('pool.jpg → 수영장', () => {
  assertEqual(getFilenameFeatureKo('pool.jpg'), '수영장');
});
test('lobby-interior.jpg → 로비', () => {
  assertEqual(getFilenameFeatureKo('lobby-interior.jpg'), '로비');
});
test('featured.jpg → 대표이미지', () => {
  assertEqual(getFilenameFeatureKo('featured.jpg'), '대표이미지');
});
test('restaurant-interior.jpg → 레스토랑', () => {
  assertEqual(getFilenameFeatureKo('restaurant-interior.jpg'), '레스토랑');
});
test('알 수 없는 파일명 → null', () => {
  assertEqual(getFilenameFeatureKo('xyz-unknown.jpg'), null);
});

// ── resolveHotelImages (실제 assets/raw 사용) ─────────────────────────────────
console.log('\n[7] resolveHotelImages\n');

test('grand-hyatt-seoul 이미지 최소 1장 반환 (raw 없으면 폴백)', () => {
  const imgs = resolveHotelImages('grand-hyatt-seoul', '그랜드 하얏트 서울', 'seoul', 4);
  assert(Array.isArray(imgs), '배열이어야 함');
  assert(imgs.length >= 1, '폴백 포함 최소 1장');
  assert(imgs.length <= 4, '최대 4장 초과 안 됨');
  assert(imgs[0].local_path.startsWith('assets/'), 'local_path가 assets/로 시작');
  assert(typeof imgs[0].alt === 'string' && imgs[0].alt.length > 0, 'alt 텍스트 있어야 함');
});

test('grand-hyatt-seoul alt에 호텔명 포함 (raw 또는 폴백)', () => {
  const imgs = resolveHotelImages('grand-hyatt-seoul', '그랜드 하얏트 서울', 'seoul', 4);
  assert(imgs.length >= 1, '이미지 없음');
  assert(imgs[0].alt.includes('그랜드 하얏트 서울'), 'alt에 호텔명 없음');
});

test('존재하지 않는 호텔 → 폴백 1장 (featured.webp 경로)', () => {
  const imgs = resolveHotelImages('nonexistent-hotel', '존재안함', 'seoul', 4);
  assertEqual(imgs.length, 1, '폴백 이미지 1장이어야 함');
  assert(imgs[0].local_path.includes('nonexistent-hotel'), 'hotel_id가 경로에 포함');
  assert(imgs[0].alt.length > 0, 'alt 텍스트 있어야 함');
});

test('max=2이면 최대 2장', () => {
  const imgs = resolveHotelImages('grand-hyatt-seoul', '그랜드 하얏트 서울', 'seoul', 2);
  assert(imgs.length <= 2, '최대 2장 초과');
});

// ── buildContentImages ────────────────────────────────────────────────────────
console.log('\n[8] buildContentImages\n');

const mockHotels = [
  { hotel_id: 'grand-hyatt-seoul', hotel_name: '그랜드 하얏트 서울', city: 'seoul' },
  { hotel_id: 'lotte-hotel-seoul', hotel_name: '롯데호텔 서울',      city: 'seoul' },
];

test('post-summary 섹션 포함 (이미지 있을 때)', () => {
  // assets/processed/seoul-luxury-comparison/featured.webp 존재 가정
  const items = buildContentImages('seoul-luxury-comparison', mockHotels);
  const hasSummary = items.some(it => it.position === 'post-summary');
  assert(hasSummary, 'post-summary 섹션 없음 (featured.webp 없으면 PASS)');
});

test('hotel-section 구조 검증', () => {
  const items = buildContentImages('seoul-luxury-comparison', mockHotels);
  const hotelSections = items.filter(it => it.position === 'hotel-section');
  for (const sec of hotelSections) {
    assert(typeof sec.hotel_id === 'string', 'hotel_id 없음');
    assert(typeof sec.hotel_name === 'string', 'hotel_name 없음');
    assert(Array.isArray(sec.images), 'images 배열 없음');
    assert(sec.images.length > 0, 'hotel-section에 이미지 없음');
  }
});

test('빈 hotels 배열이면 hotel-section 없음', () => {
  const items = buildContentImages('some-slug', []);
  const hotelSections = items.filter(it => it.position === 'hotel-section');
  assertEqual(hotelSections.length, 0, '빈 hotels인데 hotel-section이 있음');
});

test('총 이미지 8장 상한', () => {
  const manyHotels = Array.from({ length: 5 }, (_, i) => ({
    hotel_id: 'grand-hyatt-seoul', hotel_name: '그랜드 하얏트 서울', city: 'seoul',
  }));
  const items = buildContentImages('test-slug', manyHotels);
  const total = items.reduce((s, sec) => s + (sec.images || []).length, 0);
  assert(total <= 8, `이미지 상한 8장 초과: ${total}장`);
});

// ── 결과 ──────────────────────────────────────────────────────────────────────
console.log(`\n결과: PASS ${passed} / FAIL ${failed} / 합계 ${passed + failed}`);
if (failed > 0) {
  console.error(`\n❌ ${failed}개 테스트 실패`);
  process.exit(1);
}
console.log('\n✅ 모든 테스트 통과');
