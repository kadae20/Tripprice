#!/usr/bin/env node
/**
 * ingest-hotel-data.js
 *
 * 호텔 CSV/JSON 데이터를 적재, 검증, 정규화하고 coverage score를 계산합니다.
 * 외부 패키지 없이 Node.js 내장 모듈만 사용합니다.
 *
 * 사용법:
 *   node scripts/ingest-hotel-data.js [파일경로]
 *   node scripts/ingest-hotel-data.js data/hotels/sample.csv
 *   node scripts/ingest-hotel-data.js data/hotels/hotels.json
 *
 *   파일 경로를 생략하면 data/hotels/ 폴더의 모든 CSV/JSON 파일을 처리합니다.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────
// 경로 설정
// ──────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const DIR_INPUT = path.join(ROOT, 'data', 'hotels');
const DIR_PROCESSED = path.join(ROOT, 'data', 'processed');
const DIR_COVERAGE = path.join(ROOT, 'state', 'coverage');
const DIR_CAMPAIGNS = path.join(ROOT, 'state', 'campaigns');

// ──────────────────────────────────────────────
// 필수 필드 / 선택 필드 정의
// ──────────────────────────────────────────────
const REQUIRED_FIELDS = ['hotel_name', 'city', 'country', 'address'];

// source_url 또는 partner_url 중 하나 필수
const REQUIRED_URL_FIELDS = ['source_url', 'partner_url'];

// Coverage score 항목 (총 100점)
// data-pipeline-quality.md 기준
// key: v2 정규화 필드명. check 함수에서 v1 필드 폴백 처리.
const COVERAGE_CRITERIA = [
  {
    key: 'photos_count',
    label: '사진 ≥ 5장',
    points: 20,
    check: (v) => (parseInt(v, 10) || 0) >= 5,
  },
  {
    key: 'amenities',
    label: '어메니티 ≥ 10개',
    points: 15,
    check: (v) => Array.isArray(v) ? v.length >= 10 : (parseInt(v, 10) || 0) >= 10,
  },
  {
    key: 'location_description',
    label: '위치 설명',
    points: 15,
    check: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  {
    key: 'review_summary',
    label: '후기 요약',
    points: 15,
    check: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  {
    key: 'room_types',
    label: '객실 타입 설명',
    points: 10,
    check: (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0),
  },
  {
    key: 'transport_info',
    label: '교통/동선 정보',
    points: 10,
    check: (v) => typeof v === 'string' && v.trim().length > 0,
  },
  {
    key: 'price_min',
    label: '가격대 정보',
    points: 10,
    check: (v) => v !== null && v !== undefined && String(v).trim().length > 0,
  },
  {
    key: 'checkin_time',
    label: '체크인 정보',
    points: 5,
    check: (v) => typeof v === 'string' && v.trim().length > 0,
  },
];

// ──────────────────────────────────────────────
// CSV 파서 (외부 패키지 없이 구현)
// RFC 4180 기본 지원: 따옴표 필드, 내부 쉼표 처리
// ──────────────────────────────────────────────
function parseCSV(content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const rows = [];

  for (const line of lines) {
    if (line.trim() === '') continue;
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      if (inQuotes) {
        if (ch === '"' && next === '"') {
          current += '"';
          i++; // 이스케이프된 따옴표 건너뜀
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          fields.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    fields.push(current.trim());
    rows.push(fields);
  }

  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const records = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((cell) => cell === '')) continue; // 빈 줄 건너뜀
    const record = {};
    headers.forEach((header, idx) => {
      record[header] = row[idx] !== undefined ? row[idx] : '';
    });
    records.push(record);
  }

  return records;
}

// ──────────────────────────────────────────────
// hotel_id 생성 (hotel_name + city → slug)
// ──────────────────────────────────────────────
function generateHotelId(name, city) {
  const slug = `${name}-${city}`
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60);
  return slug;
}

// ──────────────────────────────────────────────
// 필수 필드 검증
// ──────────────────────────────────────────────
function validateHotel(raw) {
  const errors = [];
  const warnings = [];

  // 필수 필드 존재 여부
  for (const field of REQUIRED_FIELDS) {
    const val = raw[field];
    if (!val || String(val).trim() === '') {
      errors.push(`필수 필드 누락: ${field}`);
    }
  }

  // source_url 또는 partner_url 중 하나 필수
  // agoda_hotel_id가 있으면 partner_url 자동 생성 가능 → 허용
  const hasUrl = REQUIRED_URL_FIELDS.some(
    (f) => raw[f] && String(raw[f]).trim() !== ''
  ) || (raw.agoda_hotel_id && String(raw.agoda_hotel_id).trim() !== '');
  if (!hasUrl) {
    errors.push(`필수 필드 누락: source_url, partner_url, agoda_hotel_id 중 하나 필요`);
  }

  // v1 필드 감지 → 경고 (하위 호환 처리됨)
  if (raw.price_range && String(raw.price_range).trim()) {
    warnings.push('[v1 호환] price_range 감지 → price_min/price_max로 변환');
  }
  if (raw.checkin_info && String(raw.checkin_info).trim()) {
    warnings.push('[v1 호환] checkin_info 감지 → checkin_time/checkout_time으로 변환');
  }
  if (raw.photos && !raw.photos_count) {
    warnings.push('[v1 호환] photos 감지 → photos_count로 변환');
  }

  // 이상값 감지
  const priceMin = raw.price_min || (raw.price_range ? String(raw.price_range).split(/[-~]/)[0] : '');
  if (priceMin && parseFloat(priceMin) === 0) {
    warnings.push('price_min이 0 — 가격 데이터 확인 필요');
  }
  if (raw.hotel_name && raw.hotel_name.length < 2) {
    warnings.push('hotel_name이 너무 짧음');
  }

  return { errors, warnings, isValid: errors.length === 0 };
}

// ──────────────────────────────────────────────
// v1 → v2 필드 하위 호환 파싱 헬퍼
// ──────────────────────────────────────────────

/**
 * v1 price_range ("80000-150000" 또는 "8만~15만") → { price_min, price_max }
 */
