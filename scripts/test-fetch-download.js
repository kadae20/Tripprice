'use strict';
/**
 * test-fetch-download.js
 *
 * fetch-hotel-images.js / download-images.js 순수 함수 단위 테스트.
 * 외부 네트워크·API 호출 없이 실행 가능.
 *
 * 실행: node scripts/test-fetch-download.js
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { extractImageUrls }                              = require('./fetch-hotel-images');
const { validateDownload, cleanStubFiles, inferFilename } = require('./download-images');

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

// ── 1. extractImageUrls ────────────────────────────────────────────────────────
console.log('\n[1] extractImageUrls — API 응답에서 URL 배열 추출\n');

test('body.property.images 배열 → URL 추출', () => {
  const body = {
    property: {
      images: [
        { url: 'https://pix.agoda.net/hotel/1.jpg' },
        { url: 'https://pix.agoda.net/hotel/2.jpg' },
      ],
    },
  };
  const urls = extractImageUrls(body);
  assertEqual(urls.length, 2);
  assert(urls[0].startsWith('https://'));
});

test('body.photos 배열 → URL 추출 (다른 필드명)', () => {
  const body = {
    photos: [
      { imageUrl: 'https://example.com/img1.jpg' },
      { imageUrl: 'https://example.com/img2.jpg' },
    ],
  };
  const urls = extractImageUrls(body);
  assertEqual(urls.length, 2);
  assert(urls[0].includes('example.com'));
});

test('body.property.hotelImages 배열 → URL 추출', () => {
  const body = {
    property: {
      hotelImages: [
        { href: 'https://cdn.agoda.net/lobby.jpg' },
      ],
    },
  };
  const urls = extractImageUrls(body);
  assertEqual(urls.length, 1);
  assert(urls[0].includes('lobby'));
});

test('이미지 필드에 문자열 URL 직접 포함', () => {
  const body = {
    images: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
  };
  const urls = extractImageUrls(body);
  assertEqual(urls.length, 2);
});

test('http:// 아닌 URL은 필터링', () => {
  const body = {
    property: {
      images: [
        { url: 'https://valid.com/img.jpg' },
        { url: '/relative/path.jpg' },        // 상대경로 제외
        { url: null },                          // null 제외
      ],
    },
  };
  const urls = extractImageUrls(body);
  assertEqual(urls.length, 1);
});

test('이미지 필드 없는 응답 → 빈 배열', () => {
  const urls = extractImageUrls({ propertyId: 12345, propertyName: '테스트 호텔' });
  assertEqual(urls.length, 0);
});

test('null 입력 → 빈 배열 (에러 없음)', () => {
  const urls = extractImageUrls(null);
  assertEqual(urls.length, 0);
});

test('빈 이미지 배열 → 빈 배열', () => {
  const urls = extractImageUrls({ property: { images: [] } });
  assertEqual(urls.length, 0);
});

test('여러 후보 중 첫 번째 유효한 배열 사용', () => {
  const body = {
    property: { images: [] },    // 비어있음 → 건너뜀
    photos: [
      { url: 'https://cdn.test.com/photo.jpg' },
    ],
  };
  const urls = extractImageUrls(body);
  assertEqual(urls.length, 1);
});

// ── 2. validateDownload ────────────────────────────────────────────────────────
console.log('\n[2] validateDownload — 다운로드 파일 검증\n');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tripprice-test-'));

function makeTmpFile(name, sizeBytes) {
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, Buffer.alloc(sizeBytes, 0x00));
  return p;
}

test('유효한 이미지 파일 (5KB+, image/jpeg) → ok', () => {
  const fp = makeTmpFile('valid.jpg', 6 * 1024);
  const { ok } = validateDownload(fp, 'image/jpeg');
  assert(ok, 'ok여야 함');
  fs.unlinkSync(fp);
});

test('5KB 미만 파일 → 실패', () => {
  const fp = makeTmpFile('small.jpg', 100);
  const { ok, reason } = validateDownload(fp, 'image/jpeg');
  assert(!ok, '실패여야 함');
  assert(reason.includes('크기'), `reason: ${reason}`);
  fs.unlinkSync(fp);
});

test('content-type이 image/로 시작 안 하면 실패', () => {
  const fp = makeTmpFile('html.jpg', 10 * 1024);
  const { ok, reason } = validateDownload(fp, 'text/html');
  assert(!ok, '실패여야 함');
  assert(reason.includes('content-type'), `reason: ${reason}`);
  fs.unlinkSync(fp);
});

test('content-type null → 실패', () => {
  const fp = makeTmpFile('null-ct.jpg', 10 * 1024);
  const { ok } = validateDownload(fp, null);
  assert(!ok, '실패여야 함');
  fs.unlinkSync(fp);
});

test('파일 없는 경로 → 실패 (에러 없음)', () => {
  const { ok, reason } = validateDownload('/nonexistent/path.jpg', 'image/jpeg');
  assert(!ok);
  assert(reason.includes('없음'), `reason: ${reason}`);
});

test('image/webp content-type → ok', () => {
  const fp = makeTmpFile('valid.webp', 8 * 1024);
  const { ok } = validateDownload(fp, 'image/webp; charset=...');
  assert(ok, 'image/webp도 허용');
  fs.unlinkSync(fp);
});

// ── 3. cleanStubFiles ─────────────────────────────────────────────────────────
console.log('\n[3] cleanStubFiles — 0-byte stub 제거\n');

test('0-byte 파일 제거, 유효 파일 보존', () => {
  const dir = fs.mkdtempSync(path.join(TMP_DIR, 'clean-'));
  // 0-byte stub 3개
  ['a.jpg', 'b.jpg', 'c.jpg'].forEach(f => fs.writeFileSync(path.join(dir, f), ''));
  // 유효 파일 1개
  fs.writeFileSync(path.join(dir, 'valid.jpg'), Buffer.alloc(10 * 1024));

  const removed = cleanStubFiles(dir);

  assertEqual(removed.length, 3, '0-byte 파일 3개 제거');
  assert(removed.includes('a.jpg'));
  assert(!removed.includes('valid.jpg'), '유효 파일 보존');
  assert(fs.existsSync(path.join(dir, 'valid.jpg')), '유효 파일 실제 존재');
  fs.rmSync(dir, { recursive: true });
});

test('모두 유효 파일이면 제거 없음', () => {
  const dir = fs.mkdtempSync(path.join(TMP_DIR, 'clean2-'));
  fs.writeFileSync(path.join(dir, 'img.jpg'), Buffer.alloc(6 * 1024));
  const removed = cleanStubFiles(dir);
  assertEqual(removed.length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('디렉토리 없으면 빈 배열 반환 (에러 없음)', () => {
  const removed = cleanStubFiles('/nonexistent/dir/xyz');
  assertEqual(removed.length, 0);
});

test('빈 디렉토리 → 빈 배열', () => {
  const dir = fs.mkdtempSync(path.join(TMP_DIR, 'empty-'));
  const removed = cleanStubFiles(dir);
  assertEqual(removed.length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('5KB 미만(stub 기준) 파일은 제거', () => {
  const dir = fs.mkdtempSync(path.join(TMP_DIR, 'clean3-'));
  fs.writeFileSync(path.join(dir, 'tiny.jpg'), Buffer.alloc(100));
  const removed = cleanStubFiles(dir);
  assertEqual(removed.length, 1);
  assert(removed[0] === 'tiny.jpg');
  fs.rmSync(dir, { recursive: true });
});

// ── 4. inferFilename ──────────────────────────────────────────────────────────
console.log('\n[4] inferFilename — URL에서 파일명 추론\n');

test('URL에 pool 포함 → pool.jpg (index=0)', () => {
  assertEqual(inferFilename('https://cdn.agoda.net/hotels/pool-area.jpg', 0, '.jpg'), 'pool.jpg');
});

test('URL에 lobby 포함 → lobby.jpg (index=0)', () => {
  assertEqual(inferFilename('https://cdn.agoda.net/grand-lobby-01.jpg', 0, '.jpg'), 'lobby.jpg');
});

test('URL에 restaurant 포함 → restaurant.jpg (index=0)', () => {
  assertEqual(inferFilename('https://example.com/restaurant-view.jpg', 0, '.jpg'), 'restaurant.jpg');
});

test('index > 0이면 인덱스 접미사 추가', () => {
  const name = inferFilename('https://cdn.example.com/pool-bar.jpg', 2, '.jpg');
  assert(name.startsWith('pool'), `pool로 시작해야 함: ${name}`);
  assert(name.includes('02'), `인덱스 02 포함: ${name}`);
});

test('특징어 없으면 index=0 → featured.jpg', () => {
  assertEqual(inferFilename('https://cdn.agoda.net/unknown-image-123.jpg', 0, '.jpg'), 'featured.jpg');
});

test('특징어 없고 index>0 → img-NNN.jpg', () => {
  const name = inferFilename('https://cdn.agoda.net/unknown-456.jpg', 3, '.jpg');
  assert(name.startsWith('img-'), `img- 접두사: ${name}`);
  assert(name.includes('003'), `003 포함: ${name}`);
});

test('.webp 확장자 그대로 사용', () => {
  const name = inferFilename('https://cdn.agoda.net/spa-suite.webp', 0, '.webp');
  assert(name.endsWith('.webp'), `.webp 확장자: ${name}`);
});

test('URL에 room 포함 → room.jpg', () => {
  assertEqual(inferFilename('https://cdn.example.com/deluxe-room-king.jpg', 0, '.jpg'), 'room.jpg');
});

// ── 임시 디렉토리 정리 ────────────────────────────────────────────────────────
try { fs.rmSync(TMP_DIR, { recursive: true }); } catch {}

// ── 결과 ──────────────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const total = passed + failed;
console.log(` 결과: ${passed}/${total} passed${failed > 0 ? `  (${failed} failed)` : ''}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (failed > 0) process.exit(1);
