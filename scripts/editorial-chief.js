#!/usr/bin/env node
/**
 * editorial-chief.js — Chief Editor Orchestrator
 *
 * 한 커맨드로 "선정→보강→QA→발행→로그"까지 완료.
 * 부서 호출 순서:
 *   desk-assign → desk-writing → desk-seo → desk-image → QA
 *     → (QA FAIL) auto-patch → 재QA → quarantine
 *     → (QA PASS) WP 발행 or queued
 *
 * Usage:
 *   node scripts/editorial-chief.js --auto --since=YYYY-MM-DD [--publish] [--max-publish=5]
 *   node scripts/editorial-chief.js --auto --dry-run
 *
 * Options:
 *   --auto              자동 선정 (desk-assign 위임)
 *   --since=DATE        DATE 이후 수정된 draft만 대상 (기본: 오늘)
 *   --lang=ko|en|ja     언어 태그 (기본: ko, pipeline 연동용)
 *   --html              HTML 모드 플래그 (pipeline 연동용)
 *   --hotels=a,b        수동 지정 (--auto 대신)
 *   --match=keyword     파일명 키워드 필터
 *   --limit=N           대상 최대 수 (기본 50)
 *   --min-score=N       processed 자동 선정 최소 score (기본 60)
 *   --publish           QA 통과 시 WP 발행
 *   --max-publish=N     하루 최대 발행 수 (기본 5)
 *   --no-move           파일 이동 없이 QA/보강/발행 시뮬레이션 (운영 안전 모드)
 *   --dry-run           파일 조작 없음, 선정·데스크 결과만 출력
 *   --force             락 무시하고 실행
 *   --sleep-ms=NNN      발행 간 딜레이 ms (기본 1500)
 *   --retry-wp=N        WP 발행 재시도 횟수 (기본 3)
 *   --retry-delay-ms=N  재시도 초기 대기 ms, 지수 증가 (기본 2000)
 *
 * 안전장치:
 *   - /tmp/tripprice-editorial.lock : 동시 실행 방지 (PID 생존 확인 + 2h 스테일)
 *   - MAX_DAILY_PROCESS = 50        : 폭주 방지
 *   - rate limit --sleep-ms (기본 1500ms)
 *   - WP 실패 → 재시도 → quarantine (3회 소진 시)
 *   - patch_count >= 2 → quarantine (무한 루프 방지)
 *   - published_wp_id 존재 시 재발행 금지 (멱등성)
 */
'use strict';

const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const { spawnSync } = require('child_process');
const { runQA }     = require('./qa-wp-post');

const ROOT           = path.resolve(__dirname, '..');
const DRAFTS_DIR     = path.join(ROOT, 'wordpress', 'drafts');
const PUBLISHED_DIR  = path.join(ROOT, 'wordpress', 'published');
const QUARANTINE_DIR = path.join(ROOT, 'wordpress', 'quarantine');
const LOGS_DIR       = path.join(ROOT, 'logs');

// 락 파일: /tmp (OS 임시 디렉토리, 프로세스 종료에도 남음)
const LOCK_FILE = path.join(os.tmpdir(), 'tripprice-editorial.lock');

const MAX_DAILY_PROCESS = 50;                  // 폭주 방지 상한
const LOCK_MAX_AGE_MS   = 2 * 60 * 60 * 1000; // 2h 스테일 락 임계치
const PATCH_LIMIT       = 2;                   // auto-patch 최대 횟수

// ── .env 파일 파서 (dotenv 없이, 외부 패키지 0) ──────────────────────────────
// 반환: 로드된 키 수 (파일 없음/읽기 실패 = -1)
// 이미 process.env에 있는 키는 절대 덮어쓰지 않음
function loadEnvFile(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    let loaded = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx < 1) continue;
      const key = line.slice(0, eqIdx).trim();
      let val   = line.slice(eqIdx + 1).trim();
      // 양끝 따옴표 제거 (" 또는 ')
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = val;
        loaded++;
      }
    }
    return loaded;
  } catch { return -1; } // 파일 없음 또는 권한 오류
}

