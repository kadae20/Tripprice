#!/usr/bin/env node
/**
 * hoteldata-extract.js
 * hotels-latest.csv(대용량)에서 조건에 맞는 행만 스트리밍 추출 → hotels-subset.csv 생성.
 * 메모리 상수 수준(한 줄씩 처리).
 *
 * EXTRACT_MODE=city (기본): HOTELDATA_CITIES 목록으로 필터 (normalizeCity 기반 매칭)
 * EXTRACT_MODE=global:      상위 빈도 도시 HOTELDATA_TOP_CITIES개로 필터 (2패스)
 * EXTRACT_MODE=performance: scoreHotel 점수 상위 호텔 선택 (2패스)
 *
 * 환경변수:
 *   EXTRACT_MODE               — city|global|performance (기본: city)
 *   HOTELDATA_CITIES           — 추출 도시 (쉼표 구분, 기본: seoul,busan,jeju)
 *   HOTELDATA_TOP_CITIES       — global 모드: 상위 N개 도시 (기본: 20)
 *   HOTELDATA_EXTRACT_ROWS     — 최대 출력 행 수 (기본: 50000)
 *   HOTELDATA_EXTRACT_HOTELS   — 최대 hotel_id 유니크 수 (기본: 10000)
 *   HOTELDATA_PROGRESS_EVERY   — 진행 로그 간격 행 수 (기본: 100000)
 *   ROTATION_COOLDOWN_DAYS     — 최근 N일 내 사용 호텔 제외 (기본: 7, 0=비활성)
 *   HOTELDATA_LATEST_CSV       — 입력 파일 경로 override
 *   HOTELDATA_SUBSET_CSV       — 출력 파일 경로 override
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const ROOT         = path.resolve(__dirname, '..');
const INPUT_CSV    = path.resolve(ROOT, process.env.HOTELDATA_LATEST_CSV || 'data/hotels/hotels-latest.csv');
const OUTPUT_CSV   = path.resolve(ROOT, process.env.HOTELDATA_SUBSET_CSV || 'data/hotels/hotels-subset.csv');
const ROTATION_PATH = path.join(ROOT, 'state', 'rotation', 'hotel-rotation.json');
const KPI_PATH      = path.join(ROOT, 'state', 'kpi', 'hotel-performance.json');
const REPORT_DIR    = path.join(ROOT, 'state', 'campaigns');

const EXTRACT_MODE  = (process.env.EXTRACT_MODE || 'city').toLowerCase();
const CITIES        = (process.env.HOTELDATA_CITIES || 'seoul,busan,jeju')
  .split(',').map(s => s.trim()).filter(Boolean);
const TOP_CITIES    = Math.max(1,    parseInt(process.env.HOTELDATA_TOP_CITIES    || '20',     10));
const MAX_ROWS      = Math.max(1,    parseInt(process.env.HOTELDATA_EXTRACT_ROWS   || '50000',  10));
const MAX_HOTELS    = Math.max(1,    parseInt(process.env.HOTELDATA_EXTRACT_HOTELS || '10000',  10));
const LOG_EVERY     = Math.max(1000, parseInt(process.env.HOTELDATA_PROGRESS_EVERY || '100000', 10));
const COOLDOWN_DAYS = Math.max(0,    parseInt(process.env.ROTATION_COOLDOWN_DAYS   || '7',      10));

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

// ── 도시명 정규화 ─────────────────────────────────────────────────────────────

/**
 * 괄호 제거, 슬래시 앞만 사용, 연속 공백 정리, 소문자 변환.
 *   "로스앤젤레스 (CA)"  → "로스앤젤레스"
 *   "멜버른 / 멜번"      → "멜버른"
 *   "Seoul"              → "seoul"
 */
