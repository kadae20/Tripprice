#!/usr/bin/env node
/**
 * editorial-24h.js — 24/7 편집국 스케줄러
 *
 * KST 스케줄에 따라 파이프라인을 자동 실행하고 WordPress에 직접 발행합니다.
 *
 * Usage:
 *   node scripts/editorial-24h.js [--dry-run] [--no-publish] [--max-publish=5]
 *   node scripts/editorial-24h.js --run-now   (즉시 1회 실행 후 스케줄 진입)
 *
 * 스케줄 (KST):
 *   06:00 — Agoda 데이터 동기화
 *   08:00 — 편집국 1차 가동 + WP 발행
 *   10:00 — 편집국 2차 가동 + WP 발행
 *   14:00 — 이미지 처리 배치
 *   22:00 — KPI 동기화
 *   23:00 — 내일 큐 사전 준비
 */
'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');

const ROOT     = path.resolve(__dirname, '..');
const LOGS_DIR = path.join(ROOT, 'logs');

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

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
    dryRun:     !!(obj['dry-run'] || obj.dryrun),
    noPublish:  !!obj['no-publish'],
    maxPublish: parseInt(obj['max-publish'] || '5', 10),
    runNow:     !!obj['run-now'],
  };
}

// ── KST 유틸 ─────────────────────────────────────────────────────────────────
function nowKST()    { return new Date(Date.now() + KST_OFFSET_MS); }
function kstHHMM()   { const d = nowKST(); return d.getUTCHours() * 100 + d.getUTCMinutes(); }
function kstDate()   { return nowKST().toISOString().split('T')[0]; }
function kstTime()   { const d = nowKST(); return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} KST`; }

// ── 로그 ──────────────────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toISOString()}][${kstTime()}] ${msg}`); }

