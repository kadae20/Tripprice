#!/usr/bin/env node
/**
 * hoteldata-to-tripprice.js
 *
 * Agoda 원본 subset CSV → Tripprice ingest 포맷 CSV 변환.
 * readline 스트리밍 처리 (대용량 메모리 안전, OOM 없음).
 *
 * 입력:  data/hotels/hotels-subset.csv  (Agoda 원본 컬럼)
 * 출력:  data/hotels/tripprice-hotels.csv (Tripprice ingest 스키마)
 * 리포트: state/campaigns/hoteldata-transform-report-YYYY-MM-DD.md
 *
 * 환경변수:
 *   AGODA_CID               — 제휴 CID (기본: 1926938)
 *   HOTELDATA_SUBSET_CSV    — 입력 경로 override
 *   HOTELDATA_TRIPPRICE_CSV — 출력 경로 override
 */
'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const ROOT       = path.resolve(__dirname, '..');
const INPUT_CSV  = path.resolve(ROOT, process.env.HOTELDATA_SUBSET_CSV    || 'data/hotels/hotels-subset.csv');
const OUTPUT_CSV = path.resolve(ROOT, process.env.HOTELDATA_TRIPPRICE_CSV || 'data/hotels/tripprice-hotels.csv');
const REPORT_DIR = path.join(ROOT, 'state', 'campaigns');
const CID        = (process.env.AGODA_CID || '1926938').trim();

// ── Tripprice ingest 출력 컬럼 (ingest-hotel-data.js 스키마 기준) ─────────────
const OUTPUT_HEADERS = [
  'hotel_id', 'hotel_name', 'hotel_name_en',
  'city', 'country', 'address',
  'agoda_hotel_id', 'partner_url', 'source_url',
  'star_rating', 'review_score', 'review_count', 'photos_count',
  'latitude', 'longitude',
  'price_min', 'currency', 'checkin_time', 'checkout_time',
  'overview', 'numberrooms', 'chain_name',
  'photo1', 'photo2', 'photo3', 'photo4', 'photo5',
  'rating_average', 'number_of_reviews',
  'rates_from', 'rates_currency',
  'content_priority', 'data_source',
];

