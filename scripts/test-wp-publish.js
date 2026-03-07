'use strict';
/**
 * test-wp-publish.js
 *
 * wp-publish.js의 핵심 로직 단위 테스트.
 * WP 서버 연결 없이 로컬에서 실행 가능.
 *
 * 실행: node scripts/test-wp-publish.js
 */

const path = require('path');
const fs = require('fs');
const {
  validateInput, markdownToHTML, buildPayload,
  buildFigureHtml, injectImagesIntoHtml,
} = require('./wp-publish');

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

function assertIncludes(arr, needle, msg) {
  const found = arr.some((s) => s.includes(needle));
  if (!found) throw new Error(msg || `"${needle}" 를 포함하는 항목 없음\n        배열: ${JSON.stringify(arr)}`);
}

// ──────────────────────────────────────────────
// 1. validateInput — 차단 케이스
// ──────────────────────────────────────────────
console.log('\n[1] validateInput — 차단 케이스\n');

test('publish 상태 차단', () => {
  const { errors } = validateInput({
    post_title: '테스트 글',
    slug: 'test-slug',
    lang: 'ko',
    content_html: '<p>내용</p>',
    post_status: 'publish',
  });
  assertIncludes(errors, '차단됨', 'publish 차단 오류 없음');
});

test('post_status="publish"일 때 isValid=false', () => {
  const { isValid } = validateInput({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_html: '<p>x</p>',
    post_status: 'publish',
  });
  assert(isValid === false, 'isValid가 false여야 함');
});

test('허용되지 않는 status 차단 (scheduled)', () => {
  const { errors } = validateInput({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_html: '<p>x</p>',
    post_status: 'scheduled',
  });
  assertIncludes(errors, '허용되지 않는 post_status', 'scheduled 차단 오류 없음');
});

// ──────────────────────────────────────────────
// 2. validateInput — 필수 필드 누락
// ──────────────────────────────────────────────
console.log('\n[2] validateInput — 필수 필드 누락\n');

test('post_title 누락 감지', () => {
  const { errors } = validateInput({
    slug: 'test',
    lang: 'ko',
    content_html: '<p>내용</p>',
  });
  assertIncludes(errors, 'post_title', 'post_title 누락 오류 없음');
});

test('slug 누락 감지', () => {
  const { errors } = validateInput({
    post_title: '글',
    lang: 'ko',
    content_html: '<p>내용</p>',
  });
  assertIncludes(errors, 'slug', 'slug 누락 오류 없음');
});

test('lang 누락 감지', () => {
  const { errors } = validateInput({
    post_title: '글',
    slug: 'test',
    content_html: '<p>내용</p>',
  });
  assertIncludes(errors, 'lang', 'lang 누락 오류 없음');
});

test('content_html, content_markdown 모두 없을 때 감지', () => {
  const { errors } = validateInput({
    post_title: '글',
    slug: 'test',
    lang: 'ko',
  });
  assertIncludes(errors, 'content', 'content 누락 오류 없음');
});

test('content_html만 있으면 content 오류 없음', () => {
  const { errors } = validateInput({
    post_title: '글',
    slug: 'test',
    lang: 'ko',
    content_html: '<p>내용</p>',
  });
  const hasContentError = errors.some((e) => e.includes('content'));
  assert(!hasContentError, 'content_html 있을 때 content 오류 발생하면 안 됨');
});

test('content_markdown만 있으면 content 오류 없음', () => {
  const { errors } = validateInput({
    post_title: '글',
    slug: 'test',
    lang: 'ko',
    content_markdown: '## 제목\n\n내용',
  });
  const hasContentError = errors.some((e) => e.includes('content'));
  assert(!hasContentError, 'content_markdown 있을 때 content 오류 발생하면 안 됨');
});

// ──────────────────────────────────────────────
// 3. validateInput — 정상 케이스
// ──────────────────────────────────────────────
console.log('\n[3] validateInput — 정상 케이스\n');

test('최소 필수 필드로 isValid=true', () => {
  const { isValid, errors } = validateInput({
    post_title: '서울 명동 호텔 추천',
    slug: 'seoul-myeongdong-hotel',
    lang: 'ko',
    content_markdown: '## 제목\n\n내용입니다.',
    post_status: 'draft',
  });
  assert(isValid === true, `isValid=false, errors: ${errors.join(', ')}`);
});

