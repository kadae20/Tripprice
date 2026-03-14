# scripts/

이 폴더는 Tripprice 편집국 운영 자동화 스크립트를 담습니다.

---

## 구현 완료

### ingest-hotel-data.js
CSV/JSON 호텔 데이터 적재 + 필수 필드 검증 + coverage score 계산.

```bash
# 특정 파일 처리
node scripts/ingest-hotel-data.js data/hotels/sample-hotels.csv

# data/hotels/ 전체 처리 (파일 생략 시)
node scripts/ingest-hotel-data.js
```

출력: `data/processed/[hotel_id].json`, `state/coverage/[hotel_id].json`, `state/campaigns/ingest-report-[date].md`

---

### wp-publish.js
WordPress REST API 기반 Draft 발행. publish 상태 차단.

```bash
WP_URL=https://tripprice.net \
WP_USER=admin \
WP_APP_PASS="xxxx xxxx xxxx xxxx" \
  node scripts/wp-publish.js wordpress/sample-post.json
```

출력: `state/campaigns/[slug]-published.json`

---

### process-images.js
원본 이미지 WebP 변환·리사이즈·alt 텍스트 자동 생성. sharp 필요 (`npm install`).

```bash
# dry-run (저장 없이 결과 미리보기)
node scripts/process-images.js --hotel=grand-hyatt-seoul --dry-run

# 특정 호텔 처리
node scripts/process-images.js --hotel=grand-hyatt-seoul

# 전체 호텔 처리
node scripts/process-images.js --all

# 워터마크 포함 (파트너 정책 허용 확인 후)
node scripts/process-images.js --hotel=grand-hyatt-seoul --watermark
```

출력: `assets/processed/[hotel_id]/`, `assets/processed/[hotel_id]/alt-texts.json`

---

### test-wp-publish.js / test-process-images.js
핵심 로직 단위 테스트. WP 서버·sharp 없이 실행 가능.

```bash
node scripts/test-wp-publish.js
node scripts/test-process-images.js

# 전체 테스트 한 번에
npm test
```

---

### enrich-missing-data.js
coverage score 미달 호텔 진단 + 필드별 보강 계획 생성. 크롤링/API 호출 없이 진단·전략 제안만 수행.

```bash
# threshold 60점 미만 (기본)
node scripts/enrich-missing-data.js

# threshold 직접 지정
node scripts/enrich-missing-data.js --threshold=80

# 특정 호텔만 진단
node scripts/enrich-missing-data.js --hotel=haeundae-no-data

# 전체 호텔 진단
node scripts/enrich-missing-data.js --all
```

출력: `state/campaigns/enrichment-report-[date].md`, `state/campaigns/enrichment-plan-[hotel_id].json`

---

### coverage-report.js
전체 호텔 coverage 상태를 요약. 발행 가능 / 보강 필요 / 발행 제외 현황을 한눈에 출력.

```bash
# 전체 요약
node scripts/coverage-report.js

# 상위/하위 10개
node scripts/coverage-report.js --top=10

# 특정 등급만
node scripts/coverage-report.js --grade=A

# 액션 필터
node scripts/coverage-report.js --action=needs-enrichment
node scripts/coverage-report.js --action=publish-ready
node scripts/coverage-report.js --action=exclude

# JSON 요약 파일 추가 저장
node scripts/coverage-report.js --json
```

출력: `state/campaigns/coverage-report-[date].md`, `state/campaigns/coverage-summary-[date].json` (--json 시)

---

### agoda-search.js
아고다 CID 포함 링크 생성 + 로컬 호텔 데이터 검색.
Content API(`--api`)는 tripprice.net 서버 배포 후 사용 가능 (도메인 제한).

```bash
# 도시로 검색 + CID 링크 생성
node scripts/agoda-search.js --city=서울

# 키워드 검색
node scripts/agoda-search.js --keyword=롯데

# 특정 호텔 ID
node scripts/agoda-search.js --hotel-id=grand-hyatt-seoul

# 전체 호텔 목록
node scripts/agoda-search.js --all

# JSON 저장
node scripts/agoda-search.js --city=서울 --json

# Content API 모드 (서버 배포 후)
AGODA_API_KEY="1926938:xxxx" node scripts/agoda-search.js --city=서울 --api
```

환경변수: `AGODA_CID` (기본 1926938), `AGODA_API_KEY` (서버 전용)

---

### pipeline.js
콘텐츠 파이프라인 전체 실행 래퍼. 기본은 build-wp-post까지(안전 모드), `--publish`시 wp-publish까지.

```bash
# 안전 모드 (기본) — build-brief → generate-draft → seo-qa → build-wp-post
node scripts/pipeline.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul

# 언어 지정
node scripts/pipeline.js --hotels=grand-hyatt-seoul --lang=en

# 전체 발행 (WP 환경변수 필요)
node scripts/pipeline.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul --publish
```

