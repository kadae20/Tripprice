#!/usr/bin/env bash
# ============================================================
# Tripprice 스모크 테스트 (2건만 실행, auto-publish 없음)
# 실행: bash deploy/smoke-test.sh
# ============================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

echo "=== [1] npm test ==="
npm test
echo ""

echo "=== [2] scheduler dry-run ==="
node scripts/scheduler-generate-jobs.js --dry-run
echo ""

echo "=== [3] newsroom dry-run ==="
node scripts/_run-with-env.js scripts/newsroom.js daily \
  --concurrency=1 --dry-run
echo ""

echo "=== [4] 실제 2건 스모크 실행 ==="
# 현재 jobs 백업 후 2건으로 제한
JOBS_FILE="$REPO_DIR/config/daily-jobs.json"
JOBS_BACKUP="$REPO_DIR/config/daily-jobs-backup.json"

if [ -f "$JOBS_FILE" ]; then
  cp "$JOBS_FILE" "$JOBS_BACKUP"
  node -e "
    const fs = require('fs');
    const jobs = JSON.parse(fs.readFileSync('$JOBS_FILE', 'utf8'));
    fs.writeFileSync('$JOBS_FILE', JSON.stringify(jobs.slice(0, 2), null, 2));
    console.log('2건으로 제한:', jobs.slice(0,2).map(j=>j.hotels).join(', '));
  "
fi

node scripts/_run-with-env.js scripts/newsroom.js daily --concurrency=1

# 백업 복원
if [ -f "$JOBS_BACKUP" ]; then
  mv "$JOBS_BACKUP" "$JOBS_FILE"
  echo "jobs 복원 완료"
fi

echo ""
echo "=== [5] 결과 확인 ==="
LOG_FILE="$REPO_DIR/state/newsroom-log-$(date +%Y-%m-%d).json"
if [ -f "$LOG_FILE" ]; then
  echo "로그 파일: $LOG_FILE"
  node -e "
    const d = JSON.parse(require('fs').readFileSync('$LOG_FILE', 'utf8'));
    console.log('Summary:', JSON.stringify(d.summary, null, 2));
    d.jobs.forEach(j => console.log(' -', j.status, '|', j.slug || j.label));
  "
else
  echo "⚠  로그 파일 없음: $LOG_FILE"
fi

echo ""
echo "=== 스모크 테스트 완료 ==="
echo "WordPress 관리자 > 글 > 임시글 에서 draft 확인하세요."