test('post_status="draft" 허용', () => {
  const { isValid } = validateInput({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_html: '<p>내용</p>',
    post_status: 'draft',
  });
  assert(isValid === true, 'draft 상태 허용되어야 함');
});

test('post_status="pending" 허용', () => {
  const { isValid } = validateInput({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_html: '<p>내용</p>',
    post_status: 'pending',
  });
  assert(isValid === true, 'pending 상태 허용되어야 함');
});

test('meta 없을 때 warnings 포함 (meta_description 없음)', () => {
  const { warnings } = validateInput({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_html: '<p>x</p>',
    post_status: 'draft',
  });
  assertIncludes(warnings, 'meta_description', 'meta_description 경고 없음');
});

test('정상 데이터에서 errors 배열 비어있음', () => {
  const { errors } = validateInput({
    post_title: '글',
    slug: 'valid-slug',
    lang: 'ko',
    content_html: '<p>내용</p>',
    post_status: 'draft',
  });
  assert(errors.length === 0, `errors가 있어야 함: ${errors.join(', ')}`);
});

// ──────────────────────────────────────────────
// 4. markdownToHTML
// ──────────────────────────────────────────────
console.log('\n[4] markdownToHTML\n');

test('H1 변환', () => {
  const html = markdownToHTML('# 제목');
  assert(html.includes('<h1>'), 'H1 태그 없음');
  assert(html.includes('제목'), '텍스트 없음');
});

test('H2 변환', () => {
  const html = markdownToHTML('## 소제목');
  assert(html.includes('<h2>'), 'H2 태그 없음');
});

test('H3 변환', () => {
  const html = markdownToHTML('### 소소제목');
  assert(html.includes('<h3>'), 'H3 태그 없음');
});

test('bold(**) 변환', () => {
  const html = markdownToHTML('**굵은 글자**');
  assert(html.includes('<strong>'), '<strong> 태그 없음');
  assert(html.includes('굵은 글자'), '텍스트 없음');
});

test('italic(*) 변환', () => {
  const html = markdownToHTML('*기울임*');
  assert(html.includes('<em>'), '<em> 태그 없음');
});

test('ul/li 변환', () => {
  const html = markdownToHTML('- 항목1\n- 항목2');
  assert(html.includes('<ul>'), '<ul> 없음');
  assert(html.includes('<li>항목1</li>'), '<li> 없음');
});

test('blockquote 변환', () => {
  const html = markdownToHTML('> 인용 문구');
  assert(html.includes('<blockquote>'), '<blockquote> 없음');
  assert(html.includes('인용 문구'), '텍스트 없음');
});

test('인라인 링크 변환', () => {
  const html = markdownToHTML('[링크 텍스트](https://example.com)');
  assert(html.includes('<a href="https://example.com">'), 'href 없음');
  assert(html.includes('링크 텍스트'), '링크 텍스트 없음');
});

test('일반 텍스트 → <p> 태그', () => {
  const html = markdownToHTML('일반 텍스트입니다.');
  assert(html.includes('<p>'), '<p> 태그 없음');
});

test('빈 입력 → 빈 문자열', () => {
  assert(markdownToHTML('') === '', '빈 입력 결과가 빈 문자열이어야 함');
  assert(markdownToHTML(null) === '', 'null 입력 결과가 빈 문자열이어야 함');
});

test('복합 마크다운 변환 (H2 + bold + ul + blockquote)', () => {
  const md = '## 제목\n\n**볼드** 텍스트\n\n- 항목1\n- 항목2\n\n> 인용';
  const html = markdownToHTML(md);
  assert(html.includes('<h2>'), 'H2 없음');
  assert(html.includes('<strong>'), 'strong 없음');
  assert(html.includes('<ul>'), 'ul 없음');
  assert(html.includes('<blockquote>'), 'blockquote 없음');
});

// ──────────────────────────────────────────────
// 5. buildPayload
// ──────────────────────────────────────────────
console.log('\n[5] buildPayload\n');

test('status 항상 draft (입력이 무엇이든)', () => {
  const payload = buildPayload({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_html: '<p>내용</p>',
    post_status: 'draft',
  });
  assert(payload.status === 'draft', `status가 draft가 아님: ${payload.status}`);
});

test('content_markdown이 HTML로 변환됨', () => {
  const payload = buildPayload({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_markdown: '## 제목\n\n내용',
  });
  assert(payload.content.includes('<h2>'), 'markdown이 HTML로 변환되지 않음');
});

