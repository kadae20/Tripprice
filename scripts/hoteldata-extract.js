#!/usr/bin/env node
/**
 * hoteldata-extract.js
 * hotels-latest.csv(대용량)에서 조건에 맞는 행만 스트리밍 추출 → hotels-subset.csv 생성.
 * 메모리 상수 수준(한 줄씩 처리), std::bad_alloc 없음.
 *
 * 환경변수:
 *   HOTELDATA_CITIES           — 추출할 도시 (쉼표 구분, 기본: seoul,busan,jeju)
 *   HOTELDATA_EXTRACT_ROWS     — 최대 출력 행 수 (기본: 50000)
 *   HOTELDATA_EXTRACT_HOTELS   — 최대 hotel_id 유니크 수 (기본: 10000)
 *   HOTELDATA_PROGRESS_EVERY   — 진행 로그 간격 행 수 (기본: 100000)
 *   HOTELDATA_LATEST_CSV       — 입력 파일 경로 override
 *   HOTELDATA_SUBSET_CSV       — 출력 파일 경로 override
 *
 * 입력: data/hotels/hotels-latest.csv
 * 출력: data/hotels/hotels-subset.csv
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const ROOT       = path.resolve(__dirname, '..');
const INPUT_CSV  = path.resolve(ROOT, process.env.HOTELDATA_LATEST_CSV || 'data/hotels/hotels-latest.csv');
const OUTPUT_CSV = path.resolve(ROOT, process.env.HOTELDATA_SUBSET_CSV || 'data/hotels/hotels-subset.csv');

const CITIES     = (process.env.HOTELDATA_CITIES || 'seoul,busan,jeju')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const MAX_ROWS   = Math.max(1, parseInt(process.env.HOTELDATA_EXTRACT_ROWS   || '50000',  10));
const MAX_HOTELS = Math.max(1, parseInt(process.env.HOTELDATA_EXTRACT_HOTELS || '10000',  10));
const LOG_EVERY  = Math.max(1000, parseInt(process.env.HOTELDATA_PROGRESS_EVERY || '100000', 10));

// ── CSV 유틸 (RFC 4180) ───────────────────────────────────────────────────────

function parseCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQ = false;
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

// ── 컬럼 이름 후보 (Agoda 원본 포맷 + 우리 포맷 모두 커버) ───────────────────
// Agoda property data file: CityName, CityNameEnglish, PropertyCity 등
// 우리 포맷: city
const CITY_CANDIDATES     = ['city', 'cityname', 'city_name', 'propertycity', 'property_city',
                              'city_english', 'citynameenglish', 'city_name_english'];
const PRIORITY_CANDIDATES = ['content_priority', 'priority'];
const ID_CANDIDATES       = ['hotel_id', 'propertyid', 'property_id', 'hotelid', 'objectid',
                              'agoda_hotel_id', 'property_id_agoda'];

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(INPUT_CSV)) {
    console.error(`[오류] 입력 파일 없음: ${path.relative(ROOT, INPUT_CSV)}`);
    console.error('  → npm run hoteldata:sync 으로 hotels-latest.csv 생성 후 재실행');
    process.exit(1);
  }

  const inputStat = fs.statSync(INPUT_CSV);
  console.log('══════════════════════════════════════════════════');
  console.log('  Agoda 호텔 데이터 subset 추출');
  console.log('══════════════════════════════════════════════════');
  console.log(`  입력  : ${path.relative(ROOT, INPUT_CSV)} (${(inputStat.size / 1024 / 1024).toFixed(0)}MB)`);
  console.log(`  출력  : ${path.relative(ROOT, OUTPUT_CSV)}`);
  console.log(`  도시  : ${CITIES.join(', ')}`);
  console.log(`  상한  : 행 ${MAX_ROWS.toLocaleString()} / 호텔 ${MAX_HOTELS.toLocaleString()}`);
  console.log('');

  const rl      = readline.createInterface({
    input:     fs.createReadStream(INPUT_CSV, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  const tmpPath = OUTPUT_CSV + '.tmp';
  fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });
  const ws = fs.createWriteStream(tmpPath, { encoding: 'utf8' });

  let headers        = null;
  let cityIdx        = -1;
  let priorityIdx    = -1;
  let idIdx          = -1;
  let totalRead      = 0;
  let totalWritten   = 0;
  const seenIds      = new Set();
  let done           = false;

  await new Promise((resolve, reject) => {
    rl.on('line', line => {
      if (done || !line.trim()) return;

      const fields = parseCSVLine(line);

      // ── 헤더 처리 ──────────────────────────────────────────────────────────
      if (headers === null) {
        headers = fields.map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
        for (let i = 0; i < headers.length; i++) {
          const h = headers[i];
          if (cityIdx     < 0 && CITY_CANDIDATES.includes(h))     cityIdx     = i;
          if (priorityIdx < 0 && PRIORITY_CANDIDATES.includes(h)) priorityIdx = i;
          if (idIdx       < 0 && ID_CANDIDATES.includes(h))       idIdx       = i;
        }
        if (cityIdx < 0) {
          ws.end();
          try { fs.unlinkSync(tmpPath); } catch {}
          reject(new Error(
            `city 컬럼을 찾지 못했습니다.\n` +
            `  검색한 이름: ${CITY_CANDIDATES.join(', ')}\n` +
            `  실제 헤더(처음 10개): ${headers.slice(0, 10).join(', ')}`
          ));
          return;
        }
        console.log(
          `  헤더 감지 — city[${cityIdx}]:"${headers[cityIdx]}"` +
          (priorityIdx >= 0 ? ` / priority[${priorityIdx}]` : '') +
          (idIdx >= 0 ? ` / id[${idIdx}]` : '')
        );
        ws.write(fields.map(escapeCSV).join(',') + '\n');
        return;
      }

      totalRead++;
      if (totalRead % LOG_EVERY === 0) {
        process.stdout.write(
          `\r  읽기: ${totalRead.toLocaleString()}행 | 추출: ${totalWritten.toLocaleString()}행 | ID: ${seenIds.size.toLocaleString()}`
        );
      }

      // 상한 도달 → readline을 닫아 조기 종료
      if (totalWritten >= MAX_ROWS || seenIds.size >= MAX_HOTELS) {
        if (!done) { done = true; rl.close(); }
        return;
      }

      // 도시 필터
      const cityVal = (fields[cityIdx] || '').toLowerCase().trim();
      if (!CITIES.some(c => cityVal === c || cityVal.includes(c))) return;

      // content_priority 필터 (컬럼 있을 때만 적용)
      if (priorityIdx >= 0) {
        const pv = (fields[priorityIdx] || '').toLowerCase().trim();
        if (pv && pv !== 'high' && pv !== 'normal') return;
      }

      // hotel_id 중복 제거 (컬럼 있을 때만)
      if (idIdx >= 0) {
        const idVal = (fields[idIdx] || '').trim();
        if (idVal) {
          if (seenIds.has(idVal)) return;
          seenIds.add(idVal);
        }
      }

      ws.write(fields.map(escapeCSV).join(',') + '\n');
      totalWritten++;
    });

    rl.on('close', () => { ws.end(); });
    ws.on('finish', resolve);
    rl.on('error', reject);
    ws.on('error', reject);
  });

  // 원자적 교체
  fs.renameSync(tmpPath, OUTPUT_CSV);

  const outStat = fs.statSync(OUTPUT_CSV);
  process.stdout.write('\n');
  console.log('');
  console.log('══════════════════════════════════════════════════');
  console.log('  추출 완료');
  console.log('══════════════════════════════════════════════════');
  console.log(`  읽은 행    : ${totalRead.toLocaleString()}`);
  console.log(`  추출 행    : ${totalWritten.toLocaleString()}`);
  console.log(`  유니크 호텔: ${seenIds.size.toLocaleString()}`);
  console.log(`  출력 크기  : ${(outStat.size / 1024).toFixed(0)}KB`);
  console.log(`  출력 파일  : ${path.relative(ROOT, OUTPUT_CSV)}`);
  console.log('══════════════════════════════════════════════════');

  if (totalWritten === 0) {
    console.warn('\n  ⚠  추출 결과가 0행입니다.');
    console.warn(`  → HOTELDATA_CITIES="${CITIES.join(',')}" 와 CSV 도시 값이 일치하는지 확인`);
    console.warn(`  → 예: 도시 값이 "Seoul"이면 HOTELDATA_CITIES=seoul 로 설정`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n실패: ${err.message}`);
  process.exit(1);
});