FAIL이 있으면 해당 단계에서 즉시 중단 (exit 1).

---

### generate-draft.js
브리프 JSON → hotel-decision-guide.md 구조 기반 마크다운 초안 생성.

```bash
node scripts/generate-draft.js --brief=brief-seoul-luxury-comparison-2026-03-05
node scripts/generate-draft.js --brief=brief-grand-hyatt-seoul-2026-03-05 --lang=en
```

출력: `wordpress/drafts/draft-[slug]-[date].md`

---

### build-brief.js
호텔 processed 데이터 + coverage score 읽어 콘텐츠 브리프 JSON 생성.
coverage_score < 60이면 조기 차단.

```bash
# 비교 가이드 (복수 호텔)
node scripts/build-brief.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul

# 단독 리뷰
node scripts/build-brief.js --hotels=grand-hyatt-seoul

# 언어 지정 (기본 ko)
node scripts/build-brief.js --hotels=grand-hyatt-seoul --lang=en
```

출력: `wordpress/drafts/brief-[slug]-[date].json`

---

### seo-qa.js
마크다운 초안의 SEO·발행 품질 자동 점검 (16개 항목). FAIL 시 exit 1.

```bash
# 기본 점검
node scripts/seo-qa.js --draft=draft-seoul-luxury-comparison-2026-03-05

# JSON 요약 함께 저장
node scripts/seo-qa.js --draft=draft-seoul-luxury-comparison-2026-03-05 --json
```

점검 항목: SEO title / slug / meta_description / H1·H2 구조 / 필수 섹션 5종 / CTA / 내부 링크 / 가격·제휴 고지 / lang

출력: `state/campaigns/seo-qa-[slug]-[date].md` (+ `--json` 시 `.json`)

---

### build-wp-post.js
마크다운 초안 → wp-post-schema.json 준수 발행 번들 JSON 생성. wp-publish.js에 바로 전달 가능.

```bash
# 기본 (content_markdown 포함)
node scripts/build-wp-post.js --draft=draft-seoul-luxury-comparison-2026-03-05

# HTML 변환 포함
node scripts/build-wp-post.js --draft=draft-seoul-luxury-comparison-2026-03-05 --html
```

자동 추출: affiliate_links / internal_links / FAQ schema_markup / coverage_score (brief 참조)
필수 필드(post_title·slug·post_status·lang) 누락 시 exit 1. post_status는 항상 draft 강제.

출력: `wordpress/drafts/post-[slug]-[date].json`

---

## 예정 스크립트

| 파일명 | 목적 |
|--------|------|
| `performance-fetch.js` | Search Console/Analytics 데이터 수집 |

---

### qa-wp-post.js
`wordpress/drafts/post-*.json` 단일 파일 QA (title·slug·본문길이·이미지·featured 검증).

```bash
node scripts/qa-wp-post.js wordpress/drafts/post-ibis-myeongdong.json
node scripts/qa-wp-post.js wordpress/drafts/post-ibis-myeongdong.json --json
npm run qa -- wordpress/drafts/post-ibis-myeongdong.json
```

---

### publish-auto.js
`wordpress/drafts/` 전체 스캔 → QA → 조건부 WP 발행.

```bash
node scripts/publish-auto.js --dry-run          # QA만, 발행 없음
node scripts/publish-auto.js --since=2026-03-13 # 날짜 이후 파일만
node scripts/publish-auto.js --match=ibis       # 파일명 부분 일치
npm run publish:auto -- --dry-run
```

---

### editorial-os.js
선정 → pipeline → publish-auto 전체 자동화.

```bash
node scripts/editorial-os.js --dry-run                          # 대상 선정만 출력
node scripts/editorial-os.js --limit=3 --min-score=60           # 자동 선정 3개
node scripts/editorial-os.js --hotels=ibis-myeongdong --publish # 직접 지정 + 발행
npm run editorial:os -- --limit=5 --publish
```

---

## 공통 규칙

- API 키는 환경변수로만 전달. 파일·로그 저장 금지.
- 실행 결과는 `state/` 폴더에 저장.
- 실제 처리 전 `--dry-run` 옵션으로 먼저 확인 권장.

## 환경변수

```bash
WP_URL=https://tripprice.net
WP_USER=your_username
WP_APP_PASS="xxxx xxxx xxxx xxxx"   # WP Application Password
AGODA_API_KEY=...
GOOGLE_SC_CREDENTIALS=path/to/service-account.json
```

> `.env` 파일은 절대 git에 커밋하지 마세요. `.gitignore`에 추가하세요.