// ── WP 환경변수 자동 로드 (.env.local → .env 우선순위) ───────────────────────
// 이미 WP_URL/WP_USER/WP_APP_PASS 모두 있으면 로드 생략
// 로그: 파일명 + 로드 키 수만 출력 (값 절대 미출력)
// 반환: { source: 'process.env'|'파일명'|'none', count: N }
function loadEnvIfNeeded() {
  if (process.env.WP_URL && process.env.WP_USER && process.env.WP_APP_PASS) {
    return { source: 'process.env', count: 0 };
  }
  for (const fname of ['.env.local', '.env']) {
    const fp = path.join(ROOT, fname);
    const n  = loadEnvFile(fp);
    if (n >= 0) {
      console.log(`  [env] ${fname} 로드 완료 (신규 ${n}개 키 적용)`);
      // 퍼미션 경고 (Unix only) — 경고만, 자동 변경 없음
      if (process.platform !== 'win32') {
        try {
          const mode = fs.statSync(fp).mode & 0o777;
          if (mode !== 0o600) {
            console.warn(`  ⚠  ${fname} permission ${mode.toString(8).padStart(3, '0')} detected. Recommend: chmod 600 ${fname}`);
          }
        } catch { /* skip */ }
      }
      return { source: fname, count: n }; // 첫 번째 존재 파일만 사용 (.env.local 우선)
    }
  }
  return { source: 'none', count: 0 };
}

// ── 민감정보 마스킹 (디버그 출력 전용, 마지막 4자만 노출) ──────────────────
// 예) "abcd-efgh-ijkl" → "****-****-ijkl"
function maskSecret(s) {
  const str = String(s || '');
  if (!str) return '(없음)';
  if (str.length <= 4) return '****';
  return str.slice(0, -4).replace(/\S/g, '*') + str.slice(-4);
}

// ── 동기 sleep ────────────────────────────────────────────────────────────────
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) {} }
}

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const raw = process.argv.slice(2);
  const obj = {};
  for (const a of raw) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k  = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const v  = eq === -1 ? true       : a.slice(eq + 1);
      obj[k] = v;
    }
  }
  return {
    hotels:       obj.hotels  ? String(obj.hotels).split(',').map(h => h.trim()).filter(Boolean) : null,
    limit:        parseInt(obj.limit          || '50',   10),
    minScore:     parseInt(obj['min-score']   || '60',   10),
    lang:         String(obj.lang             || 'ko'),
    html:         !!obj.html,
    publish:      !!obj.publish,
    dryRun:       !!(obj['dry-run'] || obj.dryrun),
    noMove:       !!obj['no-move'],
    force:        !!obj.force,
    since:        obj.since   ? String(obj.since) : new Date().toISOString().split('T')[0],
    match:        obj.match   ? String(obj.match) : null,
    maxPublish:   parseInt(obj['max-publish']     || '5',    10),
    sleepMs:      parseInt(obj['sleep-ms']         || '1500', 10),
    retryWp:      parseInt(obj['retry-wp']         || '3',    10),
    retryDelayMs: parseInt(obj['retry-delay-ms']   || '2000', 10),
  };
}

// ── PID 생존 확인 ─────────────────────────────────────────────────────────────
function isPidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

