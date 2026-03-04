# Skill: write-hotel-article

## 역할
브리프를 기반으로 의사결정형 호텔 가이드 초안을 작성한다.

## 호출 방식
수동 호출 — build-brief 완료 후 실행.

## 허용 도구
- 파일 읽기/쓰기
- data/processed/ 접근 (호텔 데이터)
- content-templates/ 접근 (구조 참조)

## 입력
- state/campaigns/[slug]-brief.md
- data/processed/[hotel-id].json (각 호텔)

## 출력 (state/campaigns/[slug]-draft.md)

content-templates/hotel-decision-guide.md 구조를 따름.

필수 포함 요소:
- SEO title / slug / meta description / excerpt
- H1~H3 구조
- 빠른 결론 요약 박스
- 이 글이 필요한 사람
- 선택 기준 섹션
- 호텔별 분석 (추천 대상/장점/단점/위치·동선/주의점)
- FAQ (3개 이상)
- CTA 블록 (최대 4개)
- 내부 링크 제안 (최소 2개)
- 대표 이미지 프롬프트
- 가격 고지 문구

## 작성 원칙
- 공급자 설명 복사 금지 — 편집자 관점에서 재서술
- 모든 호텔에 단점/주의점 반드시 포함
- 키워드는 자연스럽게, 반복 남발 금지
- 초안은 사람이 읽어도 어색하지 않은 수준까지 완성

## 품질 게이트
- "이 글이 필요한 사람" 섹션 없으면 반환
- 단점 없는 호텔 섹션 있으면 반환
- CTA가 5개 초과면 삭제 후 재출력
