# Skill: enrich-missing-data

## 역할
data_coverage_score가 낮은 호텔의 누락 데이터를 보강하거나, 대체 전략을 적용한다.

## 호출 방식
수동 호출 — ingest-hotel-data 후 coverage score 미달 호텔 대상.

## 허용 도구
- 파일 읽기/쓰기
- 웹 검색 (공식 정보 탐색)
- 네트워크 (공식 API 호출, 허용된 경우)

## 입력
- state/coverage/[hotel_id].json (커버리지 점수)
- data/processed/[hotel_id].json

## 보강 전략 (점수별)

### 60~79점: 부분 보강
- 누락 항목 우선순위 파악
- 공식 웹사이트/파트너 API에서 정보 탐색
- 대체 이미지 전략 적용 (지도, 동선, 랜드마크)

### 40~59점: 구조 전환
- 단독 리뷰형 글 → 지역/예산 가이드형으로 변경
- 비교표 카드 형식으로만 노출
- image-brief.md 기반으로 자체 제작 이미지 요청

### 40점 미만: 보류
- 콘텐츠 생산 대상에서 임시 제외
- 데이터 보강 필요 목록에 추가
- state/coverage/pending-enrichment.md에 기록

## 대체 이미지 전략

사진 부족 시 대안:
1. 구글 지도 스크린샷 (정책 허용 범위)
2. 동선/위치 인포그래픽 자체 제작 (image-brief.md 사용)
3. 주변 랜드마크 이미지 (라이선스 확인 후)
4. 요약 정보 카드 이미지 자체 제작

## 출력
- data/processed/[hotel_id].json 업데이트
- state/coverage/[hotel_id].json 점수 갱신
- state/coverage/enrichment-log-[date].md (보강 작업 기록)
