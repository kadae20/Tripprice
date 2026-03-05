# Tripprice — 편집국 운영 지침

## 프로젝트 한 줄 요약
호텔 선택을 돕는 의사결정형 콘텐츠 + 자연스러운 아고다 제휴 전환.
단일 도메인 권위 축적. 스팸/도어웨이/대량 복제 절대 금지.

## 절대 규칙 (위반 시 즉시 중단)
1. 도시명/호텔명/언어만 바꾼 페이지 복제 → 금지
2. 키워드 스터핑, 도어웨이 페이지 → 금지
3. 서브도메인 다중 복제 운영 → 금지
4. 실질 부가가치 없는 thin affiliate 콘텐츠 → 발행 금지
5. API키/비밀키 파일 저장 → 금지 (환경변수 전용)

## 편집국 워크플로우 (순서 고정)
```
리서치 → 키워드전략 → 브리프 → 초안 → 팩트체크
→ SEO QA → 자연화 → CTA → 내부링크 → Draft발행 → 사람검토 → Publish
```

## 명령어

```bash
# 콘텐츠 파이프라인 전체 (안전 모드: build-wp-post까지)
node scripts/pipeline.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul

# 파이프라인 + WP 발행
WP_URL=https://tripprice.net WP_USER=admin WP_APP_PASS="xxxx xxxx" \
  node scripts/pipeline.js --hotels=grand-hyatt-seoul --publish

# 호텔 데이터 적재
node scripts/ingest-hotel-data.js data/hotels/[file].csv

# 이미지 처리 (dry-run 먼저 확인 권장)
node scripts/process-images.js --hotel=[hotel_id] --dry-run
node scripts/process-images.js --hotel=[hotel_id]

# WordPress Draft 수동 발행
WP_URL=https://tripprice.net WP_USER=admin WP_APP_PASS="xxxx xxxx" \
  node scripts/wp-publish.js wordpress/drafts/[post].json

# 시크릿 감사
node scripts/secrets-audit.js

# 테스트
npm test
```

> 환경변수 설정: .env.example → .env.local 복사 후 값 입력
> 상세 옵션 및 예시: scripts/README.md

## 아키텍처 요약
- WordPress 단일 도메인 + /ko/ /en/ /ja/ 서브디렉토리 다국어
- 데이터: 정적(DB) + 동적(API 우선, 보조 크롤링)
- 이미지: 공식소스 → WebP 최적화 → alt 자동생성 → WP 업로드
- 발행: Draft 우선, 사람이 최종 Publish (품질 게이트)
- data_coverage_score로 호텔 데이터 품질 제어 (state/coverage/ 참고)

## 모듈 인덱스
| 위치 | 역할 |
|------|------|
| `.claude/rules/` | 안정적/반복 품질 기준 |
| `.claude/skills/` | 작업 지침 (한 파일=한 책임) |
| `.claude/agents/` | 역할 분업, 최소 권한 |
| `.claude/hooks/` | 훅 정책 문서 + 실행 스크립트 |
| `content-templates/` | 콘텐츠 구조 템플릿 |
| `docs/` | 배포·운영 문서 |
| `lib/` | 공유 유틸리티 (agoda 링크·API) |
| `wordpress/` | WP 발행 스키마 |
| `data/` | 호텔 원본 데이터 |
| `assets/` | 이미지 (raw/processed) |
| `state/` | 운영 상태 (캠페인/커버리지) |
| `scripts/` | 실행 자동화 스크립트 |
