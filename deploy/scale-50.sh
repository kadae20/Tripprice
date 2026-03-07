#!/usr/bin/env bash
# ============================================================
# Tripprice 50개/일 확장 스크립트
# 3일 스모크 이후 실행
# 실행: bash deploy/scale-50.sh
# ============================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"
SERVICE="tripprice-newsroom-daily.service"
NODE_BIN="$(which node)"

echo "=== [1] 50건 job 생성 ==="
node scripts/scheduler-generate-jobs.js --new=20 --refresh=30
echo ""

echo "=== [2] config/daily-jobs.json 건수 확인 ==="
node -e "
  const jobs = JSON.parse(require('fs').readFileSync('config/daily-jobs.json','utf8'));
  console.log('총', jobs.length, '건');
  const news    = jobs.filter(j=>j.note&&j.note.includes('신규')).length;
  const refresh = jobs.filter(j=>j.note&&j.note.includes('리프레시')).length;
  console.log(' 신규:', news, '/ 리프레시:', refresh);
"
echo ""

echo "=== [3] systemd service concurrency=5 + auto-publish 업데이트 ==="
sudo sed -i "s|--concurrency=[0-9]*|--concurrency=5|g" \
  /etc/systemd/system/tripprice-newsroom-daily.service
sudo sed -i "s|daily --concurrency=5|daily --concurrency=5 --auto-publish|g" \
  /etc/systemd/system/tripprice-newsroom-daily.service

sudo systemctl daemon-reload
sudo systemctl restart tripprice-newsroom-daily.service || true

echo "업데이트된 ExecStart:"
grep ExecStart /etc/systemd/system/tripprice-newsroom-daily.service
echo ""
echo "=== 확장 완료 ==="
echo "  일 50건 / concurrency=5 / auto-publish=ON"
echo ""
echo "모니터링:"
echo "  tail -f $REPO_DIR/logs/newsroom-daily.log"
