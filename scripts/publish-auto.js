#!/usr/bin/env node
/**
 * publish-auto.js
 *
 * wordpress/drafts/ 의 post-*.json을 스캔해:
 *   1) QA 실행 → 실패 시 wordpress/failed/에 qa 결과 저장, draft 유지
 *   2) QA 통과 시:
 *      - WP 환경변수(WP_URL, WP_USER, WP_APP_PASS) 있으면 wp-publish.js 실행
 *      - 성공 시 wordpress/published/로 이동
 *      - WP env 없으면 "draft only" 경고 후 건너뜀
 *
 * 사용법:
 *   node scripts/publish-auto.js --dry-run                (파일 조작 없이 QA 결과만 출력)
 *   node scripts/publish-auto.js                          (QA만, 발행은 --publish 필요)
 *   node scripts/publish-auto.js --publish                (QA 통과 시 WP 발행)
 *   node scripts/publish-auto.js --publish --match=ibis   (파일명 부분 일치 필터)
 *   node scripts/publish-auto.js --publish --since=2026-03-13  (날짜 이후 파일만)
 *
 * --dry-run: 어떤 파일도 생성/수정/이동하지 않음. 콘솔 출력만.
 * --publish: QA 통과 시 wp-publish.js 실행. 없으면 "queued" 상태로만 출력.
 * 환경변수: WP_URL, WP_USER, WP_APP_PASS (없으면 draft only)
 */
'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');
const { runQA }     = require('./qa-wp-post');

const ROOT         = path.resolve(__dirname, '..');
const DRAFTS_DIR   = path.join(ROOT, 'wordpress', 'drafts');
const PUBLISHED_DIR = path.join(ROOT, 'wordpress', 'published');
const FAILED_DIR   = path.join(ROOT, 'wordpress', 'failed');

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
  return obj;
}

// ── WP 환경변수 확인 ──────────────────────────────────────────────────────────
function hasWpEnv() {
  return !!(process.env.WP_URL && process.env.WP_USER && process.env.WP_APP_PASS);
}

// ── draft 파일 목록 필터링 ────────────────────────────────────────────────────
function getDraftFiles(args) {
  if (!fs.existsSync(DRAFTS_DIR)) return [];

  let files = fs.readdirSync(DRAFTS_DIR)
    .filter(f => f.startsWith('post-') && f.endsWith('.json'))
    .sort();

  // --match: 파일명 부분 일치
  if (args.match) {
    files = files.filter(f => f.includes(args.match));
  }

  // --since: YYYY-MM-DD 이후 수정된 파일
  if (args.since) {
    const sinceMs = new Date(args.since).getTime();
    files = files.filter(f => {
      const stat = fs.statSync(path.join(DRAFTS_DIR, f));
      return stat.mtimeMs >= sinceMs;
    });
  }

  return files.map(f => path.join(DRAFTS_DIR, f));
}

// ── draft의 patch_count 읽기 ─────────────────────────────────────────────────
function getDraftPatchCount(draftFile) {
  try {
    const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
    return (draft.workflow_state && draft.workflow_state.patch_count) || 0;
  } catch { return 0; }
}

