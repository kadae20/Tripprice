#!/usr/bin/env node
/**
 * newsroom.js
 * AI 편집국 오케스트레이터.
 *
 * 모드:
 *   daily   — config/daily-jobs.json 읽기 → pipeline (동시 N개) → approval-gate → [auto-publish]
 *   monthly — agoda-report-download → agoda-report-parse → notion-upsert-kpi → telegram-send
 *
 * 사용법:
 *   node scripts/newsroom.js daily [--auto-publish] [--concurrency=3] [--dry-run]
 *   node scripts/newsroom.js monthly [--month=2026-02]
 *
 * 환경변수 (daily):
 *   WP_URL, WP_USER, WP_APP_PASS  — --auto-publish 시 필요
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — 선택 (결과 알림)
 *
 * 환경변수 (monthly):
 *   AGODA_PARTNER_EMAIL, AGODA_PARTNER_PASSWORD
 *   NOTION_API_KEY, NOTION_DATABASE_ID
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */

'use strict';

const fs              = require('fs');
const path            = require('path');
const { execFileSync } = require('child_process');
const rotation        = require('./rotation');

const ROOT    = path.join(__dirname, '..');
const SCRIPTS = __dirname;
const NODE    = process.execPath;

// 스모크 체크 샘플링 비율 (0.0~1.0, 기본 1.0=항상 실행)
const SMOKE_RATE = Math.min(1, Math.max(0,
  parseFloat(process.env.SMOKE_CHECK_SAMPLE_RATE || '1.0')
));

// ── KPI 훅: 발행 성공 시 hotel-performance.json 갱신 ─────────────────────────
function updateHotelPerformance(hotelIds, slug) {
  const kpiPath = path.join(ROOT, 'state', 'kpi', 'hotel-performance.json');
  const kpiDir  = path.dirname(kpiPath);
  if (!fs.existsSync(kpiDir)) fs.mkdirSync(kpiDir, { recursive: true });

  let perf = {};
  try { perf = JSON.parse(fs.readFileSync(kpiPath, 'utf8')); } catch {}

  const now = new Date().toISOString().split('T')[0];
  for (const hotelId of hotelIds) {
    if (!perf[hotelId]) perf[hotelId] = { published_count: 0, slugs: [], clicks: 0 };
    perf[hotelId].published_count++;
    perf[hotelId].last_published_at = now;
    perf[hotelId].last_slug         = slug;
    if (!perf[hotelId].slugs.includes(slug)) perf[hotelId].slugs.push(slug);
  }

  // 다중 호텔 조합 키도 기록 (scheduler의 scoreHotel KPI 부스트용)
  if (hotelIds.length > 1) {
    const comboKey = 'combo:' + hotelIds.slice().sort().join('|');
    if (!perf[comboKey]) perf[comboKey] = { published_count: 0, slugs: [], clicks: 0 };
    perf[comboKey].published_count++;
    perf[comboKey].last_published_at = now;
    perf[comboKey].last_slug         = slug;
    if (!perf[comboKey].slugs.includes(slug)) perf[comboKey].slugs.push(slug);
  }

  try { fs.writeFileSync(kpiPath, JSON.stringify(perf, null, 2), 'utf8'); }
  catch { /* KPI 갱신 실패는 무시 */ }
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags      = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const mode        = positional[0];
const autoPublish = flags['auto-publish'] === true;
const dryRun      = flags['dry-run']      === true;
const concurrency = Math.min(Math.max(parseInt(flags.concurrency || '3', 10), 1), 5);
const today       = new Date().toISOString().split('T')[0];

if (!mode || !['daily', 'monthly'].includes(mode)) {
  console.error('사용법: node scripts/newsroom.js <daily|monthly> [옵션]');
  console.error('  daily   [--auto-publish] [--concurrency=3] [--dry-run]');
  console.error('  monthly [--month=YYYY-MM]');
  process.exit(1);
}

// ── 실행 헬퍼 ─────────────────────────────────────────────────────────────────
function runScript(scriptName, scriptArgs, { failOk = false } = {}) {
  try {
    const out = execFileSync(NODE, [path.join(SCRIPTS, scriptName), ...scriptArgs], {
      cwd: ROOT, env: process.env, encoding: 'utf8',
    });
    return { ok: true, stdout: out, stderr: '' };
  } catch (err) {
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    if (!failOk) {
      process.stderr.write(stderr);
    }
    return { ok: false, stdout, stderr, code: err.status ?? 1 };
  }
}

// ── 동시 실행 큐 ──────────────────────────────────────────────────────────────
async function runConcurrent(tasks, limit) {
  const results = new Array(tasks.length);
  let   next    = 0;

  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: limit }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── 로그 저장 ─────────────────────────────────────────────────────────────────
function saveLog(log) {
  const logDir = path.join(ROOT, 'state');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `newsroom-log-${today}.json`);
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
  return logPath;
}

