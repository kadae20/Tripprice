#!/usr/bin/env bash
# run-publish-auto.sh
# 스마트 since 계산 후 publish-auto.js 실행
# PM2 ecosystem.config.js 또는 cron에서 호출
#
# 우선순위:
#   1) $SINCE 환경변수가 설정된 경우 그대로 사용
#   2) drafts/ 폴더의 가장 최신 post-*-YYYY-MM-DD.json 파일명 날짜
#   3) 기본값: 최근 7일

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DRAFTS_DIR="$ROOT_DIR/wordpress/drafts"

# ── since 계산 ────────────────────────────────────────────────────────────────
if [ -n "${SINCE:-}" ]; then
  # 환경변수로 명시된 경우
  COMPUTED_SINCE="$SINCE"
  echo "  [run-publish-auto] since 환경변수 사용: $COMPUTED_SINCE"
else
  # drafts/ 폴더에서 파일명 날짜 추출
  FILENAME_DATE=""
  if [ -d "$DRAFTS_DIR" ]; then
    FILENAME_DATE=$(
      ls "$DRAFTS_DIR"/post-*-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json 2>/dev/null \
        | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}(?=\.json$)' \
        | sort -r \
        | head -1 \
      || true
    )
  fi

  if [ -n "$FILENAME_DATE" ]; then
    COMPUTED_SINCE="$FILENAME_DATE"
    echo "  [run-publish-auto] 최신 draft 파일명 날짜 사용: $COMPUTED_SINCE"
  else
    # 기본: 최근 7일
    if date --version >/dev/null 2>&1; then
      # GNU date (Linux)
      COMPUTED_SINCE=$(date -d '7 days ago' +%Y-%m-%d)
    else
      # BSD date (macOS)
      COMPUTED_SINCE=$(date -v-7d +%Y-%m-%d)
    fi
    echo "  [run-publish-auto] draft 없음 → 기본 7일 since: $COMPUTED_SINCE"
  fi
fi

# ── publish-auto.js 실행 ──────────────────────────────────────────────────────
cd "$ROOT_DIR"

exec node scripts/publish-auto.js \
  --publish \
  --since="$COMPUTED_SINCE" \
  "${@}"