function parsePriceRange(priceRange) {
  const str = String(priceRange).replace(/[^\d~\-]/g, '');
  const sep = str.includes('~') ? '~' : '-';
  const parts = str.split(sep);
  return {
    price_min: parts[0] ? parseInt(parts[0], 10) : null,
    price_max: parts[1] ? parseInt(parts[1], 10) : null,
  };
}

/**
 * v1 checkin_info ("15:00 / 12:00" 또는 "체크인 15:00, 체크아웃 12:00") → { checkin_time, checkout_time }
 */
function parseCheckinInfo(checkinInfo) {
  const timeRe = /(\d{1,2}:\d{2})/g;
  const matches = String(checkinInfo).match(timeRe) || [];
  return {
    checkin_time: matches[0] || '',
    checkout_time: matches[1] || '',
  };
}

// ──────────────────────────────────────────────
// 데이터 정규화 (v2 기준, v1 하위 호환 포함)
// ──────────────────────────────────────────────
function normalizeHotel(raw) {
  const hotelId = raw.hotel_id
    ? String(raw.hotel_id).trim()
    : generateHotelId(raw.hotel_name || '', raw.city || '');

  // ── 가격 정보 (v2 우선, v1 폴백) ──────────────
  let priceMin = raw.price_min ? parseInt(raw.price_min, 10) : null;
  let priceMax = raw.price_max ? parseInt(raw.price_max, 10) : null;
  if (!priceMin && raw.price_range && String(raw.price_range).trim()) {
    const parsed = parsePriceRange(raw.price_range);
    priceMin = priceMin || parsed.price_min;
    priceMax = priceMax || parsed.price_max;
  }

  // ── 체크인/아웃 (v2 우선, v1 폴백) ───────────
  let checkinTime = (raw.checkin_time || '').trim();
  let checkoutTime = (raw.checkout_time || '').trim();
  if (!checkinTime && raw.checkin_info && String(raw.checkin_info).trim()) {
    const parsed = parseCheckinInfo(raw.checkin_info);
    checkinTime = parsed.checkin_time;
    checkoutTime = parsed.checkout_time;
  }

  // ── 사진 수 (v2 우선, v1 photos 폴백) ─────────
  let photosCount = raw.photos_count ? parseInt(raw.photos_count, 10) : null;
  if (!photosCount && raw.photos) {
    const p = raw.photos;
    if (typeof p === 'number') photosCount = p;
    else if (typeof p === 'string' && !isNaN(parseInt(p, 10))) photosCount = parseInt(p, 10);
    else if (Array.isArray(p)) photosCount = p.length;
  }
  photosCount = photosCount || 0;

  // ── amenities: 파이프 구분 문자열 또는 배열 ───
  let amenities = raw.amenities || [];
  if (typeof amenities === 'string') {
    amenities = amenities.split('|').map((s) => s.trim()).filter(Boolean);
  }

  // ── room_types: 파이프 구분 문자열 처리 ────────
  let roomTypes = raw.room_types || '';
  if (typeof roomTypes === 'string' && roomTypes.trim()) {
    roomTypes = roomTypes.split('|').map((s) => s.trim()).filter(Boolean);
  }

  // ── partner_url: agoda_hotel_id로 자동 생성 ───
  const agodaId = (raw.agoda_hotel_id || '').trim();
  const utmCampaign = (raw.utm_campaign || hotelId).trim();
  let partnerUrl = (raw.partner_url || '').trim();
  if (!partnerUrl && agodaId) {
    partnerUrl = `https://www.agoda.com/hotel/${agodaId}?cid=1922720&tag=${utmCampaign}`;
  }

  return {
    // 기본 식별
    hotel_id: hotelId,
    hotel_name: (raw.hotel_name || '').trim(),
    hotel_name_en: (raw.hotel_name_en || '').trim(),
    city: (raw.city || '').trim().toLowerCase(),
    country: (raw.country || '').trim().toLowerCase(),
    address: (raw.address || '').trim(),
    district: (raw.district || '').trim(),

    // 위치 좌표 및 교통
    latitude: raw.latitude ? parseFloat(raw.latitude) : null,
    longitude: raw.longitude ? parseFloat(raw.longitude) : null,
    nearest_station: (raw.nearest_station || '').trim(),
    station_walk_min: raw.station_walk_min ? parseInt(raw.station_walk_min, 10) : null,

    // 호텔 분류
    star_rating: raw.star_rating ? parseFloat(raw.star_rating) : null,
    hotel_category: (raw.hotel_category || '').trim(),
    target_persona: raw.target_persona
      ? String(raw.target_persona).split('|').map((s) => s.trim()).filter(Boolean)
      : [],

    // 가격
    price_min: priceMin,
    price_max: priceMax,
    currency: (raw.currency || 'KRW').trim(),

    // 체크인/아웃
    checkin_time: checkinTime,
    checkout_time: checkoutTime,

    // 시설
    amenities,
    room_types: roomTypes,

    // 사진
    photos_count: photosCount,
    photo_source: (raw.photo_source || '').trim(),

    // 콘텐츠
    location_description: (raw.location_description || '').trim(),
    transport_info: (raw.transport_info || '').trim(),
    review_summary: (raw.review_summary || '').trim(),
    review_score: raw.review_score ? parseFloat(raw.review_score) : null,
    review_count: raw.review_count ? parseInt(raw.review_count, 10) : null,

    // 제휴
    agoda_hotel_id: agodaId,
    partner_url: partnerUrl,
    utm_campaign: utmCampaign,
    source_url: (raw.source_url || partnerUrl).trim(),

    // 운영
    publish_status: (raw.publish_status || 'pending').trim(),
    content_priority: (raw.content_priority || 'normal').trim(),
    data_source: (raw.data_source || '').trim(),
    data_fetched_at: (raw.data_fetched_at || '').trim(),
    notes: (raw.notes || '').trim(),

    // 적재 메타
    ingested_at: new Date().toISOString(),
    source_file: raw._source_file || '',
  };
}