function normalizeCity(s) {
  return String(s || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')  // "(CA)" 등 괄호 내용 제거
    .replace(/\s*\/.*$/,         '')    // 슬래시 이후 제거
    .replace(/\s+/g,             ' ')  // 연속 공백 정리
    .trim()
    .toLowerCase();
}

/**
 * 슬래시 표기의 두 번째 이름(alias)도 반환.
 * "멜버른 / 멜번" → ["멜버른", "멜번"]
 */
function cityAliases(raw) {
  const s   = String(raw || '');
  const base = normalizeCity(s);
  const si   = s.indexOf('/');
  if (si < 0) return [base];
  const alt = normalizeCity(s.slice(si + 1));
  return alt && alt !== base ? [base, alt] : [base];
}

/** targetCities(Set) 에 raw 도시값이 일치하는지 확인 */
function cityMatches(rawValue, targetCities) {
  return cityAliases(rawValue).some(a => targetCities.has(a));
}

/** 문자열 배열 → 정규화된 도시 Set */
function buildTargetCities(cityList) {
  return new Set(cityList.map(normalizeCity).filter(Boolean));
}

// ── 컬럼 이름 후보 (Agoda 원본 + 우리 포맷) ──────────────────────────────────
const CITY_CANDIDATES     = ['city', 'cityname', 'city_name', 'propertycity', 'property_city',
                              'city_english', 'citynameenglish', 'city_name_english'];
const PRIORITY_CANDIDATES = ['content_priority', 'priority'];
const ID_CANDIDATES       = ['hotel_id', 'propertyid', 'property_id', 'hotelid', 'objectid',
                              'agoda_hotel_id', 'property_id_agoda'];

function detectCols(hdrMap) {
  let cityIdx = -1, priorityIdx = -1, idIdx = -1;
  for (const h of Object.keys(hdrMap)) {
    if (cityIdx     < 0 && CITY_CANDIDATES.includes(h))     cityIdx     = hdrMap[h];
    if (priorityIdx < 0 && PRIORITY_CANDIDATES.includes(h)) priorityIdx = hdrMap[h];
    if (idIdx       < 0 && ID_CANDIDATES.includes(h))       idIdx       = hdrMap[h];
  }
  return { cityIdx, priorityIdx, idIdx };
}

// ── 호텔 성과 점수 (휴리스틱) ─────────────────────────────────────────────────

/**
 * star_rating, review_score, review_count(log), photos_count,
 * content_priority, price_min 기반 휴리스틱.
 * perfData(state/kpi/hotel-performance.json)가 있으면 clicks/bookings/commission 가중치 추가.
 */
function scoreHotel(fields, hdrMap, perfData) {
  const get = col => {
    const idx = hdrMap[col];
    return idx !== undefined ? (fields[idx] || '').trim() : '';
  };

  let score = 50;
  const star  = parseFloat(get('star_rating'))  || 0;
  const rv    = parseFloat(get('review_score')) || 0;
  const rn    = parseInt(get('review_count'))   || 0;
  const ph    = parseInt(get('photos_count'))   || 0;
  const pri   = get('content_priority').toLowerCase();
  const price = parseInt(get('price_min'))      || 0;

  score += star  * 5;                                        // 최대 +25
  score += rv    * 3;                                        // 최대 +30
  score += rn > 0 ? Math.log10(rn) * 5 : 0;               // log scale
  score += ph >= 10 ? 10 : ph >= 5 ? 5 : 0;
  score += pri === 'high' ? 20 : pri === 'low' ? -10 : 0;
  score += price > 200000 ? 10 : (price > 0 && price < 80000) ? 5 : 0;

  if (perfData) {
    // hotel_id 또는 agoda_hotel_id 로 KPI 조회
    const id = get('hotel_id') || get('propertyid') || get('property_id') || get('agoda_hotel_id');
    const p  = perfData[id];
    if (p) {
      score += Math.min((p.bookings    || 0) * 2,                   30);
      score += Math.min(Math.log10((p.clicks || 0) + 1) * 5,        15);
      score += Math.min((p.commission  || 0) / 10000,               20);
    }
  }
  return score;
}

function loadPerfData() {
  if (!fs.existsSync(KPI_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(KPI_PATH, 'utf8')); } catch { return null; }
}

// ── Rotation state ────────────────────────────────────────────────────────────

function isoWeekLabel(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const y      = d.getFullYear();
  const jan4   = new Date(y, 0, 4);
  const weekNum = 1 + Math.round(((d - jan4) / 86400000 - 3 + (jan4.getDay() + 6) % 7) / 7);
  return `${y}-W${String(weekNum).padStart(2, '0')}`;
}

function loadRotationState() {
  if (!fs.existsSync(ROTATION_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(ROTATION_PATH, 'utf8')); } catch { return {}; }
}

function saveRotationState(state, newlyUsed) {
  fs.mkdirSync(path.dirname(ROTATION_PATH), { recursive: true });
  const now  = new Date().toISOString();
  const week = isoWeekLabel();
  for (const id of newlyUsed) {
    const prev = state[id] || {};
    state[id]  = { last_used_at: now, used_count: (prev.used_count || 0) + 1, last_week: week };
  }
  fs.writeFileSync(ROTATION_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function isOnCooldown(hotelId, rotationState) {
  if (COOLDOWN_DAYS <= 0) return false;
  const e = rotationState[hotelId];
  if (!e || !e.last_used_at) return false;
  return (Date.now() - new Date(e.last_used_at).getTime()) / 86400000 < COOLDOWN_DAYS;
}

// ── 스트리밍 CSV 헬퍼 (1패스용) ──────────────────────────────────────────────

function streamCsv(filePath, { onHeader, onRow }) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let hdrMap = null;
    let done   = false;

    rl.on('line', line => {
      if (done || !line.trim()) return;
      const fields = parseCSVLine(line);
      if (hdrMap === null) {
        const headers = fields.map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
        hdrMap = {};
        headers.forEach((h, i) => { hdrMap[h] = i; });
        if (onHeader) onHeader(headers, hdrMap);
        return;
      }
      const cont = onRow(fields, hdrMap);
      if (cont === false) { done = true; rl.close(); }
    });
    rl.on('close', resolve);
    rl.on('error', reject);
  });
}

