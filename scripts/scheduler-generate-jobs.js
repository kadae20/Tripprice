#!/usr/bin/env node
/**
 * scheduler-generate-jobs.js
 * 매일 실행할 콘텐츠 작업 목록(daily-jobs.json)을 자동 생성.
 *
 * 핵심 변경사항 (OOM 대응):
 *   tripprice-hotels.csv 를 통째로 로드하지 않고 readline 스트리밍으로 처리.
 *   SCHED_CANDIDATE_POOL 상한에 달하면 즉시 스트림을 닫아 메모리를 보호한다.
 *
 * 후보 선정 조건 (모두 충족해야 함):
 *   1. publish_status = active (또는 필드 없음)
 *   2. data/processed/{hotel_id}.json 존재
 *   3. state/coverage/{hotel_id}.json 있으면 coverage_score >= 60
 *   4. 미발행 (state/campaigns/*-published.json 에 없음)
 *   5. JOB_COOLDOWN_DAYS 쿨다운 기간 미포함
 *
 * 사용법:
 *   node scripts/scheduler-generate-jobs.js
 *   node scripts/scheduler-generate-jobs.js --dry-run
 *   node scripts/scheduler-generate-jobs.js --out=config/daily-jobs.json
 *
 * 환경변수:
 *   DAILY_JOB_COUNT      — 신규 작업 수 (기본 50, 최대 200)
 *   SCHED_CANDIDATE_POOL — 후보 풀 상한 (기본 20000)
 *   JOB_COOLDOWN_DAYS    — rotation 쿨다운 일수 (기본 14)
 *
 * 쿨다운 자동 완화:
 *   후보 수 < DAILY_JOB_COUNT/2 이면 쿨다운을 절반으로 줄여 재스트리밍.
 *   완화 여부와 완화된 쿨다운 일수는 로그에 기록됨.
 */

'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const rotation = require('./rotation');

