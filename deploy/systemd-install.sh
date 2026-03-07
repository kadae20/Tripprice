#!/usr/bin/env bash
# ============================================================
# Tripprice systemd timer 설치
# Ubuntu 22/24, sudo 필요
# 실행: bash deploy/systemd-install.sh
# ============================================================
set -euo pipefail

REPO_DIR="/home/ubuntu/tripprice"
NODE_BIN="$(which node)"

echo "Node 경로: $NODE_BIN"
echo "레포 경로: $REPO_DIR"

# ── tripprice-schedule (07:00 KST = 22:00 UTC) ───────────────────────────────
sudo tee /etc/systemd/system/tripprice-schedule.service > /dev/null << UNIT
[Unit]
Description=Tripprice daily-jobs.json 자동 생성
After=network-online.target

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=$REPO_DIR
ExecStart=$NODE_BIN scripts/scheduler-generate-jobs.js
StandardOutput=append:$REPO_DIR/logs/scheduler.log
StandardError=append:$REPO_DIR/logs/scheduler.log
UNIT

sudo tee /etc/systemd/system/tripprice-schedule.timer > /dev/null << UNIT
[Unit]
Description=Tripprice scheduler 07:00 KST

[Timer]
OnCalendar=*-*-* 22:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# ── tripprice-newsroom-daily (07:10 KST = 22:10 UTC) ─────────────────────────
sudo tee /etc/systemd/system/tripprice-newsroom-daily.service > /dev/null << UNIT
[Unit]
Description=Tripprice AI 편집국 일일 실행
After=network-online.target tripprice-schedule.service

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=$REPO_DIR
ExecStart=$NODE_BIN scripts/_run-with-env.js scripts/newsroom.js daily --concurrency=3
StandardOutput=append:$REPO_DIR/logs/newsroom-daily.log
StandardError=append:$REPO_DIR/logs/newsroom-daily.log
TimeoutStartSec=3600
UNIT

sudo tee /etc/systemd/system/tripprice-newsroom-daily.timer > /dev/null << UNIT
[Unit]
Description=Tripprice newsroom daily 07:10 KST

[Timer]
OnCalendar=*-*-* 22:10:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# ── tripprice-newsroom-monthly (말일 23:50 KST = 14:50 UTC) ──────────────────
sudo tee /etc/systemd/system/tripprice-newsroom-monthly.service > /dev/null << UNIT
[Unit]
Description=Tripprice 월간 KPI 리포트
After=network-online.target

[Service]
Type=oneshot
User=ubuntu
WorkingDirectory=$REPO_DIR
ExecStart=$NODE_BIN scripts/_run-with-env.js scripts/newsroom.js monthly
StandardOutput=append:$REPO_DIR/logs/newsroom-monthly.log
StandardError=append:$REPO_DIR/logs/newsroom-monthly.log
TimeoutStartSec=1800
UNIT

sudo tee /etc/systemd/system/tripprice-newsroom-monthly.timer > /dev/null << UNIT
[Unit]
Description=Tripprice newsroom monthly 말일 23:50 KST

[Timer]
OnCalendar=*-*-28,29,30,31 14:50:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
UNIT

# ── 활성화 ────────────────────────────────────────────────────────────────────
sudo systemctl daemon-reload
sudo systemctl enable --now tripprice-schedule.timer
sudo systemctl enable --now tripprice-newsroom-daily.timer
sudo systemctl enable --now tripprice-newsroom-monthly.timer

echo ""
echo "=== systemd 타이머 등록 완료 ==="
sudo systemctl list-timers --all | grep tripprice || true
echo ""
echo "로그 확인:"
echo "  journalctl -u tripprice-newsroom-daily.service -f"
echo "  tail -f $REPO_DIR/logs/newsroom-daily.log"
