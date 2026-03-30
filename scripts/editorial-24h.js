#!/usr/bin/env node
/**
 * scripts/editorial-24h.js
 * Tripprice 일일 편집국 — 전체 파이프라인 자동 실행.
 *
 * 동작:
 *   1. config/daily-jobs.json 로드 (또는 --hotels 인자)
 *   2. 각 잡마다 pipeline.js --publish 실행
 *   3. 발행 완료 후 Telegram 일일 KPI 요약 전송
 *   4. Notion 월별 KPI 업데이트
 *
 * 사용법:
 *   node scripts/editorial-24h.js               # daily-jobs.json 기준 실행
 *   node scripts/editorial-24h.js --dry-run      # 파이프라인만 실행, WP 발행 제외
 *   node scripts/editorial-24h.js --run-now      # 시간 게이트 무시하고 즉시 실행
 *   node scripts/editorial-24h.js --hotels=grand-hyatt-seoul-seoul --lang=ko
 *   node scripts/editorial-24h.js --max=2        # 최대 2편 발행 후 중단
 *
 * 환경변수 (.env.local 자동 로드):
 *   WP_URL, WP_USER, WP_APP_PASS, ANTHROPIC_API_KEY
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *   NOTION_API_KEY, NOTION_DATABASE_ID
 */

'use strict';

const fs              = require('fs');
const path            = require('path');
const { execFileSync } = require('child_process');

const ROOT    = path.join(__dirname, '..');
const SCRIPTS = __dirname;
const NODE    = process.execPath;

// ── 환경변수 로드 ─────────────────────────────────────────────────────────────
function loadEnv() {
  for (const fname of ['.env.local', '.env']) {
    const fp = path.join(ROOT, fname);
    try {
      fs.readFileSync(fp, 'utf8').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const idx = line.indexOf('='); if (idx < 1) return;
        const k = line.slice(0, idx).trim();
        let v = line.slice(idx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1,-1);
        if (k && !(k in process.env)) process.env[k] = v;
      });
      break;
    } catch { /* 파일 없으면 스킵 */ }
  }
}
loadEnv();

// 알림 + KPI (lib 로드는 env 로드 이후)
const notify    = require('../lib/notify');
const notionKpi = require('../lib/notion-kpi');

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
const cliArgs = process.argv.slice(2);
const flags   = Object.fromEntries(
  cliArgs.filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const isDryRun  = flags['dry-run']  === true;
const runNow    = flags['run-now']  === true;
const maxPublish = parseInt(flags.max || '10', 10);
const today     = new Date().toISOString().slice(0, 10);

// ── 잡 목록 구성 ──────────────────────────────────────────────────────────────
let jobs = [];

if (flags.hotels) {
  // 직접 지정
  jobs = [{ hotels: flags.hotels, lang: flags.lang || 'ko', note: '직접 지정' }];
} else {
  // config/daily-jobs.json
  const dailyJobsPath = path.join(ROOT, 'config', 'daily-jobs.json');
  try {
    jobs = JSON.parse(fs.readFileSync(dailyJobsPath, 'utf8'));
  } catch (e) {
    console.error(`[오류] daily-jobs.json 로드 실패: ${e.message}`);
    process.exit(1);
  }
}

if (jobs.length === 0) {
  console.log('[편집국] 오늘 실행할 잡이 없습니다.');
  process.exit(0);
}

// ── 중복 발행 체크 ────────────────────────────────────────────────────────────
function getTodayPublishedCount() {
  try {
    const ids = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'state', 'published', 'published_ids.json'), 'utf8'
    ));
    return (ids.ids || []).filter(e => e.published_at && e.published_at.startsWith(today)).length;
  } catch { return 0; }
}

