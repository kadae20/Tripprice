# Skill: build-brief

## 역할
plan-article 출력을 바탕으로 article-writer가 실제로 사용할 상세 브리프를 작성한다.

## 호출 방식
수동 호출 — plan-article 완료 후 실행.

## 허용 도구
- 파일 읽기/쓰기
- data/ 폴더 접근 (호텔 데이터 참조)

## 입력
- state/campaigns/[slug]-plan.md
- 포함할 호텔 ID 목록 (data/processed/ 참조)

## 출력 (state/campaigns/[slug]-brief.md)

```
## 글 제목 (H1 초안)
## SEO title 초안
## meta description 초안
## slug 초안
## 타겟 독자
## 검색 의도
## 포함 호텔 목록 + 각 호텔의 포지셔닝
## 섹션별 작성 지침
  - 선택 기준: [기준 3~5개]
  - 각 호텔: [강조점 / 주의점 / CTA 위치]
## FAQ 주제 목록 (3개 이상)
## 내부 링크 후보
## 대표 이미지 방향
## 언어/톤 지침
```

## 품질 게이트
- 호텔 목록 중 data_coverage_score 60점 미만 호텔 → 비교표 카드로만 처리 명시
- 브리프에 "선택 기준"이 없으면 작성 불완전, 반환