// ── .env 로드 ─────────────────────────────────────────────────────────────────
function loadEnv() {
  for (const fname of ['.env.local', '.env']) {
    const fp = path.join(ROOT, fname);
    if (!fs.existsSync(fp)) continue;
    try {
      let loaded = 0;
      for (const raw of fs.readFileSync(fp, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let val   = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (key && !(key in process.env)) { process.env[key] = val; loaded++; }
      }
      log(`환경변수 로드: ${fname} (${loaded}개)`);
      return;
    } catch { /* skip */ }
  }
}

// ── Telegram 알림 (선택적) ────────────────────────────────────────────────────
function notifyTelegram(text) {
  const token  = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID   || '').trim();
  if (!token || !chatId) return;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  const https = require('https');
  const req = https.request({
    hostname: 'api.telegram.org', port: 443,
    path: `/bot${token}/sendMessage`, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => { res.resume(); });
  req.on('error', () => {});
  req.setTimeout(8000, () => { req.destroy(); });
  req.write(body); req.end();
}

// ── 편집국 결과 파싱 ──────────────────────────────────────────────────────────
function parseEditorialSummary(stdout) {
  const lines = (stdout || '').split('\n');
  const summary = {};
  for (const l of lines) {
    const m1 = l.match(/총 대상:\s*(\d+)/);  if (m1) summary.total = +m1[1];
    const m2 = l.match(/발행 성공:\s*(\d+)/); if (m2) summary.published = +m2[1];
    const m3 = l.match(/QA 실패[^:]*:\s*(\d+)/); if (m3) summary.qaFail = +m3[1];
    const m4 = l.match(/발행 실패[^:]*:\s*(\d+)/); if (m4) summary.pubFail = +m4[1];
    const m5 = l.match(/TOP3 실패 원인:\s*(.+)/); if (m5) summary.failReasons = m5[1];
  }
  return summary;
}

// ── 스크립트 실행 ─────────────────────────────────────────────────────────────
function runScript(scriptName, args = [], timeoutMin = 30) {
  const scriptPath = path.join(__dirname, scriptName);
  if (!fs.existsSync(scriptPath)) { log(`⚠️  스크립트 없음: ${scriptName}`); return false; }

  log(`▶ ${scriptName} ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: 'utf8',
    env:      { ...process.env },
    cwd:      ROOT,
    timeout:  timeoutMin * 60 * 1000,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const ok = result.status === 0;
  log(ok ? `✅ ${scriptName} 완료` : `❌ ${scriptName} 실패 (exit ${result.status})`);
  return ok;
}

// ── 편집국 실행 헬퍼 ──────────────────────────────────────────────────────────
function runEditorial(args, maxPub) {
  const edArgs = ['--auto', `--since=${kstDate()}`];
  if (!args.noPublish && !args.dryRun) edArgs.push('--publish');
  if (args.dryRun) edArgs.push('--dry-run');
  edArgs.push(`--max-publish=${maxPub}`);

  const scriptPath = path.join(__dirname, 'editorial-chief.js');
  const result = require('child_process').spawnSync(process.execPath, [scriptPath, ...edArgs], {
    encoding: 'utf8', env: { ...process.env }, cwd: ROOT,
    timeout: 45 * 60 * 1000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const ok = result.status === 0;
  log(ok ? '✅ editorial-chief.js 완료' : `❌ editorial-chief.js 실패 (exit ${result.status})`);

  // Telegram 요약 전송
  const s = parseEditorialSummary(result.stdout || '');
  const total = s.total || 0;
  const published = s.published || 0;
  const failed = (s.qaFail || 0) + (s.pubFail || 0);
  if (total > 0) {
    const lines = [
      `🏨 <b>tripprice.net</b> 편집국 — ${kstDate()}`,
      `총 ${total}건 | ✅ 발행 ${published} | ❌ 실패 ${failed}`,
    ];
    if (s.failReasons) lines.push(`실패 원인: ${s.failReasons}`);
    notifyTelegram(lines.join('\n'));
  } else if (!ok) {
    notifyTelegram(`⚠️ tripprice.net 편집국 실행 오류\nexit ${result.status}`);
  }

  return ok;
}

// ── 실행 상태 ─────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(LOGS_DIR, '24h-scheduler-state.json');
function loadState() {
  try { if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { /* ignore */ }
  return { lastRun: {}, totalRuns: 0 };
}
function saveState(state) {
  try { fs.mkdirSync(LOGS_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch { /* ignore */ }
}

// ── 작업 목록 ─────────────────────────────────────────────────────────────────
function buildJobs(args) {
  return [
    {
      id: 'hoteldata-sync', hhmm: 600, cooldownMin: 360,
      label: '📡 Agoda 데이터 동기화',
      run: () => runScript('agoda-hoteldata-sync.js', [], 20),
    },
    {
      id: 'editorial-1', hhmm: 800, cooldownMin: 90,
      label: '🏢 편집국 1차 → WP 발행',
      run: () => runEditorial(args, args.maxPublish),
    },
    {
      id: 'editorial-2', hhmm: 1000, cooldownMin: 90,
      label: '🏢 편집국 2차 → WP 발행',
      run: () => runEditorial(args, Math.max(1, Math.floor(args.maxPublish / 2))),
    },
    {
      id: 'image-batch', hhmm: 1400, cooldownMin: 360,
      label: '🖼️ 이미지 처리 배치',
      run: () => runScript('process-images.js', [], 20),
    },
    {
      id: 'kpi-sync', hhmm: 2200, cooldownMin: 360,
      label: '💰 KPI 동기화',
      run: () => runScript('agoda-report-parse.js', [], 10),
    },
    {
      id: 'pre-select', hhmm: 2300, cooldownMin: 360,
      label: '🗂️ 내일 큐 사전 준비',
      run: () => runScript('desk-assign.js', [`--since=${kstDate()}`, '--limit=20', '--min-score=60'], 5),
    },
  ];
}

// ── 실행 대상 판단 (±5분 윈도우 + 쿨다운) ────────────────────────────────────
function shouldRun(job, state) {
  const last = state.lastRun[job.id];
  if (!last) return true;
  return (Date.now() - new Date(last).getTime()) / 60000 >= job.cooldownMin;
}

function findDue(jobs, state) {
  const now = kstHHMM();
  return jobs.filter(j => {
    const diff = Math.min(Math.abs(now - j.hhmm), 2400 - Math.abs(now - j.hhmm));
    return diff <= 5 && shouldRun(j, state);
  });
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
function main() {
  loadEnv();
  const args = parseArgs();
  const jobs = buildJobs(args);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  Tripprice 편집국 24/7 스케줄러              ║');
  console.log(`║  모드: ${args.dryRun ? 'DRY-RUN' : args.noPublish ? 'NO-PUBLISH' : 'LIVE → WordPress 직접 발행'}`);
  console.log(`║  최대 발행: ${args.maxPublish}건/일`);
  console.log('╚══════════════════════════════════════════════╝\n');

  jobs.forEach(j => {
    const h = String(Math.floor(j.hhmm / 100)).padStart(2, '0');
    const m = String(j.hhmm % 100).padStart(2, '0');
    log(`  ${h}:${m} — ${j.label}`);
  });

  // --run-now: 즉시 편집국 실행
  if (args.runNow) {
    log('--run-now: 즉시 실행');
    runEditorial(args, args.maxPublish);
  }

  // 1분 폴링 루프
  function tick() {
    const state = loadState();
    for (const job of findDue(jobs, state)) {
      log(`⏰ ${job.label}`);
      job.run();
      state.lastRun[job.id] = new Date().toISOString();
      state.totalRuns = (state.totalRuns || 0) + 1;
      saveState(state);
    }
  }

  tick();
  const iv = setInterval(tick, 60 * 1000);

  // 1시간마다 생존 신호
  setInterval(() => log(`━ 대기 중 (총 실행: ${loadState().totalRuns}회)`), 60 * 60 * 1000);

  function shutdown(sig) {
    log(`${sig} — 종료`);
    clearInterval(iv);
    process.exit(0);
  }
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (process.platform === 'win32') {
    try {
      require('readline').createInterface({ input: process.stdin }).on('SIGINT', () => process.emit('SIGINT'));
    } catch { /* ignore */ }
  }
}

if (require.main === module) main();