// ──────────────────────────────────────────────
// Coverage Score 계산
// ──────────────────────────────────────────────
function calculateCoverageScore(normalized) {
  let score = 0;
  const breakdown = {};
  const missing = [];

  for (const criterion of COVERAGE_CRITERIA) {
    const value = normalized[criterion.key];
    const passed = value !== undefined && value !== null && value !== ''
      ? criterion.check(value)
      : false;

    breakdown[criterion.key] = {
      label: criterion.label,
      points: criterion.points,
      earned: passed ? criterion.points : 0,
      passed,
    };

    if (passed) {
      score += criterion.points;
    } else {
      missing.push(criterion.label);
    }
  }

  // 등급 결정
  let grade;
  let action;
  if (score >= 80) {
    grade = 'A';
    action = '단독 리뷰형 글 발행 가능';
  } else if (score >= 60) {
    grade = 'B';
    action = '단독 리뷰형 글 가능 (비교표 카드 병행 권장)';
  } else if (score >= 40) {
    grade = 'C';
    action = '비교표 카드로만 제한, 단독 발행 금지';
  } else {
    grade = 'D';
    action = '콘텐츠 제외 — 데이터 보강 필요 (enrich-missing-data)';
  }

  return { score, grade, action, breakdown, missing };
}

// ──────────────────────────────────────────────
// 파일 저장 헬퍼
// ──────────────────────────────────────────────
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function saveJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ──────────────────────────────────────────────
// 리포트 생성
// ──────────────────────────────────────────────
function generateReport(results, sourceFiles) {
  const date = new Date().toISOString().split('T')[0];
  const total = results.length;
  const success = results.filter((r) => r.status === 'success').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed = total - success - skipped;

  // 누락 필드 집계
  const missingFieldCount = {};
  for (const r of results) {
    for (const err of r.errors || []) {
      missingFieldCount[err] = (missingFieldCount[err] || 0) + 1;
    }
  }

  // Coverage 등급 분포
  const gradeDist = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of results) {
    if (r.coverage) gradeDist[r.coverage.grade]++;
  }

  let md = `# Tripprice 호텔 데이터 적재 리포트\n\n`;
  md += `- 실행 일시: ${new Date().toISOString()}\n`;
  md += `- 처리 파일: ${sourceFiles.join(', ')}\n\n`;

  md += `## 처리 결과 요약\n\n`;
  md += `| 항목 | 수 |\n|------|----|\n`;
  md += `| 총 호텔 수 | ${total} |\n`;
  md += `| 성공 | ${success} |\n`;
  md += `| 실패 (필수 필드 누락) | ${failed} |\n`;
  md += `| 건너뜀 (빈 행) | ${skipped} |\n\n`;

  md += `## Coverage Score 등급 분포\n\n`;
  md += `| 등급 | 수 | 기준 |\n|------|----|------|\n`;
  md += `| A (80~100점) | ${gradeDist.A} | 단독 리뷰형 발행 가능 |\n`;
  md += `| B (60~79점) | ${gradeDist.B} | 발행 가능, 보강 권장 |\n`;
  md += `| C (40~59점) | ${gradeDist.C} | 비교표 카드만 허용 |\n`;
  md += `| D (0~39점) | ${gradeDist.D} | 발행 불가, 보강 필요 |\n\n`;

  if (Object.keys(missingFieldCount).length > 0) {
    md += `## 자주 누락된 필드 / 오류\n\n`;
    const sorted = Object.entries(missingFieldCount).sort((a, b) => b[1] - a[1]);
    for (const [msg, count] of sorted) {
      md += `- ${msg}: ${count}건\n`;
    }
    md += '\n';
  }

  if (failed > 0) {
    md += `## 실패 호텔 목록\n\n`;
    for (const r of results.filter((r) => r.status === 'failed')) {
      md += `### ${r.raw_name || '(이름 없음)'}\n`;
      for (const err of r.errors) {
        md += `- ❌ ${err}\n`;
      }
      for (const warn of r.warnings || []) {
        md += `- ⚠️ ${warn}\n`;
      }
      md += '\n';
    }
  }

  const warnings = results.filter(
    (r) => r.status === 'success' && (r.warnings || []).length > 0
  );
  if (warnings.length > 0) {
    md += `## 경고 항목 (성공했지만 주의 필요)\n\n`;
    for (const r of warnings) {
      md += `- **${r.hotel_id}**: ${r.warnings.join(' / ')}\n`;
    }
    md += '\n';
  }

  const lowCoverage = results.filter(
    (r) => r.status === 'success' && r.coverage && r.coverage.grade === 'D'
  );
  if (lowCoverage.length > 0) {
    md += `## 즉시 보강 필요 (D등급)\n\n`;
    for (const r of lowCoverage) {
      md += `- **${r.hotel_id}** (${r.coverage.score}점): 누락 — ${r.coverage.missing.join(', ')}\n`;
    }
    md += '\n';
  }

  md += `---\n*다음 단계: D등급 호텔은 \`enrich-missing-data\` skill 실행 권장*\n`;

  return { md, date };
}