// ── 파이프라인 실행 헬퍼 ──────────────────────────────────────────────────────
function runPipeline(job) {
  const pipelineArgs = [
    path.join(SCRIPTS, 'pipeline.js'),
    `--hotels=${job.hotels}`,
    `--lang=${job.lang || 'ko'}`,
    ...(isDryRun ? [] : ['--publish']),
  ];

  try {
    const out = execFileSync(NODE, pipelineArgs, {
      cwd:      ROOT,
      env:      process.env,
      encoding: 'utf8',
      timeout:  600_000, // 10분
    });
    process.stdout.write(out);

    // WP_RESULT_JSON 줄에서 결과 파싱
    const resultLine = out.split('\n').find(l => l.startsWith('WP_RESULT_JSON:'));
    if (resultLine) {
      try {
        return JSON.parse(resultLine.replace('WP_RESULT_JSON:', '').trim());
      } catch { /* skip */ }
    }
    // dry-run 또는 발행 없음
    return { dry_run: isDryRun, hotels: job.hotels };
  } catch (err) {
    process.stdout.write(err.stdout || '');
    process.stderr.write(err.stderr || '');
    console.error(`\n❌ [pipeline] 실패 — ${job.note || job.hotels}`);
    return null;
  }
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  const banner = '═'.repeat(55);
  console.log(banner);
  console.log('  Tripprice 편집국 — 일일 자동 실행');
  console.log(`  날짜: ${today}  모드: ${isDryRun ? 'dry-run' : '발행'}`);
  console.log(`  잡: ${jobs.length}개  최대 발행: ${maxPublish}편`);
  console.log(banner);

  // 이미 오늘 발행된 편 수 확인
  let todayCount = getTodayPublishedCount();
  if (!isDryRun && todayCount >= maxPublish) {
    console.log(`\n[편집국] 오늘 이미 ${todayCount}편 발행 완료 (최대: ${maxPublish}). 종료.`);
    await notify.send(`ℹ️ 편집국: 오늘(${today}) 이미 ${todayCount}편 발행됨 — 자동 종료`).catch(() => {});
    process.exit(0);
  }

  const results   = [];
  const published = [];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];

    if (!isDryRun && todayCount >= maxPublish) {
      console.log(`\n[편집국] 최대 발행(${maxPublish})편 도달 — 나머지 잡 중단`);
      break;
    }

    console.log(`\n[${i+1}/${jobs.length}] ${job.note || job.hotels} (${job.lang || 'ko'})`);
    const result = runPipeline(job);
    results.push({ job, result });

    if (result && result.post_id) {
      published.push({
        title:  result.slug || job.hotels,
        slug:   result.slug,
        url:    result.url,
        postId: result.post_id,
      });
      todayCount++;
    }
  }

  console.log(`\n${banner}`);
  console.log(`  완료: ${published.length}편 발행, ${results.filter(r => !r.result).length}편 실패`);
  console.log(banner);

  if (isDryRun) {
    console.log('\n[dry-run] Telegram/Notion 업데이트 건너뜀.');
    return;
  }

  // ── Telegram 일일 KPI 요약 ────────────────────────────────────────────────
  const totalPosts = (() => {
    try {
      const ids = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'state', 'published', 'published_ids.json'), 'utf8'
      ));
      return (ids.ids || []).filter(e => e.wp_post_id).length;
    } catch { return '?'; }
  })();

  if (published.length > 0 || results.length > 0) {
    await notify.dailyKpi({
      date:       today,
      published:  published.length,
      totalPosts,
      hotels:     published,
    }).catch(() => {});
  }

  // ── Notion KPI (발행이 있을 때만) ────────────────────────────────────────
  // 발행된 글 수는 wp-publish.js 내부에서 이미 incrementPosts() 호출됨.
  // 여기서는 Notes 필드 업데이트만 (선택).
  if (published.length > 0) {
    const yearMonth = today.slice(0, 7);
    const note      = `자동발행 ${today}: ${published.map(p => p.title).join(', ')}`;
    await notionKpi.upsertMonthKpi(yearMonth, { notes: note }).catch(() => {});
  }

  console.log('\n[편집국] 일일 자동 실행 완료.');
})().catch(async e => {
  console.error('[편집국] 치명 오류:', e.message);
  await notify.errorAlert('editorial-24h', e.message).catch(() => {});
  process.exit(1);
});
