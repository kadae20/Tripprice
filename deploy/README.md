# Tripprice VPS 배포 가이드

## 순서

```bash
# 1) VPS에서 설치 (최초 1회)
bash deploy/install.sh

# 2) .env.local 복사 (로컬 → VPS)
scp .env.local ubuntu@<VPS_IP>:/home/ubuntu/tripprice/.env.local

# 3) 테스트
npm test

# 4) 스모크 (2건, draft만)
bash deploy/smoke-test.sh

# 5) systemd 타이머 등록
bash deploy/systemd-install.sh

# ── 3일 후 ────────────────────────────────────────────

# 6) 50건/일 확장 + auto-publish ON
bash deploy/scale-50.sh
```

## 타이머 일정 (KST)

| 타이머 | 시각 | 내용 |
|--------|------|------|
| tripprice-schedule | 07:00 | daily-jobs.json 자동 생성 |
| tripprice-newsroom-daily | 07:10 | AI 편집국 일일 실행 |
| tripprice-newsroom-monthly | 말일 23:50 | Agoda CSV → Notion KPI → Telegram |

## 로그

```bash
journalctl -u tripprice-newsroom-daily.service -f
tail -f /home/ubuntu/tripprice/logs/newsroom-daily.log
```

## .env.local 필수값

| 변수 | 발급 위치 |
|------|-----------|
| WP_URL / WP_USER / WP_APP_PASS | WP 관리자 > 사용자 > Application Passwords |
| ZAI_API_KEY | open.bigmodel.cn > API Keys |
| AGODA_API_KEY | partners.agoda.com > API |
| TELEGRAM_BOT_TOKEN / CHAT_ID | @BotFather |
| NOTION_API_KEY / DATABASE_ID | notion.so/my-integrations |
| SUPABASE_URL / SERVICE_ROLE_KEY | supabase.com > Settings > API |
