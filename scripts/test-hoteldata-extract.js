'use strict';
/**
 * test-hoteldata-extract.js
 *
 * hoteldata-extract.js + ingest-hotel-data.js 통합 검증.
 * 외부 네트워크 없이 실행. 임시 파일은 자동 정리.
 *
 * 실행: node scripts/test-hoteldata-extract.js
 */

const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { execFileSync } = require('child_process');

const ROOT       = path.resolve(__dirname, '..');
const SCRIPTS    = __dirname;

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

// ── 테스트용 CSV 생성 ─────────────────────────────────────────────────────────
const SAMPLE_CSV_CONTENT = [
  'hotel_id,hotel_name,city,country,address,agoda_hotel_id,content_priority',
  'grand-hyatt-seoul,그랜드 하얏트 서울,seoul,korea,서울시 용산구 소월로 322,535922,high',
  'lotte-hotel-seoul,롯데호텔 서울,seoul,korea,서울시 중구 을지로 30,68689,high',
  'hilton-busan,힐튼 부산,busan,korea,부산시 해운대구,123456,normal',
  'shilla-jeju,신라호텔 제주,jeju,korea,제주시 표선면,789012,normal',
  'tokyo-hotel,도쿄 호텔,tokyo,japan,도쿄 신주쿠,999999,high',     // 도시 불일치 → 제외
  'grand-hyatt-seoul,중복행,seoul,korea,서울 어딘가,535922,high',   // hotel_id 중복 → 제외
].join('\n');

const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'tripprice-test-'));
const tmpLatest  = path.join(tmpDir, 'hotels-latest.csv');
const tmpSubset  = path.join(tmpDir, 'hotels-subset.csv');
const tmpIngest  = path.join(tmpDir, 'processed');

fs.writeFileSync(tmpLatest, SAMPLE_CSV_CONTENT, 'utf8');

// ── 검증 A: extract 결과 검증 ─────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [A] hoteldata-extract.js 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

let extractOut = '';
try {
  extractOut = execFileSync(process.execPath, [
    path.join(SCRIPTS, 'hoteldata-extract.js'),
  ], {
    env: {
      ...process.env,
      HOTELDATA_LATEST_CSV: tmpLatest,
      HOTELDATA_SUBSET_CSV: tmpSubset,
      HOTELDATA_CITIES:     'seoul,busan,jeju',
      HOTELDATA_EXTRACT_ROWS:   '9999',
      HOTELDATA_EXTRACT_HOTELS: '9999',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
} catch (err) {
  console.error('  extract 실행 실패:', (err.stderr || err.message).slice(0, 300));
  process.exit(1);
}

test('subset.csv 파일 생성됨', () => {
  assert(fs.existsSync(tmpSubset), `${tmpSubset} 미존재`);
});

test('subset.csv 헤더 포함', () => {
  const lines = fs.readFileSync(tmpSubset, 'utf8').trim().split('\n');
  assert(lines[0].includes('hotel_id'), `헤더 없음: ${lines[0]}`);
});

test('seoul/busan/jeju 행만 추출됨', () => {
  const lines = fs.readFileSync(tmpSubset, 'utf8').trim().split('\n');
  const dataLines = lines.slice(1); // 헤더 제외
  assert(dataLines.length === 4, `기대 4행, 실제 ${dataLines.length}행 (도쿄·중복 제외 후)`);
});

test('도시 불일치(tokyo) 제외됨', () => {
  const content = fs.readFileSync(tmpSubset, 'utf8');
  assert(!content.includes('tokyo-hotel'), '도쿄 호텔이 포함되어 있음');
});

test('hotel_id 중복 제거됨 (두 번째 grand-hyatt-seoul 제외)', () => {
  const lines = fs.readFileSync(tmpSubset, 'utf8').trim().split('\n').slice(1);
  const dupes = lines.filter(l => l.startsWith('grand-hyatt-seoul,'));
  assert(dupes.length === 1, `grand-hyatt-seoul이 ${dupes.length}번 포함됨 (기대: 1)`);
});

// ── 검증 B: subset → ingest 결과 검증 ────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [B] ingest-hotel-data.js (subset) 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// ingest는 ROOT 기준 경로를 쓰므로 tmp 파일을 data/hotels/에 일시 복사
const ingestInput = path.join(ROOT, 'data', 'hotels', '_test-subset-tmp.csv');
const processedDir = path.join(ROOT, 'data', 'processed');
fs.copyFileSync(tmpSubset, ingestInput);

try {
  execFileSync(process.execPath, [
    path.join(SCRIPTS, 'ingest-hotel-data.js'),
    ingestInput,
  ], {
    cwd:      ROOT,
    env:      { ...process.env, AGODA_CID: '1926938' },
    encoding: 'utf8',
    timeout:  30_000,
  });
} catch (err) {
  // exit(1)은 failed 호텔이 있을 때도 발생 — 단 처리 자체는 완료
  if (!err.stdout && !err.stderr) {
    console.error('  ingest 실행 자체 실패:', err.message.slice(0, 200));
    fs.unlinkSync(ingestInput);
    process.exit(1);
  }
} finally {
  fs.unlinkSync(ingestInput);
}

test('data/processed/*.json 생성됨', () => {
  const files = fs.readdirSync(processedDir).filter(f => f.endsWith('.json'));
  assert(files.length > 0, `${processedDir} 에 json 파일 없음`);
});

test('grand-hyatt-seoul.json 생성됨', () => {
  const p = path.join(processedDir, 'grand-hyatt-seoul.json');
  assert(fs.existsSync(p), `${p} 미존재`);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert(data.hotel_id === 'grand-hyatt-seoul', `hotel_id 불일치: ${data.hotel_id}`);
  assert(data.city === 'seoul', `city 불일치: ${data.city}`);
});

test('hilton-busan.json 생성됨', () => {
  const p = path.join(processedDir, 'hilton-busan.json');
  assert(fs.existsSync(p), `${p} 미존재`);
});

// ── 정리 ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ── 결과 ─────────────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(` 결과: ${passed + failed}/${passed + failed} 중 ${passed} passed`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (failed > 0) process.exit(1);
