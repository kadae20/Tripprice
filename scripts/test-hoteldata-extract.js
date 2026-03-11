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
      HOTELDATA_LATEST_CSV:     tmpLatest,
      HOTELDATA_SUBSET_CSV:     tmpSubset,
      HOTELDATA_CITIES:         'seoul,busan,jeju',
      ROTATION_COOLDOWN_DAYS:   '0',
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

// ── 검증 C: normalizeCity / cityAliases 단위 테스트 ──────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [C] normalizeCity / cityAliases 단위 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const {
  normalizeCity, cityAliases, cityMatches, buildTargetCities,
} = require('./hoteldata-extract');

test('normalizeCity: 괄호 제거 ("서울 (경기)" → "서울")', () => {
  const result = normalizeCity('서울 (경기)');
  assert(result === '서울', `결과: "${result}"`);
});

test('normalizeCity: 슬래시 이후 제거 ("멜버른 / 멜번" → "멜버른")', () => {
  const result = normalizeCity('멜버른 / 멜번');
  assert(result === '멜버른', `결과: "${result}"`);
});

test('normalizeCity: 대소문자 → 소문자 ("Seoul" → "seoul")', () => {
  const result = normalizeCity('Seoul');
  assert(result === 'seoul', `결과: "${result}"`);
});

test('normalizeCity: 연속 공백 정리 ("Los  Angeles" → "los angeles")', () => {
  const result = normalizeCity('Los  Angeles');
  assert(result === 'los angeles', `결과: "${result}"`);
});

test('cityAliases: 슬래시 양쪽 모두 반환', () => {
  const aliases = cityAliases('멜버른 / 멜번');
  assert(
    aliases.includes('멜버른') && aliases.includes('멜번'),
    `기대 ["멜버른","멜번"], 실제: ${JSON.stringify(aliases)}`
  );
});

test('cityAliases: 슬래시 없으면 1개 반환', () => {
  const aliases = cityAliases('서울');
  assert(aliases.length === 1 && aliases[0] === '서울', `결과: ${JSON.stringify(aliases)}`);
});

test('cityMatches: alias로 매칭 ("멜번" 타겟 → "멜버른 / 멜번" 포함)', () => {
  const cities = buildTargetCities(['멜번']);
  assert(cityMatches('멜버른 / 멜번', cities), '멜번 alias 매칭 실패');
});

test('cityMatches: 괄호 포함 도시명 매칭 ("서울" 타겟 → "서울 (경기)" 포함)', () => {
  const cities = buildTargetCities(['서울']);
  assert(cityMatches('서울 (경기)', cities), '괄호 포함 도시명 매칭 실패');
});

// ── 검증 D: Rotation 냉각 제외 ───────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [D] Rotation 냉각 제외 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const ROTATION_PATH = path.join(ROOT, 'state', 'rotation', 'hotel-rotation.json');
const tmpRotSubset  = path.join(tmpDir, 'hotels-subset-rot.csv');

// 기존 rotation 백업
const rotBackup = fs.existsSync(ROTATION_PATH) ? fs.readFileSync(ROTATION_PATH, 'utf8') : null;

// grand-hyatt-seoul을 1일 전 사용한 것으로 기록 (30일 냉각 → 제외 대상)
const rotState = {
  'grand-hyatt-seoul': {
    last_used_at: new Date(Date.now() - 86400000).toISOString(),
    used_count:   1,
    last_week:    '2026-W10',
  },
};
fs.mkdirSync(path.dirname(ROTATION_PATH), { recursive: true });
fs.writeFileSync(ROTATION_PATH, JSON.stringify(rotState), 'utf8');

let rotRunErr = false;
try {
  execFileSync(process.execPath, [path.join(SCRIPTS, 'hoteldata-extract.js')], {
    env: {
      ...process.env,
      HOTELDATA_LATEST_CSV:     tmpLatest,
      HOTELDATA_SUBSET_CSV:     tmpRotSubset,
      HOTELDATA_CITIES:         'seoul,busan,jeju',
      ROTATION_COOLDOWN_DAYS:   '30',
      HOTELDATA_EXTRACT_ROWS:   '9999',
      HOTELDATA_EXTRACT_HOTELS: '9999',
    },
    encoding: 'utf8',
    timeout:  30_000,
  });
} catch (err) {
  rotRunErr = true;
  console.error('  rotation 테스트 extract 실패:', (err.stderr || err.message).slice(0, 200));
}

