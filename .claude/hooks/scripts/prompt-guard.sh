#!/bin/bash
# Tripprice — UserPromptSubmit Hook (Prompt Guard)
# 스팸/도어웨이/중복 양산 패턴 감지 시 경고 출력

# Claude Code는 UserPromptSubmit 훅에서 stdin으로 프롬프트를 받음
PROMPT=$(cat)

# 감지 패턴 함수
check_pattern() {
  local pattern="$1"
  local label="$2"
  if echo "$PROMPT" | grep -qiE "$pattern"; then
    echo ""
    echo "⚠️  [Tripprice 편집국 경고]"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "요청이 편집국 절대 규칙에 위배될 수 있습니다."
    echo ""
    echo "감지된 패턴: ${label}"
    echo ""
    echo "권장 대안:"
    echo "  → 단일 도메인 품질 글 확장 전략 유지"
    echo "  → 기존 부진 글 개선: refresh-underperforming-post"
    echo "  → 새 도시 진입 시 keyword-map 먼저 실행"
    echo ""
    echo "계속하려면 의도를 명확히 설명해주세요."
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    exit 2  # Claude Code: exit 2 = 사용자에게 경고 표시
  fi
}

# 패턴 검사
check_pattern "(도시.{0,10}바꿔|지역.{0,10}바꿔|도시마다.{0,20}같은 구조|[0-9]+개 도시.{0,20}동시)" \
  "도시/지역명 변형 대량 복제 요청"

check_pattern "(키워드.{0,15}많이 넣|키워드.{0,15}최대한|키워드 밀도.{0,10}높|키워드 스터핑)" \
  "키워드 스터핑 요청"

check_pattern "(도어웨이|doorway|같은 내용.{0,15}다른 URL|다른 URL.{0,15}같은 내용)" \
  "도어웨이 페이지 요청"

check_pattern "(서브도메인.{0,15}[0-9]+개|[0-9]+개.{0,15}서브도메인|city\..{0,20}도메인)" \
  "서브도메인 다발 복제 요청"

check_pattern "(링크만.{0,15}발행|설명 없이.{0,15}예약 링크|빠르게.{0,15}[0-9]+개.{0,15}발행)" \
  "Thin affiliate 대량 발행 요청"

# 이상 없으면 조용히 통과
exit 0
