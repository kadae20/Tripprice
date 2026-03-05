# Tripprice 배포 구조

## 인프라 개요

```
┌─────────────────────────────┐    ┌─────────────────────────────┐
│        EasyWP 서버           │    │      Node 자동화 서버         │
│   (tripprice.net 도메인)     │    │   (VPS / 별도 서버)          │
│                             │    │                             │
│  WordPress                  │◄───│  Node.js 파이프라인 스크립트  │
│  - 콘텐츠 DB + 미디어 라이브러리│    │  - pipeline.js              │
│  - REST API (:443/wp-json/) │    │  - wp-publish.js            │
│  - Elementor / SEO 플러그인  │    │  - agoda-search.js (--api)  │
│                             │    │  - process-images.js        │
└─────────────────────────────┘    └─────────────────────────────┘
```

---

## 환경별 역할 분리

### EasyWP (WordPress 서버)
- **역할**: 콘텐츠 서빙, SEO 플러그인, 미디어 라이브러리
- **접근**: 관리자 패널 (`/wp-admin`), REST API (`/wp-json/wp/v2/`)
- **발행 원칙**: 자동 Publish 금지. 항상 **Draft 상태**로만 업로드, 사람이 최종 Publish
- **환경변수 없음**: WP 서버 자체는 API 키를 보관하지 않음

### Node 자동화 서버
- **역할**: 콘텐츠 파이프라인 실행, Agoda Content API 호출, 이미지 처리
- **필수 환경변수**: 아래 "환경변수 설정" 참고
- **주의**: `agoda-client.js` (Content API)는 이 서버 도메인이 Agoda 파트너 허브에 등록되어야 동작

### 로컬 개발 환경
- **역할**: 코드 작성, 테스트, 브리프·초안 생성 (로컬 데이터 기반)
- **제한**: Agoda Content API (`--api` 모드) 사용 불가 (도메인 미등록)
- **대체**: `agoda-search.js` 로컬 모드 (data/processed/ 기반) 사용

---

## Agoda Content API 도메인 제한

Agoda Content API는 **파트너 허브에 등록된 도메인**에서만 응답합니다.

| 환경 | Content API | CID 딥링크 |
|------|------------|-----------|
| 로컬 (localhost, CLI) | ❌ 403/redirect | ✅ 가능 |
| tripprice.net 서버 | ✅ 가능 | ✅ 가능 |

**로컬에서 `--api` 호출 시**: `www.agoda.com`으로 리다이렉트 → `lib/agoda-client.js`가 명확한 오류 발생시킴.

---

## 환경변수 설정

### 설정 파일

```bash
# 로컬 개발
cp .env.example .env.local      # git에서 제외됨 (.gitignore)

# 서버 배포
# 시스템 환경변수 또는 secrets manager 사용 권장
export WP_URL=https://tripprice.net
export WP_USER=...
# ...
```

### 변수 목록

| 변수 | 용도 | 필요 환경 |
|------|------|---------|
| `WP_URL` | WordPress REST API 기본 URL | Node 서버 |
| `WP_USER` | WordPress 사용자명 | Node 서버 |
| `WP_APP_PASS` | WordPress Application Password | Node 서버 |
| `AGODA_CID` | 아고다 파트너 CID (기본: 1926938) | 모든 환경 |
| `AGODA_API_KEY` | Agoda Content API 키 (`CID:secret`) | Node 서버만 |
| `SITE_URL` | canonical URL 생성 기본값 | Node 서버 |
| `GOOGLE_SC_CREDENTIALS` | Search Console 서비스 계정 JSON | Node 서버 |

### WordPress Application Password 생성

1. WP 관리자 → 사용자 → 프로필
2. "Application Passwords" 섹션 → 이름 입력 → 생성
3. 생성된 비밀번호를 `WP_APP_PASS`에 설정 (공백 포함 그대로)

---

## 배포 플로우

```
로컬 개발
  ↓ git push
Node 자동화 서버 (git pull)
  ↓ node scripts/pipeline.js --hotels=... --publish
    ├── build-brief    → brief-*.json
    ├── generate-draft → draft-*.md
    ├── seo-qa         → 품질 게이트 (FAIL 시 중단)
    ├── build-wp-post  → post-*.json
    └── wp-publish     → WordPress Draft 생성
                            ↓
                    사람이 WP 관리자에서 검토 → Publish
```

---

## 보안 체크리스트

- [ ] `.env.local` 또는 `.env` 파일이 `.gitignore`에 있는지 확인
- [ ] `node scripts/secrets-audit.js` → FAIL 항목 없음
- [ ] `AGODA_API_KEY` 파일/로그에 노출 없음
- [ ] `WP_APP_PASS` 파일/로그에 노출 없음
- [ ] WordPress Application Password 주기적 교체 (권장: 6개월)

---

## 장애 대응

### WP REST API 인증 실패 (401)
- `WP_USER` / `WP_APP_PASS` 확인
- WP 관리자 → Application Passwords에서 재생성

### Agoda Content API 리다이렉트 (→ www.agoda.com)
- Node 서버의 도메인이 Agoda 파트너 허브 "Approval Sites"에 등록되어 있는지 확인
- 미등록 시: 파트너 허브에서 도메인 추가 신청

### pipeline.js FAIL 중단
- 해당 단계 스크립트를 단독 실행해 원인 확인
- SEO QA FAIL: `state/campaigns/seo-qa-*.md` 확인
- coverage_score 미달: `node scripts/enrich-missing-data.js --hotel=[id]` 실행