// rotation 파일 복원
if (rotBackup !== null) {
  fs.writeFileSync(ROTATION_PATH, rotBackup, 'utf8');
} else {
  try { fs.unlinkSync(ROTATION_PATH); } catch {}
}

test('rotation: 냉각 중 호텔(grand-hyatt-seoul) 제외됨', () => {
  assert(!rotRunErr, 'extract 자체가 실패함');
  assert(fs.existsSync(tmpRotSubset), 'subset 파일 미생성');
  const content = fs.readFileSync(tmpRotSubset, 'utf8');
  assert(!content.includes('grand-hyatt-seoul,'), 'grand-hyatt-seoul이 냉각임에도 포함됨');
});

test('rotation: 냉각 외 호텔(lotte-hotel-seoul)은 포함됨', () => {
  assert(!rotRunErr && fs.existsSync(tmpRotSubset), 'subset 파일 없음');
  const content = fs.readFileSync(tmpRotSubset, 'utf8');
  assert(content.includes('lotte-hotel-seoul'), 'lotte-hotel-seoul이 미포함');
});

// ── 검증 E: global 모드 (상위 도시 자동 선택) ────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [E] global 모드 (상위 도시 자동 선택) 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// seoul 행이 가장 많은 CSV: seoul×3, busan×1, jeju×1
const GLOBAL_CSV_CONTENT = [
  'hotel_id,hotel_name,city,country,agoda_hotel_id,content_priority',
  'g-seoul-1,서울호텔1,seoul,korea,111,normal',
  'g-seoul-2,서울호텔2,seoul,korea,222,normal',
  'g-seoul-3,서울호텔3,seoul,korea,333,normal',
  'g-busan-1,부산호텔1,busan,korea,444,normal',
  'g-jeju-1,제주호텔1,jeju,korea,555,normal',
].join('\n');

const tmpGlobalLatest = path.join(tmpDir, 'hotels-global-latest.csv');
const tmpGlobalSubset = path.join(tmpDir, 'hotels-global-subset.csv');
fs.writeFileSync(tmpGlobalLatest, GLOBAL_CSV_CONTENT, 'utf8');

let globalRunErr = false;
try {
  execFileSync(process.execPath, [path.join(SCRIPTS, 'hoteldata-extract.js')], {
    env: {
      ...process.env,
      EXTRACT_MODE:             'global',
      HOTELDATA_TOP_CITIES:     '1',
      HOTELDATA_LATEST_CSV:     tmpGlobalLatest,
      HOTELDATA_SUBSET_CSV:     tmpGlobalSubset,
      ROTATION_COOLDOWN_DAYS:   '0',
      HOTELDATA_EXTRACT_ROWS:   '9999',
      HOTELDATA_EXTRACT_HOTELS: '9999',
    },
    encoding: 'utf8',
    timeout:  30_000,
  });
} catch (err) {
  globalRunErr = true;
  console.error('  global 모드 extract 실패:', (err.stderr || err.message).slice(0, 200));
}

test('global 모드: subset.csv 생성됨', () => {
  assert(!globalRunErr, 'extract 실패');
  assert(fs.existsSync(tmpGlobalSubset), 'subset 파일 미생성');
});

test('global 모드: 상위 1개 도시(seoul)만 추출됨', () => {
  assert(fs.existsSync(tmpGlobalSubset), 'subset 파일 없음');
  const content = fs.readFileSync(tmpGlobalSubset, 'utf8');
  assert(content.includes('g-seoul-1'), 'seoul 호텔 미포함');
  assert(!content.includes('g-busan-1'), 'busan이 포함됨 (top 1 초과)');
  assert(!content.includes('g-jeju-1'),  'jeju가 포함됨 (top 1 초과)');
});

// ── 검증 F: 0행 추출 시 에러 메시지 ─────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [F] 0행 추출 에러 메시지 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const tmpZeroSubset = path.join(tmpDir, 'hotels-zero-subset.csv');
let zeroExitCode = 0;
let zeroOutput   = '';

try {
  execFileSync(process.execPath, [path.join(SCRIPTS, 'hoteldata-extract.js')], {
    env: {
      ...process.env,
      HOTELDATA_LATEST_CSV:     tmpLatest,
      HOTELDATA_SUBSET_CSV:     tmpZeroSubset,
      HOTELDATA_CITIES:         'nonexistent-city-xyz',
      ROTATION_COOLDOWN_DAYS:   '0',
      HOTELDATA_EXTRACT_ROWS:   '9999',
      HOTELDATA_EXTRACT_HOTELS: '9999',
    },
    encoding: 'utf8',
    timeout:  30_000,
  });
} catch (err) {
  zeroExitCode = err.status || 1;
  zeroOutput   = (err.stdout || '') + (err.stderr || '');
}