// ── Agoda 원본 컬럼명 후보 (정규화 후 매칭: 소문자, 언더스코어) ───────────────
// 앞쪽 후보일수록 우선순위 높음
const CANDIDATES = {
  // Agoda 숫자 ID (agoda_hotel_id 출력에 사용)
  agoda_hotel_id:  ['objectid', 'object_id', 'propertyid', 'property_id',
                    'hotelid', 'hotel_id_agoda', 'agoda_hotel_id', 'agodaid'],
  // 영문 호텔명 (slug 생성에 사용)
  hotel_name_en:   ['propertyname', 'property_name', 'hotel_name_en',
                    'hotelname', 'hotel_name_english', 'englishname', 'english_name',
                    'name_en', 'hotel_name'],
  // 현지어 호텔명 (없으면 영문 폴백)
  hotel_name_local:['hotel_name_local', 'localname', 'local_name',
                    'hotel_name_ko', 'chinesename', 'japanesename', 'hotel_name'],
  // 도시 (영문 우선)
  city:            ['city_english', 'citynameenglish', 'city_name_english',
                    'city_name_en', 'cityname', 'city_name',
                    'propertycity', 'property_city', 'city'],
  // 국가
  country:         ['countryname', 'country_name', 'propertycountry',
                    'property_country', 'country'],
  // 주소
  address:         ['propertyaddress', 'property_address', 'hoteladdress',
                    'hotel_address', 'streetaddress', 'street_address',
                    'full_address', 'address1', 'address'],
  // 좌표
  latitude:        ['latitude', 'lat'],
  longitude:       ['longitude', 'long', 'lon', 'lng'],
  // 등급/리뷰
  star_rating:     ['starrating', 'star_rating', 'stars', 'hotelstar', 'star'],
  review_score:    ['guestreviewscore', 'guest_review_score', 'reviewscore',
                    'review_score', 'rating', 'averagereview', 'guestrating'],
  review_count:    ['numberofrereviews', 'numberofreviews', 'number_of_reviews',
                    'reviewcount', 'review_count', 'totalreviews', 'numreviews'],
  photos_count:    ['numberofphotos', 'number_of_photos', 'photoscount',
                    'photos_count', 'imagecount', 'photo_count'],
  // 우선순위
  content_priority:['contentpriority', 'content_priority', 'priority'],
  // 파트너 랜딩 URL
  landing_url:     ['landingurl', 'landing_url', 'hotel_url', 'hotelurl',
                    'url', 'propertyurl', 'agoda_url'],
  // 가격/체크인
  price_min:       ['pricemin', 'price_min', 'minprice', 'min_price',
                    'price_from', 'lowestprice', 'ratesfrom', 'rates_from'],
  currency:        ['currency', 'ratescurrency', 'rates_currency'],
  checkin_time:    ['checkintime', 'checkin_time', 'checkin',
                    'check_in_time', 'check_in'],
  checkout_time:   ['checkouttime', 'checkout_time', 'checkout',
                    'check_out_time', 'check_out'],
  // 소개글 / 객실수 / 체인
  overview:        ['overview', 'hotel_overview', 'description', 'propertydescription',
                    'property_description', 'hoteldescription', 'hotel_description'],
  numberrooms:     ['numberrooms', 'number_of_rooms', 'numberofrooms', 'roomcount',
                    'room_count', 'total_rooms', 'totalrooms'],
  chain_name:      ['chainname', 'chain_name', 'brandname', 'brand_name',
                    'hotelchain', 'hotel_chain'],
  // 개별 사진 URL (photo1~5)
  photo1:          ['photo1', 'photo_1'],
  photo2:          ['photo2', 'photo_2'],
  photo3:          ['photo3', 'photo_3'],
  photo4:          ['photo4', 'photo_4'],
  photo5:          ['photo5', 'photo_5'],
  // 리뷰 (원본 컬럼명 그대로 추가 출력)
  rating_average:  ['ratingaverage', 'rating_average', 'averagerating', 'review_score',
                    'guestreviewscore', 'guest_review_score'],
  number_of_reviews: ['numberofreviews', 'number_of_reviews', 'numberofrereviews',
                    'reviewcount', 'review_count', 'totalreviews', 'numreviews'],
  // 요금 원본 컬럼
  rates_from:      ['ratesfrom', 'rates_from', 'price_from', 'min_rate',
                    'pricemin', 'price_min', 'minprice', 'min_price', 'lowestprice'],
  rates_currency:  ['ratescurrency', 'rates_currency', 'currency'],
};

// ── CSV 유틸 (RFC 4180) ───────────────────────────────────────────────────────
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