// ── Telegram 알림 (선택적) ────────────────────────────────────────────────────
function sendTelegramIfConfigured(message) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  runScript('telegram-send.js', [`--message=${message}`], { failOk: true });
}

// ════════════════════════════════════════════════════════════════════════════
//  DAILY MODE
// ════════════════════════════════════════════════════════════════════════════
async function runDaily() {
  const jobsPath = path.join(ROOT, 'config', 'daily-jobs.json');
  if (!fs.existsSync(jobsPath)) {
    console.error(`오류: ${jobsPath} 파일 없음`);
    console.error('  config/daily-jobs.json 을 생성하세요 (config/daily-jobs.example.json 참고)');
    process.exit(1);
  }

  const jobs = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));
  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.error('오류: daily-jobs.json 이 비어있거나 배열이 아닙니다.');
    process.exit(1);
  }

  const divider = '═'.repeat(60);
  console.log(divider);
  console.log(`  Newsroom 일일 실행`);
  console.log(`  날짜: ${today}  |  작업: ${jobs.length}개  |  동시: ${concurrency}`);
  console.log(`  모드: ${autoPublish ? '자동발행' : '승인후발행'}${dryRun ? '  (DRY-RUN)' : ''}`);
  console.log(divider);

  const log = {
    date: today, mode: 'daily', jobs: [],
    summary: { total: jobs.length, approved: 0, published: 0, failed: 0 },
  };

  // 각 job 실행 함수
  function makeJobTask(job, idx) {
    return async () => {
      const label    = job.hotels || job.hotel_ids || `job-${idx + 1}`;
      const hotels   = Array.isArray(job.hotels) ? job.hotels.join(',') : (job.hotels || '');
      const lang     = job.lang || 'ko';
      const jobLog   = { label, hotels, lang, status: 'pending', steps: [] };
      // rotation key: 단독이면 hotel_id, 다중이면 comboKey
      const hotelIds = hotels.split(',').map(h => h.trim()).filter(Boolean);
      const rotKey   = rotation.comboKey(hotelIds);

      console.log(`\n[${idx + 1}/${jobs.length}] 시작: ${label}`);

      if (dryRun) {
        jobLog.status = 'dry-run';
        console.log(`  [DRY-RUN] 건너뜀: ${label}`);
        log.jobs.push(jobLog);
        return jobLog;
      }

      // ── rotation: 작업 시작 기록 ──────────────────────────────────────────
      const rotState = rotation.load();
      rotation.markUsed(rotKey, rotState);
      rotation.save(rotState);

      // STEP: pipeline (build-brief → generate-draft → images → seo-qa → build-wp-post)
      const pipeArgs   = [`--hotels=${hotels}`, `--lang=${lang}`, '--no-images'];
      const pipeResult = runScript('pipeline.js', pipeArgs, { failOk: true });
      jobLog.steps.push({ step: 'pipeline', ok: pipeResult.ok });

      if (!pipeResult.ok) {
        jobLog.status = 'pipeline-failed';
        log.summary.failed++;
        console.log(`  [${idx + 1}] FAIL: pipeline — ${label}`);
        // rotation: 실패 기록
        const rotSt2 = rotation.load();
        rotation.markOutcome(rotKey, rotSt2, { success: false, failure_reason: 'pipeline-failed' });
        rotation.save(rotSt2);
        log.jobs.push(jobLog);
        return jobLog;
      }

      // STEP: approval-gate
      // slug 추출 — "슬러그(확정): {slug}" 우선, 없으면 "슬러그: {slug}" 폴백
      const slugMatch = pipeResult.stdout.match(/슬러그\(확정\):\s+(\S+)/) ||
                        pipeResult.stdout.match(/슬러그:\s+(\S+)/);
      const jobSlug   = slugMatch ? slugMatch[1] : null;

      if (!jobSlug) {
        jobLog.status = 'slug-parse-failed';
        log.summary.failed++;
        console.log(`  [${idx + 1}] FAIL: 슬러그 파싱 실패 — ${label}`);
        const rotSt2 = rotation.load();
        rotation.markOutcome(rotKey, rotSt2, { success: false, failure_reason: 'slug-parse-failed' });
        rotation.save(rotSt2);
        log.jobs.push(jobLog);
        return jobLog;
      }

      jobLog.slug = jobSlug;
      const gateResult = runScript('approval-gate.js', [`--slug=${jobSlug}`], { failOk: true });
      jobLog.steps.push({ step: 'approval-gate', ok: gateResult.ok });

      if (!gateResult.ok) {
        jobLog.status = 'rejected';
        log.summary.failed++;
        console.log(`  [${idx + 1}] REJECTED: ${jobSlug}`);
        const rotSt2 = rotation.load();
        rotation.markOutcome(rotKey, rotSt2, { success: false, slug: jobSlug, failure_reason: 'approval-rejected' });
        rotation.save(rotSt2);
        log.jobs.push(jobLog);
        return jobLog;
      }

      log.summary.approved++;
      console.log(`  [${idx + 1}] APPROVED: ${jobSlug}`);

      // STEP: wp-publish (--auto-publish 시)
      if (autoPublish) {
        const missing = ['WP_URL', 'WP_USER', 'WP_APP_PASS'].filter(k => !process.env[k]);
        if (missing.length > 0) {
          console.error(`  [${idx + 1}] --auto-publish 필요 환경변수 없음: ${missing.join(', ')}`);
          jobLog.status = 'approved-not-published';
        } else {
          const postMatch = pipeResult.stdout.match(/발행번들:\s+(\S+\.json)/);
          if (postMatch) {
            const publishResult = runScript(
              'wp-publish.js',
              [postMatch[1], '--status=publish'],
              { failOk: true }
            );
            jobLog.steps.push({ step: 'wp-publish', ok: publishResult.ok, status: 'publish' });

            if (publishResult.ok) {
              log.summary.published++;
              jobLog.status = 'published';
              console.log(`  [${idx + 1}] PUBLISHED (live): ${jobSlug}`);

              // ── KPI 훅: hotel-performance.json 갱신 ───────────────────────
              updateHotelPerformance(hotelIds, jobSlug);

              // ── smoke check ──────────────────────────────────────────────
              const postIdMatch = publishResult.stdout.match(/post_id\s*:\s*(\d+)/);
              const postId = postIdMatch ? parseInt(postIdMatch[1], 10) : null;
              let smokeOk = true;
              let smokeFailures = [];

              if (postId && Math.random() < SMOKE_RATE) {
                const smokeResult = runScript(
                  'smoke-check-post.js',
                  [`--post-id=${postId}`, `--slug=${jobSlug}`],
                  { failOk: true }
                );
                jobLog.steps.push({ step: 'smoke-check', ok: smokeResult.ok });

                if (!smokeResult.ok) {
                  try {
                    const parsed = JSON.parse(smokeResult.stdout);
                    smokeFailures = parsed.failures || [];
                  } catch { smokeFailures = ['parse-error']; }
                  smokeOk = false;
                  console.log(`  [${idx + 1}] SMOKE FAIL: ${smokeFailures.join(', ')}`);
                }
              }

              // rotation: 성공/스모크 결과 기록
              const rotSt2 = rotation.load();
              if (smokeOk) {
                rotation.markOutcome(rotKey, rotSt2, { success: true, slug: jobSlug });
              } else {
                rotation.markOutcome(rotKey, rotSt2, {
                  success: false, slug: jobSlug,
                  failure_reason: `smoke:${smokeFailures.join(',')}`,
                });
              }
              rotation.save(rotSt2);

            } else {
              jobLog.status = 'publish-failed';
              log.summary.failed++;
              console.log(`  [${idx + 1}] PUBLISH FAIL (draft 유지): ${jobSlug}`);
              const rotSt2 = rotation.load();
              rotation.markOutcome(rotKey, rotSt2, { success: false, slug: jobSlug, failure_reason: 'wp-publish-failed' });
              rotation.save(rotSt2);
            }
          } else {
            jobLog.status = 'approved-post-not-found';
            console.log(`  [${idx + 1}] 발행번들 파싱 실패: ${jobSlug}`);
          }
        }
      } else {
        // auto-publish 아님 → approved 상태로만 저장 (rotation 성공 기록 보류)
        jobLog.status = 'approved';
      }

      log.jobs.push(jobLog);
      return jobLog;
    };
  }

  const tasks   = jobs.map((job, i) => makeJobTask(job, i));
  await runConcurrent(tasks, concurrency);

  // ── 로그 저장 ──────────────────────────────────────────────────────────────
  const logPath = saveLog(log);

  // ── 최종 요약 ──────────────────────────────────────────────────────────────
  console.log(`\n${divider}`);
  console.log(`  일일 실행 완료 (${today})`);
  console.log(`  총 ${log.summary.total}건  |  승인 ${log.summary.approved}  |  발행 ${log.summary.published}  |  실패 ${log.summary.failed}`);
  console.log(`  로그: ${logPath}`);
  console.log(divider);

  // ── Telegram 알림 ──────────────────────────────────────────────────────────
  const msg = [
    `[Tripprice 편집국] ${today} 일일 실행 완료`,
    `총 ${log.summary.total}건 | 승인 ${log.summary.approved} | 발행 ${log.summary.published} | 실패 ${log.summary.failed}`,
    log.jobs.filter(j => j.status === 'rejected').map(j => `거부: ${j.slug || j.label}`).join('\n'),
  ].filter(Boolean).join('\n');
  sendTelegramIfConfigured(msg);
}

