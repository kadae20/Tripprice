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
├── docs/               # 배포·운영 문서
├── lib/                # 공유 유틸리티 (agoda-link-builder, agoda-client)
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

# 2. 환경변수 설정
cp .env.example .env.local
# .env.local 열어서 실제 값 입력

# 3. 호텔 데이터 적재
node scripts/ingest-hotel-data.js data/hotels/sample-hotels.csv

# 4. 테스트
npm test
```

---

## 스크립트

### `pipeline.js` — 콘텐츠 파이프라인 전체 실행

build-brief → generate-draft → seo-qa → build-wp-post를 순서대로 실행. `--publish` 시 wp-publish까지.

```bash
# 안전 모드 (build-wp-post까지)
node scripts/pipeline.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul

# 전체 발행 (WP 환경변수 필요)
node scripts/pipeline.js --hotels=grand-hyatt-seoul --publish
```

---

### `ingest-hotel-data.js` — 호텔 데이터 적재

CSV/JSON 파일을 읽어 필수 필드 검증, 정규화, coverage score 계산 후 저장.

```bash
node scripts/ingest-hotel-data.js data/hotels/sample-hotels.csv

# data/hotels/ 전체 처리
node scripts/ingest-hotel-data.js
```

출력: `data/processed/[hotel_id].json` · `state/coverage/[hotel_id].json` · `state/campaigns/ingest-report-[date].md`

---

### `build-brief.js` — 콘텐츠 브리프 생성

호텔 processed 데이터 + coverage score를 읽어 콘텐츠 브리프 JSON 생성. coverage_score < 60이면 조기 차단.

```bash
node scripts/build-brief.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul
node scripts/build-brief.js --hotels=grand-hyatt-seoul --lang=en
```

출력: `wordpress/drafts/brief-[slug]-[date].json`

---

### `generate-draft.js` — 마크다운 초안 생성

브리프 JSON → hotel-decision-guide.md 구조 기반 마크다운 초안 생성.

```bash
node scripts/generate-draft.js --brief=brief-seoul-luxury-comparison-2026-03-05
node scripts/generate-draft.js --brief=brief-grand-hyatt-seoul-2026-03-05 --lang=en
```

출력: `wordpress/drafts/draft-[slug]-[date].md`

---

### `seo-qa.js` — SEO 품질 점검

마크다운 초안의 SEO·발행 품질 자동 점검 (16개 항목). FAIL 시 exit 1.

```bash
node scripts/seo-qa.js --draft=draft-seoul-luxury-comparison-2026-03-05
node scripts/seo-qa.js --draft=draft-seoul-luxury-comparison-2026-03-05 --json
```

출력: `state/campaigns/seo-qa-[slug]-[date].md`

---

### `build-wp-post.js` — 발행 번들 JSON 생성

마크다운 초안 → wp-post-schema.json 준수 발행 번들 JSON 생성. wp-publish.js에 바로 전달 가능.

```bash
node scripts/build-wp-post.js --draft=draft-seoul-luxury-comparison-2026-03-05
node scripts/build-wp-post.js --draft=draft-seoul-luxury-comparison-2026-03-05 --html
```

출력: `wordpress/drafts/post-[slug]-[date].json`

---

### `wp-publish.js` — WordPress Draft 발행

WordPress REST API로 포스트를 Draft 상태로 발행. `publish` 상태는 차단됨 (사람이 최종 검토 후 발행).

```bash
WP_URL=https://tripprice.net \
WP_USER=admin \
WP_APP_PASS="xxxx xxxx xxxx xxxx" \
  node scripts/wp-publish.js wordpress/drafts/post-[slug]-[date].json
```

출력: `state/campaigns/[slug]-published.json`

---

### `agoda-search.js` — 아고다 링크 생성 + 호텔 검색

CID 포함 딥링크 생성 + 로컬 호텔 데이터 검색. `--api` 옵션은 서버 배포 후 사용 가능 (도메인 제한).

```bash
node scripts/agoda-search.js --city=서울
node scripts/agoda-search.js --keyword=롯데
node scripts/agoda-search.js --hotel-id=grand-hyatt-seoul
node scripts/agoda-search.js --all --json
```

---

### `process-images.js` — 이미지 최적화

원본 이미지를 WebP로 변환·리사이즈하고 alt 텍스트를 자동 생성.

```bash
node scripts/process-images.js --hotel=grand-hyatt-seoul --dry-run
node scripts/process-images.js --hotel=grand-hyatt-seoul
node scripts/process-images.js --all
```

출력: `assets/processed/[hotel_id]/` · `assets/processed/[hotel_id]/alt-texts.json`

---

### `coverage-report.js` — Coverage 현황 대시보드

전체 호텔 coverage 상태 요약.

```bash
node scripts/coverage-report.js
node scripts/coverage-report.js --top=10
node scripts/coverage-report.js --action=publish-ready
node scripts/coverage-report.js --json
```

출력: `state/campaigns/coverage-report-[date].md`

---

### `enrich-missing-data.js` — 데이터 보강 계획 생성

coverage score 미달 호텔 진단 + 필드별 보강 방법 제안. 크롤링/API 호출 없이 진단만 수행.

```bash
node scripts/enrich-missing-data.js
node scripts/enrich-missing-data.js --threshold=80
node scripts/enrich-missing-data.js --hotel=haeundae-no-data
```

출력: `state/campaigns/enrichment-report-[date].md` · `state/campaigns/enrichment-plan-[hotel_id].json`

---

### `secrets-audit.js` — 시크릿 감사

코드베이스에서 하드코딩된 API키·비밀번호·URL 패턴을 스캔. 진단 전용, 파일 수정 없음.

```bash
node scripts/secrets-audit.js
node scripts/secrets-audit.js --dir=scripts
```

---

### `npm test` — 단위 테스트

WP 서버·sharp 없이 실행 가능. 89개 테스트 (wp-publish 37 + process-images 33 + build-wp-post 19).

```bash
npm test
```

---

## 환경변수

`.env.example`을 `.env.local`로 복사 후 값을 채우세요.

| 변수 | 용도 | 필수 |
|------|------|------|
| `WP_URL` | WordPress 사이트 URL | wp-publish 시 |
| `WP_USER` | WordPress 사용자명 | wp-publish 시 |
| `WP_APP_PASS` | WordPress Application Password | wp-publish 시 |
| `AGODA_CID` | 아고다 파트너 CID (기본: 1926938) | 선택 |
| `AGODA_API_KEY` | 아고다 Content API 키 (서버 전용) | 선택 |
| `SITE_URL` | canonical URL 생성용 기본 URL | 선택 |
| `GOOGLE_SC_CREDENTIALS` | Google Search Console 서비스 계정 JSON 경로 | 선택 |

> `.env.local`은 절대 커밋하지 마세요. `.gitignore`에 등록되어 있습니다.

---

## 데이터 커버리지 기준

호텔 데이터는 `data_coverage_score`(0~100점)로 품질을 관리합니다.

| 등급 | 점수 | 발행 정책 |
|------|------|-----------|
| A | 80~100 | 단독 리뷰형 글 발행 가능 |
| B | 60~79 | 발행 가능, 보강 권장 |
| C | 40~59 | 비교표 카드 형식만 허용 |
| D | 0~39 | 발행 불가, 데이터 보강 필요 |

상세 기준: `.claude/rules/data-pipeline-quality.md`

---

© 2026 kadae20. All rights reserved.
