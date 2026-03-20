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
# WP 인증정보는 .env.local에서 자동 로드 (cp .env.example .env.local 후 값 입력)
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

### editorial-chief.js ⭐ 실전 편집국 OS (핵심)

"선정 → 보강 → QA → 발행 → 로그" 전체 파이프라인을 단일 커맨드로 실행하는 지휘관 스크립트.

```bash
# ── 기본 (QA까지, 발행 안 함) ─────────────────────────────────────────
node scripts/editorial-chief.js --auto --since=$(date +%Y-%m-%d)

# ── 실전 발행 (.env.local에 WP 인증정보 설정 후) ─────────────────────
# WP_URL / WP_USER / WP_APP_PASS 는 .env.local 에서 자동 로드됩니다
node scripts/editorial-chief.js --auto --since=$(date +%Y-%m-%d) --publish --max-publish=5

# ── DRY-RUN (파일 조작 전혀 없이 결과만 확인) ─────────────────────────
node scripts/editorial-chief.js --auto --since=$(date +%Y-%m-%d) --dry-run

# ── NO-MOVE (QA/보강 실행, 파일 이동 없음 — 운영 안전 모드) ───────────
node scripts/editorial-chief.js --auto --since=$(date +%Y-%m-%d) --no-move

# ── 특정 파일만 처리 ─────────────────────────────────────────────────
node scripts/editorial-chief.js --auto --since=$(date +%Y-%m-%d) --match=ibis

# ── 락 충돌 시 강제 실행 ─────────────────────────────────────────────
node scripts/editorial-chief.js --auto --since=$(date +%Y-%m-%d) --force

# ── npm scripts 축약 ─────────────────────────────────────────────────
npm run editorial:chief  # QA까지 (기본)
npm run editorial:run    # WP 발행 포함 (env 설정 후)
```

**주요 옵션:**

| 옵션 | 기본값 | 설명 |
|------|-------|------|
| `--auto` | (필수) | 자동 선정 (drafts→campaigns→processed) |
| `--since=YYYY-MM-DD` | 오늘 | 이 날짜 이후 수정 파일만 처리 |
| `--publish` | false | WP REST API 발행 활성화 |
| `--max-publish=N` | 5 | 하루 최대 발행 수 |
| `--no-move` | false | 파일 이동 없이 QA/보강 시뮬레이션 |
| `--dry-run` | false | 파일 조작 전혀 없음 |
| `--force` | false | 락 무시하고 실행 |
| `--sleep-ms=N` | 1500 | 발행 간 딜레이 (ms) |
| `--retry-wp=N` | 3 | WP 발행 재시도 횟수 |
| `--retry-delay-ms=N` | 2000 | 재시도 초기 대기 (지수 증가) |
| `--lang=ko\|en\|ja` | ko | 언어 (pipeline 연동용) |
| `--match=keyword` | - | 파일명 키워드 필터 |

**안전장치:**
- 락 파일: `/tmp/tripprice-editorial.lock` (PID 생존 확인 + 2h 스테일 자동 해제)
- 발행 한도: `MAX_DAILY_PROCESS=50` (폭주 방지) + `--max-publish`
- 격리: patch 2회 초과 QA 실패 또는 WP 발행 전회 실패 → `wordpress/quarantine/`
- 멱등성: `workflow_state.published_wp_id` 있으면 재발행 방지
- WP env 없음: 전체 런 계속 (failed 아닌 skipped 처리)

**크론 예시:**
```bash
# 매일 오전 9시 자동 발행 (최대 5편)
# WP 인증정보는 /home/ubuntu/tripprice/.env.local 에서 자동 로드됨
# ※ cron에서 % 문자 오작동 방지: /bin/date +\%Y-\%m-\%d 형식 + SINCE 변수 사용
0 9 * * * cd /home/ubuntu/tripprice && SINCE=$(/bin/date +\%Y-\%m-\%d) && node scripts/editorial-chief.js --auto --since=$SINCE --publish --max-publish=5 >> logs/cron-editorial.log 2>&1

# 매주 월요일 오전 8시: 지난 7일 draft 대량 처리
0 8 * * 1 cd /home/ubuntu/tripprice && SINCE=$(/bin/date -d '7 days ago' +\%Y-\%m-\%d) && node scripts/editorial-chief.js --auto --since=$SINCE --no-move >> logs/cron-editorial-weekly.log 2>&1
```

**로그 위치:**
- 런 단위 요약: `logs/editorial-chief-YYYY-MM-DD.json`
- 글별 발행 기록: `logs/publish-auto-YYYY-MM-DD.json`
- 크론 실행 로그: `logs/cron-editorial.log` (직접 지정 시)

**워크플로우:**
```
desk-assign (선정)
  → desk-writing (H3/FAQ/체크리스트 보강)
  → desk-seo (meta/내부링크/schema)
  → desk-image (featured + 이미지 5장)
  → QA (hard gates)
  → [FAIL] auto-patch → 재QA
    → [FAIL again] → wordpress/quarantine/
  → [PASS] WP 발행 (--publish 시)
    → [실패] 재시도 3회 → wordpress/quarantine/
    → [성공] wordpress/published/ 이동
```

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
# 대상 선정만 출력 (파일 조작 없음)
node scripts/editorial-os.js --dry-run