// ── 락 취득 ────────────────────────────────────────────────────────────────────
function acquireLock(force) {
  if (fs.existsSync(LOCK_FILE)) {
    let isStale = false;
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      const age  = Date.now() - new Date(lock.startedAt).getTime();

      if (lock.pid && !isPidAlive(lock.pid)) {
        console.warn(`  ⚠  락 PID ${lock.pid} 사망 확인 — 스테일 락 자동 해제`);
        isStale = true;
      } else if (age >= LOCK_MAX_AGE_MS) {
        console.warn(`  ⚠  스테일 락 감지 (${Math.round(age / 60000)}분 경과) — 자동 해제`);
        isStale = true;
      }

      if (!isStale) {
        if (force) {
          console.warn(`  ⚠  --force 옵션: 기존 락 무시 (PID ${lock.pid} @ ${lock.hostname})`);
        } else {
          console.error(`\n  ❌ 이미 실행 중 (PID: ${lock.pid} @ ${lock.hostname}, 시작: ${lock.startedAt})`);
          console.error(`  강제 해제: rm ${LOCK_FILE}`);
          console.error(`  또는 --force 옵션으로 실행\n`);
          return false;
        }
      }
    } catch { isStale = true; /* 파싱 실패 = 스테일 */ }

    if (isStale) {
      try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    }
  }

  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    pid:       process.pid,
    hostname:  os.hostname(),
    startedAt: new Date().toISOString(),
  }), 'utf8');
  return true;
}

function releaseLock() {
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ── 로그 저장 (배열 append) ───────────────────────────────────────────────────
function appendLog(logFile, data) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    let arr = [];
    if (fs.existsSync(logFile)) {
      try { arr = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch { arr = []; }
      if (!Array.isArray(arr)) arr = [arr];
    }
    arr.push({ ...data, savedAt: new Date().toISOString() });
    fs.writeFileSync(logFile, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.error(`  ⚠  로그 저장 실패 (${path.basename(logFile)}): ${e.message}`);
  }
}

// ── workflow_state 필드 업데이트 후 파일 저장 ─────────────────────────────────
function updateWorkflowState(draftFile, updates) {
  try {
    if (!fs.existsSync(draftFile)) return;
    const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
    if (!draft.workflow_state) draft.workflow_state = {};
    Object.assign(draft.workflow_state, updates);
    fs.writeFileSync(draftFile, JSON.stringify(draft, null, 2), 'utf8');
  } catch (e) {
    console.warn(`  ⚠  workflow_state 저장 실패: ${e.message}`);
  }
}

// ── desk 스크립트 실행 ────────────────────────────────────────────────────────
function runDesk(scriptName, draftFile, extraArgs = []) {
  const result = spawnSync(process.execPath,
    [path.join(__dirname, scriptName), draftFile, ...extraArgs],
    { encoding: 'utf8', env: process.env, cwd: ROOT });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.status === 0;
}

// ── patch_count 읽기 ──────────────────────────────────────────────────────────
function getPatchCount(draftFile) {
  try {
    const d = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
    return (d.workflow_state && d.workflow_state.patch_count) || 0;
  } catch { return 0; }
}

// ── publish_attempts 읽기 ─────────────────────────────────────────────────────
function getPublishAttempts(draftFile) {
  try {
    const d = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
    return (d.workflow_state && d.workflow_state.publish_attempts) || 0;
  } catch { return 0; }
}

// ── quarantine (격리) ─────────────────────────────────────────────────────────
function quarantineFile(draftFile, noMove, reason) {
  const base    = path.basename(draftFile);
  const nowIso  = new Date().toISOString();

  // workflow_state에 격리 사유 기록 (이동 전에)
  updateWorkflowState(draftFile, { quarantine_reason: reason, quarantine_at: nowIso });

  if (!noMove && fs.existsSync(draftFile)) {
    try {
      fs.mkdirSync(QUARANTINE_DIR, { recursive: true });
      fs.renameSync(draftFile, path.join(QUARANTINE_DIR, base));
      console.log(`  → 격리 완료: wordpress/quarantine/${base}`);
    } catch (e) {
      console.log(`  → 격리 파일이동 실패 (기록만): ${e.message}`);
    }
  } else {
    console.log(`  → 격리${noMove ? ' [NO-MOVE: 이동 없음]' : ''}: ${base}`);
  }
  console.log(`  사유: ${reason}`);
}

// ── WP 발행 stdout에서 post_id 파싱 ──────────────────────────────────────────
function parseWpResult(stdout) {
  // wp-publish.js가 "WP_RESULT_JSON: {...}" 라인을 출력하면 파싱
  const jsonLine = (stdout || '').match(/WP_RESULT_JSON:\s*(\{.+?\})/);
  if (jsonLine) {
    try { return JSON.parse(jsonLine[1]); } catch { /* fallthrough */ }
  }
  // fallback: " post_id  : 123" 라인
  const idLine = (stdout || '').match(/post_id\s*[：:]\s*(\d+)/);
  return idLine ? { post_id: parseInt(idLine[1], 10) } : null;
}

// ── WP 발행 (재시도 + 지수 백오프) ───────────────────────────────────────────
function wpPublishWithRetry(draftFile, args) {
  const maxRetry    = args.retryWp     || 3;
  const baseDelay   = args.retryDelayMs || 2000;
  const publishScript = path.join(__dirname, 'wp-publish.js');

  for (let attempt = 0; attempt < maxRetry; attempt++) {
    if (attempt > 0) {
      const delay = baseDelay * Math.pow(2, attempt - 1); // 2s→4s→8s
      console.log(`  → WP 재시도 ${attempt}/${maxRetry - 1} (${delay / 1000}초 대기)...`);
      sleepSync(delay);
    }
    const result = spawnSync(process.execPath, [publishScript, draftFile], {
      encoding: 'utf8', env: process.env, cwd: ROOT,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.status === 0) {
      return {
        ok:       true,
        stdout:   result.stdout || '',
        stderr:   result.stderr || '',
        attempts: attempt + 1,
        wpResult: parseWpResult(result.stdout || ''),
      };
    }
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return { ok: false, stdout: '', stderr: 'max retries reached', attempts: maxRetry, wpResult: null };
}

// ── desk-assign 실행 → 대상 배열 반환 ─────────────────────────────────────────
function runDeskAssign(args) {
  const assignArgs = [
    `--since=${args.since}`,
    `--limit=${args.limit}`,
    `--min-score=${args.minScore}`,
  ];
  if (args.hotels) assignArgs.push(`--hotels=${args.hotels.join(',')}`);
  if (args.match)  assignArgs.push(`--match=${args.match}`);

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, 'desk-assign.js'), ...assignArgs],
    { encoding: 'utf8', env: process.env, cwd: ROOT }
  );

  if (result.status !== 0 || !String(result.stdout || '').trim()) {
    if (result.stderr) console.error(result.stderr);
    return [];
  }
  try { return JSON.parse(String(result.stdout).trim()); }
  catch (e) { console.error(`  ⚠  desk-assign 파싱 실패: ${e.message}`); return []; }
}

