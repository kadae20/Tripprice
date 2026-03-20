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
 *   node scripts/publish-auto.js --since=2026-03-13 --no-move  (QA+보강 실행, 이동 없음)
 *
 * --dry-run: 어떤 파일도 생성/수정/이동하지 않음. 보강도 스킵. 콘솔 출력만.
 * --no-move: QA + 자동 보강 실행하되 파일 이동(failed/published) 비활성화. 운영 안전 모드.
 * --publish: QA 통과 시 wp-publish.js 실행. 없으면 "queued" 상태로만 출력.
 * 환경변수: WP_URL, WP_USER, WP_APP_PASS (없으면 draft only)
 */
'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');
const { runQA }     = require('./qa-wp-post');

const ROOT           = path.resolve(__dirname, '..');
const DRAFTS_DIR     = path.join(ROOT, 'wordpress', 'drafts');
const PUBLISHED_DIR  = path.join(ROOT, 'wordpress', 'published');
const FAILED_DIR     = path.join(ROOT, 'wordpress', 'failed');
const QUARANTINE_DIR = path.join(ROOT, 'wordpress', 'quarantine');
const LOGS_DIR       = path.join(ROOT, 'logs');
const CAMPAIGNS_DIR  = path.join(ROOT, 'state', 'campaigns');

// ── .env.local 자동 로드 (process.env에 이미 있는 키는 덮어쓰지 않음) ─────────
// 민감정보 값은 절대 로그에 출력하지 않음
;(function loadEnvLocal() {
  for (const fname of ['.env.local', '.env']) {
    const fp = path.join(ROOT, fname);
    try {
      const lines = fs.readFileSync(fp, 'utf8').split('\n');
      let loaded = 0;
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = line.indexOf('=');
        if (eqIdx < 1) continue;
        const key = line.slice(0, eqIdx).trim();
        let val   = line.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key && !(key in process.env)) { process.env[key] = val; loaded++; }
      }
      if (loaded > 0) console.log(`  [env] ${fname} 로드 완료 (신규 ${loaded}개 키 적용)`);
      break;
    } catch { /* 파일 없으면 다음 시도 */ }
  }
}());

// ── "발행 불가" hotel_id 목록 (state/campaigns/ 기반) ─────────────────────────
function getBlockedHotelIds() {
  const blocked = new Set();
  if (!fs.existsSync(CAMPAIGNS_DIR)) return blocked;
  const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(CAMPAIGNS_DIR, f), 'utf8');
      if (!raw.includes('현재 발행 불가')) continue;
      const j = JSON.parse(raw);
      if (j.hotel_id) blocked.add(j.hotel_id);
    } catch { /* skip */ }
  }
  return blocked;
}

// ── draft에서 hotel_id 추출 ────────────────────────────────────────────────────
function extractHotelId(draftFile) {
  try {
    const d = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
    return String(d.hotel_id || d.slug || '').trim();
  } catch { return ''; }
}