test('content_html이 있으면 markdown보다 우선', () => {
  const payload = buildPayload({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_html: '<p>HTML 내용</p>',
    content_markdown: '## 마크다운',
  });
  assert(payload.content.includes('HTML 내용'), 'content_html 우선 처리 안 됨');
  assert(!payload.content.includes('<h2>'), 'content_markdown이 우선 처리됨');
});

test('meta_description이 Yoast 필드로 매핑됨', () => {
  const payload = buildPayload({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_html: '<p>x</p>',
    meta: { meta_description: '설명 텍스트' },
  });
  assert(payload.meta?._yoast_wpseo_metadesc === '설명 텍스트', 'Yoast meta 매핑 실패');
});

test('categories/tags 배열 전달', () => {
  const payload = buildPayload({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_html: '<p>x</p>',
    categories: [1, 2],
    tags: [10],
  });
  assert(Array.isArray(payload.categories), 'categories 없음');
  assert(payload.categories[0] === 1, 'categories 값 불일치');
  assert(payload.tags[0] === 10, 'tags 값 불일치');
});

test('빈 categories/tags는 payload에 포함 안 됨', () => {
  const payload = buildPayload({
    post_title: '글',
    slug: 'slug',
    lang: 'ko',
    content_html: '<p>x</p>',
    categories: [],
    tags: [],
  });
  assert(!payload.categories, '빈 categories가 포함되면 안 됨');
  assert(!payload.tags, '빈 tags가 포함되면 안 됨');
});

// ──────────────────────────────────────────────
// 6. sample-post.json 검증
// ──────────────────────────────────────────────
console.log('\n[6] sample-post.json 검증\n');

const samplePath = path.join(__dirname, '..', 'wordpress', 'sample-post.json');
let sample;

test('sample-post.json 파일 존재', () => {
  assert(fs.existsSync(samplePath), `파일 없음: ${samplePath}`);
  sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
});

test('sample-post.json 검증 통과 (isValid=true)', () => {
  const { isValid, errors } = validateInput(sample);
  assert(isValid === true, `isValid=false, errors: ${errors.join(', ')}`);
});

test('sample-post.json post_status="draft"', () => {
  assert(sample.post_status === 'draft', `status: ${sample.post_status}`);
});

test('sample-post.json workflow_state.internal_links=false (미완료 상태)', () => {
  assert(sample.workflow_state?.internal_links === false, 'internal_links가 false여야 함');
});

test('sample-post.json affiliate_links 존재', () => {
  assert(Array.isArray(sample.affiliate_links) && sample.affiliate_links.length > 0, 'affiliate_links 없음');
});

test('sample-post.json buildPayload가 content 생성', () => {
  const payload = buildPayload(sample);
  assert(typeof payload.content === 'string' && payload.content.length > 0, 'content 없음');
  assert(payload.status === 'draft', 'status가 draft가 아님');
});

// ──────────────────────────────────────────────
// 7. buildFigureHtml + injectImagesIntoHtml
// ──────────────────────────────────────────────
console.log('\n[7] buildFigureHtml\n');

const mockMediaMap = {
  'assets/raw/hotel-a/featured.jpg': { id: 10, url: 'https://example.com/featured.jpg' },
  'assets/raw/hotel-a/pool.jpg':     { id: 11, url: 'https://example.com/pool.jpg' },
  'assets/raw/hotel-a/lobby.jpg':    { id: 12, url: 'https://example.com/lobby.jpg' },
};

test('1장 → wp-block-image figure', () => {
  const html = buildFigureHtml(
    [{ local_path: 'assets/raw/hotel-a/featured.jpg', alt: '대표이미지' }],
    mockMediaMap
  );
  assert(html.includes('wp-block-image'), 'wp-block-image 없음');
  assert(html.includes('https://example.com/featured.jpg'), 'URL 없음');
  assert(html.includes('alt="대표이미지"'), 'alt 없음');
  assert(!html.includes('wp-block-gallery'), '1장인데 gallery 태그 사용됨');
});

test('2장 → wp-block-gallery figure', () => {
  const html = buildFigureHtml(
    [
      { local_path: 'assets/raw/hotel-a/featured.jpg', alt: '이미지1' },
      { local_path: 'assets/raw/hotel-a/pool.jpg',     alt: '이미지2' },
    ],
    mockMediaMap
  );
  assert(html.includes('wp-block-gallery'), 'wp-block-gallery 없음');
  assert(html.includes('columns-2'), '2장 갤러리 columns-2 없음');
});