// ──────────────────────────────────────────────
// 단일 파일 처리
// ──────────────────────────────────────────────
function processFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const content = fs.readFileSync(filePath, 'utf8');
  const sourceFile = path.basename(filePath);

  let rawRecords;
  try {
    if (ext === '.json') {
      const parsed = JSON.parse(content);
      rawRecords = Array.isArray(parsed) ? parsed : [parsed];
    } else if (ext === '.csv') {
      rawRecords = parseCSV(content);
    } else {
      throw new Error(`지원하지 않는 파일 형식: ${ext}`);
    }
  } catch (err) {
    console.error(`  [오류] 파일 파싱 실패: ${filePath}\n  → ${err.message}`);
    return [];
  }

  console.log(`  읽기 완료: ${rawRecords.length}개 레코드`);

  const results = [];

  for (const raw of rawRecords) {
    // 완전히 빈 레코드 건너뜀
    const allEmpty = Object.values(raw).every((v) => !v || String(v).trim() === '');
    if (allEmpty) {
      results.push({ status: 'skipped', raw_name: '' });
      continue;
    }

    raw._source_file = sourceFile;
    const rawName = raw.hotel_name || raw.name || '(이름 없음)';

    try {
      // 1) 검증
      const { errors, warnings, isValid } = validateHotel(raw);

      if (!isValid) {
        results.push({
          status: 'failed',
          raw_name: rawName,
          errors,
          warnings,
        });
        console.log(`  ✗ ${rawName}: 필수 필드 오류 — ${errors.join(', ')}`);
        continue;
      }

      // 2) 정규화
      const normalized = normalizeHotel(raw);

      // 3) Coverage score 계산
      const coverage = calculateCoverageScore(normalized);

      // 4) data/processed/{hotel_id}.json 저장
      const processedPath = path.join(DIR_PROCESSED, `${normalized.hotel_id}.json`);
      saveJSON(processedPath, { ...normalized, coverage_score: coverage.score });

      // 5) state/coverage/{hotel_id}.json 저장
      const coveragePath = path.join(DIR_COVERAGE, `${normalized.hotel_id}.json`);
      saveJSON(coveragePath, {
        hotel_id: normalized.hotel_id,
        hotel_name: normalized.hotel_name,
        score: coverage.score,
        grade: coverage.grade,
        action: coverage.action,
        missing: coverage.missing,
        breakdown: coverage.breakdown,
        updated_at: new Date().toISOString(),
      });

      const gradeIcon = { A: '✓', B: '✓', C: '⚠', D: '✗' }[coverage.grade];
      console.log(
        `  ${gradeIcon} ${normalized.hotel_id} — ${coverage.score}점 (${coverage.grade}등급)` +
        (warnings.length > 0 ? ` ⚠ ${warnings.join(', ')}` : '')
      );

      results.push({
        status: 'success',
        hotel_id: normalized.hotel_id,
        coverage,
        warnings,
        errors: [],
      });
    } catch (err) {
      results.push({
        status: 'failed',
        raw_name: rawName,
        errors: [`처리 중 예외 발생: ${err.message}`],
        warnings: [],
      });
      console.log(`  ✗ ${rawName}: 예외 — ${err.message}`);
    }
  }

  return results;
}

