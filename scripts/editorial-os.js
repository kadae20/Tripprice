#!/usr/bin/env node
/**
 * editorial-os.js
 *
 * 편집국 OS — 한 번의 명령으로 "발행 대상 선정 → pipeline → QA → publish(조건부)"
 *
 * 사용법:
 *   node scripts/editorial-os.js
 *   node scripts/editorial-os.js --hotels=ibis-myeongdong,shilla-stay-mapo
 *   node scripts/editorial-os.js --limit=5 --lang=ko --html --publish
 *
 * 옵션:
 *   --hotels=a,b,c  호텔 slug 직접 지정 (미지정 시 data/processed/ 자동 선정)
 *   --limit=N       자동 선정 시 최대 개수 (기본: 5)
 *   --min-score=N   자동 선정 시 최소 coverage score (기본: 60)
 *   --lang=ko       pipeline으로 전달 (기본: ko)
 *   --html          pipeline으로 전달
 *   --publish       publish-auto 실행 (기본: QA까지만)
 *                   WP 환경변수 없으면 자동으로 draft only
 *   --dry-run       pipeline 없이 선정 결과만 출력
 *
 * 발행 대상 선정 기준:
 *   1) state/campaigns/에서 "현재 발행 불가" hotel_id 제외
 *   2) data/processed/*.json에서 coverage_score >= min-score인 호텔
 *   3) --limit 개수 내로 추림
 */
'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const ROOT          = path.resolve(__dirname, '..');
const PROCESSED_DIR = path.join(ROOT, 'data', 'processed');
const CAMPAIGNS_DIR = path.join(ROOT, 'state', 'campaigns');
const DRAFTS_DIR    = path.join(ROOT, 'wordpress', 'drafts');
const LOGS_DIR      = path.join(ROOT, 'logs');

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const raw = process.argv.slice(2);
  const obj = {};
  for (const a of raw) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      obj[k] = v === undefined ? true : v;
    }
  }
  return {
    hotels:   obj.hotels   ? obj.hotels.split(',').map(h => h.trim()).filter(Boolean) : null,
    limit:    parseInt(obj.limit    || '5',  10),
    minScore: parseInt(obj['min-score'] || '60', 10),
    lang:     obj.lang     || 'ko',
    html:     !!obj.html,
    publish:  !!obj.publish,
    dryRun:   !!(obj['dry-run'] || obj['dryrun']),  // --dry-run 또는 --dryrun 모두 허용
    auto:     !!obj.auto,
    since:      obj.since      || null,
    match:      obj.match      || null,
    maxPublish: parseInt(obj['max-publish'] || '3', 10),
  };
}

// ── "발행 불가" hotel_id 수집 ─────────────────────────────────────────────────
function getBlockedHotelIds() {
  const blocked = new Set();
  if (!fs.existsSync(CAMPAIGNS_DIR)) return blocked;

  const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(CAMPAIGNS_DIR, f), 'utf8');
      if (!raw.includes('현재 발행 불가')) continue; // 텍스트 미포함 파일은 스킵
      const j = JSON.parse(raw);
      if (j.hotel_id) blocked.add(j.hotel_id);
    } catch { /* 파싱 실패는 무시 */ }
  }
  return blocked;
}

// ── --auto: wordpress/drafts/ 의 오늘 post-*.json 선별 ───────────────────────
function selectFromDrafts(sinceDate) {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  const since = sinceDate ? new Date(sinceDate).getTime() : Date.now() - 86400000; // 기본: 24h
  return fs.readdirSync(DRAFTS_DIR)
    .filter(f => f.startsWith('post-') && f.endsWith('.json') && !f.endsWith('.qa.json'))
    .filter(f => {
      try { return fs.statSync(path.join(DRAFTS_DIR, f)).mtimeMs >= since; } catch { return false; }
    })
    .map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8'));
        return { id: j.slug || f.replace('post-', '').replace('.json', ''), score: j.coverage_score || 0, name: j.post_title || '', draftFile: f };
      } catch { return null; }
    })
    .filter(Boolean);
}

// ── --auto: state/campaigns/ 에서 grade A/B 호텔 추출 ─────────────────────────
function selectFromCampaigns(blocked, limit) {
  if (!fs.existsSync(CAMPAIGNS_DIR)) return [];
  const results = [];
  const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, f), 'utf8'));
      const grade = j.grade || j.coverage_grade || '';
      if ((grade === 'A' || grade === 'B') && j.hotel_id && !blocked.has(j.hotel_id)) {
        results.push({ id: j.hotel_id, score: j.coverage_score || 0, name: j.hotel_name || '' });
      }
    } catch { /* skip */ }
  }
  // 중복 제거 후 score 내림차순
  const seen = new Set();
  return results
    .filter(h => { if (seen.has(h.id)) return false; seen.add(h.id); return true; })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── 자동 호텔 선정 ────────────────────────────────────────────────────────────
