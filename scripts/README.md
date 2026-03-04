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
WP_URL=https://tripprice.com \
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

## 예정 스크립트

| 파일명 | 목적 | 담당 Skill |
|--------|------|-----------|
| `enrich-missing-data.js` | 커버리지 미달 호텔 보강 전략 실행 | enrich-missing-data |
| `coverage-report.js` | 전체 호텔 커버리지 현황 요약 출력 | data-engineer |
| `performance-fetch.js` | Search Console/Analytics 데이터 수집 | performance-analyst |

---

## 공통 규칙

- API 키는 환경변수로만 전달. 파일·로그 저장 금지.
- 실행 결과는 `state/` 폴더에 저장.
- 실제 처리 전 `--dry-run` 옵션으로 먼저 확인 권장.

## 환경변수

```bash
WP_URL=https://tripprice.com
WP_USER=your_username
WP_APP_PASS="xxxx xxxx xxxx xxxx"   # WP Application Password
AGODA_API_KEY=...
GOOGLE_SC_CREDENTIALS=path/to/service-account.json
```

> `.env` 파일은 절대 git에 커밋하지 마세요. `.gitignore`에 추가하세요.