test('0행: exit code 1로 종료됨', () => {
  assert(zeroExitCode === 1, `기대 exit 1, 실제: ${zeroExitCode}`);
});

test('0행: 원인 힌트 메시지 포함 (HOTELDATA_CITIES 또는 도시 언급)', () => {
  assert(
    zeroOutput.includes('HOTELDATA_CITIES') || zeroOutput.includes('도시') || zeroOutput.includes('city'),
    `힌트 미포함: ${zeroOutput.slice(0, 300)}`
  );
});

// ── 검증 G: NUL sanitize + raw 도시명 매칭 ───────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [G] NUL sanitize + raw 도시명(한국어) 매칭 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// NUL 문자(\u0000)가 섞인 CSV 라인을 포함한 테스트 파일
const NUL_CSV_CONTENT = [
  'hotel_id,hotel_name,city,country,agoda_hotel_id,content_priority',
  // NUL이 섞인 서울 행 (city 필드에 NUL 포함)
  'nul-hotel-seoul,NUL테스트 호텔,\u0000서울\u0000,korea,100001,normal',
  // 일반 한국어 도시명 행
  'normal-hotel-busan,부산 호텔,부산,korea,100002,normal',
  // 타겟 외 도시
  'out-hotel-tokyo,도쿄 호텔,도쿄,japan,100003,normal',
].join('\n');

const tmpNulLatest = path.join(tmpDir, 'hotels-nul-latest.csv');
const tmpNulSubset = path.join(tmpDir, 'hotels-nul-subset.csv');
// tmpDir는 윗 블록에서 이미 지워지므로 새로 생성
const tmpDir2 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'tripprice-nul-'));
const tmpNulLatest2 = path.join(tmpDir2, 'hotels-nul-latest.csv');
const tmpNulSubset2 = path.join(tmpDir2, 'hotels-nul-subset.csv');
fs.writeFileSync(tmpNulLatest2, NUL_CSV_CONTENT, 'utf8');

let nulRunErr = false;
try {
  execFileSync(process.execPath, [path.join(SCRIPTS, 'hoteldata-extract.js')], {
    env: {
      ...process.env,
      HOTELDATA_LATEST_CSV:     tmpNulLatest2,
      HOTELDATA_SUBSET_CSV:     tmpNulSubset2,
      HOTELDATA_CITIES:         '서울,부산',   // 한국어 raw 타겟
      ROTATION_COOLDOWN_DAYS:   '0',
      HOTELDATA_EXTRACT_ROWS:   '9999',
      HOTELDATA_EXTRACT_HOTELS: '9999',
    },
    encoding: 'utf8',
    timeout: 30_000,
  });
} catch (err) {
  nulRunErr = true;
  console.error('  NUL 테스트 extract 실패:', (err.stderr || err.message).slice(0, 300));
}

test('NUL 포함 라인 sanitize 후 city 매칭 동작 (서울 포함)', () => {
  assert(!nulRunErr, 'extract가 실패함 (NUL CSV)');
  assert(fs.existsSync(tmpNulSubset2), 'subset 파일 미생성');
  const content = fs.readFileSync(tmpNulSubset2, 'utf8');
  assert(content.includes('nul-hotel-seoul'), 'NUL 제거 후 서울 호텔이 미포함');
});

test('raw 한국어 도시명 우선 매칭 (부산 raw → 매칭 성공, 도쿄 → 제외)', () => {
  assert(!nulRunErr && fs.existsSync(tmpNulSubset2), 'subset 파일 없음');
  const content = fs.readFileSync(tmpNulSubset2, 'utf8');
  assert(content.includes('normal-hotel-busan'), '부산 호텔 미포함 (raw 매칭 실패)');
  assert(!content.includes('out-hotel-tokyo'),   '도쿄 호텔이 포함됨 (타겟 외 도시)');
});

try { fs.rmSync(tmpDir2, { recursive: true, force: true }); } catch {}

// ── 정리 ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ── 결과 ─────────────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(` 결과: ${passed + failed}/${passed + failed} 중 ${passed} passed`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (failed > 0) process.exit(1);
