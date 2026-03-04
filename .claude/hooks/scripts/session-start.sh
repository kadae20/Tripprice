#!/bin/bash
# Tripprice — SessionStart Hook
# 세션 시작 시 운영 리마인더 출력 + 상태 파일 로드

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " [Tripprice 편집국] 세션 시작"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 절대 규칙:"
echo "  ✗ 도시/호텔명만 바꾼 페이지 복제"
echo "  ✗ 키워드 스터핑, 도어웨이 페이지"
echo "  ✗ Thin affiliate 콘텐츠 발행"
echo "  ✗ API키를 파일에 저장"
echo "  ✓ Draft 발행 → 사람이 검토 → Publish"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 진행 중 캠페인 확인 (있으면 출력)
CAMPAIGNS_DIR="state/campaigns"
if [ -d "$CAMPAIGNS_DIR" ]; then
  IN_PROGRESS=$(ls "$CAMPAIGNS_DIR"/*-plan.md 2>/dev/null | wc -l | tr -d ' ')
  if [ "$IN_PROGRESS" -gt 0 ]; then
    echo " 진행 중 캠페인: ${IN_PROGRESS}개"
    ls "$CAMPAIGNS_DIR"/*-plan.md 2>/dev/null | xargs -I{} basename {} -plan.md | head -5 | sed 's/^/  → /'
  fi
fi

# 커버리지 경고 (40점 미만 호텔 있으면 출력)
COVERAGE_DIR="state/coverage"
if [ -d "$COVERAGE_DIR" ] && command -v jq &>/dev/null; then
  LOW=$(find "$COVERAGE_DIR" -name "*.json" -exec jq -e 'select(.score < 40)' {} \; 2>/dev/null | grep -c '"score"' || echo 0)
  if [ "$LOW" -gt 0 ]; then
    echo " ⚠ 커버리지 40점 미만 호텔: ${LOW}개 (enrich-missing-data 필요)"
  fi
fi

echo ""
