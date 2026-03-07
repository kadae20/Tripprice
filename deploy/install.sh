#!/usr/bin/env bash
# ============================================================
# Tripprice VPS 설치 스크립트
# Ubuntu 22/24 LTS, Node.js 22
# 실행: bash deploy/install.sh
# ============================================================
set -euo pipefail

REPO_DIR="/home/ubuntu/tripprice"
SERVICE_USER="ubuntu"

echo "=== [1/6] 시스템 패키지 설치 ==="
sudo apt-get update -qq
sudo apt-get install -y git curl

echo "=== [2/6] Node.js 22 설치 ==="
if ! node --version 2>/dev/null | grep -q "^v22"; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node: $(node --version), npm: $(npm --version)"

echo "=== [3/6] 레포 클론/업데이트 ==="
if [ -d "$REPO_DIR/.git" ]; then
  echo "기존 레포 업데이트"
  cd "$REPO_DIR" && git pull origin main
else
  echo "신규 클론"
  git clone https://github.com/kadae20/Tripprice.git "$REPO_DIR"
  cd "$REPO_DIR"
fi

echo "=== [4/6] 의존성 설치 ==="
cd "$REPO_DIR"
npm ci

echo "=== [5/6] 로그/상태 디렉토리 생성 ==="
mkdir -p "$REPO_DIR/logs"
mkdir -p "$REPO_DIR/state/published"
mkdir -p "$REPO_DIR/downloads/agoda"

echo "=== [6/6] .env.local 확인 ==="
if [ ! -f "$REPO_DIR/.env.local" ]; then
  echo ""
  echo "⚠  .env.local 파일이 없습니다."
  echo "   scp 또는 nano로 생성 후 재실행하세요:"
  echo "   scp .env.local ubuntu@<VPS_IP>:$REPO_DIR/.env.local"
  echo ""
else
  echo "✓ .env.local 존재 확인"
fi

echo ""
echo "=== 설치 완료 ==="
echo "다음 단계:"
echo "  1) .env.local 복사 (없으면)"
echo "  2) npm test"
echo "  3) bash deploy/smoke-test.sh"
echo "  4) bash deploy/systemd-install.sh"
