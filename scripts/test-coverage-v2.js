'use strict';
/**
 * test-coverage-v2.js
 * coverage score v2 (CSV-only) 단위 테스트.
 * 실행: node scripts/test-coverage-v2.js
 *
 * 새 공식 (6개 항목):
 *   photos(30pts) + overview(25pts) + rating(20pts) + reviews(15pts)
 *   + checkin/checkout(5pts) + lat/lon(5pts) = 100pts max
 * 등급: A>=60, B>=40, C>=20, D<20
 */

const { calculateCoverageScoreV2 } = require('./ingest-hotel-data');

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

// ── [1] 개별 항목 점수 ────────────────────────────────────────────────────────
console.log('\n[1] 개별 항목 점수\n');

// photos (30pts)
test('photos_count: 5이상 → 30점', () => {
  const { breakdown } = calculateCoverageScoreV2({ photos_count: '5' });
  assertEqual(breakdown.photos_count.points, 30);
});

test('photos_count: 20 → 30점 (cap)', () => {
  const { breakdown } = calculateCoverageScoreV2({ photos_count: '20' });
  assertEqual(breakdown.photos_count.points, 30);
});

test('photos_count: 3 → 18점', () => {
  const { breakdown } = calculateCoverageScoreV2({ photos_count: '3' });
  assertEqual(breakdown.photos_count.points, 18);
});

test('photos_count: 1 → 8점', () => {
  const { breakdown } = calculateCoverageScoreV2({ photos_count: '1' });
  assertEqual(breakdown.photos_count.points, 8);
});

test('photos_count: 0 → 0점 + missing에 photos 포함', () => {
  const { breakdown, missing } = calculateCoverageScoreV2({ photos_count: '0' });
  assertEqual(breakdown.photos_count.points, 0);
  assert(missing.includes('photos'), 'missing에 photos 없음');
});

// overview (25pts)
test('overview 100자 이상 → 25점', () => {
  const { breakdown } = calculateCoverageScoreV2({ overview: 'A'.repeat(100) });
  assertEqual(breakdown.overview.points, 25);
});

test('overview 300자 → 25점 (cap)', () => {
  const { breakdown } = calculateCoverageScoreV2({ overview: 'A'.repeat(300) });
  assertEqual(breakdown.overview.points, 25);
});

test('overview 50자 → 15점', () => {
  const { breakdown } = calculateCoverageScoreV2({ overview: 'A'.repeat(50) });
  assertEqual(breakdown.overview.points, 15);
});

test('overview 1자 → 5점', () => {
  const { breakdown } = calculateCoverageScoreV2({ overview: 'X' });
  assertEqual(breakdown.overview.points, 5);
});

test('overview 비어있음 → 0점', () => {
  const { breakdown } = calculateCoverageScoreV2({ overview: '' });
  assertEqual(breakdown.overview.points, 0);
});

test('location_description도 overview 대신 인정 (100자 이상 → 25점)', () => {
  const { breakdown } = calculateCoverageScoreV2({ location_description: 'B'.repeat(100) });
  assertEqual(breakdown.overview.points, 25);
});

// rating (20pts)
test('rating_average: 8.0 이상 → 20점', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_score: '8.0' });
  assertEqual(breakdown.rating_average.points, 20);
});

test('rating_average: 9.0 → 20점', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_score: '9.0' });
  assertEqual(breakdown.rating_average.points, 20);
});

test('rating_average: 10.0 → 20점 (cap)', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_score: '10.0' });
  assertEqual(breakdown.rating_average.points, 20);
});

test('rating_average: 6.0 → 14점', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_score: '6.0' });
  assertEqual(breakdown.rating_average.points, 14);
});

test('rating_average: 7.9 → 14점 (6~7.9)', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_score: '7.9' });
  assertEqual(breakdown.rating_average.points, 14);
});

test('rating_average: 5.0 (>0, <6) → 7점', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_score: '5.0' });
  assertEqual(breakdown.rating_average.points, 7);
});

test('rating_average: 0 → 0점', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_score: '0' });
  assertEqual(breakdown.rating_average.points, 0);
});

// reviews (15pts)
test('number_of_reviews: 1000이상 → 15점', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_count: '1000' });
  assertEqual(breakdown.number_of_reviews.points, 15);
});