# --auto: 오늘 drafts 있으면 pipeline 생략 → publish-auto만 실행
node scripts/editorial-os.js --auto --dry-run

# --auto + 날짜 필터 (EC2 배포 이후 파일만)
node scripts/editorial-os.js --auto --since=2026-03-13 --dry-run

# 자동 선정 3개, pipeline + QA까지 (발행은 별도)
node scripts/editorial-os.js --limit=3 --min-score=60

# 직접 지정 + 실제 발행 (WP 환경변수 필요)
node scripts/editorial-os.js --hotels=ibis-myeongdong --publish

npm run editorial:os -- --auto --dry-run
```

---

## 검증 커맨드 (로컬 / EC2 공통)

```bash
# 1) 단일 draft QA — content_markdown/html 실제 길이 확인 (0자이면 버그)
node scripts/qa-wp-post.js wordpress/drafts/post-arang-stay-seoul-review-2026-03-13.json
# 출력 예시: 텍스트 2135자(markdown) | H2 9 | 이미지 6개(featured 1+secs 5+html 0)

# 2) publish-auto dry-run — 파일 이동/기록 없이 QA 결과만 출력
node scripts/publish-auto.js --dry-run --since=2026-03-13

# 3) publish-auto --no-move — QA + 자동 보강 실행, 파일 이동은 없음 (운영 안전 모드)
node scripts/publish-auto.js --since=2026-03-13 --no-move

# 4) editorial-os --auto dry-run — 선정 대상 + 실행될 명령어만 출력
node scripts/editorial-os.js --auto --dry-run --since=2026-03-13

# 5) editorial-os --auto (오타 별칭도 동작)
node scripts/editorial-os.js --auto --dryrun --since=2026-03-13

# 6) 전체 QA + 자동 보강 + queued (WP 발행 없음, failed/ 기록 활성화)
node scripts/publish-auto.js
```

---

## EC2 실전 운영 검증 커맨드 8개

```bash
# 0) 최신 반영
cd /home/ubuntu/tripprice && git pull origin main

# 1) env 자동 로드 확인 (값 출력 없이 boolean으로만 확인)
unset WP_URL WP_USER WP_APP_PASS
node -e "require('./scripts/wp-publish.js'); const e=process.env; console.log('ENV', !!e.WP_URL, !!e.WP_USER, !!e.WP_APP_PASS)"

# 2) blocked 제외가 draft 후보 선정에서 동작하는지 (dry-run)
node scripts/editorial-os.js --auto --dry-run --since=$(date +%Y-%m-%d) | grep -E "blocked로 제외|거부" || echo "(blocked 호텔 없음 — 정상)"

# 3) resolveHotelImages 단독 테스트 (호텔 1개, 이미지 6장 목표)
node scripts/resolveHotelImages.js --hotel-id=ibis-myeongdong
ls -la assets/processed/ibis-myeongdong/ | head

# 4) AGODA_API_KEY 있을 때 추가 소스 테스트 (키 값은 로그에 출력 금지 — boolean만 확인)
node -e "console.log('AGODA_API_KEY set:', !!process.env.AGODA_API_KEY)"
# AGODA_API_KEY가 설정돼 있으면:
node scripts/resolveHotelImages.js --hotel-id=ibis-myeongdong

# 5) patch에서 step-0 이미지 확보 실행 여부 확인 (일반 실행 — dry-run 아님)
node scripts/patch-draft-minimums.js wordpress/drafts/post-$(ls wordpress/drafts/post-*.json 2>/dev/null | head -1 | xargs basename) 2>&1 | head -30
# → "🔍 [hotel-id] 이미지 … 확보 시도" 라인이 보여야 함

# 6) publish-auto 실제 발행 테스트 (소량)
node scripts/publish-auto.js --since=$(date +%Y-%m-%d) --publish --max-publish=3

# 7) placeholder 비율 확인 (줄어들어야 함)
grep -rl "assets/placeholder/featured.webp" wordpress/published/ 2>/dev/null | wc -l

# 8) quarantine 확인 (blocked_hotel / publish_failed 구분)
ls -la wordpress/quarantine/ 2>/dev/null | head
grep -h "quarantine_reason" wordpress/quarantine/*.json 2>/dev/null | sort | uniq -c | sort -rn || echo "(quarantine 없음)"
```

---

## 공통 규칙

- API 키는 환경변수로만 전달. 파일·로그 저장 금지.
- 실행 결과는 `state/` 폴더에 저장.
- 실제 처리 전 `--dry-run` 옵션으로 먼저 확인 권장.

## 환경변수 설정

```bash
# 1) 템플릿 복사
cp .env.example .env.local

# 2) .env.local 편집 (값 입력)
#    WP_URL, WP_USER, WP_APP_PASS, AGODA_API_KEY 등
```

editorial-chief.js / wp-publish.js는 실행 시 `.env.local` → `.env` 순으로
자동 로드합니다. 커맨드 라인에 인증정보를 노출할 필요가 없습니다.

> ⚠️ `.env.local` / `.env` 는 절대 git에 커밋하지 마세요. `.gitignore`에 포함되어 있습니다.
