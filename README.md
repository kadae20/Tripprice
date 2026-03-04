# Tripprice

호텔 선택을 돕는 의사결정형 콘텐츠 + 아고다 제휴 전환 시스템.
WordPress 단일 도메인 기반, 편집국 자동화 파이프라인.

---

## 폴더 구조

```
tripprice/
├── .claude/
│   ├── rules/          # 편집·SEO·이미지·제휴 품질 기준
│   ├── skills/         # 작업 단위 지침 (한 파일 = 한 책임)
│   ├── agents/         # 역할 분업 에이전트 정의
│   └── hooks/          # Claude Code 훅 정책 + 실행 스크립트
├── content-templates/  # 콘텐츠 구조 템플릿
├── wordpress/          # WP 발행 스키마 + 샘플 포스트
├── data/
│   ├── hotels/         # 호텔 원본 데이터 (CSV/JSON)
│   └── processed/      # 정규화 완료 데이터 (런타임 생성)
├── assets/
│   ├── raw/            # 원본 이미지
│   └── processed/      # WebP 변환 완료 이미지 (런타임 생성)
├── scripts/            # 자동화 스크립트
├── state/
│   ├── coverage/       # 호텔별 커버리지 점수 (런타임 생성)
│   └── campaigns/      # 발행 결과 리포트 (런타임 생성)
└── CLAUDE.md           # Claude Code 편집국 운영 지침
```

---

## 빠른 시작

```bash
# 1. 의존성 설치 (sharp — 이미지 처리용)
npm install

# 2. 호텔 데이터 적재
node scripts/ingest-hotel-data.js data/hotels/sample-hotels.csv

# 3. 테스트
npm test
```

---

## 스크립트

### `ingest-hotel-data.js` — 호텔 데이터 적재

CSV/JSON 파일을 읽어 필수 필드 검증, 정규화, coverage score 계산 후 저장.

```bash
# 특정 파일 처리
node scripts/ingest-hotel-data.js data/hotels/sample-hotels.csv

# data/hotels/ 전체 처리
node scripts/ingest-hotel-data.js
```

출력: `data/processed/[hotel_id].json` · `state/coverage/[hotel_id].json` · `state/campaigns/ingest-report-[date].md`

---

### `wp-publish.js` — WordPress Draft 발행

WordPress REST API로 포스트를 Draft 상태로 발행. `publish` 상태는 차단됨 (사람이 최종 검토 후 발행).

```bash
WP_URL=https://tripprice.com \
WP_USER=admin \
WP_APP_PASS="xxxx xxxx xxxx xxxx" \
  node scripts/wp-publish.js wordpress/sample-post.json
```

출력: `state/campaigns/[slug]-published.json`

---

### `process-images.js` — 이미지 최적화

원본 이미지를 WebP로 변환·리사이즈하고 alt 텍스트를 자동 생성.

```bash
# dry-run (저장 없이 미리보기)
node scripts/process-images.js --hotel=grand-hyatt-seoul --dry-run

# 특정 호텔 처리
node scripts/process-images.js --hotel=grand-hyatt-seoul

# 전체 처리
node scripts/process-images.js --all

# 워터마크 포함 (파트너 정책 확인 후)
node scripts/process-images.js --hotel=grand-hyatt-seoul --watermark
```

출력: `assets/processed/[hotel_id]/` · `assets/processed/[hotel_id]/alt-texts.json`

---

### `enrich-missing-data.js` — 데이터 보강 계획 생성

coverage score 미달 호텔을 찾아 누락 필드별 보강 방법과 대체 전략을 제안. 크롤링/API 호출 없이 진단·전략 제안만 수행.

```bash
# 60점 미만 (기본)
node scripts/enrich-missing-data.js

# threshold 직접 지정
node scripts/enrich-missing-data.js --threshold=80

# 특정 호텔만 진단
node scripts/enrich-missing-data.js --hotel=haeundae-no-data

# 전체 호텔 진단
node scripts/enrich-missing-data.js --all
```

출력: `state/campaigns/enrichment-report-[date].md` · `state/campaigns/enrichment-plan-[hotel_id].json`

---

### `coverage-report.js` — Coverage 현황 대시보드

전체 호텔 coverage 상태 요약. 발행 가능 / 보강 필요 / 발행 제외 현황을 한눈에 출력.

```bash
# 전체 요약
node scripts/coverage-report.js

# 상위/하위 10개
node scripts/coverage-report.js --top=10

# 특정 등급만
node scripts/coverage-report.js --grade=A

# 액션 필터
node scripts/coverage-report.js --action=publish-ready
node scripts/coverage-report.js --action=needs-enrichment
node scripts/coverage-report.js --action=exclude

# JSON 요약 파일 추가 저장
node scripts/coverage-report.js --json
```

출력: `state/campaigns/coverage-report-[date].md` · `state/campaigns/coverage-summary-[date].json` (`--json` 시)

---

### `npm test` — 단위 테스트

WP 서버·sharp 없이 실행 가능. 현재 70개 테스트 (wp-publish 37 + process-images 33).

```bash
npm test
```

---

## 환경변수

| 변수 | 용도 |
|------|------|
| `WP_URL` | WordPress 사이트 URL |
| `WP_USER` | WordPress 사용자명 |
| `WP_APP_PASS` | WordPress Application Password |
| `AGODA_API_KEY` | 아고다 파트너 API 키 |
| `GOOGLE_SC_CREDENTIALS` | Google Search Console 서비스 계정 JSON 경로 |

> `.env` 파일은 절대 커밋하지 마세요. `.gitignore`에 등록되어 있습니다.

---

## 예정 스크립트

| 파일명 | 목적 |
|--------|------|
| `performance-fetch.js` | Search Console/Analytics 데이터 수집 |

---

## 데이터 커버리지 기준

호텔 데이터는 `data_coverage_score`(0~100점)로 품질을 관리합니다.

| 등급 | 점수 | 발행 정책 |
|------|------|-----------|
| A | 80~100 | 단독 리뷰형 글 발행 가능 |
| B | 60~79 | 발행 가능, 보강 권장 |
| C | 40~59 | 비교표 카드 형식만 허용 |
| D | 0~39 | 발행 불가, 데이터 보강 필요 |

---

© 2026 kadae20. All rights reserved.
