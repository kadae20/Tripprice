'use strict';
/**
 * test-top5-list.js
 * top5-list 전략 단위 테스트.
 * 대상: scheduler-generate-jobs.js의 scoreHotelByTheme, buildTop5ListJobs
 * 실행: node scripts/test-top5-list.js
 */

const {
  scoreHotelByTheme,
  themeLabel,
  buildTop5ListJobs,
} = require('./scheduler-generate-jobs');

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

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── 샘플 호텔 데이터 ──────────────────────────────────────────────────────────
function makeHotel(overrides) {
  return {
    hotel_id:     overrides.hotel_id     || 'test-hotel',
    hotel_name:   overrides.hotel_name   || 'Test Hotel',
    city:         overrides.city         || 'seoul',
    review_score: overrides.review_score || '0',
    review_count: overrides.review_count || '0',
    star_rating:  overrides.star_rating  || '0',
    photo_count:  overrides.photo_count  || '0',
    checkin_time: overrides.checkin_time || '',
    ...overrides,
  };
}

// ── [1] scoreHotelByTheme ─────────────────────────────────────────────────────
console.log('\n[1] scoreHotelByTheme\n');

test('rating theme — review_score 반환', () => {
  const h = makeHotel({ review_score: '8.5' });
  assertEqual(scoreHotelByTheme(h, 'rating'), 8.5);
});

test('reviews theme — review_count 반환 (정수)', () => {
  const h = makeHotel({ review_count: '1234' });
  assertEqual(scoreHotelByTheme(h, 'reviews'), 1234);
});

test('stars theme — star_rating 반환', () => {
  const h = makeHotel({ star_rating: '5' });
  assertEqual(scoreHotelByTheme(h, 'stars'), 5);
});

test('photos theme — photo_count 반환', () => {
  const h = makeHotel({ photo_count: '42' });
  assertEqual(scoreHotelByTheme(h, 'photos'), 42);
});

test('checkin theme — star_rating proxy 반환', () => {
  const h = makeHotel({ star_rating: '4' });
  assertEqual(scoreHotelByTheme(h, 'checkin'), 4);
});

test('city theme — star*5+rating*3 합산 반환', () => {
  const h = makeHotel({ star_rating: '5', review_score: '9.0' });
  const expected = 5 * 5 + 9.0 * 3; // 25 + 27 = 52
  assertEqual(scoreHotelByTheme(h, 'city'), expected);
});

test('알 수 없는 theme — review_score 폴백', () => {
  const h = makeHotel({ review_score: '7.3' });
  assertEqual(scoreHotelByTheme(h, 'unknown'), 7.3);
});

test('빈 값이면 0 반환', () => {
  const h = makeHotel({});
  assertEqual(scoreHotelByTheme(h, 'rating'), 0);
  assertEqual(scoreHotelByTheme(h, 'reviews'), 0);
});

// ── [2] themeLabel ────────────────────────────────────────────────────────────
console.log('\n[2] themeLabel\n');

test('rating → "평점 높은"', () => {
  assertEqual(themeLabel('rating'), '평점 높은');
});
test('reviews → "리뷰 많은"', () => {
  assertEqual(themeLabel('reviews'), '리뷰 많은');
});
test('알 수 없는 theme → "추천" 폴백', () => {
  assertEqual(themeLabel('foobar'), '추천');
});

// ── [3] buildTop5ListJobs ─────────────────────────────────────────────────────
console.log('\n[3] buildTop5ListJobs\n');

// 서울 7개 + 부산 6개 + 제주 4개(미달)
const seoulHotels = Array.from({ length: 7 }, (_, i) =>
  makeHotel({ hotel_id: `seoul-h${i}`, city: 'seoul', review_score: `${8 + i * 0.1}` })
);
const busanHotels = Array.from({ length: 6 }, (_, i) =>
  makeHotel({ hotel_id: `busan-h${i}`, city: 'busan', review_score: `${7 + i * 0.1}` })
);
const jejuHotels = Array.from({ length: 4 }, (_, i) =>  // min 5 미달
  makeHotel({ hotel_id: `jeju-h${i}`, city: 'jeju', review_score: `${6 + i * 0.1}` })
);

const allCandidates = [...seoulHotels, ...busanHotels, ...jejuHotels];

test('각 job이 post_type=top5-list임', () => {
  const jobs = buildTop5ListJobs(seoulHotels, 5, 'rating');
  assert(jobs.length >= 1, '작업 없음');
  jobs.forEach(j => assertEqual(j.post_type, 'top5-list', `post_type 불일치: ${j.post_type}`));
});

test('각 job이 theme 필드 포함', () => {
  const jobs = buildTop5ListJobs(seoulHotels, 5, 'reviews');
  assert(jobs.length >= 1, '작업 없음');
  jobs.forEach(j => assertEqual(j.theme, 'reviews'));
});

test('min 5개 미달 도시는 제외 (제주 4개 → 작업 없음)', () => {
  const jobs = buildTop5ListJobs(jejuHotels, 5, 'rating');
  assertEqual(jobs.length, 0, '제주 4개인데 작업이 생성됨');
});

test('각 작업의 hotels에 최대 7개 포함', () => {
  const jobs = buildTop5ListJobs(seoulHotels, 5, 'rating');
  assert(jobs.length >= 1, '작업 없음');
  const count = jobs[0].hotels.split(',').length;
  assert(count <= 7, `hotels ${count}개 > 7`);
  assert(count >= 5, `hotels ${count}개 < 5`);
});

test('theme 기준 내림차순 정렬 (rating: 높은 평점 먼저)', () => {
  const jobs = buildTop5ListJobs(seoulHotels, 5, 'rating');
  assert(jobs.length >= 1, '작업 없음');
  const ids  = jobs[0].hotels.split(',');
  // 마지막 호텔(index 6)이 가장 높은 review_score를 가짐
  assertEqual(ids[0], 'seoul-h6', '평점 높은 순 정렬 오류');
});

test('LIST_CITY_MAX 도시 상한 적용', () => {
  process.env.LIST_CITY_MAX = '2';
  const jobs = buildTop5ListJobs(allCandidates, 10, 'rating');
  // 제주는 4개라 제외, 서울+부산 최대 2개
  assert(jobs.length <= 2, `도시 상한 2인데 ${jobs.length}개 작업 생성`);
  delete process.env.LIST_CITY_MAX;
});

test('maxJobs 상한 적용', () => {
  process.env.LIST_CITY_MAX = '10';
  const jobs = buildTop5ListJobs(allCandidates, 1, 'rating');
  assertEqual(jobs.length, 1, 'maxJobs=1인데 1개 초과');
  delete process.env.LIST_CITY_MAX;
});

test('빈 candidates → 빈 배열', () => {
  const jobs = buildTop5ListJobs([], 5, 'rating');
  assertEqual(jobs.length, 0, '빈 배열이어야 함');
});

test('cooldownRelaxed=true면 note에 쿨다운완화 표시', () => {
  const jobs = buildTop5ListJobs(seoulHotels, 5, 'rating', true);
  assert(jobs.length >= 1, '작업 없음');
  assert(jobs[0].note.includes('쿨다운완화'), 'note에 쿨다운완화 없음');
});

// ── 결과 ──────────────────────────────────────────────────────────────────────
console.log(`\n결과: PASS ${passed} / FAIL ${failed} / 합계 ${passed + failed}`);
if (failed > 0) {
  console.error(`\n❌ ${failed}개 테스트 실패`);
  process.exit(1);
}
console.log('\n✅ 모든 테스트 통과');
