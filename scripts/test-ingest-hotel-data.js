'use strict';
/**
 * test-ingest-hotel-data.js
 *
 * ingest-hotel-data.js 실패 기록 및 리포트 검증.
 * 외부 네트워크 없이 실행. 임시 파일 자동 정리.
 *
 * 실행: node scripts/test-ingest-hotel-data.js
 */

const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { execFileSync } = require('child_process');

const ROOT    = path.resolve(__dirname, '..');
const SCRIPTS = __dirname;

// ── 테스트 러너 ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

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

// ── 임시 디렉토리 준비 ────────────────────────────────────────────────────────
const tmpDir         = fs.mkdtempSync(path.join(os.tmpdir(), 'tripprice-ingest-'));
const tmpInput       = path.join(tmpDir, 'hotels-input.csv');
const tmpProcessed   = path.join(tmpDir, 'processed');
const tmpCoverage    = path.join(tmpDir, 'coverage');
const tmpCampaigns   = path.join(tmpDir, 'campaigns');

fs.mkdirSync(tmpProcessed, { recursive: true });
fs.mkdirSync(tmpCoverage,  { recursive: true });
fs.mkdirSync(tmpCampaigns, { recursive: true });

// ingest-hotel-data.js는 경로를 하드코딩하므로 실제 state/campaigns에 리포트 생성됨.
// 테스트 후 오늘 날짜 리포트를 읽어 검증.
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
    throw new Error(`ingest 예외 종료: ${(err.stderr || err.message).slice(0, 200)}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 검증 A: 필수 필드 누락 1행 → 리포트에 hotel_id 포함
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [A] 필수 필드 누락 → 리포트 hotel_id 포함');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// city / country 누락, source_url / partner_url / agoda_hotel_id 누락
const MISSING_CSV =
  'hotel_name,hotel_name_en,city,country,address,partner_url\n' +
  'Fail Test Hotel,Fail Test Hotel,,,123 Fail St,\n';

fs.writeFileSync(tmpInput, MISSING_CSV, 'utf8');

// 실패율 100% → exit 1 예상
const resA = runIngest(tmpInput, { expectFail: true });

test('필수 필드 누락: ingest 실행 완료 (파싱 에러 없음)', () => {
  // stderr에 JS 예외 없어야 함 (exit 1은 허용)
  assert(!resA.stderr.includes('TypeError'), `JS 예외 발생: ${resA.stderr.slice(0, 200)}`);
  assert(!resA.stderr.includes('ReferenceError'), `JS 예외 발생: ${resA.stderr.slice(0, 200)}`);
});

test('필수 필드 누락: 리포트에 hotel_id(fail-test-hotel) 포함', () => {
  assert(fs.existsSync(reportPath), `리포트 파일 없음: ${reportPath}`);
  const md = fs.readFileSync(reportPath, 'utf8');
  // hotel_id 슬러그: "fail-test-hotel" (city 빈값이면 "fail-test-hotel-" → "fail-test-hotel")
  assert(
    md.includes('fail-test-hotel'),
    `리포트에 hotel_id "fail-test-hotel" 없음.\n리포트 일부:\n${md.slice(0, 600)}`
  );
});

test('필수 필드 누락: 리포트 실패 목록이 원인 집계 문자열(필수 필드 누락:)만 출력하지 않음', () => {
  assert(fs.existsSync(reportPath), '리포트 파일 없음');
  const md = fs.readFileSync(reportPath, 'utf8');
  // "실패 호텔 목록" 섹션이 있어야 함
  assert(md.includes('실패 호텔 목록'), '실패 호텔 목록 섹션 없음');
  // 섹션 내용에서 **hotel_id** 형식이어야 함 (fail-test-hotel)
  const section = md.split('## 실패 호텔 목록')[1] || '';
  assert(
    section.includes('**fail-test-hotel**'),
    `"**fail-test-hotel**" 형식 없음. 섹션:\n${section.slice(0, 400)}`
  );
});

test('필수 필드 누락: 리포트에 missing: 필드 목록 포함', () => {
  const md = fs.readFileSync(reportPath, 'utf8');
  const section = md.split('## 실패 호텔 목록')[1] || '';
  assert(
    section.includes('missing:') || section.includes('error:'),
    `missing:/error: 표현 없음. 섹션:\n${section.slice(0, 400)}`
  );
});

test('필수 필드 누락: exit code 1 (실패율 100% → 1% 이상)', () => {
  assert(!resA.ok, '기대 exit 1인데 exit 0');
});

// ══════════════════════════════════════════════════════════════════════════════
// 검증 B: 정상 입력 → failures 0, exit 0
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [B] 정상 입력 → failures=0, exit 0');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const VALID_CSV =
  'hotel_name,hotel_name_en,city,country,address,agoda_hotel_id,star_rating,review_score,review_count,photos_count\n' +
  'Valid Test Hotel,Valid Test Hotel,Seoul,South Korea,1 Valid St,99999,4,8.5,1200,6\n';

const tmpValidInput = path.join(tmpDir, 'hotels-valid.csv');
fs.writeFileSync(tmpValidInput, VALID_CSV, 'utf8');

const resB = runIngest(tmpValidInput);

test('정상 입력: exit 0', () => {
  assert(resB.ok, `exit 0 기대, 실패: ${resB.stderr.slice(0, 200)}`);
});

test('정상 입력: 리포트에 실패 호텔 목록 섹션 없음 (failures=0)', () => {
  assert(fs.existsSync(reportPath), '리포트 파일 없음');
  const md = fs.readFileSync(reportPath, 'utf8');
  // 실패가 0이면 "실패 호텔 목록" 섹션이 없어야 함
  assert(!md.includes('실패 호텔 목록'), `failures=0인데 실패 목록 섹션 존재:\n${md.slice(0, 400)}`);
});

test('정상 입력: data/processed/valid-test-hotel-seoul.json 생성', () => {
  const processedPath = path.join(ROOT, 'data', 'processed', 'valid-test-hotel-seoul.json');
  assert(fs.existsSync(processedPath), `processed JSON 미생성: ${processedPath}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// 검증 C: 단위 함수 — validateHotel, generateHotelId
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [C] 단위 함수 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const { validateHotel, generateHotelId } = require('./ingest-hotel-data');

test('validateHotel: 정상 입력 → isValid=true', () => {
  const result = validateHotel({
    hotel_name: 'Test Hotel',
    city: 'Seoul',
    country: 'South Korea',
    address: '1 Test St',
    partner_url: 'https://www.agoda.com/hotel/123',
  });
  assert(result.isValid, `isValid=false, errors: ${result.errors.join(', ')}`);
  assert(result.errors.length === 0, `errors 있음: ${result.errors.join(', ')}`);
});

test('validateHotel: city 누락 → isValid=false, error 포함', () => {
  const result = validateHotel({
    hotel_name: 'Test Hotel',
    city: '',
    country: 'South Korea',
    address: '1 Test St',
    partner_url: 'https://www.agoda.com/hotel/123',
  });
  assert(!result.isValid, 'city 누락인데 isValid=true');
  assert(result.errors.some(e => e.includes('city')), `city 에러 없음: ${result.errors.join(', ')}`);
});

test('validateHotel: hotel_name + country + address + partner_url 누락 → 복수 에러', () => {
  const result = validateHotel({ city: 'Seoul' });
  assert(!result.isValid, 'isValid=true여야 하는데 false 아님');
  assert(result.errors.length >= 2, `에러 2개 이상 기대, 실제: ${result.errors.length}`);
});

test('validateHotel: agoda_hotel_id 있으면 URL 에러 없음', () => {
  const result = validateHotel({
    hotel_name: 'Test Hotel',
    city: 'Seoul',
    country: 'South Korea',
    address: '1 Test St',
    agoda_hotel_id: '12345',
  });
  assert(result.isValid, `agoda_hotel_id 있는데 isValid=false: ${result.errors.join(', ')}`);
});

test('generateHotelId: 영문명+도시 → slug', () => {
  const id = generateHotelId('Grand Hyatt Seoul', 'Seoul');
  assert(/^[a-z0-9-]+$/.test(id), `slug 형식 오류: "${id}"`);
  assert(id.includes('grand'), `"grand" 미포함: "${id}"`);
  assert(id.includes('seoul'), `"seoul" 미포함: "${id}"`);
});

test('generateHotelId: 빈 city여도 crash 없음', () => {
  const id = generateHotelId('Fail Hotel', '');
  assert(typeof id === 'string', '결과가 string 아님');
  assert(id.length > 0, 'slug가 빈값');
});

// ── 정리 ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ── 결과 ─────────────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(` 결과: ${passed + failed}/${passed + failed} 중 ${passed} passed`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (failed > 0) process.exit(1);