// ── draft 파일 절대경로 해석 ──────────────────────────────────────────────────
function resolveDraftFile(item) {
  if (!item.draftFile) return null;
  const abs = path.isAbsolute(item.draftFile)
    ? item.draftFile
    : path.resolve(ROOT, item.draftFile);
  return fs.existsSync(abs) ? abs : null;
}

// ── 단일 draft 처리 파이프라인 ────────────────────────────────────────────────
function processDraft(draftFile, args, counters, publishLogRecords) {
  const rel      = path.relative(ROOT, draftFile);
  const basename = path.basename(draftFile);
  const itemLog  = {
    draftFile: basename,
    startedAt: new Date().toISOString(),
    steps:     {},
    status:    'processing',
  };

  console.log(`\n  ──────────────────────────────────────────`);
  console.log(`  📄 ${basename}`);

  try {
    // ── 멱등성: published_wp_id 있으면 재발행 금지 ────────────────────────────
    try {
      const existing = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
      const wpId = existing.workflow_state?.published_wp_id;
      if (wpId) {
        console.log(`  → 이미 발행됨 (WP post_id: ${wpId}) — 스킵\n`);
        itemLog.status = 'skipped-already-published';
        itemLog.wpPostId = wpId;
        counters.skipped++;
        return itemLog;
      }
    } catch { /* 파싱 실패 시 계속 진행 */ }

    // ── [1/5] Writing Desk ────────────────────────────────────────────────────
    console.log(`  [1/5] writing desk...`);
    itemLog.steps.writing = runDesk('desk-writing.js', draftFile,
      args.dryRun ? ['--dry-run'] : []);

    // ── [2/5] SEO Desk ───────────────────────────────────────────────────────
    console.log(`  [2/5] seo desk...`);
    itemLog.steps.seo = runDesk('desk-seo.js', draftFile,
      args.dryRun ? ['--dry-run'] : []);

    // ── [3/5] Image Desk ─────────────────────────────────────────────────────
    console.log(`  [3/5] image desk...`);
    itemLog.steps.image = runDesk('desk-image.js', draftFile,
      args.dryRun ? ['--dry-run'] : []);

    // ── [4/5] QA ─────────────────────────────────────────────────────────────
    console.log(`  [4/5] QA...`);
    let qa = runQA(rel);
    console.log(`  QA: ${qa.pass ? '✅ PASS' : '❌ FAIL'}  SEO ${qa.seoScore}/100`);
    if (qa.errors.length   > 0) qa.errors.forEach(e   => console.log(`     ✗ ${e}`));
    if (qa.warnings.length > 0) qa.warnings.forEach(w => console.log(`     ⚠ ${w}`));

    if (!qa.pass) {
      const patchCount = getPatchCount(draftFile);

      // patch 한도 초과 → quarantine
      if (patchCount >= PATCH_LIMIT) {
        qa.errors.forEach(e => {
          const k = e.split(':')[0].trim();
          counters.failReasons[k] = (counters.failReasons[k] || 0) + 1;
        });
        console.log(`  → patch_count=${patchCount} 한도 초과`);
        quarantineFile(draftFile, args.noMove, qa.errors[0] || 'QA 실패 (patch 한도 초과)');
        itemLog.status   = 'quarantined-patch-limit';
        itemLog.qaErrors = qa.errors;
        counters.quarantined++;
        publishLogRecords.push({
          draftFile: basename, patchSkipped: true, patchCount,
          qaErrors: qa.errors.slice(0, 5), published: false, quarantined: true,
          savedAt: new Date().toISOString(),
        });
        return itemLog;
      }

      if (args.dryRun) {
        counters.qaFail++;
        itemLog.status   = 'dry-run-qa-fail';
        itemLog.qaErrors = qa.errors;
        console.log(`  → DRY-RUN: QA 실패 기록\n`);
        return itemLog;
      }

      // auto-patch + 재QA
      console.log(`  [5/5] auto-patch (patch_count=${patchCount})...`);
      runDesk('patch-draft-minimums.js', draftFile);
      counters.patched++;

      const qa2 = runQA(rel);
      console.log(`  재QA: ${qa2.pass ? '✅ PASS' : '❌ FAIL'}  SEO ${qa2.seoScore}/100`);
      if (qa2.errors.length   > 0) qa2.errors.forEach(e   => console.log(`     ✗ ${e}`));
      if (qa2.warnings.length > 0) qa2.warnings.forEach(w => console.log(`     ⚠ ${w}`));

      if (qa2.pass) {
        Object.assign(qa, qa2);
      } else {
        // 재QA도 FAIL → quarantine
        qa2.errors.forEach(e => {
          const k = e.split(':')[0].trim();
          counters.failReasons[k] = (counters.failReasons[k] || 0) + 1;
        });
        quarantineFile(draftFile, args.noMove, qa2.errors[0] || '재QA 실패');
        itemLog.status   = 'quarantined-reqa-fail';
        itemLog.qaErrors = qa2.errors;
        counters.quarantined++;
        publishLogRecords.push({
          draftFile: basename, patched: true, qaErrors: qa2.errors.slice(0, 5),
          published: false, quarantined: true, savedAt: new Date().toISOString(),
        });
        return itemLog;
      }
    }

    // ── QA PASS ──────────────────────────────────────────────────────────────
    counters.qaPass++;
    itemLog.seoScore   = qa.seoScore;
    itemLog.qaWarnings = qa.warnings;

    const qaPassedAt = new Date().toISOString();
    if (!args.dryRun && !args.noMove) {
      updateWorkflowState(draftFile, { qa_passed_at: qaPassedAt });
    }

    if (args.dryRun) {
      itemLog.status = 'dry-run-pass';
      console.log(`  → DRY-RUN: QA 통과\n`);
      return itemLog;
    }

    // ── [5/5] 발행 결정 ────────────────────────────────────────────────────
    if (!args.publish || args.noMove) {
      counters.queued++;
      itemLog.status = args.noMove ? 'queued-no-move' : 'queued';
      console.log(`  → ${args.noMove ? '[NO-MOVE] ' : ''}QA 통과 (queued)\n`);
      publishLogRecords.push({
        draftFile: basename, seoScore: qa.seoScore,
        published: false, status: itemLog.status, savedAt: new Date().toISOString(),
      });
      return itemLog;
    }

    // WP 환경변수 없으면 skipped (실패 아님)
    const wpEnvOk = !!(process.env.WP_URL && process.env.WP_USER && process.env.WP_APP_PASS);
    if (!wpEnvOk) {
      counters.queued++;
      counters.wpSkipped++;
      itemLog.status = 'skipped-no-wp-env';
      console.log(`  → WP 환경변수 없음 — skipped (queued)\n`);
      publishLogRecords.push({
        draftFile: basename, seoScore: qa.seoScore,
        published: false, status: 'skipped-no-wp-env', savedAt: new Date().toISOString(),
      });
      return itemLog;
    }

    // 일일 발행 한도
    if (counters.published >= args.maxPublish) {
      counters.queued++;
      counters.limitReached++;
      itemLog.status = 'queued-limit';
      console.log(`  → 일일 발행 한도 도달 (max-publish=${args.maxPublish}) → queued\n`);
      publishLogRecords.push({
        draftFile: basename, seoScore: qa.seoScore,
        published: false, status: 'limit-reached', savedAt: new Date().toISOString(),
      });
      return itemLog;
    }

    // rate limit (첫 발행은 대기 없음)
    if (counters.published > 0) sleepSync(args.sleepMs);

    // publish_attempts 추적
    const prevAttempts = getPublishAttempts(draftFile);
    const attemptAt    = new Date().toISOString();
    updateWorkflowState(draftFile, {
      publish_attempts:      prevAttempts + 1,
      last_publish_attempt:  attemptAt,
    });

    console.log(`  → wp-publish.js 실행 중... (${counters.published + 1}/${args.maxPublish})`);
    const pub = wpPublishWithRetry(draftFile, args);

    if (pub.ok) {
      counters.published++;
      const publishedAt = new Date().toISOString();
      const wpPostId    = pub.wpResult?.post_id || null;

      // workflow_state: 발행 완료 기록
      updateWorkflowState(draftFile, {
        published_at:    publishedAt,
        published_wp_id: wpPostId,
      });

      // 파일 이동 wordpress/published/
      if (!args.noMove && fs.existsSync(draftFile)) {
        try {
          fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
          fs.renameSync(draftFile, path.join(PUBLISHED_DIR, basename));
        } catch (e) { console.warn(`  ⚠  파일 이동 실패: ${e.message}`); }
      }

      console.log(`  ✅ 발행 성공 (${pub.attempts}회 시도, WP ID: ${wpPostId ?? '?'})\n`);
      itemLog.status   = 'published';
      itemLog.wpPostId = wpPostId;
      publishLogRecords.push({
        draftFile: basename, seoScore: qa.seoScore,
        published: true, wpPostId, attempts: pub.attempts,
        slug: pub.wpResult?.slug || null, savedAt: publishedAt,
      });

    } else {
      // WP 발행 전체 실패 → quarantine
      counters.publishFailed++;
      const reason = `WP 발행 ${args.retryWp}회 모두 실패`;
      console.log(`  ❌ ${reason}\n`);
      quarantineFile(draftFile, args.noMove, reason);
      itemLog.status = 'quarantined-publish-fail';
      counters.quarantined++;
      publishLogRecords.push({
        draftFile: basename, seoScore: qa.seoScore,
        published: false, quarantined: true,
        wpError: (pub.stderr || '').slice(0, 300).trim(),
        savedAt: new Date().toISOString(),
      });
    }

  } catch (err) {
    console.error(`  ❌ 처리 오류: ${err.message}\n`);
    itemLog.status = 'error';
    itemLog.error  = err.message;
    counters.errors++;
  }

  return itemLog;
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
function main() {
  // WP 환경변수 자동 로드 (.env.local → .env, 이미 있으면 스킵)
  // 반드시 parseArgs() 이전에 실행 — 이후 wpEnvOk 판단에 영향
  const envInfo = loadEnvIfNeeded();

  const args      = parseArgs();
  const startedAt = new Date().toISOString();
  const dateStr   = startedAt.split('T')[0];

  // 헤더 출력
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Tripprice 편집국 — Chief Editor              ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  since=${args.since}  max-publish=${args.maxPublish}  publish=${args.publish}`);
  console.log(`║  env: ${envInfo.source}${envInfo.count > 0 ? ` (${envInfo.count}개 키 로드)` : ''}`);
  if (args.lang !== 'ko') console.log(`║  lang=${args.lang}`);
  if (args.dryRun) console.log('║  모드: DRY-RUN (파일 조작 없음)');
  if (args.noMove) console.log('║  모드: NO-MOVE (파일 이동 없음)');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ── 락 취득 ──────────────────────────────────────────────────────────────
  if (!args.dryRun) {
    if (!acquireLock(args.force)) process.exit(1);
    process.on('exit',    releaseLock);
    process.on('SIGINT',  () => { releaseLock(); process.exit(130); });
    process.on('SIGTERM', () => { releaseLock(); process.exit(143); });
  }

  // ── [1/3] desk-assign: 발행 대상 선정 ────────────────────────────────────
  console.log('  [1/3] desk-assign: 발행 대상 선정...');
  const rawQueue = runDeskAssign(args);

  if (rawQueue.length === 0) {
    console.log('  → 발행 대상 없음. 종료.\n');
    appendLog(path.join(LOGS_DIR, `editorial-chief-${dateStr}.json`), {
      startedAt,
      args: { since: args.since, publish: args.publish, maxPublish: args.maxPublish, lang: args.lang },
      summary: { total: 0 },
    });
    releaseLock();
    return;
  }

  // MAX_DAILY_PROCESS 상한
  const candidates = rawQueue.slice(0, MAX_DAILY_PROCESS);
  if (rawQueue.length > MAX_DAILY_PROCESS) {
    console.log(`  ⚠  폭주 방지: ${rawQueue.length}개 중 ${MAX_DAILY_PROCESS}개만 처리`);
  }

  // draftFile 절대경로 해석
  const draftFiles = candidates.map(resolveDraftFile).filter(Boolean);

  const noDraft = candidates.filter(it => !resolveDraftFile(it));
  if (noDraft.length > 0) {
    console.log(`  ℹ  draft 파일 없는 항목 ${noDraft.length}개 제외 (pipeline 실행 필요)`);
    noDraft.forEach(it => console.log(`    • ${it.slug}`));
  }

  if (draftFiles.length === 0) {
    console.log('  → 처리 가능한 draft 파일 없음. 종료.\n');
    releaseLock();
    return;
  }

  console.log(`  → 처리 대상: ${draftFiles.length}개`);
  draftFiles.forEach(f => console.log(`    • ${path.basename(f)}`));
  console.log('');

  if (args.dryRun) console.log('  DRY-RUN: 각 desk를 dry-run 모드로 실행합니다.\n');

  // ── [2/3] 콘텐츠 파이프라인 ────────────────────────────────────────────────
  console.log(`  [2/3] 콘텐츠 파이프라인 시작 — 대상 ${draftFiles.length}개 | max-publish=${args.maxPublish} | since=${args.since}`);

  const counters = {
    total:         draftFiles.length,
    qaPass:        0,
    qaFail:        0,
    patched:       0,
    published:     0,
    publishFailed: 0,
    queued:        0,
    quarantined:   0,
    skipped:       0,
    wpSkipped:     0,
    limitReached:  0,
    errors:        0,
    failReasons:   {},
  };
  const publishLogRecords = [];
  const chiefItems        = [];

  for (const draftFile of draftFiles) {
    const entry = processDraft(draftFile, args, counters, publishLogRecords);
    chiefItems.push(entry);
  }

  // ── [3/3] desk-audit: 감사 리포트 ────────────────────────────────────────
  console.log('\n  [3/3] desk-audit: 감사 리포트 저장...');

  const summary = {
    total:         counters.total,
    qaPass:        counters.qaPass,
    qaFail:        counters.qaFail + counters.quarantined,
    patched:       counters.patched,
    published:     counters.published,
    publishFailed: counters.publishFailed,
    queued:        counters.queued,
    quarantined:   counters.quarantined,
    skipped:       counters.skipped,
    wpSkipped:     counters.wpSkipped,
    limitReached:  counters.limitReached,
    errors:        counters.errors,
  };

  // 최종 요약 출력
  const top3 = Object.entries(counters.failReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  편집국 최종 요약                             ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  총 대상: ${summary.total}개  (이미발행 스킵: ${summary.skipped}건)`);
  console.log(`║  QA 통과: ${summary.qaPass} | QA 실패/격리: ${summary.qaFail} | 보강: ${summary.patched}건`);
  console.log(`║  발행 성공: ${summary.published} | 발행 실패→격리: ${summary.publishFailed} | queued: ${summary.queued}`);
  console.log(`║  WP env 없음: ${summary.wpSkipped}건 | 한도 초과: ${summary.limitReached}건 | 격리: ${summary.quarantined}건`);
  if (top3.length > 0) {
    console.log(`║  TOP3 실패 원인: ${top3.map(([k, v]) => `${k}(${v}건)`).join(' | ')}`);
  }
  console.log('╚══════════════════════════════════════════════╝\n');

  // 로그 저장
  const chiefLogFile   = path.join(LOGS_DIR, `editorial-chief-${dateStr}.json`);
  const publishLogFile = path.join(LOGS_DIR, `publish-auto-${dateStr}.json`);

  appendLog(chiefLogFile, {
    startedAt,
    args: {
      since: args.since, publish: args.publish, maxPublish: args.maxPublish,
      noMove: args.noMove, dryRun: args.dryRun, lang: args.lang,
      sleepMs: args.sleepMs, retryWp: args.retryWp,
    },
    summary,
    failReasons: counters.failReasons,
    items:       chiefItems,
  });

  if (publishLogRecords.length > 0) {
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      let existing = [];
      if (fs.existsSync(publishLogFile)) {
        try { existing = JSON.parse(fs.readFileSync(publishLogFile, 'utf8')); } catch { existing = []; }
        if (!Array.isArray(existing)) existing = [existing];
      }
      existing.push(...publishLogRecords);
      fs.writeFileSync(publishLogFile, JSON.stringify(existing, null, 2), 'utf8');
    } catch (e) { console.error(`  ⚠  publish 로그 저장 실패: ${e.message}`); }
  }

  console.log(`  로그: logs/editorial-chief-${dateStr}.json`);
  if (publishLogRecords.length > 0) console.log(`       logs/publish-auto-${dateStr}.json`);
  console.log(`  락:   ${LOCK_FILE}\n`);

  releaseLock();
}

if (require.main === module) main();