function selectHotels(limit, minScore, blocked) {
  if (!fs.existsSync(PROCESSED_DIR)) return [];

  const candidates = fs.readdirSync(PROCESSED_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, f), 'utf8'));
        return { id: j.hotel_id, score: j.coverage_score || 0, name: j.hotel_name || '' };
      } catch { return null; }
    })
    .filter(h => h && h.id && h.score >= minScore && !blocked.has(h.id))
    .sort((a, b) => b.score - a.score) // 점수 높은 순
    .slice(0, limit);

  return candidates;
}

// ── 로그 리포트 저장 ──────────────────────────────────────────────────────────
function saveLog(data) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    const logPath = path.join(LOGS_DIR, `editorial-os-${date}.json`);
    // 기존 파일 있으면 배열로 append
    let existing = [];
    if (fs.existsSync(logPath)) {
      try { existing = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { existing = []; }
      if (!Array.isArray(existing)) existing = [existing];
    }
    existing.push({ ...data, savedAt: new Date().toISOString() });
    fs.writeFileSync(logPath, JSON.stringify(existing, null, 2), 'utf8');
    return logPath;
  } catch (e) {
    console.error(`  ⚠  로그 저장 실패: ${e.message}`);
    return null;
  }
}

// ── 스크립트 실행 헬퍼 ────────────────────────────────────────────────────────
function runScript(scriptName, extraArgs = []) {
  const scriptPath = path.join(__dirname, scriptName);
  const result = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    stdio: 'inherit',
    env:   process.env,
    cwd:   ROOT,
  });
  return result.status === 0;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs();
  const startedAt = new Date().toISOString();

  console.log('\n══════════════════════════════════════════════');
  console.log('  Tripprice 편집국 OS');
  console.log('══════════════════════════════════════════════\n');

  // ── 1) 발행 불가 목록 ───────────────────────────────────────────────────────
  const blocked = getBlockedHotelIds();
  if (blocked.size > 0) {
    const preview = [...blocked].slice(0, 20).join(', ');
    const ellipsis = blocked.size > 20 ? ` … (총 ${blocked.size}개)` : '';
    console.log(`  발행 불가 제외 목록: 총 ${blocked.size}개`);
    console.log(`  예시(최대 20개): ${preview}${ellipsis}`);
  }

  // ── 2) 호텔 선정 ───────────────────────────────────────────────────────────
  let hotels;
  let selectionMode;
  let skipPipeline = false;

  if (args.hotels) {
    // 수동 지정
    const blockedInList = args.hotels.filter(h => blocked.has(h));
    if (blockedInList.length > 0) {
      console.log(`  ⚠  발행 불가 hotel_id가 --hotels에 포함됨: ${blockedInList.join(', ')}`);
      console.log(`     계속 진행하려면 이대로 두세요. 제외하려면 --hotels에서 빼세요.\n`);
    }
    hotels = args.hotels.map(id => ({ id, score: '?', name: '' }));
    selectionMode = 'manual';
    console.log(`  선정 방식: 수동 지정 (${hotels.length}개)`);

  } else if (args.auto) {
    // --auto: (a) 오늘 drafts 우선 → (b) campaigns grade A/B → (c) processed by score
    const sinceDate = args.since || new Date().toISOString().split('T')[0];
    const draftsToday = selectFromDrafts(sinceDate);

    if (draftsToday.length > 0) {
      // 이미 draft가 있음 → pipeline 생략, publish-auto만 실행
      hotels = draftsToday;
      selectionMode = 'auto-from-drafts';
      skipPipeline = true;
      console.log(`  선정 방식: 자동 — 기존 drafts (${sinceDate} 이후, ${hotels.length}개)`);
      hotels.forEach(h => console.log(`    • ${h.draftFile || h.id}${h.name ? ' — ' + h.name : ''}`));
    } else {
      // drafts 없음 → campaigns → processed 순
      let campaignHotels = selectFromCampaigns(blocked, args.limit);
      if (campaignHotels.length > 0) {
        hotels = campaignHotels;
        selectionMode = 'auto-from-campaigns';
        console.log(`  선정 방식: 자동 — campaigns grade A/B (${hotels.length}개)`);
      } else {
        const selected = selectHotels(args.limit, args.minScore, blocked);
        if (selected.length === 0) {
          console.log(`  ❌ 발행 가능 호텔 없음 (coverage_score >= ${args.minScore}, 발행불가 제외)`);
          console.log(`     → data/processed/ 확인 또는 --min-score 낮추기\n`);
          process.exit(0);
        }
        hotels = selected;
        selectionMode = 'auto-from-processed';
        console.log(`  선정 방식: 자동 — processed (score >= ${args.minScore}, 상위 ${args.limit}개)`);
      }
      console.log(`\n  대상 호텔 (${hotels.length}개):`);
      hotels.forEach(h => console.log(`    • ${h.id}${h.name ? ' — ' + h.name : ''}${h.score !== '?' ? ' (' + h.score + '점)' : ''}`));
    }

  } else {
    // 기존 동작: processed에서 자동 선정
    const selected = selectHotels(args.limit, args.minScore, blocked);
    if (selected.length === 0) {
      console.log(`  ❌ 발행 가능 호텔 없음 (coverage_score >= ${args.minScore}, 발행불가 제외)`);
      console.log(`     → data/processed/ 확인 또는 --min-score 낮추기\n`);
      process.exit(0);
    }
    hotels = selected;
    selectionMode = 'auto-from-processed';
    console.log(`  선정 방식: 자동 (score >= ${args.minScore}, 상위 ${args.limit}개)`);
    console.log(`\n  대상 호텔 (${hotels.length}개):`);
    hotels.forEach(h => console.log(`    • ${h.id}${h.name ? ' — ' + h.name : ''}${h.score !== '?' ? ' (' + h.score + '점)' : ''}`));
  }

  // ── dry-run: 여기서 종료 ────────────────────────────────────────────────────
  if (args.dryRun) {
    console.log('\n  DRY-RUN: pipeline/publish 없이 종료.\n');
    return;
  }

  // ── 로그 데이터 준비 ────────────────────────────────────────────────────────
  const logData = {
    startedAt,
    selectionMode,
    hotels: hotels.map(h => ({ id: h.id, score: h.score, name: h.name })),
    args: { lang: args.lang, html: args.html, publish: args.publish, auto: args.auto, since: args.since, match: args.match },
    blockedList: [...blocked],   // 전체 목록은 로그에만 기록
    pipelineSkipped: skipPipeline,
    pipelineOk: null,
    publishAutoRan: false,
    error: null,
  };

  // ── 3) pipeline 실행 (skip 가능) ───────────────────────────────────────────
  let pipelineOk = true;
  if (!skipPipeline) {
    const slugList = hotels.map(h => h.id).join(',');
    const pipelineArgs = [`--hotels=${slugList}`, `--lang=${args.lang}`];
    if (args.html) pipelineArgs.push('--html');

    console.log(`\n──────────────────────────────────────────────`);
    console.log(`  STEP 1/2: pipeline`);
    console.log(`  node scripts/pipeline.js ${pipelineArgs.join(' ')}`);
    console.log(`──────────────────────────────────────────────\n`);

    pipelineOk = runScript('pipeline.js', pipelineArgs);
    logData.pipelineOk = pipelineOk;

    if (!pipelineOk) {
      console.error('\n  ❌ pipeline 실패 — publish 중단\n');
      logData.error = 'pipeline failed';
      saveLog(logData);
      process.exit(1);
    }
  } else {
    console.log(`\n  ℹ  pipeline 생략 — 기존 drafts 사용`);
    logData.pipelineOk = null; // skipped
  }

  // ── 4) publish-auto 실행 ────────────────────────────────────────────────────
  if (!args.publish) {
    console.log('\n  ℹ  --publish 미지정 → QA/publish 생략 (draft까지만)');
    console.log('  발행하려면: node scripts/publish-auto.js');
    console.log('  또는 재실행: node scripts/editorial-os.js ... --publish\n');
    saveLog(logData);
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  const publishArgs = [`--since=${args.since || today}`, '--publish', `--max-publish=${args.maxPublish}`];
  if (args.match) publishArgs.push(`--match=${args.match}`);

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  STEP 2/2: publish-auto`);
  console.log(`  node scripts/publish-auto.js ${publishArgs.join(' ')}`);
  console.log(`──────────────────────────────────────────────\n`);

  try {
    const ok = runScript('publish-auto.js', publishArgs);
    logData.publishAutoRan = true;
    if (!ok) logData.error = 'publish-auto exited non-zero';
  } catch (e) {
    logData.error = `publish-auto exception: ${e.message}`;
    console.error(`\n  ❌ publish-auto 예외: ${e.message}\n`);
  }
  saveLog(logData);

  console.log('\n══════════════════════════════════════════════');
  console.log('  편집국 OS 완료');
  console.log('══════════════════════════════════════════════\n');
}

if (require.main === module) main();