// ── 패스 1A: 도시 빈도 카운트 (global 모드) ──────────────────────────────────

async function countCities() {
  const cityCount = new Map();
  let cityIdx     = -1;

  await streamCsv(INPUT_CSV, {
    onHeader(_, hdrMap) { ({ cityIdx } = detectCols(hdrMap)); },
    onRow(fields) {
      if (cityIdx < 0) return;
      const norm = normalizeCity(fields[cityIdx] || '');
      if (norm) cityCount.set(norm, (cityCount.get(norm) || 0) + 1);
    },
  });

  return cityIdx >= 0 ? cityCount : null;
}

// ── 패스 1B: 점수 수집 (performance 모드) ────────────────────────────────────

async function collectScores(targetCities, perfData, rotationState) {
  const scores = new Map();
  let cityIdx = -1, idIdx = -1;

  await streamCsv(INPUT_CSV, {
    onHeader(_, hdrMap) {
      ({ cityIdx, idIdx } = detectCols(hdrMap));
    },
    onRow(fields, hdrMap) {
      if (idIdx < 0) return;
      if (targetCities && targetCities.size > 0 && cityIdx >= 0) {
        if (!cityMatches(fields[cityIdx] || '', targetCities)) return;
      }
      const id = (fields[idIdx] || '').trim();
      if (!id || scores.has(id)) return;
      let sc = scoreHotel(fields, hdrMap, perfData);
      if (isOnCooldown(id, rotationState)) sc *= 0.1; // 큰 페널티
      scores.set(id, sc);
    },
  });

  return scores;
}

// ── 메인 추출 패스 ────────────────────────────────────────────────────────────

