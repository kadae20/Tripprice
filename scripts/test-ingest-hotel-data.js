'use strict';
/**
 * test-ingest-hotel-data.js
 *
 * ingest-hotel-data.js 검증:
 *   [A] 멀티라인 CSV (따옴표 내부 개행) → 레코드 2개로 정상 파싱
 *   [B] 필수 필드 누락 → 리포트에 **hotel_id** 포함
 *   [C] 정상 입력 → exit 0, processed JSON 생성
 *   [D] 단위 함수 — validateHotel, generateHotelId
 *
 * 실행: node scripts/test-ingest-hotel-data.js
 */

const fs               = require('fs');
const path             = require('path');
const os               = require('os');
const { execFileSync } = require('child_process');

const ROOT    = path.resolve(__dirname, '..');
const SCRIPTS = __dirname;

// ── 테스트 러너 ───────────────────────────────────────────────────────────────
let passed = 0, failedCount = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        → ${err.message}`);
    failedCount++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '조건 불충족');
}

// ── 임시 디렉토리 ─────────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tripprice-ingest-'));

// ingest-hotel-data.js는 경로를 하드코딩하므로 실제 state/campaigns에 리포트 생성됨.
const today      = new Date().toISOString().split('T')[0];
const reportPath = path.join(ROOT, 'state', 'campaigns', `ingest-report-${today}.md`);

// ── 공통: ingest 실행 헬퍼 ────────────────────────────────────────────────────
function runIngest(csvPath, { expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [
      path.join(SCRIPTS, 'ingest-hotel-data.js'),
      csvPath,
    ], {
      encoding: 'utf8',
      timeout:  30_000,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    if (expectFail) return { ok: false, stdout: err.stdout || '', stderr: err.stderr || '' };
    throw new Error(`ingest 예외 종료: ${(err.stderr || err.message).slice(0, 300)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// [A] 멀티라인 CSV: hotel_name에 \n 포함 → 레코드 2개로 정상 파싱
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [A] 멀티라인 CSV — csv-parse 정상 파싱');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// hotel_name 필드 내부에 실제 개행 포함 (RFC 4180 quoted field)
// 이전 parseCSV(줄 split)로는 이 레코드가 2줄로 찢겨 검증 실패 유발
const MULTILINE_CSV =
  'hotel_name,hotel_name_en,city,country,address,agoda_hotel_id,photos_count,review_score,review_count\n' +
  '"Hotel With\nNewline",Hotel Newline,Seoul,South Korea,1 Multi St,11111,6,8.5,1200\n' +
  'Normal Hotel,Normal Hotel,Busan,South Korea,2 Normal St,22222,6,8.2,900\n';

const tmpMultiInput = path.join(tmpDir, 'multiline.csv');
fs.writeFileSync(tmpMultiInput, MULTILINE_CSV, 'utf8');

// 두 호텔 모두 필수 필드 완비 → exit 0 기대
const resA = runIngest(tmpMultiInput);

test('멀티라인 CSV: ingest exit 0 (레코드 2개 모두 성공)', () => {
  assert(resA.ok,
    `exit 0 기대 — 멀티라인 파싱 실패 또는 레코드 찢김:\n${resA.stderr.slice(0, 300)}`);
});

test('멀티라인 CSV: hotel-with-newline-seoul processed JSON 생성', () => {
  // csv-parse가 hotel_name = "Hotel With\nNewline" 을 하나의 필드로 읽음
  // → generateHotelId → "hotel-with-newline-seoul"
  const p = path.join(ROOT, 'data', 'processed', 'hotel-with-newline-seoul.json');
  assert(fs.existsSync(p),
    `hotel-with-newline-seoul.json 미생성 → 멀티라인 레코드가 찢겼을 가능성 있음\n` +
    `(old parseCSV 사용 시 이 파일은 생성되지 않음)`);
});

test('멀티라인 CSV: normal-hotel-busan processed JSON 생성', () => {
  const p = path.join(ROOT, 'data', 'processed', 'normal-hotel-busan.json');
  assert(fs.existsSync(p), `normal-hotel-busan.json 미생성`);
});

test('멀티라인 CSV: 리포트에 실패 호텔 목록 없음 (파싱 정확 시 0 실패)', () => {
  if (!fs.existsSync(reportPath)) return; // 리포트 없으면 skip
  const md = fs.readFileSync(reportPath, 'utf8');
  assert(!md.includes('실패 호텔 목록'),
    `실패 목록 섹션 존재 — 멀티라인 레코드 파싱 실패 의심:\n${md.slice(0, 500)}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// [B] 필수 필드 누락 1행 → 리포트에 ### **hotel_id** 형식 포함
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [B] 필수 필드 누락 → 리포트 hotel_id 포함');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// city/country/partner_url/agoda_hotel_id 모두 누락
const MISSING_CSV =
  'hotel_name,hotel_name_en,city,country,address,partner_url\n' +
  'Fail Test Hotel,Fail Test Hotel,,,123 Fail St,\n';

const tmpMissingInput = path.join(tmpDir, 'missing-fields.csv');
fs.writeFileSync(tmpMissingInput, MISSING_CSV, 'utf8');

// 실패율 100% → exit 1 예상
const resB = runIngest(tmpMissingInput, { expectFail: true });

test('필수 필드 누락: ingest 실행 완료 (JS 예외 아닌 exit 1)', () => {
  assert(!resB.stderr.includes('TypeError'),
    `JS TypeError 발생: ${resB.stderr.slice(0, 200)}`);
  assert(!resB.stderr.includes('ReferenceError'),
    `JS ReferenceError 발생: ${resB.stderr.slice(0, 200)}`);
});

test('필수 필드 누락: exit code 1 (실패율 100% ≥ 1%)', () => {
  assert(!resB.ok, '기대 exit 1인데 exit 0');
});

test('필수 필드 누락: 리포트에 ### **fail-test-hotel** 형식 포함', () => {
  assert(fs.existsSync(reportPath), `리포트 파일 없음: ${reportPath}`);
  const md = fs.readFileSync(reportPath, 'utf8');
  assert(md.includes('실패 호텔 목록'), '실패 호텔 목록 섹션 없음');
  const section = md.split('## 실패 호텔 목록')[1] || '';
  // 형식: ### **fail-test-hotel**
  assert(
    section.includes('### **fail-test-hotel**'),
    `"### **fail-test-hotel**" 형식 없음.\n섹션:\n${section.slice(0, 500)}`
  );
});

test('필수 필드 누락: 리포트에 missing: 필드 목록 포함', () => {
  const md = fs.readFileSync(reportPath, 'utf8');
  const section = md.split('## 실패 호텔 목록')[1] || '';
  assert(
    section.includes('missing:') || section.includes('error:'),
    `missing:/error: 표현 없음.\n섹션:\n${section.slice(0, 400)}`
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// [C] 정상 입력 → exit 0, processed JSON 생성
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [C] 정상 입력 → exit 0, processed JSON 생성');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const VALID_CSV =
  'hotel_name,hotel_name_en,city,country,address,agoda_hotel_id,star_rating,review_score,review_count,photos_count\n' +
  'Valid Test Hotel,Valid Test Hotel,Seoul,South Korea,1 Valid St,99999,4,8.5,1200,6\n';

const tmpValidInput = path.join(tmpDir, 'valid.csv');
fs.writeFileSync(tmpValidInput, VALID_CSV, 'utf8');

const resC = runIngest(tmpValidInput);

test('정상 입력: exit 0', () => {
  assert(resC.ok, `exit 0 기대: ${resC.stderr.slice(0, 200)}`);
});

test('정상 입력: 리포트에 실패 호텔 목록 섹션 없음 (failures=0)', () => {
  assert(fs.existsSync(reportPath), '리포트 파일 없음');
  const md = fs.readFileSync(reportPath, 'utf8');
  assert(!md.includes('실패 호텔 목록'),
    `failures=0인데 실패 목록 섹션 존재:\n${md.slice(0, 400)}`);
});

test('정상 입력: valid-test-hotel-seoul.json 생성', () => {
  const p = path.join(ROOT, 'data', 'processed', 'valid-test-hotel-seoul.json');
  assert(fs.existsSync(p), `processed JSON 미생성: ${p}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// [D] 단위 함수 — validateHotel, generateHotelId
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [D] 단위 함수 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const { validateHotel, generateHotelId } = require('./ingest-hotel-data');

test('validateHotel: 정상 입력 → isValid=true', () => {
  const r = validateHotel({
    hotel_name: 'Test Hotel', city: 'Seoul', country: 'South Korea',
    address: '1 Test St', partner_url: 'https://www.agoda.com/hotel/123',
  });
  assert(r.isValid, `isValid=false: ${r.errors.join(', ')}`);
});

test('validateHotel: city 누락 → isValid=false, error 포함', () => {
  const r = validateHotel({
    hotel_name: 'Test Hotel', city: '', country: 'South Korea',
    address: '1 Test St', partner_url: 'https://www.agoda.com/hotel/123',
  });
  assert(!r.isValid, 'city 누락인데 isValid=true');
  assert(r.errors.some(e => e.includes('city')), `city 에러 없음: ${r.errors.join(', ')}`);
});

test('validateHotel: 복수 필드 누락 → 복수 에러', () => {
  const r = validateHotel({ city: 'Seoul' });
  assert(!r.isValid, '기대 false');
  assert(r.errors.length >= 2, `에러 2개 이상 기대, 실제: ${r.errors.length}`);
});

test('validateHotel: agoda_hotel_id 있으면 URL 에러 없음', () => {
  const r = validateHotel({
    hotel_name: 'Test Hotel', city: 'Seoul', country: 'South Korea',
    address: '1 Test St', agoda_hotel_id: '12345',
  });
  assert(r.isValid, `agoda_hotel_id 있는데 isValid=false: ${r.errors.join(', ')}`);
});

test('generateHotelId: 영문명+도시 → slug', () => {
  const id = generateHotelId('Grand Hyatt Seoul', 'Seoul');
  assert(/^[a-z0-9-]+$/.test(id), `slug 형식 오류: "${id}"`);
  assert(id.includes('grand') && id.includes('seoul'), `slug 내용 오류: "${id}"`);
});

test('generateHotelId: 빈 city여도 crash 없음', () => {
  const id = generateHotelId('Fail Hotel', '');
  assert(typeof id === 'string' && id.length > 0, `slug 빈값 또는 타입 오류: "${id}"`);
});

test('generateHotelId: hotel_name 내부 개행 포함 → slug에 "-" 치환', () => {
  // csv-parse가 멀티라인 필드를 "Hotel With\nNewline"으로 전달할 때의 slug 생성
  const id = generateHotelId('Hotel With\nNewline', 'Seoul');
  assert(/^[a-z0-9-]+$/.test(id), `slug에 개행 남음: "${id}"`);
  assert(id.includes('hotel') && id.includes('newline'), `slug 내용 오류: "${id}"`);
});

// ── 정리 ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ── 결과 ─────────────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(` 결과: ${passed + failedCount}/${passed + failedCount} 중 ${passed} passed`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (failedCount > 0) process.exit(1);