// ── patch-draft-minimums.js 실행 (보강) ──────────────────────────────────────
function runPatch(draftFile) {
  const patchScript = path.join(__dirname, 'patch-draft-minimums.js');
  const result = spawnSync(process.execPath, [patchScript, draftFile], {
    encoding: 'utf8',
    env: process.env,
    cwd: ROOT,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  return result.status === 0;
}

// ── wp-publish.js 실행 ────────────────────────────────────────────────────────
function runWpPublish(draftFile) {
  const publishScript = path.join(__dirname, 'wp-publish.js');
  const result = spawnSync(process.execPath, [publishScript, draftFile], {
    encoding: 'utf8',
    env: process.env,
    cwd: ROOT,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// ── 파일 이동 ─────────────────────────────────────────────────────────────────
function moveFile(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(src));
  fs.renameSync(src, dest);
  return dest;
}

// ── QA 결과 저장 ──────────────────────────────────────────────────────────────
function saveQAResult(qaResult, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(qaResult.draftFile).replace('.json', '.qa.json');
  const dest = path.join(destDir, base);
  fs.writeFileSync(dest, JSON.stringify({ ...qaResult, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  return dest;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
function main() {
  const args    = parseArgs();
  const dryRun  = !!args['dry-run'];
  const publish = !!args['publish'];
  const wpOk    = hasWpEnv();

  console.log('\n══════════════════════════════════════════════');
  console.log('  publish-auto — 자동 QA → 발행');
  console.log('══════════════════════════════════════════════');
  if (dryRun)        console.log('  모드: DRY-RUN (파일 조작 없음, 콘솔 출력만)');
  else if (!publish) console.log('  모드: QA 전용 (발행하려면 --publish 추가)');
  if (!dryRun && !wpOk) console.log('  ⚠  WP 환경변수 없음 → draft only (발행 스킵)');
  console.log('');

  const files = getDraftFiles(args);
  if (files.length === 0) {
    console.log(`  wordpress/drafts/ 에 post-*.json 없음`);
    if (args.match)  console.log(`  (--match=${args.match} 필터 적용됨)`);
    if (args.since)  console.log(`  (--since=${args.since} 필터 적용됨)`);
    return;
  }

  console.log(`  대상 파일: ${files.length}개\n`);

  const summary = { total: files.length, qaPass: 0, qaFail: 0, queued: 0, published: 0, skipped: 0, errors: 0, patched: 0, repass: 0 };

  for (const draftFile of files) {
    const rel = path.relative(ROOT, draftFile);
    console.log(`────────────────────────────────────────────`);
    console.log(`  📄 ${path.basename(draftFile)}`);

    // ── QA 실행 ────────────────────────────────────────────────────────────
    const qa = runQA(rel);
    console.log(`  QA: ${qa.pass ? '✅ PASS' : '❌ FAIL'}  SEO ${qa.seoScore}/100`);
    if (qa.errors.length > 0) {
      qa.errors.forEach(e => console.log(`     ✗ ${e}`));
    }
    if (qa.warnings.length > 0) {
      qa.warnings.forEach(w => console.log(`     ⚠ ${w}`));
    }

    if (!qa.pass) {
      if (dryRun) {
        // dry-run: 보강 없이 FAIL 출력만
        summary.qaFail++;
        console.log(`  → DRY-RUN: QA 실패 (파일 기록 없음)`);
        console.log('');
        continue;
      }

      // ── patch_count 한도 확인 (최대 2회) ──────────────────────────────────
      const patchCount = getDraftPatchCount(draftFile);
      if (patchCount >= 2) {
        summary.qaFail++;
        const savedQA = saveQAResult({ ...qa, patchLimitReached: true }, FAILED_DIR);
        console.log(`  → 보강 한도 초과 (patch_count=${patchCount}) → ${path.relative(ROOT, savedQA)}`);
        console.log('');
        continue;
      }

      // ── 자동 보강 후 재시도 (1회) ────────────────────────────────────────
      console.log(`  → 자동 보강 시도 (patch-draft-minimums, patch_count=${patchCount})...`);
      const patchOk = runPatch(draftFile);
      if (patchOk) {
        summary.patched++;
        const qa2 = runQA(rel);
        console.log(`  재QA: ${qa2.pass ? '✅ PASS' : '❌ FAIL'}  SEO ${qa2.seoScore}/100`);
        if (qa2.errors.length > 0) qa2.errors.forEach(e => console.log(`     ✗ ${e}`));
        if (qa2.warnings.length > 0) qa2.warnings.forEach(w => console.log(`     ⚠ ${w}`));

        if (qa2.pass) {
          summary.repass++;
          // 재시도 PASS → 아래 PASS 분기로 진행
          Object.assign(qa, qa2);
        } else {
          // 재시도에서도 FAIL → failed/ 기록
          summary.qaFail++;
          const savedQA = saveQAResult(qa2, FAILED_DIR);
          console.log(`  → 보강 후에도 FAIL → ${path.relative(ROOT, savedQA)}`);
          console.log('');
          continue;
        }
      } else {
        // 패치 자체가 실패(변경 없음 포함): 원래 QA 결과로 FAIL 처리
        summary.qaFail++;
        const savedQA = saveQAResult(qa, FAILED_DIR);
        console.log(`  → QA 실패 기록: ${path.relative(ROOT, savedQA)}`);
        console.log('');
        continue;
      }
    }

    summary.qaPass++;

    // ── dry-run: 파일 조작 없이 종료 ─────────────────────────────────────
    if (dryRun) {
      console.log(`  → DRY-RUN: QA 통과 (파일 조작 없음)`);
      console.log('');
      continue;
    }

    // ── --publish 없으면 queued ──────────────────────────────────────────
    if (!publish) {
      summary.queued++;
      console.log(`  → 발행 준비됨 (queued) — 실제 발행은 --publish 옵션 추가`);
      console.log('');
      continue;
    }

    // ── WP env 없으면 스킵 ─────────────────────────────────────────────────
    if (!wpOk) {
      summary.skipped++;
      console.log(`  → WP 환경변수 없음 — draft 유지 (발행 스킵)`);
      console.log('');
      continue;
    }

    // ── wp-publish 실행 ────────────────────────────────────────────────────
    console.log(`  → wp-publish.js 실행 중...`);
    const pub = runWpPublish(draftFile);

    if (pub.ok) {
      summary.published++;
      const dest = moveFile(draftFile, PUBLISHED_DIR);
      console.log(`  ✅ 발행 성공 → ${path.relative(ROOT, dest)}`);
    } else {
      summary.errors++;
      // 발행 실패 시 QA 결과에 publish error도 기록
      const failResult = { ...qa, publishError: pub.stderr.slice(0, 500), publishedAt: new Date().toISOString() };
      const savedQA = saveQAResult(failResult, FAILED_DIR);
      console.log(`  ❌ 발행 실패 → ${path.relative(ROOT, savedQA)}`);
      if (pub.stderr) console.log(`     ${pub.stderr.slice(0, 200)}`);
    }
    console.log('');
  }

  // ── 요약 ──────────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════');
  console.log(`  완료: 총 ${summary.total}개`);
  console.log(`    QA 통과: ${summary.qaPass} | QA 실패: ${summary.qaFail}`);
  if (!dryRun) {
    if (summary.patched > 0) {
      console.log(`    자동 보강: ${summary.patched}건 시도 | 보강 후 PASS: ${summary.repass}건`);
    }
    if (publish) {
      console.log(`    발행 성공: ${summary.published} | WP 스킵: ${summary.skipped} | 발행 오류: ${summary.errors}`);
    } else {
      console.log(`    발행 준비됨(queued): ${summary.queued} (발행하려면 --publish 추가)`);
    }
  }
  console.log('══════════════════════════════════════════════\n');
}

if (require.main === module) main();
