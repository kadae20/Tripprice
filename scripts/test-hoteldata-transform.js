'use strict';
/**
 * test-hoteldata-transform.js
 *
 * hoteldata-to-tripprice.js 변환 결과 검증.
 * 외부 네트워크 없이 실행. 임시 파일 자동 정리.
 *
 * 실행: node scripts/test-hoteldata-transform.js
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

// ── 샘플 CSV (Agoda 원본 포맷 컬럼) ──────────────────────────────────────────
const SAMPLE_CSV = [
  'ObjectId,PropertyName,CityName,CountryName,Address,LandingUrl,StarRating,ReviewScore,NumberOfReviews,NumberOfPhotos,ContentPriority',
  '535922,Grand Hyatt Seoul,Seoul,South Korea,322 Sowol-ro Yongsan-gu Seoul,https://www.agoda.com/grand-hyatt-seoul,5,8.9,5000,50,high',
  '68689,Lotte Hotel Seoul,Seoul,South Korea,30 Eulji-ro Jung-gu Seoul,https://www.agoda.com/lotte-hotel-seoul,5,8.5,3000,40,high',
  '123456,Hilton Busan,Busan,South Korea,,https://www.agoda.com/hilton-busan,4,8.2,2000,30,normal',
].join('\n');

const CID    = '1926938';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tripprice-xform-'));
const tmpIn  = path.join(tmpDir, 'hotels-subset.csv');
const tmpOut = path.join(tmpDir, 'tripprice-hotels.csv');

fs.writeFileSync(tmpIn, SAMPLE_CSV, 'utf8');

// ── 검증 A: subprocess 변환 결과 ─────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [A] hoteldata-to-tripprice.js 변환 검증');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

let xformFailed = false;
try {
  execFileSync(process.execPath, [
    path.join(SCRIPTS, 'hoteldata-to-tripprice.js'),
  ], {
    env: {
      ...process.env,
      HOTELDATA_SUBSET_CSV:    tmpIn,
      HOTELDATA_TRIPPRICE_CSV: tmpOut,
      AGODA_CID:               CID,
    },
    encoding: 'utf8',
    timeout:  30_000,
  });
} catch (err) {
  xformFailed = true;
  console.error('  transform 실행 실패:', (err.stderr || err.stdout || err.message).slice(0, 300));
}

// ── CSV 파서 (RFC 4180 — 인용 필드·내부 쉼표 처리) ──────────────────────────
function parseCSVLine(line) {
  const fields = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cur += c; }
    } else {
      if (c === '"') { inQ = true; }
      else if (c === ',') { fields.push(cur); cur = ''; }
      else { cur += c; }
    }
  }
  fields.push(cur);
  return fields;
}

function parseOutputCSV(filePath = tmpOut) {
  if (!fs.existsSync(filePath)) return { headers: [], rows: [] };
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
  if (lines.length < 2) return { headers: parseCSVLine(lines[0] || ''), rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
  return { headers, rows };
}

test('output CSV 생성됨', () => {
  assert(!xformFailed, 'transform 자체가 실패함');
  assert(fs.existsSync(tmpOut), '출력 파일 미생성');
});

test('출력 행 수: 3행 (헤더 제외)', () => {
  const { rows } = parseOutputCSV();
  assert(rows.length === 3, `기대 3행, 실제 ${rows.length}행`);
});

test('agoda_hotel_id: ObjectId 값 그대로 (535922)', () => {
  const { rows } = parseOutputCSV();
  assert(rows.length > 0, '데이터 없음');
  assert(rows[0].agoda_hotel_id === '535922',
    `기대 535922, 실제: "${rows[0].agoda_hotel_id}"`);
});

test('address: Grand Hyatt Seoul 원본 주소 포함', () => {
  const { rows } = parseOutputCSV();
  const hyatt = rows.find(r => (r.hotel_id || '').includes('grand'));
  assert(hyatt, 'Grand Hyatt 행 없음');
  assert(hyatt.address && hyatt.address.length > 0, `address 빈값`);
  assert(hyatt.address.toLowerCase().includes('sowol') ||
         hyatt.address.toLowerCase().includes('322'),
    `주소 오류: "${hyatt.address}"`);
});

test('address: Hilton Busan 주소 없어도 city+country 폴백', () => {
  const { rows } = parseOutputCSV();
  const hilton = rows.find(r => (r.hotel_id || '').includes('hilton'));
  assert(hilton, 'Hilton Busan 행 없음');
  assert(hilton.address && hilton.address.length > 0, 'address가 빈값');
  // 폴백: "busan, south korea" 또는 유사
  assert(hilton.address.toLowerCase().includes('busan'),
    `city+country 폴백 미작동: "${hilton.address}"`);
});

test('partner_url: 모든 행에 cid=1926938 포함', () => {
  const { rows } = parseOutputCSV();
  for (const row of rows) {
    assert((row.partner_url || '').includes(`cid=${CID}`),
      `cid 미포함: "${(row.partner_url || '').slice(0, 80)}"`);
  }
});

test('partner_url: LandingUrl이 있으면 cid만 추가 (URL 기반)', () => {
  const { rows } = parseOutputCSV();
  const hyatt = rows.find(r => (r.hotel_id || '').includes('grand'));
  assert(hyatt, 'Grand Hyatt 행 없음');
  // LandingUrl이 있으므로 agoda.com/grand-hyatt-seoul 기반 URL이어야 함
  assert((hyatt.partner_url || '').includes('agoda.com'),
    `Agoda URL 아님: "${hyatt.partner_url}"`);
});

test('hotel_id: 슬러그 형식 (소문자, 하이픈, 공백 없음)', () => {
  const { rows } = parseOutputCSV();
  for (const row of rows) {
    assert(/^[a-z0-9-]+$/.test(row.hotel_id || ''),
      `슬러그 형식 오류: "${row.hotel_id}"`);
  }
});

test('hotel_id: Grand Hyatt Seoul 슬러그 포함', () => {
  const { rows } = parseOutputCSV();
  const hyatt = rows.find(r => (r.hotel_id || '').includes('grand'));
  assert(hyatt, `Grand Hyatt 슬러그 없음 (rows: ${rows.map(r => r.hotel_id).join(', ')})`);
});

test('content_priority: 기본값 normal 채워짐', () => {
  const { rows } = parseOutputCSV();
  for (const row of rows) {
    assert(row.content_priority && row.content_priority.length > 0,
      `content_priority 빈값: hotel_id=${row.hotel_id}`);
  }
});

test('data_source: agoda-hoteldata', () => {
  const { rows } = parseOutputCSV();
  assert(rows.length > 0, '데이터 없음');
  assert(rows[0].data_source === 'agoda-hoteldata',
    `data_source: "${rows[0].data_source}"`);
});

// ── 검증 B: 단위 테스트 ───────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [B] 단위 함수 검증 (slugify / buildPartnerUrl)');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

const { slugify, buildPartnerUrl, detectColMap } = require('./hoteldata-to-tripprice');

test('slugify: 영문 호텔명 → 올바른 slug', () => {
  const result = slugify('Grand Hyatt Seoul');
  assert(result === 'grand-hyatt-seoul', `결과: "${result}"`);
});

test('slugify: 특수문자 제거', () => {
  const result = slugify('Hotel & Resort (Busan)');
  assert(/^[a-z0-9-]+$/.test(result), `결과: "${result}"`);
  assert(result.length > 0, 'slug가 빈값');
});

test('slugify: 한국어만 있으면 빈값 또는 하이픈만 (비ASCII 제거)', () => {
  const result = slugify('그랜드 하얏트');
  // 한국어 제거 후 빈값이거나 '-'만 남음
  assert(result === '' || /^[a-z0-9-]*$/.test(result), `결과: "${result}"`);
});

test('buildPartnerUrl: landing URL에 cid 파라미터 추가', () => {
  const url = buildPartnerUrl('https://www.agoda.com/hotel/123', '123', 'test-hotel', '1926938');
  assert(url.includes('cid=1926938'), `cid 미포함: "${url}"`);
  assert(url.startsWith('https://www.agoda.com/hotel/123'), `URL 구조 오류: "${url}"`);
});

test('buildPartnerUrl: agodaId로 URL 직접 생성 (landingUrl 없음)', () => {
  const url = buildPartnerUrl('', '535922', 'grand-hyatt-seoul', '1926938');
  assert(url.includes('535922'), `agodaId 미포함: "${url}"`);
  assert(url.includes('cid=1926938'), `cid 미포함: "${url}"`);
  assert(url.includes('tag=grand-hyatt-seoul'), `tag 미포함: "${url}"`);
});

test('buildPartnerUrl: agodaId도 없으면 빈값', () => {
  const url = buildPartnerUrl('', '', 'hotel', '1926938');
  assert(url === '', `기대 빈값, 실제: "${url}"`);
});

test('detectColMap: Agoda 포맷 컬럼 탐지', () => {
  const keys = ['objectid', 'propertyname', 'cityname', 'countryname', 'address', 'landingurl'];
  const m = detectColMap(keys);
  assert(m.agoda_hotel_id === 'objectid',    `agoda_hotel_id key: ${m.agoda_hotel_id}`);
  assert(m.hotel_name_en  === 'propertyname',`hotel_name_en key: ${m.hotel_name_en}`);
  assert(m.city           === 'cityname',    `city key: ${m.city}`);
  assert(m.landing_url    === 'landingurl',  `landing_url key: ${m.landing_url}`);
});

test('detectColMap: Tripprice 내부 포맷 컬럼 탐지', () => {
  const keys = ['hotel_id', 'hotel_name', 'city', 'country', 'address', 'agoda_hotel_id'];
  const m = detectColMap(keys);
  assert(m.agoda_hotel_id !== undefined, 'agoda_hotel_id 탐지 실패');
  assert(m.city           !== undefined, 'city 탐지 실패');
});

// ── 검증 C: address 없는 서브셋 처리 ─────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(' [C] address 컬럼 없는 CSV 폴백 처리');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// address 컬럼 자체가 없는 CSV
const NO_ADDR_CSV = [
  'ObjectId,PropertyName,CityName,CountryName,StarRating',
  '999,Test Hotel,Busan,South Korea,4',
].join('\n');

const tmpIn2  = path.join(tmpDir, 'no-addr-subset.csv');
const tmpOut2 = path.join(tmpDir, 'no-addr-tripprice.csv');
fs.writeFileSync(tmpIn2, NO_ADDR_CSV, 'utf8');

let noAddrFailed = false;
try {
  execFileSync(process.execPath, [
    path.join(SCRIPTS, 'hoteldata-to-tripprice.js'),
  ], {
    env: {
      ...process.env,
      HOTELDATA_SUBSET_CSV:    tmpIn2,
      HOTELDATA_TRIPPRICE_CSV: tmpOut2,
      AGODA_CID:               CID,
    },
    encoding: 'utf8',
    timeout:  30_000,
  });
} catch (err) {
  noAddrFailed = true;
  console.error('  no-addr 테스트 실패:', (err.stderr || err.message).slice(0, 200));
}

test('address 컬럼 없어도 변환 성공 (city+country 폴백)', () => {
  assert(!noAddrFailed, 'transform 실패');
  assert(fs.existsSync(tmpOut2), '출력 파일 미생성');
  const { rows } = parseOutputCSV(tmpOut2);
  assert(rows.length === 1, `기대 1행, 실제 ${rows.length}행`);
  assert((rows[0].address || '').length > 0, 'address 폴백 빈값');
});

// ── 정리 ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

// ── 결과 ─────────────────────────────────────────────────────────────────────
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(` 결과: ${passed + failed}/${passed + failed} 중 ${passed} passed`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (failed > 0) process.exit(1);