const ROOT = path.join(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const DAILY_JOB_COUNT = Math.min(
  parseInt(process.env.DAILY_JOB_COUNT || args.new || '50', 10), 200
);
const REF_COUNT = Math.min(
  parseInt(args.refresh || '10', 10), 50
);
const CANDIDATE_POOL = Math.min(
  parseInt(process.env.SCHED_CANDIDATE_POOL || '20000', 10), 100000
);
const DRY_RUN  = args['dry-run'] === true;
const OUT_PATH = path.resolve(ROOT, args.out || 'config/daily-jobs.json');
const today    = new Date().toISOString().split('T')[0];

// ── 경로 상수 ─────────────────────────────────────────────────────────────────
const TRIPPRICE_CSV  = path.join(ROOT, 'data', 'hotels', 'tripprice-hotels.csv');
const PROCESSED_DIR  = path.join(ROOT, 'data', 'processed');
const COVERAGE_DIR   = path.join(ROOT, 'state', 'coverage');
const PLAYBOOK_PATH  = path.join(ROOT, 'config', 'editorial-playbook.json');
const KPI_PATH       = path.join(ROOT, 'state', 'kpi', 'hotel-performance.json');

// ── editorial-playbook 로드 ───────────────────────────────────────────────────
function loadPlaybook() {
  if (!fs.existsSync(PLAYBOOK_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(PLAYBOOK_PATH, 'utf8')); }
  catch { return null; }
}

// post_type 가중 랜덤 선택 (playbook scheduling_weight 기준)
function pickPostType(playbook) {
  if (!playbook || !playbook.post_types) return 'hotel-comparison';
  const types   = Object.entries(playbook.post_types);
  const total   = types.reduce((s, [, t]) => s + (t.scheduling_weight || 0), 0);
  if (total <= 0) return 'hotel-comparison';
  let r = Math.random() * total;
  for (const [name, t] of types) {
    r -= (t.scheduling_weight || 0);
    if (r <= 0) return name;
  }
  return types[types.length - 1][0];
}

// post_type에 맞는 호텔 수 결정
function hotelCountForType(postType, playbook, availableCount) {
  const def = playbook?.post_types?.[postType];
  if (!def) return Math.min(2, availableCount);
  const min = def.min_hotels || 1;
  const max = def.max_hotels || 3;
  const n   = min + Math.floor(Math.random() * (max - min + 1));
  return Math.min(n, availableCount);
}

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

// ── 발행 이력 로드 ────────────────────────────────────────────────────────────
function loadPublishedHistory() {
  const dir = path.join(ROOT, 'state', 'campaigns');
  if (!fs.existsSync(dir)) return {};
  const map = {};
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

// ── KPI 클릭 데이터 (state/kpi/hotel-performance.json) ───────────────────────
function loadRecentKpiClicks() {
  if (!fs.existsSync(KPI_PATH)) return {};
  try {
    const perf   = JSON.parse(fs.readFileSync(KPI_PATH, 'utf8'));
    const clicks = {};
    for (const [key, val] of Object.entries(perf)) {
      // combo: 키 제외, 단일 hotel_id만 clicks에 포함
      if (!key.startsWith('combo:')) clicks[key] = val.clicks || 0;
    }
    return clicks;
  } catch { return {}; }
}

// ── 점수 계산 ─────────────────────────────────────────────────────────────────
function scoreHotel(h, kpiClicks = {}) {
  let score = 0;
  const star        = parseFloat(h.star_rating || h.stars || '0') || 0;
  const reviewScore = parseFloat(h.review_score || h.rating || '0') || 0;
  const reviewCount = parseInt(h.review_count  || h.num_reviews || '0', 10) || 0;
  const photoCount  = parseInt(h.photo_count   || '0', 10) || 0;
  const priority    = h.content_priority || 'normal';
  const priceLevel  = h.price_level || '';

  score += star * 5;
  score += reviewScore * 3;
  score += reviewCount > 0 ? Math.log10(reviewCount) * 5 : 0;
  score += photoCount >= 5 ? 10 : 0;
  score += priority === 'high' ? 20 : priority === 'low' ? -10 : 0;
  score += priceLevel === 'luxury' ? 5 : 0;
  score += (kpiClicks[h.hotel_id] || 0) * 2;

  return Math.max(0.01, score);
}

// ── 가중 랜덤 샘플링 (비복원) ─────────────────────────────────────────────────
function weightedRandom(pool, scores, n) {
  const result          = [];
  const remaining       = pool.slice();
  const remainingScores = scores.slice();

  while (result.length < n && remaining.length > 0) {
    const total = remainingScores.reduce((s, v) => s + v, 0);
    let r   = Math.random() * total;
    let idx = remaining.length - 1;
    for (let i = 0; i < remainingScores.length; i++) {
      r -= remainingScores[i];
      if (r <= 0) { idx = i; break; }
    }
    result.push(remaining[idx]);
    remaining.splice(idx, 1);
    remainingScores.splice(idx, 1);
  }

  return result;
}

// ── tripprice-hotels.csv 스트리밍 후보 로드 ──────────────────────────────────
// readline 스트리밍: CANDIDATE_POOL 개 채워지면 즉시 스트림 종료 (OOM 방지).
// 각 행에서 필터 5개를 인라인 적용 — 통과한 것만 candidates 배열에 추가.
// cooldownDaysOverride: 쿨다운 완화 시 기본값 대신 이 값을 사용
async function streamCandidateHotels(publishedMap, rotState, cooldownDaysOverride) {
  if (!fs.existsSync(TRIPPRICE_CSV)) return [];

  return new Promise((resolve, reject) => {
    const candidates = [];
    const seen       = new Set();   // hotel_id 중복 제거
    let   headers    = null;
    let   lineNum    = 0;
    let   done       = false;

    const rl = readline.createInterface({
      input:     fs.createReadStream(TRIPPRICE_CSV),
      crlfDelay: Infinity,
    });

    rl.on('line', line => {
      if (done || !line.trim()) return;
      lineNum++;

      // 첫 줄 = 헤더
      if (lineNum === 1) {
        headers = parseCsvRow(line).map(h => h.toLowerCase().trim());
        return;
      }

      // 풀 상한 도달 → 스트림 즉시 닫기
      if (candidates.length >= CANDIDATE_POOL) {
        done = true;
        rl.close();
        return;
      }

      const vals = parseCsvRow(line);
      const h    = {};
      if (headers) headers.forEach((k, i) => { h[k] = (vals[i] || '').trim(); });

      const hotelId = h.hotel_id;
      if (!hotelId || seen.has(hotelId)) return;
      seen.add(hotelId);

      // [1] active 상태 (필드 없으면 통과)
      if (h.publish_status && h.publish_status !== 'active') return;

      // [2] data/processed/{hotel_id}.json 필수
      if (!fs.existsSync(path.join(PROCESSED_DIR, `${hotelId}.json`))) return;

      // [3] coverage_score >= 60 (파일 없으면 통과)
      const covPath = path.join(COVERAGE_DIR, `${hotelId}.json`);
      if (fs.existsSync(covPath)) {
        try {
          const cov   = JSON.parse(fs.readFileSync(covPath, 'utf8'));
          const score = cov.coverage_score ?? cov.score ?? 100;
          if (score < 60) return;
        } catch {}
      }

      // [4] 미발행
      if (publishedMap[hotelId]) return;

      // [5] 쿨다운 아님 (override 있으면 직접 계산)
      if (cooldownDaysOverride !== undefined) {
        const e = rotState[rotation.comboKey([hotelId])];
        if (cooldownDaysOverride > 0 && e && e.last_used_at) {
          const elapsed = (Date.now() - new Date(e.last_used_at).getTime()) / 86400000;
          if (elapsed < cooldownDaysOverride) return;
        }
      } else if (rotation.isOnCooldown(rotation.comboKey([hotelId]), rotState)) return;

      candidates.push(h);
    });

    rl.on('close', () => resolve(candidates));
    rl.on('error', reject);
  });
}

// ── 후보 0개일 때 원인 진단 ───────────────────────────────────────────────────
function diagnoseCandidateZero(publishedCount, rotState) {
  console.error('\n  후보 0개 — 원인 진단:');

  if (!fs.existsSync(TRIPPRICE_CSV)) {
    console.error('    ✗ tripprice-hotels.csv 없음');
    console.error('      → npm run hoteldata:sync 실행 필요');
    return;
  }

  const processedCount = fs.existsSync(PROCESSED_DIR)
    ? fs.readdirSync(PROCESSED_DIR).filter(f => f.endsWith('.json')).length
    : 0;
  console.error(`    data/processed/*.json : ${processedCount}개`);

  if (processedCount === 0) {
    console.error('    ✗ 처리된 호텔 없음');
    console.error('      → npm run hoteldata:ingest 실행 필요');
    return;
  }

  const covFiles = fs.existsSync(COVERAGE_DIR)
    ? fs.readdirSync(COVERAGE_DIR).filter(f => f.endsWith('.json')).length
    : 0;
  if (covFiles > 0) {
    console.error(`    coverage 파일 ${covFiles}개 — coverage_score < 60 으로 전부 제외됐을 수 있음`);
    console.error('      → state/coverage/*.json 확인');
  }

  console.error(`    기발행              : ${publishedCount}개`);
  console.error(`    쿨다운(${rotation.COOLDOWN_DAYS}일)          : JOB_COOLDOWN_DAYS=0 으로 임시 우회 가능`);
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  // state/rotation/rotation.json 없으면 자동 생성
  const rotDir = path.join(ROOT, 'state', 'rotation');
  if (!fs.existsSync(rotDir)) fs.mkdirSync(rotDir, { recursive: true });
  const rotJsonPath = path.join(rotDir, 'rotation.json');
  if (!fs.existsSync(rotJsonPath)) {
    fs.writeFileSync(rotJsonPath, '{}', 'utf8');
    console.log('  state/rotation/rotation.json 자동 생성');
  }

  const publishedMap = loadPublishedHistory();
  const kpiClicks    = loadRecentKpiClicks();
  const rotState     = rotation.load();
  const playbook     = loadPlaybook();

  console.log(`\n작업 스케줄러 (${today})`);
  console.log(`  후보 풀 상한  : ${CANDIDATE_POOL}`);
  console.log(`  목표 작업 수  : 신규 ${DAILY_JOB_COUNT} + 리프레시 ${REF_COUNT}`);
  console.log(`  쿨다운        : ${rotation.COOLDOWN_DAYS}일`);
  if (playbook) console.log(`  playbook      : 로드 완료 (${Object.keys(playbook.post_types || {}).length}개 유형)`);
  console.log('  후보 로딩 중 (스트리밍)...');

  let candidates = await streamCandidateHotels(publishedMap, rotState);
  let cooldownRelaxed = false;

  // 쿨다운 자동 완화: 후보 부족 시 쿨다운 절반으로 줄여 재스트리밍
  if (candidates.length < Math.max(DAILY_JOB_COUNT / 2, 1) && rotation.COOLDOWN_DAYS > 0) {
    const relaxedDays = Math.floor(rotation.COOLDOWN_DAYS / 2);
    console.log(`  ⚠  후보 ${candidates.length}개 — 쿨다운 완화 ${rotation.COOLDOWN_DAYS}일 → ${relaxedDays}일로 재스트리밍`);
    candidates      = await streamCandidateHotels(publishedMap, rotState, relaxedDays);
    cooldownRelaxed = true;
    console.log(`  (완화 후) 후보: ${candidates.length}개`);
  } else {
    console.log(`  후보          : ${candidates.length}개`);
  }

  if (candidates.length === 0) {
    diagnoseCandidateZero(Object.keys(publishedMap).length, rotState);
    process.exit(1);
  }

  // ── 점수 계산 + 상위 풀에서 가중 랜덤 선택 ────────────────────────────────
  const scored   = candidates.map(h => ({ hotel: h, score: scoreHotel(h, kpiClicks) }));
  scored.sort((a, b) => b.score - a.score);
  const poolSize = Math.min(scored.length, DAILY_JOB_COUNT * 3);
  const topPool  = scored.slice(0, poolSize);

  const selected = weightedRandom(
    topPool.map(p => p.hotel),
    topPool.map(p => p.score),
    poolSize,
  );

  // ── playbook post_type 혼합 선택으로 신규 작업 생성 ────────────────────────
  const newJobs    = [];
  const usedInJob  = new Set();
  const usedCombos = new Set();    // comboKey 중복 방지

  const byCity = {};
  for (const h of selected) {
    const c = h.city || 'unknown';
    if (!byCity[c]) byCity[c] = [];
    byCity[c].push(h);
  }

  // 비교/neighborhood/seasonal/persona 유형: 같은 city에서 복수 호텔
  for (const [city, cityHotels] of Object.entries(byCity)) {
    if (newJobs.length >= DAILY_JOB_COUNT) break;
    const available = cityHotels.filter(h => !usedInJob.has(h.hotel_id));
    if (available.length < 2) continue;

    const postType = pickPostType(playbook);
    const def      = playbook?.post_types?.[postType];
    const needMulti = !def || (def.min_hotels || 1) >= 2;

    if (needMulti) {
      const count    = hotelCountForType(postType, playbook, available.length);
      const pick     = available.slice(0, count);
      if (pick.length < (def?.min_hotels || 2)) continue;
      const comboKey = rotation.comboKey(pick.map(h => h.hotel_id));
      if (usedCombos.has(comboKey)) continue;
      usedCombos.add(comboKey);
      pick.forEach(h => usedInJob.add(h.hotel_id));
      newJobs.push({
        hotels:    pick.map(h => h.hotel_id).join(','),
        lang:      'ko',
        post_type: postType,
        note:      `${city} ${postType} (신규)${cooldownRelaxed ? ' [쿨다운완화]' : ''}`,
        type:      'new',
      });
    }
  }

  // ── 단독 리뷰 (hotel-review 또는 미사용 호텔) ────────────────────────────
  for (const h of selected) {
    if (newJobs.length >= DAILY_JOB_COUNT) break;
    if (usedInJob.has(h.hotel_id)) continue;
    usedInJob.add(h.hotel_id);
    // 단독 유형은 hotel-review 또는 playbook에서 min_hotels=1 인 것
    const soloType = playbook ? (() => {
      const soloTypes = Object.entries(playbook.post_types || {})
        .filter(([, t]) => (t.min_hotels || 1) === 1 && (t.max_hotels || 1) === 1);
      return soloTypes.length > 0 ? soloTypes[Math.floor(Math.random() * soloTypes.length)][0] : 'hotel-review';
    })() : 'hotel-review';
    newJobs.push({
      hotels:    h.hotel_id,
      lang:      'ko',
      post_type: soloType,
      note:      `${h.hotel_name || h.hotel_id} ${soloType} (신규)${cooldownRelaxed ? ' [쿨다운완화]' : ''}`,
      type:      'new',
    });
  }

  // ── 리프레시 작업 (기발행, 오래된 순) ────────────────────────────────────
  const published = Object.entries(publishedMap)
    .map(([slug, rec]) => ({ slug, ...rec }))
    .sort((a, b) => {
      const clickA = kpiClicks[a.slug] || 0;  // 수정: _kpiClicks → kpiClicks
      const clickB = kpiClicks[b.slug] || 0;
      if (clickA !== clickB) return clickA - clickB;
      return (a.published_at || '').localeCompare(b.published_at || '');
    });

  const refreshJobs = [];
  for (const rec of published) {
    if (refreshJobs.length >= REF_COUNT) break;
    const slugHotels = (rec.slug || '').split('-').filter((_, i, arr) => i < arr.length - 3);
    if (slugHotels.length === 0) continue;
    refreshJobs.push({
      hotels:        slugHotels.join('-'),
      lang:          'ko',
      note:          `${rec.slug} 리프레시`,
      type:          'refresh',
      original_slug: rec.slug,
    });
  }

  // ── 최종 합산 ─────────────────────────────────────────────────────────────
  const allJobs = [...newJobs, ...refreshJobs];

  const onCooldown = Object.keys(rotState)
    .filter(k => rotation.isOnCooldown(k, rotState)).length;

  console.log(`  신규: ${newJobs.length} / 리프레시: ${refreshJobs.length} / 총: ${allJobs.length}`);
  console.log(`  기발행: ${Object.keys(publishedMap).length} / 쿨다운 키: ${onCooldown}`);
  if (cooldownRelaxed) console.log(`  ⚠  쿨다운 완화 적용됨 — 기록 유의`);

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] 생성될 작업:');
    allJobs.forEach((j, i) =>
      console.log(`  [${i + 1}] ${(j.type || '').padEnd(8)} | ${j.hotels} | ${j.note || ''}`)
    );
    console.log('\n  (DRY-RUN: 파일 저장 건너뜀)');
    process.exit(0);
  }

  if (allJobs.length === 0) {
    console.warn('\n  ⚠ 생성된 작업 없음 — daily-jobs.json 저장 건너뜀');
    process.exit(1);
  }

  const outDir = path.dirname(OUT_PATH);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // post_type 유지, 내부 필드(type/original_slug)는 제거
  const saveJobs = allJobs.map(({ type, original_slug, ...j }) => j);
  fs.writeFileSync(OUT_PATH, JSON.stringify(saveJobs, null, 2), 'utf8');

  console.log(`\n  저장: ${path.relative(ROOT, OUT_PATH)}`);
  console.log('\n다음 단계:');
  console.log('  node scripts/_run-with-env.js scripts/newsroom.js daily --auto-publish --concurrency=1');
})().catch(err => {
  console.error('스케줄러 오류:', err.message);
  process.exit(1);
});