async function extractPass(targetCities, allowedIds, rotationState) {
  const tmpPath = OUTPUT_CSV + '.tmp';
  fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });
  const ws = fs.createWriteStream(tmpPath, { encoding: 'utf8' });

  let hdrMap = null, cityIdx = -1, priorityIdx = -1, idIdx = -1;
  let totalRead = 0, totalWritten = 0;
  const seenIds = new Set();
  const usedIds = new Set();
  const cityDist = new Map(); // 도시 분포 (리포트용)
  let done = false;

  await new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(INPUT_CSV, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    rl.on('line', line => {
      if (done || !line.trim()) return;
      const fields = parseCSVLine(line);

      // ── 헤더 ─────────────────────────────────────────────────────────────
      if (hdrMap === null) {
        const headers = fields.map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
        hdrMap = {};
        headers.forEach((h, i) => { hdrMap[h] = i; });
        ({ cityIdx, priorityIdx, idIdx } = detectCols(hdrMap));

        if (cityIdx < 0 && !allowedIds) {
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
          `  헤더 감지 — city[${cityIdx}]:"${cityIdx >= 0 ? headers[cityIdx] : 'N/A'}"` +
          (priorityIdx >= 0 ? ` / priority[${priorityIdx}]` : '') +
          (idIdx >= 0 ? ` / id[${idIdx}]` : '')
        );
        ws.write(fields.map(escapeCSV).join(',') + '\n');
        return;
      }

      // ── 진행 로그 ─────────────────────────────────────────────────────────
      totalRead++;
      if (totalRead % LOG_EVERY === 0) {
        process.stdout.write(
          `\r  읽기: ${totalRead.toLocaleString()}행 | 추출: ${totalWritten.toLocaleString()}행 | ID: ${seenIds.size.toLocaleString()}`
        );
      }

      // 상한 도달 → 조기 종료
      if (totalWritten >= MAX_ROWS || seenIds.size >= MAX_HOTELS) {
        if (!done) { done = true; rl.close(); }
        return;
      }

      // ── 도시 필터 (allowedIds가 없을 때만) ────────────────────────────────
      if (!allowedIds && targetCities && targetCities.size > 0 && cityIdx >= 0) {
        if (!cityMatches(fields[cityIdx] || '', targetCities)) return;
      }

      // ── allowedIds 필터 (global/performance 모드) ─────────────────────────
      const id = idIdx >= 0 ? (fields[idIdx] || '').trim() : '';
      if (allowedIds && (!id || !allowedIds.has(id))) return;

      // ── hotel_id 중복 제거 ────────────────────────────────────────────────
      if (id) {
        if (seenIds.has(id)) return;
        seenIds.add(id);
      }

      // ── Rotation 냉각 제외 ────────────────────────────────────────────────
      if (id && isOnCooldown(id, rotationState)) return;

      // ── content_priority 필터 ─────────────────────────────────────────────
      if (priorityIdx >= 0) {
        const pv = (fields[priorityIdx] || '').toLowerCase().trim();
        if (pv && pv !== 'high' && pv !== 'normal') return;
      }

      ws.write(fields.map(escapeCSV).join(',') + '\n');
      totalWritten++;
      if (id) usedIds.add(id);

      // 도시 분포 기록
      if (cityIdx >= 0) {
        const norm = normalizeCity(fields[cityIdx] || '');
        cityDist.set(norm, (cityDist.get(norm) || 0) + 1);
      }
    });

    rl.on('close', () => { ws.end(); });
    ws.on('finish', resolve);
    rl.on('error', reject);
    ws.on('error', reject);
  });

  fs.renameSync(tmpPath, OUTPUT_CSV);
  return { totalRead, totalWritten, seenIds, usedIds, cityDist };
}

// ── 리포트 생성 ───────────────────────────────────────────────────────────────