function escapeCSV(val) {
  const s = String(val ?? '');
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── 컬럼 인덱스 탐지 (헤더 정규화 후 후보 매칭) ──────────────────────────────
function detectColMap(normalizedHeaders) {
  // normalizedHeaders: { colName → index }
  const idx = {};
  for (const [field, candidates] of Object.entries(CANDIDATES)) {
    for (const c of candidates) {
      if (normalizedHeaders[c] !== undefined) {
        idx[field] = normalizedHeaders[c];
        break;
      }
    }
  }
  return idx;
}

// ── 슬러그 생성 (ASCII only, 영문+숫자+하이픈) ────────────────────────────────
function slugify(str) {
  return String(str || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // 발음 부호 제거
    .replace(/[^\w\s-]/g, ' ')        // 비ASCII/특수문자 → 공백
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
    .substring(0, 60) || '';
}

// ── 파트너 URL 생성 ───────────────────────────────────────────────────────────
/**
 * @param {string} landingUrl — Agoda 제공 랜딩 URL (있으면 cid 파라미터만 추가)
 * @param {string} agodaId    — Agoda 숫자 호텔 ID
 * @param {string} hotelId    — Tripprice slug (tag 파라미터용)
 * @param {string} [cid]      — CID (기본: 모듈 상수 CID)
 */
function buildPartnerUrl(landingUrl, agodaId, hotelId, cid = CID) {
  if (landingUrl) {
    try {
      const u = new URL(landingUrl);
      u.searchParams.set('cid', cid);
      return u.toString();
    } catch { /* 잘못된 URL → 직접 구성 */ }
  }
  if (agodaId) {
    return `https://www.agoda.com/hotel/${agodaId}?cid=${cid}&tag=${hotelId}`;
  }
  return '';
}

// ── 메인 변환 ─────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(INPUT_CSV)) {
    console.error(`[오류] 입력 파일 없음: ${path.relative(ROOT, INPUT_CSV)}`);
    console.error('  → npm run hoteldata:extract 으로 hotels-subset.csv 생성 후 재실행');
    process.exit(1);
  }

  const inputStat   = fs.statSync(INPUT_CSV);
  const inputSizeMB = (inputStat.size / 1024 / 1024).toFixed(1);

  console.log('══════════════════════════════════════════════════');
  console.log('  Agoda subset → Tripprice 스키마 변환');
  console.log('══════════════════════════════════════════════════');
  console.log(`  입력  : ${path.relative(ROOT, INPUT_CSV)} (${inputSizeMB}MB)`);
  console.log(`  출력  : ${path.relative(ROOT, OUTPUT_CSV)}`);
  console.log(`  CID   : ${CID}`);
  console.log('');

  fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const tmpPath = OUTPUT_CSV + '.tmp';
  const ws      = fs.createWriteStream(tmpPath, { encoding: 'utf8' });

  // ── 통계 ──────────────────────────────────────────────────────────────────
  let totalRead    = 0;
  let totalWritten = 0;
  let totalSkipped = 0;
  const missingFieldCount = {};  // 누락/폴백 사유 집계
  const samples = [];            // 리포트용 샘플 (최대 10개)
  const slugMap = new Map();     // 슬러그 충돌 카운터

  let colMap  = null;
  let normHdr = null;

  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input:     fs.createReadStream(INPUT_CSV, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', rawLine => {
      const line = rawLine.replace(/\u0000/g, ''); // NUL 문자 제거 (컬럼 밀림 방지)
      if (!line.trim()) return;
      const fields = parseCSVLine(line);

      // ── 헤더 처리 (첫 번째 행) ───────────────────────────────────────────
      if (normHdr === null) {
        normHdr = {};
        fields.forEach((h, i) => {
          const k = h.trim().toLowerCase().replace(/\s+/g, '_');
          normHdr[k] = i;
        });
        colMap = detectColMap(normHdr);

        const detected = Object.entries(colMap)
          .filter(([k]) => !['hotel_name_local', 'landing_url'].includes(k))
          .map(([k, v]) => `${k}[${v}]`)
          .join(' ');
        console.log(`  컬럼 탐지: ${detected || '(탐지 실패 — 헤더 확인 필요)'}`);
        console.log('');

        // 출력 헤더 쓰기
        ws.write(OUTPUT_HEADERS.map(escapeCSV).join(',') + '\n');
        return;
      }

      // ── 데이터 행 처리 ────────────────────────────────────────────────────
      totalRead++;

      // 빈 행 건너뜀
      if (fields.every(f => !f.trim())) { totalSkipped++; return; }

      const get = col => {
        const idx = colMap[col];
        return idx !== undefined ? (fields[idx] || '').trim() : '';
      };

      // Agoda 숫자 ID
      const agodaId = get('agoda_hotel_id');

      // 호텔명: 영문 우선, 없으면 현지어
      const nameEn    = get('hotel_name_en');
      const nameLocal = get('hotel_name_local');
      const hotelName = nameEn || nameLocal;

      if (!hotelName) {
        totalSkipped++;
        const k = '필수 누락: hotel_name 계열 컬럼 없음';
        missingFieldCount[k] = (missingFieldCount[k] || 0) + 1;
        return;
      }

      // 도시/국가 (소문자 정규화)
      const city    = get('city').toLowerCase().trim();
      const country = get('country').toLowerCase().trim();

      // hotel_id 슬러그 생성
      // 비ASCII 한국어 등 이름은 ASCII 부분만 사용 → 없으면 agoda-{id}
      const slugBase = nameEn || nameLocal.replace(/[^\x00-\x7F]/g, '').trim();
      const rawSlug  = slugBase
        ? slugify(`${slugBase}-${city}`)
        : (agodaId ? `agoda-${agodaId}` : slugify(`hotel-${city}`));
      const baseSlug = rawSlug || (agodaId ? `agoda-${agodaId}` : 'hotel');

      // 충돌 처리: 같은 슬러그 두 번째 이상은 -2, -3 suffix
      let hotelId;
      if (slugMap.has(baseSlug)) {
        const n = slugMap.get(baseSlug) + 1;
        slugMap.set(baseSlug, n);
        hotelId = `${baseSlug}-${n}`;
      } else {
        slugMap.set(baseSlug, 1);
        hotelId = baseSlug;
      }

      // address: 원본 우선, 없으면 city + country 폴백 (빈값 금지)
      const rawAddress = get('address');
      const address    = rawAddress || [city, country].filter(Boolean).join(', ');
      if (!rawAddress) {
        const k = 'address 폴백 (city+country 대체)';
        missingFieldCount[k] = (missingFieldCount[k] || 0) + 1;
      }

      // agoda_hotel_id 누락 집계
      if (!agodaId) {
        const k = 'agoda_hotel_id 없음 (partner_url 생성 제한)';
        missingFieldCount[k] = (missingFieldCount[k] || 0) + 1;
      }

      // partner_url 생성
      const landingUrl = get('landing_url');
      const partnerUrl = buildPartnerUrl(landingUrl, agodaId, hotelId);
      if (!partnerUrl) {
        const k = 'partner_url 생성 불가';
        missingFieldCount[k] = (missingFieldCount[k] || 0) + 1;
      }

      // photo1~5: 개별 컬럼에서 가져오거나, photos JSON 배열 파싱 시도
      const photoVals = [1, 2, 3, 4, 5].map(n => get(`photo${n}`));
      // photos JSON 배열 폴백: photo1~5가 모두 비어있고 photos 컬럼이 JSON 배열이면 파싱
      if (photoVals.every(v => !v)) {
        const photosCol = Object.keys(colMap).find(k => k === 'photos');
        if (photosCol === undefined) {
          // photos 컬럼 직접 탐지
          const photosIdx = normHdr['photos'];
          if (photosIdx !== undefined) {
            const photosRaw = (fields[photosIdx] || '').trim();
            try {
              const arr = JSON.parse(photosRaw);
              if (Array.isArray(arr)) {
                for (let i = 0; i < 5 && i < arr.length; i++) {
                  photoVals[i] = String(arr[i] || '');
                }
              }
            } catch { /* not JSON */ }
          }
        }
      }

      // photos_count: 우선 원본 컬럼 → photo1~5 비어있지 않은 수 계산
      let photosCount = get('photos_count');
      if (!photosCount) {
        const nonEmpty = photoVals.filter(v => v).length;
        photosCount = nonEmpty > 0 ? String(nonEmpty) : '';
      }

      // 출력 행 조립
      const row = [
        hotelId,
        hotelName,                                 // hotel_name (표시용)
        nameEn,                                    // hotel_name_en
        city,
        country,
        address,
        agodaId,                                   // agoda_hotel_id
        partnerUrl,                                // partner_url
        partnerUrl,                                // source_url (= partner_url)
        get('star_rating'),
        get('review_score'),
        get('review_count'),
        photosCount,                               // photos_count (계산된 값)
        get('latitude'),
        get('longitude'),
        get('price_min'),
        get('currency'),
        get('checkin_time'),
        get('checkout_time'),
        get('overview'),
        get('numberrooms'),
        get('chain_name'),
        photoVals[0],                              // photo1
        photoVals[1],                              // photo2
        photoVals[2],                              // photo3
        photoVals[3],                              // photo4
        photoVals[4],                              // photo5
        get('rating_average'),                     // rating_average (원본)
        get('number_of_reviews'),                  // number_of_reviews (원본)
        get('rates_from'),                         // rates_from
        get('rates_currency'),                     // rates_currency
        get('content_priority') || 'normal',
        'agoda-hoteldata',
      ];

      ws.write(row.map(escapeCSV).join(',') + '\n');
      totalWritten++;

      // 샘플 수집
      if (samples.length < 10) {
        samples.push({ hotel_id: hotelId, hotel_name: hotelName, city, agoda_hotel_id: agodaId, partner_url: partnerUrl, address });
      }

      // 진행 표시 (1000행마다)
      if (totalRead % 1000 === 0) {
        process.stdout.write(`\r  처리: ${totalRead.toLocaleString()}행 | 변환: ${totalWritten.toLocaleString()}`);
      }
    });

    rl.on('close', () => ws.end());
    ws.on('finish', resolve);
    rl.on('error', reject);
    ws.on('error', reject);
  });

  if (totalRead > 0) process.stdout.write('\n');

  // 원자적 교체
  fs.renameSync(tmpPath, OUTPUT_CSV);

  // ── 리포트 ────────────────────────────────────────────────────────────────
  const date       = new Date().toISOString().split('T')[0];
  const outStat    = fs.statSync(OUTPUT_CSV);
  const outKB      = (outStat.size / 1024).toFixed(0);
  const reportPath = path.join(REPORT_DIR, `hoteldata-transform-report-${date}.md`);

  let md = `# Hoteldata Transform Report — ${date}\n\n`;
  md += `## 요약\n\n| 항목 | 값 |\n|------|----|\n`;
  md += `| 입력 | ${path.relative(ROOT, INPUT_CSV)} (${inputSizeMB}MB) |\n`;
  md += `| 출력 | ${path.relative(ROOT, OUTPUT_CSV)} (${outKB}KB) |\n`;
  md += `| 읽은 행 | ${totalRead.toLocaleString()} |\n`;
  md += `| 변환 성공 | ${totalWritten.toLocaleString()} |\n`;
  md += `| 건너뜀 | ${totalSkipped.toLocaleString()} |\n`;
  md += `| AGODA_CID | ${CID} |\n\n`;

  if (Object.keys(missingFieldCount).length > 0) {
    md += `## 필드 누락 / 폴백 현황\n\n`;
    Object.entries(missingFieldCount)
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => { md += `- ${k}: ${v.toLocaleString()}건\n`; });
    md += '\n';
  }

  if (samples.length > 0) {
    md += `## 변환 샘플 (${samples.length}건)\n\n`;
    md += `| hotel_id | hotel_name | city | agoda_hotel_id | partner_url |\n`;
    md += `|----------|------------|------|----------------|-------------|\n`;
    for (const s of samples) {
      const url = s.partner_url.length > 55 ? s.partner_url.slice(0, 55) + '…' : s.partner_url;
      md += `| ${s.hotel_id} | ${s.hotel_name} | ${s.city} | ${s.agoda_hotel_id} | ${url} |\n`;
    }
    md += '\n';
  }

  fs.writeFileSync(reportPath, md, 'utf8');

  // ── 완료 출력 ─────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════════');
  console.log('  변환 완료');
  console.log('══════════════════════════════════════════════════');
  console.log(`  읽은 행   : ${totalRead.toLocaleString()}`);
  console.log(`  변환 성공 : ${totalWritten.toLocaleString()}`);
  console.log(`  건너뜀    : ${totalSkipped.toLocaleString()}`);
  console.log(`  출력 크기 : ${outKB}KB`);
  console.log(`  출력 파일 : ${path.relative(ROOT, OUTPUT_CSV)}`);
  console.log(`  리포트    : ${path.relative(ROOT, reportPath)}`);
  console.log('══════════════════════════════════════════════════');

  if (totalWritten === 0) {
    console.error('\n[오류] 변환 결과 0행 — 컬럼 구조 확인 필요');
    console.error(`  → head -1 ${path.relative(ROOT, INPUT_CSV)}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(`\n실패: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { slugify, buildPartnerUrl, detectColMap };