// ── resolveHotelImages 실행 (이미지 사전 확보, 실패해도 계속) ──────────────────
function runResolveImages(draftFile) {
  const hotelId = extractHotelId(draftFile);
  if (!hotelId) return;
  const resolveScript = path.join(__dirname, 'resolveHotelImages.js');
  if (!fs.existsSync(resolveScript)) return;
  const r = spawnSync(process.execPath,
    [resolveScript, `--hotel-id=${hotelId}`, `--draft=${draftFile}`],
    { encoding: 'utf8', env: process.env, cwd: ROOT, timeout: 35000 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr && r.status !== 0) {
    console.warn(`  ⚠  resolveHotelImages 오류 (계속): ${r.stderr.slice(0, 120)}`);
  }
}

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
    .filter(f => f.startsWith('post-') && f.endsWith('.json') && !f.endsWith('.qa.json'))
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

// ── 발행 시도 횟수 읽기/쓰기 ──────────────────────────────────────────────────
function getPublishAttempts(draftFile) {
  try {
    const d = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
    return (d.workflow_state && d.workflow_state.publish_attempts) || 0;
  } catch { return 0; }
}

function incrementPublishAttempts(draftFile) {
  try {
    const d = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
    if (!d.workflow_state) d.workflow_state = {};
    d.workflow_state.publish_attempts = (d.workflow_state.publish_attempts || 0) + 1;
    d.workflow_state.last_publish_attempt = new Date().toISOString();
    fs.writeFileSync(draftFile, JSON.stringify(d, null, 2), 'utf8');
    return d.workflow_state.publish_attempts;
  } catch { return 0; }
}

// ── 격리(quarantine) 이동 — publish_attempts >= 3 ────────────────────────────
function quarantineDraft(draftFile, reason) {
  fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
  // 격리 전 draft에 메타 기록
  try {
    const d = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
    if (!d.workflow_state) d.workflow_state = {};
    d.workflow_state.quarantine_reason = reason;
    d.workflow_state.quarantine_at     = new Date().toISOString();
    fs.writeFileSync(draftFile, JSON.stringify(d, null, 2), 'utf8');
  } catch { /* 메타 쓰기 실패해도 이동은 진행 */ }
  return moveFile(draftFile, QUARANTINE_DIR);
}

// ── 발행 오류가 featured-media 관련인지 판별 ──────────────────────────────────
function isFeaturedMediaError(stderr) {
  const s = String(stderr || '').toLowerCase();
  return s.includes('featured_media') || s.includes('featured media') ||
         s.includes('attachment') || s.includes('invalid_param') && s.includes('media');
}

// ── QA 결과 저장 ──────────────────────────────────────────────────────────────
function saveQAResult(qaResult, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const base = path.basename(qaResult.draftFile).replace('.json', '.qa.json');
  const dest = path.join(destDir, base);
  fs.writeFileSync(dest, JSON.stringify({ ...qaResult, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  return dest;
}

// ── 발행 로그 저장 (logs/publish-auto-YYYY-MM-DD.json) ────────────────────────
function savePublishLog(records) {
  if (!records.length) return;
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const date = new Date().toISOString().split('T')[0];
    const logPath = path.join(LOGS_DIR, `publish-auto-${date}.json`);
    let existing = [];
    if (fs.existsSync(logPath)) {
      try { existing = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch { existing = []; }
      if (!Array.isArray(existing)) existing = [existing];
    }
    existing.push(...records);
    fs.writeFileSync(logPath, JSON.stringify(existing, null, 2), 'utf8');
  } catch (e) {
    console.error(`  ⚠  로그 저장 실패: ${e.message}`);
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
function main() {
  const args       = parseArgs();
  const dryRun     = !!args['dry-run'];
  const noMove     = !!args['no-move'];   // QA + 보강 실행, 파일 이동만 비활성화
  const publish    = !!args['publish'];
  const wpOk       = hasWpEnv();
  const maxPublish = parseInt(args['max-publish'] || '3', 10);
  const blocked    = getBlockedHotelIds();

  console.log('\n══════════════════════════════════════════════');
  console.log('  publish-auto — 자동 QA → 발행');
  console.log('══════════════════════════════════════════════');
  if (dryRun)        console.log('  모드: DRY-RUN (파일 조작 없음, 보강 스킵)');
  else if (noMove)   console.log('  모드: NO-MOVE (QA+보강 실행, 파일 이동 없음)');
  else if (!publish) console.log('  모드: QA 전용 (발행하려면 --publish 추가)');
  if (!dryRun && !noMove && !wpOk) console.log('  ⚠  WP 환경변수 없음 → draft only (발행 스킵)');
  console.log('');

  const files = getDraftFiles(args);
  if (files.length === 0) {
    console.log(`  wordpress/drafts/ 에 post-*.json 없음`);
    if (args.match)  console.log(`  (--match=${args.match} 필터 적용됨)`);
    if (args.since)  console.log(`  (--since=${args.since} 필터 적용됨)`);
    return;
  }

  console.log(`  대상 파일: ${files.length}개\n`);

  const summary = { total: files.length, qaPass: 0, qaFail: 0, queued: 0, published: 0, skipped: 0, errors: 0, patched: 0, repass: 0, patchSkipped: 0, limitReached: 0, blockedQuarantined: 0 };
  const failReasons = {};  // QA 실패 원인 유형별 집계
  const logRecords  = [];  // 발행 로그 (logs/publish-auto-DATE.json에 저장)
  const trackReasons = (errors) => errors.forEach(e => {
    const k = e.split(':')[0].trim();
    failReasons[k] = (failReasons[k] || 0) + 1;
  });

  for (const draftFile of files) {
    const rel = path.relative(ROOT, draftFile);
    let wasPatched = false;
    console.log(`────────────────────────────────────────────`);
    console.log(`  📄 ${path.basename(draftFile)}`);

    // ── blocked 호텔 2중 방어: 발행 단계에서도 차단 ──────────────────────────
    const hotelIdForBlock = extractHotelId(draftFile);
    if (hotelIdForBlock && blocked.has(hotelIdForBlock)) {
      summary.blockedQuarantined++;
      if (!dryRun && !noMove) {
        const qDest = quarantineDraft(draftFile, 'blocked_hotel');
        console.log(`  🚫 blocked 호텔 → 격리(quarantine): ${path.relative(ROOT, qDest)}`);
        logRecords.push({ draftFile: path.basename(draftFile), event: 'blocked_quarantine', hotelId: hotelIdForBlock, quarantined: true, quarantine_reason: 'blocked_hotel', quarantine_at: new Date().toISOString(), savedAt: new Date().toISOString() });
      } else {
        console.log(`  ⛔ blocked 호텔 — 건너뜀 (${dryRun ? 'dry-run' : 'no-move'})`);
      }
      console.log('');
      continue;
    }

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
        summary.patchSkipped++;
        summary.qaFail++;
        trackReasons(qa.errors);
        let lastPatched = null;
        try { lastPatched = JSON.parse(fs.readFileSync(draftFile, 'utf8')).workflow_state?.last_patched || null; } catch { /* ignore */ }
        logRecords.push({ draftFile: path.basename(draftFile), patchSkipped: true, patchCount, lastPatched, qaErrors: qa.errors.slice(0, 5), published: false, savedAt: new Date().toISOString() });
        if (!noMove) {
          const savedQA = saveQAResult({ ...qa, patchLimitReached: true }, FAILED_DIR);
          console.log(`  → 보강 한도 초과 (patch_count=${patchCount}) → ${path.relative(ROOT, savedQA)}`);
        } else {
          console.log(`  → 보강 한도 초과 (patch_count=${patchCount}) [NO-MOVE: 기록 스킵]`);
        }
        console.log('');
        continue;
      }

      // ── 자동 보강 후 재시도 (1회) ────────────────────────────────────────
      console.log(`  → 자동 보강 시도 (patch-draft-minimums, patch_count=${patchCount})...`);
      const patchOk = runPatch(draftFile);
      if (patchOk) {
        summary.patched++;
        wasPatched = true;
        const qa2 = runQA(rel);
        console.log(`  재QA: ${qa2.pass ? '✅ PASS' : '❌ FAIL'}  SEO ${qa2.seoScore}/100`);
        if (qa2.errors.length > 0) qa2.errors.forEach(e => console.log(`     ✗ ${e}`));
        if (qa2.warnings.length > 0) qa2.warnings.forEach(w => console.log(`     ⚠ ${w}`));

        if (qa2.pass) {
          summary.repass++;
          // 재시도 PASS → 아래 PASS 분기로 진행
          Object.assign(qa, qa2);
        } else {
          // 재시도에서도 FAIL
          summary.qaFail++;
          trackReasons(qa2.errors);
          logRecords.push({ draftFile: path.basename(draftFile), patched: true, qaErrors: qa2.errors.slice(0, 5), published: false, savedAt: new Date().toISOString() });
          if (!noMove) {
            const savedQA = saveQAResult(qa2, FAILED_DIR);
            console.log(`  → 보강 후에도 FAIL → ${path.relative(ROOT, savedQA)}`);
          } else {
            console.log(`  → 보강 후에도 FAIL [NO-MOVE: failed/ 기록 스킵]`);
          }
          console.log('');
          continue;
        }
      } else {
        // 패치 자체가 실패(변경 없음 포함)
        summary.qaFail++;
        trackReasons(qa.errors);
        logRecords.push({ draftFile: path.basename(draftFile), patched: false, patchFailed: true, qaErrors: qa.errors.slice(0, 5), published: false, savedAt: new Date().toISOString() });
        if (!noMove) {
          const savedQA = saveQAResult(qa, FAILED_DIR);
          console.log(`  → QA 실패 기록: ${path.relative(ROOT, savedQA)}`);
        } else {
          console.log(`  → QA 실패 (보강 없음) [NO-MOVE: failed/ 기록 스킵]`);
        }
        console.log('');
        continue;
      }
    }

    summary.qaPass++;

    // ── dry-run / no-move: 이동 없이 종료 ──────────────────────────────────
    if (dryRun) {
      console.log(`  → DRY-RUN: QA 통과 (파일 조작 없음)`);
      console.log('');
      continue;
    }
    if (noMove) {
      summary.queued++;
      console.log(`  → QA 통과 [NO-MOVE: 이동 없음, queued]`);
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

    // ── 일일 발행 한도 확인 ─────────────────────────────────────────────────
    if (summary.published >= maxPublish) {
      summary.queued++;
      summary.limitReached++;
      console.log(`  → 일일 발행 한도 도달 (max-publish=${maxPublish}) → queued`);
      console.log('');
      continue;
    }

    // ── wp-publish 실행 (publish_attempts 추적 + featured-media 오류 시 1회 재시도) ──
    console.log(`  → wp-publish.js 실행 중... (${summary.published + 1}/${maxPublish})`);
    const attempts0 = incrementPublishAttempts(draftFile);
    let pub = runWpPublish(draftFile);

    // featured-media 관련 오류이면 이미지 확보 → patch → 1회 재시도
    if (!pub.ok && isFeaturedMediaError(pub.stderr + pub.stdout)) {
      console.log(`  ⚠  featured-media 오류 감지 — 이미지 확보 → patch → 재시도...`);
      runResolveImages(draftFile);
      runPatch(draftFile);
      const attempts1 = incrementPublishAttempts(draftFile);
      pub = runWpPublish(draftFile);
      if (!pub.ok) {
        console.log(`  ❌ 재시도 실패 (publish_attempts=${attempts1})`);
      } else {
        console.log(`  ✅ 재시도 성공 (publish_attempts=${attempts1})`);
      }
    }

    if (pub.ok) {
      summary.published++;
      const dest = moveFile(draftFile, PUBLISHED_DIR);
      console.log(`  ✅ 발행 성공 → ${path.relative(ROOT, dest)}`);
      logRecords.push({ draftFile: path.basename(draftFile), patched: wasPatched, seoScore: qa.seoScore, published: true, wpSummary: pub.stdout.slice(0, 200).trim() || null, savedAt: new Date().toISOString() });
    } else {
      summary.errors++;
      // publish_attempts >= 3 이면 quarantine으로 이동
      const finalAttempts = getPublishAttempts(draftFile);
      if (finalAttempts >= 3) {
        const quarantineReason = 'publish_failed';
        const qDest = quarantineDraft(draftFile, quarantineReason);
        console.log(`  🚫 격리(quarantine) 이동 (publish_attempts=${finalAttempts}) → ${path.relative(ROOT, qDest)}`);
        logRecords.push({ draftFile: path.basename(draftFile), patched: wasPatched, seoScore: qa.seoScore, published: false, quarantined: true, publish_attempts: finalAttempts, quarantine_reason: quarantineReason.slice(0, 300), savedAt: new Date().toISOString() });
      } else {
        const failResult = { ...qa, publishError: pub.stderr.slice(0, 500), publish_attempts: finalAttempts, publishedAt: new Date().toISOString() };
        const savedQA = saveQAResult(failResult, FAILED_DIR);
        console.log(`  ❌ 발행 실패 (publish_attempts=${finalAttempts}) → ${path.relative(ROOT, savedQA)}`);
        if (pub.stderr) console.log(`     ${pub.stderr.slice(0, 200)}`);
        logRecords.push({ draftFile: path.basename(draftFile), patched: wasPatched, seoScore: qa.seoScore, published: false, publish_attempts: finalAttempts, wpError: pub.stderr.slice(0, 300).trim() || null, savedAt: new Date().toISOString() });
      }
    }
    console.log('');
  }

  // ── 요약 ──────────────────────────────────────────────────────────────────
  console.log('══════════════════════════════════════════════');
  console.log(`  완료: 총 ${summary.total}개`);
  console.log(`    QA 통과: ${summary.qaPass} | QA 실패: ${summary.qaFail}`);
  if (!dryRun) {
    if (summary.blockedQuarantined > 0) {
      console.log(`    blocked 격리: ${summary.blockedQuarantined}건 (quarantine_reason=blocked_hotel)`);
    }
    if (summary.patched > 0 || summary.patchSkipped > 0) {
      console.log(`    자동 보강: ${summary.patched}건 시도 | 보강 후 PASS: ${summary.repass}건 | 한도초과 스킵: ${summary.patchSkipped}건`);
    }
    if (summary.qaFail > 0 && Object.keys(failReasons).length > 0) {
      const top3 = Object.entries(failReasons).sort((a, b) => b[1] - a[1]).slice(0, 3);
      console.log(`    QA 실패 원인 TOP3: ${top3.map(([k, v]) => `${k}(${v}건)`).join(' | ')}`);
    }
    if (noMove) {
      console.log(`    NO-MOVE: queued ${summary.queued}건 (파일 이동 없음)`);
    } else if (publish) {
      console.log(`    발행 성공: ${summary.published} | WP 스킵: ${summary.skipped} | 발행 오류: ${summary.errors}`);
      if (summary.limitReached > 0) console.log(`    한도 초과 queued: ${summary.limitReached}건 (max-publish=${maxPublish})`);
    } else {
      console.log(`    발행 준비됨(queued): ${summary.queued} (발행하려면 --publish 추가)`);
    }
  }
  console.log('══════════════════════════════════════════════\n');
  savePublishLog(logRecords);
}

if (require.main === module) main();
