# Skill: ingest-hotel-data

## 역할
CSV/JSON 형태의 호텔 원본 데이터를 검증하고 정규화하여 DB에 적재한다.

## 호출 방식
수동 호출 — 신규 호텔 데이터 업로드 시.

## 허용 도구
- 파일 읽기/쓰기 (data/)
- 스크립트 실행 (scripts/ingest-hotel-data.js — 작성 후 연결)

## 입력
- data/hotels/[filename].csv 또는 .json

## 처리 단계

1. **필수 필드 검증**
   - hotel_id, name, city, country, address 존재 여부
   - 이상값 감지 (이름 없음, 가격 0 등)

2. **중복 감지**
   - hotel_id 기준 중복 확인
   - 중복 시: 병합 또는 거부 선택 요청

3. **정규화**
   - 도시명/국가명 표준화 (영문 소문자 기준)
   - 가격 통화 통일 (USD 기본, 표시는 현지통화)
   - 태그/카테고리 정규화

4. **data_coverage_score 계산**
   - .claude/rules/data-pipeline-quality.md 기준 점수 산출
   - 결과를 state/coverage/[hotel_id].json에 저장

5. **저장**
   - 원본: data/hotels/ (보존)
   - 정규화본: data/processed/[hotel_id].json

## 출력 (state/campaigns/ingest-report-[date].md)

```
## 처리 결과
총 입력: N건
성공: N건
경고(데이터 부족): N건
오류(필수 필드 없음): N건

## 경고 목록
[hotel_id]: [경고 내용]

## 오류 목록
[hotel_id]: [오류 내용] → 처리 제외
```

## 주의
- 크롤링 기반 데이터는 출처/날짜 반드시 기록
- 가격 데이터는 수집 시각 타임스탬프 필수