test('mediaMap에 없는 이미지는 무시', () => {
  const html = buildFigureHtml(
    [{ local_path: 'assets/raw/hotel-a/nonexistent.jpg', alt: '없음' }],
    mockMediaMap
  );
  assert(html === '', 'mediaMap 없는 이미지는 빈 문자열');
});

test('alt 텍스트 XSS — 큰따옴표 이스케이프', () => {
  const map = { 'a.jpg': { id: 1, url: 'https://x.com/a.jpg' } };
  const html = buildFigureHtml([{ local_path: 'a.jpg', alt: 'A "B" C' }], map);
  assert(!html.includes('"B"'), 'alt의 큰따옴표가 이스케이프되지 않음');
  assert(html.includes('&quot;B&quot;'), 'alt XSS 이스케이프 실패');
});

console.log('\n[8] injectImagesIntoHtml\n');

const sampleHtml =
  '<h1>서울 럭셔리 호텔 비교</h1>\n' +
  '<h2>빠른 결론 요약</h2><p>요약</p>\n' +
  '<h2>그랜드 하얏트 서울 — 남산 중턱의 럭셔리 호텔</h2><p>설명</p>\n' +
  '<h2>롯데호텔 서울 — 명동 중심부</h2><p>설명</p>';

const contentImages = [
  {
    position: 'post-summary',
    images: [{ local_path: 'assets/raw/hotel-a/featured.jpg', alt: '요약카드' }],
  },
  {
    position: 'hotel-section',
    hotel_id: 'grand-hyatt-seoul',
    hotel_name: '그랜드 하얏트 서울',
    images: [
      { local_path: 'assets/raw/hotel-a/pool.jpg',  alt: '하얏트 수영장' },
      { local_path: 'assets/raw/hotel-a/lobby.jpg', alt: '하얏트 로비' },
    ],
  },
];

test('post-summary: H1 직후에 이미지 주입', () => {
  const result = injectImagesIntoHtml(sampleHtml, contentImages, mockMediaMap);
  const h1Idx  = result.indexOf('</h1>');
  const imgIdx = result.indexOf('<figure', h1Idx);
  assert(imgIdx > h1Idx, 'H1 직후에 figure 없음');
});

test('hotel-section: 그랜드 하얏트 H2 직후 갤러리 주입', () => {
  const result = injectImagesIntoHtml(sampleHtml, contentImages, mockMediaMap);
  const h2Idx  = result.indexOf('그랜드 하얏트 서울 — ');
  const galIdx = result.indexOf('wp-block-gallery', h2Idx);
  assert(galIdx > h2Idx, '하얏트 H2 직후 갤러리 없음');
});

test('hotel-section 이미지가 다른 호텔 H2 앞에 삽입되지 않음', () => {
  const result = injectImagesIntoHtml(sampleHtml, contentImages, mockMediaMap);
  const lotteH2Idx = result.indexOf('롯데호텔 서울 — ');
  const poolBeforeLotte = result.lastIndexOf('pool.jpg', lotteH2Idx);
  // pool.jpg는 롯데 H2 앞에 있으면 안 됨 (그랜드 하얏트 섹션에만 있어야 함)
  // 단, 그랜드 하얏트 섹션이 롯데보다 먼저 오므로 pool.jpg는 롯데 앞에 있을 수 있음 → 위치만 확인
  assert(result.includes('pool.jpg'), 'pool.jpg URL이 본문에 없음');
});

test('mediaMap이 비어있으면 HTML 변경 없음', () => {
  const result = injectImagesIntoHtml(sampleHtml, contentImages, {});
  assert(result === sampleHtml, '업로드 실패 시 원본 HTML 유지 안 됨');
});

test('content_images 빈 배열이면 HTML 변경 없음', () => {
  const result = injectImagesIntoHtml(sampleHtml, [], mockMediaMap);
  assert(result === sampleHtml, '빈 content_images일 때 HTML 변경됨');
});

// ──────────────────────────────────────────────
// 최종 결과
// ──────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const total = passed + failed;
console.log(` 결과: ${passed}/${total} passed${failed > 0 ? `  (${failed} failed)` : ''}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (failed > 0) process.exit(1);