// ════════════════════════════════════════════════════════════════════════════
//  MONTHLY MODE
// ════════════════════════════════════════════════════════════════════════════
async function runMonthly() {
  const targetMonth = flags.month || today.slice(0, 7);  // YYYY-MM

  console.log('═'.repeat(60));
  console.log(`  Newsroom 월간 리포트 (${targetMonth})`);
  console.log('═'.repeat(60));

  // STEP 1: agoda-report-download
  const dlResult = runScript('agoda-report-download.js', [`--month=${targetMonth}`], { failOk: true });
  if (!dlResult.ok) {
    console.error('Agoda 리포트 다운로드 실패 — CSV 없이 계속');
  }

  // STEP 2: agoda-report-parse
  const parseResult = runScript('agoda-report-parse.js', [`--month=${targetMonth}`], { failOk: true });
  let kpiData = null;
  if (parseResult.ok) {
    const jsonMatch = parseResult.stdout.match(/파일:\s+(\S+\.json)/);
    if (jsonMatch) {
      try { kpiData = JSON.parse(fs.readFileSync(path.join(ROOT, jsonMatch[1]), 'utf8')); } catch {}
    }
  }

  // STEP 3: notion-upsert-kpi
  if (kpiData && process.env.NOTION_API_KEY && process.env.NOTION_DATABASE_ID) {
    runScript('notion-upsert-kpi.js', [`--month=${targetMonth}`], { failOk: true });
  } else {
    console.log('  ⚠ Notion 환경변수 없음 또는 KPI 데이터 없음 — 건너뜀');
  }

  // STEP 4: telegram-send
  const kpiMsg = kpiData
    ? [
        `[Tripprice] ${targetMonth} 월간 KPI`,
        `클릭: ${kpiData.clicks || 0}  |  예약: ${kpiData.bookings || 0}  |  수익: ${kpiData.revenue_krw || 0}원`,
      ].join('\n')
    : `[Tripprice] ${targetMonth} 월간 리포트 — KPI 데이터 없음`;
  sendTelegramIfConfigured(kpiMsg);

  console.log(`\n  월간 리포트 완료 (${targetMonth})`);
}

// ── 실행 ──────────────────────────────────────────────────────────────────────
if (mode === 'daily') {
  runDaily().catch(err => { console.error('Newsroom daily 오류:', err.message); process.exit(1); });
} else {
  runMonthly().catch(err => { console.error('Newsroom monthly 오류:', err.message); process.exit(1); });
}