test('number_of_reviews: 10000 → 15점 (cap)', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_count: '10000' });
  assertEqual(breakdown.number_of_reviews.points, 15);
});

test('number_of_reviews: 100 → 10점', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_count: '100' });
  assertEqual(breakdown.number_of_reviews.points, 10);
});

test('number_of_reviews: 10 → 5점', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_count: '10' });
  assertEqual(breakdown.number_of_reviews.points, 5);
});

test('number_of_reviews: 0 → 0점', () => {
  const { breakdown } = calculateCoverageScoreV2({ review_count: '0' });
  assertEqual(breakdown.number_of_reviews.points, 0);
});

// checkin/checkout (5pts)
test('checkin + checkout 둘다 있음 → 5점', () => {
  const { breakdown } = calculateCoverageScoreV2({ checkin_time: '15:00', checkout_time: '12:00' });
  assertEqual(breakdown.checkin_checkout.points, 5);
});

test('checkin만 있음 → 2점', () => {
  const { breakdown } = calculateCoverageScoreV2({ checkin_time: '15:00' });
  assertEqual(breakdown.checkin_checkout.points, 2);
});

test('checkin/checkout 없음 → 0점', () => {
  const { breakdown } = calculateCoverageScoreV2({});
  assertEqual(breakdown.checkin_checkout.points, 0);
});

// lat/lon (5pts)
test('lat + lon 있음 → 5점', () => {
  const { breakdown } = calculateCoverageScoreV2({ latitude: '37.5', longitude: '126.9' });
  assertEqual(breakdown.lat_lng.points, 5);
});

test('lat 없음 → 0점', () => {
  const { breakdown } = calculateCoverageScoreV2({});
  assertEqual(breakdown.lat_lng.points, 0);
});

// ── [2] 등급 경계 테스트 ──────────────────────────────────────────────────────
console.log('\n[2] 등급 경계 테스트\n');

// A등급 (>=60): photos(30)+overview(25)+rating(20) = 75
test('photos5+overview100+rating8 → A등급 (75점)', () => {
  const hotel = {
    photos_count: '5',
    overview: 'A'.repeat(100),
    review_score: '8.0',
  };
  const { grade, score } = calculateCoverageScoreV2(hotel);
  assertEqual(score, 75);
  assertEqual(grade, 'A');
});

// A등급: photos(30)+overview(25)+rating(20)+reviews(15)+checkin(5)+lat(5) = 100
test('최고 데이터 호텔 → A등급 100점', () => {
  const hotel = {
    photos_count: '5',
    overview: 'A'.repeat(100),
    review_score: '8.0',
    review_count: '1000',
    checkin_time: '15:00', checkout_time: '12:00',
    latitude: '37.5', longitude: '126.9',
  };
  const { grade, score } = calculateCoverageScoreV2(hotel);
  assertEqual(score, 100);
  assertEqual(grade, 'A');
});

// B등급 (40~59): photos(30)+rating(14) = 44
test('photos5+rating6.0 → B등급 (44점)', () => {
  const hotel = { photos_count: '5', review_score: '6.0' };
  const { grade, score } = calculateCoverageScoreV2(hotel);
  assertEqual(score, 44);
  assertEqual(grade, 'B');
});

// C등급 (20~39): overview(25) = 25
test('overview만 100자 → C등급 (25점)', () => {
  const hotel = { overview: 'A'.repeat(100) };
  const { grade, score } = calculateCoverageScoreV2(hotel);
  assertEqual(score, 25);
  assertEqual(grade, 'C');
});

// D등급 (<20): rating(7) = 7
test('rating 5.0만 있음 → D등급 (7점)', () => {
  const hotel = { review_score: '5.0' };
  const { grade, score } = calculateCoverageScoreV2(hotel);
  assertEqual(score, 7);
  assertEqual(grade, 'D');
});

// D등급: 빈 호텔
test('빈 호텔 → D등급 + 점수 0', () => {
  const { grade, score } = calculateCoverageScoreV2({});
  assertEqual(grade, 'D');
  assertEqual(score, 0);
});

// 경계: 정확히 60점 → A등급
test('정확히 60점 → A등급', () => {
  // photos(30) + overview(25) + reviews(5, review_count=10) = 60
  const hotel = { photos_count: '5', overview: 'A'.repeat(100), review_count: '10' };
  const { grade, score } = calculateCoverageScoreV2(hotel);
  assertEqual(score, 60);
  assertEqual(grade, 'A');
});

