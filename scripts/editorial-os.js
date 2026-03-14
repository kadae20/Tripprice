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
    dryRun:   !!obj['dry-run'],
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

  console.log('\n══════════════════════════════════════════════');
  console.log('  Tripprice 편집국 OS');
  console.log('══════════════════════════════════════════════\n');

  // ── 1) 발행 불가 목록 ───────────────────────────────────────────────────────
  const blocked = getBlockedHotelIds();
  if (blocked.size > 0) {
    console.log(`  발행 불가 제외 목록 (${blocked.size}개): ${[...blocked].join(', ')}`);
  }

  // ── 2) 호텔 선정 ───────────────────────────────────────────────────────────
  let hotels;
  if (args.hotels) {
    // 명시된 경우: 발행 불가 목록에서도 경고만 하고 사용자 의도 존중
    const blockedInList = args.hotels.filter(h => blocked.has(h));
    if (blockedInList.length > 0) {
      console.log(`  ⚠  발행 불가 hotel_id가 --hotels에 포함됨: ${blockedInList.join(', ')}`);
      console.log(`     계속 진행하려면 이대로 두세요. 제외하려면 --hotels에서 빼세요.\n`);
    }
    hotels = args.hotels.map(id => ({ id, score: '?', name: '' }));
    console.log(`  선정 방식: 수동 지정 (${hotels.length}개)`);
  } else {
    const selected = selectHotels(args.limit, args.minScore, blocked);
    if (selected.length === 0) {
      console.log(`  ❌ 발행 가능 호텔 없음 (coverage_score >= ${args.minScore}, 발행불가 제외)`);
      console.log(`     → data/processed/ 확인 또는 --min-score 낮추기\n`);
      process.exit(0);
    }
    hotels = selected;
    console.log(`  선정 방식: 자동 (score >= ${args.minScore}, 상위 ${args.limit}개)`);
  }

  console.log(`\n  대상 호텔 (${hotels.length}개):`);
  hotels.forEach(h => console.log(`    • ${h.id}${h.name ? ' — ' + h.name : ''}${h.score !== '?' ? ' (' + h.score + '점)' : ''}`));

  // ── dry-run: 여기서 종료 ────────────────────────────────────────────────────
  if (args.dryRun) {
    console.log('\n  DRY-RUN: pipeline/publish 없이 종료.\n');
    return;
  }

  // ── 3) pipeline 실행 ───────────────────────────────────────────────────────
  const slugList = hotels.map(h => h.id).join(',');
  const pipelineArgs = [`--hotels=${slugList}`, `--lang=${args.lang}`];
  if (args.html) pipelineArgs.push('--html');

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  STEP 1/2: pipeline`);
  console.log(`  node scripts/pipeline.js ${pipelineArgs.join(' ')}`);
  console.log(`──────────────────────────────────────────────\n`);

  const pipelineOk = runScript('pipeline.js', pipelineArgs);
  if (!pipelineOk) {
    console.error('\n  ❌ pipeline 실패 — publish 중단\n');
    process.exit(1);
  }

  // ── 4) publish-auto 실행 (--publish 시) ───────────────────────────────────
  if (!args.publish) {
    console.log('\n  ℹ  --publish 미지정 → QA/publish 생략 (draft까지만)');
    console.log('  발행하려면: node scripts/publish-auto.js');
    console.log('  또는 재실행: node scripts/editorial-os.js ... --publish\n');
    return;
  }

  const publishArgs = [];
  // 방금 만든 파일만 타겟팅: --match로 오늘 날짜 or 호텔 slug 첫 번째
  const today = new Date().toISOString().split('T')[0];
  publishArgs.push(`--since=${today}`);
  publishArgs.push('--publish'); // editorial-os에서 --publish를 전달받은 경우에만 여기까지 오므로 항상 포함

  console.log(`\n──────────────────────────────────────────────`);
  console.log(`  STEP 2/2: publish-auto`);
  console.log(`  node scripts/publish-auto.js ${publishArgs.join(' ')}`);
  console.log(`──────────────────────────────────────────────\n`);

  runScript('publish-auto.js', publishArgs);

  console.log('\n══════════════════════════════════════════════');
  console.log('  편집국 OS 완료');
  console.log('══════════════════════════════════════════════\n');
}

if (require.main === module) main();
