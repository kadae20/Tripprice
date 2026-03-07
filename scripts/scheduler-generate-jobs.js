#!/usr/bin/env node
/**
 * scheduler-generate-jobs.js
 * 매일 실행할 콘텐츠 작업 목록(daily-jobs.json)을 자동 생성.
 *
 * 전략:
 *   신규 (NEW_COUNT=20):  content_priority=high → normal 순, 미발행 호텔
 *   리프레시 (REF_COUNT=30): 발행된 글 중 오래된 것 + 클릭 낮은 것 우선
 *
 * 사용법:
 *   node scripts/scheduler-generate-jobs.js
 *   node scripts/scheduler-generate-jobs.js --new=20 --refresh=30 --dry-run
 *   node scripts/scheduler-generate-jobs.js --out=config/daily-jobs.json
 *
 * 입력:
 *   data/hotels/*.csv      — 호텔 DB
 *   state/campaigns/       — 발행 이력 (*-published.json)
 *   downloads/agoda/*/kpi.json — 월간 KPI (있으면 클릭 참고)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const NEW_COUNT = Math.min(parseInt(args.new     || '20', 10), 50);
const REF_COUNT = Math.min(parseInt(args.refresh || '30', 10), 50);
const DRY_RUN   = args['dry-run'] === true;
const OUT_PATH  = path.resolve(ROOT, args.out || 'config/daily-jobs.json');
const today     = new Date().toISOString().split('T')[0];

// ── CSV 파서 (경량, 의존성 없음) ─────────────────────────────────────────────
function parseCsvRow(line) {
  const cells = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQ = !inQ; }
    } else if (c === ',' && !inQ) { cells.push(cur); cur = ''; }
    else { cur += c; }
  }
  cells.push(cur);
  return cells.map(s => s.trim().replace(/^"|"$/g, ''));
}

function readCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = parseCsvRow(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCsvRow(line);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] || '']));
  });
}

// ── 호텔 DB 로드 ─────────────────────────────────────────────────────────────
function loadAllHotels() {
  const hotelDir = path.join(ROOT, 'data', 'hotels');
  if (!fs.existsSync(hotelDir)) return [];
  return fs.readdirSync(hotelDir)
    .filter(f => f.endsWith('.csv') && f !== 'sample-hotels.csv')
    .flatMap(f => readCsv(path.join(hotelDir, f)));
}

// ── 발행 이력 로드 ────────────────────────────────────────────────────────────
function loadPublishedHistory() {
  const dir = path.join(ROOT, 'state', 'campaigns');
  if (!fs.existsSync(dir)) return {};
  const map = {};  // slug → { published_at, source_file }
  fs.readdirSync(dir)
    .filter(f => f.endsWith('-published.json'))
    .forEach(f => {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (rec.slug) map[rec.slug] = rec;
      } catch {}
    });
  return map;
}

// ── 클릭 데이터 (Agoda KPI, 최근 3개월 합산) ─────────────────────────────────
// 현재는 집계 단위만 있어 슬러그별 클릭 없음 → 발행일 기반 우선순위 폴백
function loadRecentKpiClicks() {
  const dlDir = path.join(ROOT, 'downloads', 'agoda');
  if (!fs.existsSync(dlDir)) return {};
  // 클릭 데이터가 슬러그별로 없으므로 빈 맵 반환 (향후 확장 포인트)
  return {};
}

// ── 호텔 그룹화 (multi-hotel 비교 vs 단독) ───────────────────────────────────
// content_priority=high 호텔들을 city 기준으로 묶어 비교 작업 생성
function groupHotelsByCity(hotels) {
  const byCity = {};
  for (const h of hotels) {
    const c = h.city || 'unknown';
    if (!byCity[c]) byCity[c] = [];
    byCity[c].push(h);
  }
  return byCity;
}

// ── 작업 생성 ─────────────────────────────────────────────────────────────────
const priorityOrder = { high: 0, normal: 1, low: 2 };