function generateReport({ totalRead, totalWritten, seenIds, cityDist }, mode, inputSizeMB) {
  const date     = new Date().toISOString().split('T')[0];
  const outStat  = fs.existsSync(OUTPUT_CSV) ? fs.statSync(OUTPUT_CSV) : null;
  const outKB    = outStat ? (outStat.size / 1024).toFixed(0) : 0;

  let md = `# Hoteldata Extract Report — ${date}\n\n`;
  md += `## 요약\n\n`;
  md += `| 항목 | 값 |\n|------|----|\n`;
  md += `| 입력 파일 | hotels-latest.csv (${inputSizeMB}MB) |\n`;
  md += `| 추출 모드 | ${mode} |\n`;
  md += `| 읽은 행 수 | ${totalRead.toLocaleString()} |\n`;
  md += `| 추출 행 수 | ${totalWritten.toLocaleString()} |\n`;
  md += `| 유니크 호텔 | ${seenIds.size.toLocaleString()} |\n`;
  md += `| 출력 크기 | ${outKB}KB |\n`;
  if (COOLDOWN_DAYS > 0) md += `| Rotation 냉각 | ${COOLDOWN_DAYS}일 |\n`;
  md += '\n';

  if (cityDist.size > 0) {
    md += `## 도시 분포\n\n| 도시 | 행 수 |\n|------|------|\n`;
    [...cityDist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
      .forEach(([c, n]) => { md += `| ${c} | ${n.toLocaleString()} |\n`; });
    md += '\n';
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `hoteldata-extract-report-${date}.md`);
  fs.writeFileSync(reportPath, md, 'utf8');
  return reportPath;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(INPUT_CSV)) {
    console.error(`[오류] 입력 파일 없음: ${path.relative(ROOT, INPUT_CSV)}`);
    console.error('  → npm run hoteldata:sync 으로 hotels-latest.csv 생성 후 재실행');
    process.exit(1);
  }

  const inputSizeMB = (fs.statSync(INPUT_CSV).size / 1024 / 1024).toFixed(0);
  console.log('══════════════════════════════════════════════════');
  console.log('  Agoda 호텔 데이터 subset 추출');
  console.log('══════════════════════════════════════════════════');
  console.log(`  입력   : ${path.relative(ROOT, INPUT_CSV)} (${inputSizeMB}MB)`);
  console.log(`  출력   : ${path.relative(ROOT, OUTPUT_CSV)}`);
  console.log(`  모드   : ${EXTRACT_MODE}`);
  console.log(`  상한   : 행 ${MAX_ROWS.toLocaleString()} / 호텔 ${MAX_HOTELS.toLocaleString()}`);
  if (COOLDOWN_DAYS > 0) console.log(`  Rotation: ${COOLDOWN_DAYS}일 냉각`);
  console.log('');

  const perfData      = loadPerfData();
  const rotationState = loadRotationState();

  let targetCities = null;
  let allowedIds   = null;

  // ── 모드별 1패스 (global/performance) ────────────────────────────────────
  if (EXTRACT_MODE === 'global') {
    console.log('  [1/2] 도시 빈도 카운트...');
    const cityCount = await countCities();
    if (!cityCount) {
      console.error('[오류] city 컬럼을 찾지 못했습니다 (global 모드)');
      process.exit(1);
    }
    const topList = [...cityCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_CITIES)
      .map(([c]) => c);
    console.log(`  상위 ${topList.length}개 도시: ${topList.slice(0, 5).join(', ')}${topList.length > 5 ? ' ...' : ''}`);
    targetCities = new Set(topList);
    console.log('  [2/2] subset 추출...');

  } else if (EXTRACT_MODE === 'performance') {
    const citiesForFilter = CITIES.length ? buildTargetCities(CITIES) : null;
    console.log(`  [1/2] 성과 점수 수집 (도시: ${citiesForFilter ? CITIES.join(',') : '전체'})...`);
    const scores = await collectScores(citiesForFilter, perfData, rotationState);
    const topIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HOTELS)
      .map(([id]) => id);
    allowedIds = new Set(topIds);
    console.log(`  상위 ${topIds.length}개 호텔 선택됨 (점수 기준)`);
    console.log('  [2/2] subset 추출...');

  } else {
    // city mode (default)
    targetCities = buildTargetCities(CITIES);
    console.log(`  도시   : ${CITIES.join(', ')} → 정규화: ${[...targetCities].join(', ')}`);
  }

  // ── 추출 패스 ─────────────────────────────────────────────────────────────
  const stats = await extractPass(targetCities, allowedIds, rotationState);
  process.stdout.write('\n');

  const { totalRead, totalWritten, seenIds, usedIds } = stats;

  // Rotation state 업데이트
  if (COOLDOWN_DAYS > 0 && usedIds.size > 0) {
    saveRotationState(rotationState, usedIds);
    console.log(`  Rotation: ${usedIds.size}개 호텔 기록 완료 (${ROTATION_PATH.replace(ROOT + path.sep, '')})`);
  }

  // 리포트 생성
  const reportPath = generateReport(stats, EXTRACT_MODE, inputSizeMB);
  console.log(`  리포트: ${path.relative(ROOT, reportPath)}`);

  const outStat = fs.statSync(OUTPUT_CSV);
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
    if (EXTRACT_MODE === 'city') {
      console.warn(`  → HOTELDATA_CITIES="${CITIES.join(',')}" 와 실제 CSV 도시 값을 비교하세요`);
      console.warn(`  → 한국어 도시명 예: "서울특별시", "서울 (경기)", "Seoul / 서울"`);
      console.warn(`  → 소량 확인: head -3 ${path.relative(ROOT, INPUT_CSV)}`);
    } else if (EXTRACT_MODE === 'global') {
      console.warn(`  → CSV city 컬럼은 감지됐지만 데이터 행이 없습니다`);
    } else {
      console.warn(`  → state/kpi/hotel-performance.json 과 호텔 ID를 확인하세요`);
      console.warn(`  → HOTELDATA_CITIES 도 함께 확인 (performance 모드에서 도시 필터 적용됨)`);
    }
    process.exit(1);
  }
}

// ── exports (테스트용) ────────────────────────────────────────────────────────
if (require.main === module) {
  main().catch(err => {
    console.error(`\n실패: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { normalizeCity, cityAliases, cityMatches, buildTargetCities, scoreHotel };
