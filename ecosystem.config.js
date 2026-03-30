'use strict';
/**
 * ecosystem.config.js — PM2 프로세스 설정
 *
 * EC2 배포:
 *   pm2 start ecosystem.config.js
 *   pm2 save          # 재부팅 후 자동 복원 저장
 *   pm2 startup       # 부팅 자동 시작 등록 (출력된 커맨드 실행)
 *
 * 로컬 Windows:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *   → start-tripprice.bat 이 부팅 시 pm2 resurrect 실행
 *
 * 프로세스 목록:
 *   tripprice-daily   — 매일 오전 9시 (KST) 편집국 자동 실행
 *   tripprice-weekly  — 매주 월요일 오전 8시 Agoda 데이터 동기화
 */

const path = require('path');
const ROOT  = __dirname;

module.exports = {
  apps: [

    // ── 1. 일일 편집국 ─────────────────────────────────────────────────────
    // 매일 09:00 KST (UTC 00:00) 실행
    // config/daily-jobs.json 기준 파이프라인 → WP 발행 → Telegram/Notion KPI
    {
      name:          'tripprice-daily',
      script:        path.join(ROOT, 'scripts', '_run-with-env.js'),
      args:          path.join(ROOT, 'scripts', 'editorial-24h.js'),
      cwd:           ROOT,
      cron_restart:  '0 0 * * *',   // UTC 00:00 = KST 09:00
      autorestart:   false,          // cron 잡 — 완료 후 재시작 안 함
      watch:         false,
      env: {
        NODE_ENV: 'production',
        // .env.local 로 자동 로드됨 (_run-with-env.js 처리)
      },
      log_file:      path.join(ROOT, 'logs', 'daily.log'),
      error_file:    path.join(ROOT, 'logs', 'daily-error.log'),
      merge_logs:    true,
      time:          true,
    },

    // ── 2. 주간 Agoda 호텔 데이터 동기화 ────────────────────────────────
    // 매주 월요일 08:00 KST (UTC 일요일 23:00)
    // 호텔 데이터(가격/랜딩URL) 갱신 — 콘텐츠 품질 유지
    {
      name:          'tripprice-weekly-sync',
      script:        path.join(ROOT, 'scripts', '_run-with-env.js'),
      args:          path.join(ROOT, 'scripts', 'agoda-hoteldata-sync.js'),
      cwd:           ROOT,
      cron_restart:  '0 23 * * 0',  // UTC 일요일 23:00 = KST 월요일 08:00
      autorestart:   false,
      watch:         false,
      env: {
        NODE_ENV: 'production',
      },
      log_file:      path.join(ROOT, 'logs', 'weekly-sync.log'),
      error_file:    path.join(ROOT, 'logs', 'weekly-sync-error.log'),
      merge_logs:    true,
      time:          true,
    },

  ],
};