// 경계: 정확히 40점 → B등급
test('정확히 40점 → B등급', () => {
  // photos(18, count=3) + overview(15, len=50) + lat/lon(5) + checkin/checkout(2) = 40
  const hotel = {
    photos_count: '3',
    overview: 'A'.repeat(50),
    latitude: '37.5', longitude: '126.9',
    checkin_time: '15:00',
  };
  const { grade, score } = calculateCoverageScoreV2(hotel);
  assertEqual(score, 40);
  assertEqual(grade, 'B');
});

// 경계: 정확히 20점 → C등급
test('정확히 20점 → C등급', () => {
  // overview(15, len=50) + checkin/checkout(5) = 20
  const hotel = { overview: 'A'.repeat(50), checkin_time: '15:00', checkout_time: '12:00' };
  const { grade, score } = calculateCoverageScoreV2(hotel);
  assertEqual(score, 20);
  assertEqual(grade, 'C');
});

// ── [3] 합계 100 상한 ─────────────────────────────────────────────────────────
console.log('\n[3] 합계 100 상한\n');

test('모든 필드 최고값이어도 score <= 100', () => {
  const hotel = {
    photos_count: '100',
    overview: 'X'.repeat(500),
    review_score: '10',
    review_count: '99999',
    checkin_time: '14:00', checkout_time: '11:00',
    latitude: '37.5', longitude: '127.0',
  };
  const { score } = calculateCoverageScoreV2(hotel);
  assert(score <= 100, `점수 ${score} > 100`);
});

// ── [4] missing 필드 배열 ─────────────────────────────────────────────────────
console.log('\n[4] missing 필드\n');

test('빈 호텔 → missing 배열에 모든 항목 포함 (6개)', () => {
  const { missing } = calculateCoverageScoreV2({});
  assert(missing.length > 0, 'missing 배열 비어있음');
  assert(Array.isArray(missing), 'missing이 배열이 아님');
  assertEqual(missing.length, 6, `missing 항목 ${missing.length}개, 6개 기대`);
});

test('평점만 있으면 missing에서 rating_average 제외', () => {
  const { missing } = calculateCoverageScoreV2({ review_score: '8.0' });
  assert(!missing.includes('rating_average'), 'rating_average가 missing에 있으면 안됨');
});

test('photos_count=5이면 missing에서 photos 제외', () => {
  const { missing } = calculateCoverageScoreV2({ photos_count: '5' });
  assert(!missing.includes('photos'), 'photos가 missing에 있으면 안됨');
});

test('overview 100자 이상이면 missing에서 overview 제외', () => {
  const { missing } = calculateCoverageScoreV2({ overview: 'A'.repeat(100) });
  assert(!missing.includes('overview'), 'overview가 missing에 있으면 안됨');
});

// ── [5] 폴백 필드명 테스트 ────────────────────────────────────────────────────
console.log('\n[5] 폴백 필드명\n');

test('rating_average 필드명도 인식', () => {
  const { breakdown } = calculateCoverageScoreV2({ rating_average: '8.5' });
  assertEqual(breakdown.rating_average.points, 20);
});

test('number_of_reviews 필드명도 인식', () => {
  const { breakdown } = calculateCoverageScoreV2({ number_of_reviews: '1000' });
  assertEqual(breakdown.number_of_reviews.points, 15);
});

test('checkin 필드명도 체크인으로 인식', () => {
  const { breakdown } = calculateCoverageScoreV2({ checkin: '15:00', checkout: '12:00' });
  assertEqual(breakdown.checkin_checkout.points, 5);
});

test('lat/lon 필드명도 좌표로 인식', () => {
  const { breakdown } = calculateCoverageScoreV2({ lat: '37.5', lon: '126.9' });
  assertEqual(breakdown.lat_lng.points, 5);
});

// ── 결과 ──────────────────────────────────────────────────────────────────────
console.log(`\n결과: PASS ${passed} / FAIL ${failed} / 합계 ${passed + failed}`);
if (failed > 0) {
  console.error(`\n❌ ${failed}개 테스트 실패`);
  process.exit(1);
}
console.log('\n✅ 모든 테스트 통과');