// ──────────────────────────────────────────────
// 메인 실행
// ──────────────────────────────────────────────
function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' Tripprice — 호텔 데이터 적재');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  ensureDir(DIR_PROCESSED);
  ensureDir(DIR_COVERAGE);
  ensureDir(DIR_CAMPAIGNS);

  // 처리할 파일 목록 결정
  const arg = process.argv[2];
  let filesToProcess = [];

  if (arg) {
    const resolved = path.resolve(ROOT, arg);
    if (!fs.existsSync(resolved)) {
      console.error(`[오류] 파일을 찾을 수 없음: ${resolved}`);
      process.exit(1);
    }
    filesToProcess = [resolved];
  } else {
    // data/hotels/ 폴더의 모든 CSV/JSON 파일
    if (!fs.existsSync(DIR_INPUT)) {
      console.error(`[오류] 입력 폴더 없음: ${DIR_INPUT}`);
      process.exit(1);
    }
    filesToProcess = fs
      .readdirSync(DIR_INPUT)
      .filter((f) => /\.(csv|json)$/i.test(f))
      .map((f) => path.join(DIR_INPUT, f));

    if (filesToProcess.length === 0) {
      console.log(`입력 파일 없음: ${DIR_INPUT}\n`);
      console.log('사용법: node scripts/ingest-hotel-data.js [파일경로]');
      process.exit(0);
    }
  }

  // 파일별 처리
  const allResults = [];
  const sourceFiles = [];

  for (const filePath of filesToProcess) {
    console.log(`\n파일 처리 중: ${path.relative(ROOT, filePath)}`);
    const results = processFile(filePath);
    allResults.push(...results);
    sourceFiles.push(path.basename(filePath));
  }

  // 리포트 생성
  const { md, date } = generateReport(allResults, sourceFiles);
  const reportPath = path.join(DIR_CAMPAIGNS, `ingest-report-${date}.md`);
  fs.writeFileSync(reportPath, md, 'utf8');

  // 최종 요약 출력
  const success = allResults.filter((r) => r.status === 'success').length;
  const failed = allResults.filter((r) => r.status === 'failed').length;
  const skipped = allResults.filter((r) => r.status === 'skipped').length;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` 완료: 총 ${allResults.length}건 | 성공 ${success} | 실패 ${failed} | 건너뜀 ${skipped}`);
  console.log(` 리포트: ${path.relative(ROOT, reportPath)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (failed > 0) {
    process.exit(1); // 실패 있으면 비정상 종료 코드 (CI 감지용)
  }
}

main();