(async () => {
  const allHotels     = loadAllHotels();
  const publishedMap  = loadPublishedHistory();
  const _kpiClicks    = loadRecentKpiClicks();  // 향후 슬러그별 클릭 데이터

  if (allHotels.length === 0) {
    console.error('오류: 호텔 데이터가 없습니다. data/hotels/*.csv 확인');
    process.exit(1);
  }

  // active 상태만
  const activeHotels = allHotels.filter(h => h.publish_status === 'active');

  // ── 신규 작업 (미발행, priority 순) ─────────────────────────────────────────
  const unpublished = activeHotels
    .filter(h => !publishedMap[h.hotel_id])
    .sort((a, b) => (priorityOrder[a.content_priority] ?? 1) - (priorityOrder[b.content_priority] ?? 1));

  const newJobs = [];
  const byCity  = groupHotelsByCity(unpublished);

  // 같은 city의 high-priority 호텔 2개 이상 → 비교 작업
  for (const [city, cityHotels] of Object.entries(byCity)) {
    if (newJobs.length >= NEW_COUNT) break;
    const highs = cityHotels.filter(h => h.content_priority === 'high');
    if (highs.length >= 2) {
      newJobs.push({
        hotels: highs.slice(0, 3).map(h => h.hotel_id).join(','),
        lang: 'ko',
        note: `${city} 럭셔리 비교 (신규)`,
        type: 'new',
      });
    }
  }

  // 남은 슬롯: 단독 리뷰 (high → normal 순)
  for (const h of unpublished) {
    if (newJobs.length >= NEW_COUNT) break;
    // 이미 비교 작업에 포함된 호텔 제외
    const alreadyInComparison = newJobs.some(j => j.hotels.split(',').includes(h.hotel_id));
    if (alreadyInComparison) continue;
    newJobs.push({
      hotels: h.hotel_id,
      lang:   'ko',
      note:   `${h.hotel_name} 단독 리뷰 (신규)`,
      type:   'new',
    });
  }

  // ── 리프레시 작업 (기발행, 오래된 순) ───────────────────────────────────────
  const published = Object.entries(publishedMap)
    .map(([slug, rec]) => ({ slug, ...rec }))
    .sort((a, b) => {
      // 기준 1: 클릭 낮은 것 우선 (데이터 없으면 0으로 처리)
      const clickA = _kpiClicks[a.slug] || 0;
      const clickB = _kpiClicks[b.slug] || 0;
      if (clickA !== clickB) return clickA - clickB;
      // 기준 2: 오래된 것 우선
      return (a.published_at || '').localeCompare(b.published_at || '');
    });

  const refreshJobs = [];
  for (const rec of published) {
    if (refreshJobs.length >= REF_COUNT) break;
    // source_file에서 hotel_id 추출 (wordpress/drafts/post-{hotel}-{date}.json)
    const srcFile = rec.source_file || '';
    const hotelMatch = srcFile.match(/post-([^-]+-[^-]+(?:-[^-]+)*)-\d{4}-\d{2}-\d{2}\.json/);
    // 슬러그에서 호텔 ID 추출 시도 (slug = hotel-ids-date 형식)
    const slugHotels = (rec.slug || '').split('-').filter((_, i, arr) => i < arr.length - 3);

    if (slugHotels.length === 0) continue;
    refreshJobs.push({
      hotels: slugHotels.join('-'),  // 원래 hotel_id (근사값)
      lang:   'ko',
      note:   `${rec.slug} 리프레시`,
      type:   'refresh',
      original_slug: rec.slug,
    });
  }

  // ── 최종 합산 ─────────────────────────────────────────────────────────────
  const allJobs = [...newJobs, ...refreshJobs];

  // ── 출력 ──────────────────────────────────────────────────────────────────
  console.log(`\n작업 스케줄러 (${today})`);
  console.log(`  총: ${allJobs.length}건  (신규 ${newJobs.length} + 리프레시 ${refreshJobs.length})`);
  console.log(`  호텔 DB: ${allHotels.length}개 (active: ${activeHotels.length}, 미발행: ${unpublished.length})`);
  console.log(`  기발행:  ${Object.keys(publishedMap).length}개`);

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] 생성될 작업:');
    allJobs.forEach((j, i) => console.log(`  [${i + 1}] ${j.type.padEnd(8)} | ${j.hotels} | ${j.note}`));
    console.log('\n  (DRY-RUN: 파일 저장 건너뜀)');
    process.exit(0);
  }

  // config 디렉토리 확인
  const outDir = path.dirname(OUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 저장 (note/type 필드는 newsroom.js에서 무시됨)
  const saveJobs = allJobs.map(({ type, original_slug, ...j }) => j);
  fs.writeFileSync(OUT_PATH, JSON.stringify(saveJobs, null, 2), 'utf8');

  console.log(`\n  저장: ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`\n다음 단계:`);
  console.log(`  node scripts/newsroom.js daily --concurrency=3`);

  if (newJobs.length === 0) {
    console.log('\n  [참고] 미발행 호텔이 없습니다. data/hotels/*.csv에 호텔을 추가하세요.');
  }
})().catch(err => {
  console.error('스케줄러 오류:', err.message);
  process.exit(1);
});
