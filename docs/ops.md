# Tripprice 운영 가이드 (VPS 크론 설정)

## Supabase 초기 설정 (최초 1회)

```sql
-- Supabase 대시보드 > SQL Editor에서 실행
create table published_signatures (
  slug        text primary key,
  date        date,
  simhash     text        not null,    -- 64-bit SimHash (16진수)
  minhash     integer[]   not null,    -- 64개 MinHash 값 (해시만, 텍스트 없음)
  created_at  timestamptz default now()
);

create table editorial_jobs (
  id          bigserial primary key,
  date        date        not null,
  slug        text        not null,
  status      text        not null,
  lang        text        default 'ko',
  source      text,
  score       integer,
  created_at  timestamptz default now()
);

create table kpi_monthly (
  id              bigserial primary key,
  month           text unique not null,
  clicks          integer,
  bookings        integer,
  revenue_krw     integer,
  server_cost_krw integer,
  net_krw         integer,
  posts_published integer,
  updated_at      timestamptz default now()
);
```

## 서버 요구사항
- Node.js 18+
- 환경변수: `.env.local` → `_run-with-env.js` 자동 로드
- Playwright (월간 리포트용): `npm install --save-dev playwright && npx playwright install chromium`

## 일일 자동화 (Daily Cron)

```cron
# 매일 06:50 KST: daily-jobs.json 자동 생성
50 21 * * * cd /home/ubuntu/tripprice && node scripts/_run-with-env.js scripts/scheduler-generate-jobs.js >> logs/scheduler.log 2>&1
```

```cron
# 매일 오전 07:00 KST (UTC+9 → UTC 22:00 전날)
0 22 * * * cd /home/ubuntu/tripprice && node scripts/_run-with-env.js scripts/newsroom.js daily >> logs/newsroom-daily.log 2>&1
```

자동 발행 모드:
```cron
0 22 * * * cd /home/ubuntu/tripprice && node scripts/_run-with-env.js scripts/newsroom.js daily --auto-publish >> logs/newsroom-daily.log 2>&1
```

## 월간 KPI 리포트 (Monthly Cron)

```cron
# 매월 말일 23:50 KST (UTC 14:50)
50 14 28-31 * * [ "$(date +\%d)" = "$(cal | awk 'NF{f=$NF} END{print f}')" ] && \
  cd /home/ubuntu/tripprice && node scripts/_run-with-env.js scripts/newsroom.js monthly >> logs/newsroom-monthly.log 2>&1
```

## 로그 디렉토리 초기화

```bash
mkdir -p /home/ubuntu/tripprice/logs
```

## 환경변수 설정

```bash
cp .env.example .env.local
nano .env.local
# ZAI_API_KEY, WP_*, TELEGRAM_*, NOTION_*, AGODA_PARTNER_* 값 입력
```

## 수동 실행

```bash
# 일일 실행 (안전 모드: wp-publish 제외)
node scripts/_run-with-env.js scripts/newsroom.js daily

# 일일 실행 (자동 발행)
node scripts/_run-with-env.js scripts/newsroom.js daily --auto-publish

# 월간 KPI
node scripts/_run-with-env.js scripts/newsroom.js monthly --month=2026-02

# 특정 호텔 수동 파이프라인
node scripts/_run-with-env.js scripts/pipeline.js --hotels=grand-hyatt-seoul

# 승인 게이트 수동 실행
node scripts/approval-gate.js --slug=grand-hyatt-seoul-2026-03-07
```

## 호텔 데이터 파일 주간 갱신

Agoda 파트너 허브에서 받은 zip 파일을 주 1회 자동 동기화합니다.

### 사전 준비 (EC2 최초 1회)

```bash
sudo apt install unzip -y
```

`.env.local`에 URL 설정 (필수):

```bash
# partners.agoda.com → Tools → Hotel Data → 다운로드 버튼 우클릭 → 링크 주소 복사
AGODA_HOTELDATA_URL=https://xml.agoda.com/hoteldatafiles/…?token=…
```

선택 변수:
```bash
HOTELDATA_KEEP=1                    # 주차 폴더 보관 수 (기본 1 = latest만)
HOTELDATA_DIR=downloads/agoda/hoteldata   # 저장 경로 (기본값)

# subset 추출 조건
HOTELDATA_CITIES=seoul,busan,jeju   # 추출 도시 (기본값)
HOTELDATA_EXTRACT_ROWS=50000        # 최대 행 수 (기본값)
HOTELDATA_EXTRACT_HOTELS=10000      # 최대 유니크 호텔 수 (기본값)

# 단계 생략 (선택)
HOTELDATA_SKIP_EXTRACT=true         # extract 건너뜀 (latest.csv만 갱신)
HOTELDATA_SKIP_INGEST=true          # ingest 건너뜀 (extract까지만)
```

### 디스크/메모리 주의점

| 파일 | 크기 | 비고 |
|------|------|------|
| `hoteldata.zip` | ~300MB | 주간 원본, KEEP 주차만 보관 |
| `hotels-latest.csv` | ~2GB | 전체 데이터, 저장만 함 |
| `hotels-subset.csv` | ~수십MB | seoul/busan/jeju subset만 |
| `data/processed/*.json` | 호텔당 ~1KB | subset 기준 ingest 결과 |

**핵심**: `ingest-hotel-data.js`는 **subset.csv만** 처리. latest.csv 전체 로드 금지(OOM).

### 수동 실행

```bash
# dry-run: 링크 확인 / 경로만 출력 (실제 다운로드 없음)
node scripts/_run-with-env.js scripts/agoda-hoteldata-sync.js --dry-run

# 실제 실행
npm run hoteldata:sync

# 강제 재다운로드 (이번 주차 이미 존재해도 재실행)
node scripts/_run-with-env.js scripts/agoda-hoteldata-sync.js --force
```

### 결과물

| 경로 | 내용 |
|------|------|
| `downloads/agoda/hoteldata/YYYY-WNN/hoteldata.zip` | 원본 zip (최근 2주 보관) |
| `downloads/agoda/hoteldata/YYYY-WNN/hoteldata.csv` | 압축 해제 CSV |
| `data/hotels/hotels-latest.csv` | 항상 최신 CSV (원자적 교체) |
| `data/processed/*.json` | ingest 결과 (호텔별) |

### 자동 타이머 (systemd)

```
tripprice-hoteldata.timer  매주 월요일 03:30 KST (일 18:30 UTC)
```

로그 확인:
```bash
tail -f /home/ubuntu/tripprice/logs/hoteldata-sync.log
journalctl -u tripprice-hoteldata.service -f
```

타이머 상태 확인:
```bash
systemctl list-timers | grep hoteldata
```

---

## 작업 목록 수정

`config/daily-jobs.json` 편집:
```json
[
  { "hotels": "hotel-id-1,hotel-id-2", "lang": "ko" },
  { "hotels": "hotel-id-3",            "lang": "en" }
]
```

`hotel-id`는 `data/hotels/` DB의 `hotel_id` 값과 일치해야 합니다.

## 동시 실행 수 조정

```bash
node scripts/newsroom.js daily --concurrency=5  # 기본: 3, 최대: 5
```

## 확장: 50건/일 운영

- `config/daily-jobs.json`에 50개 job 등록
- `--concurrency=5` 설정
- VPS 최소 사양: CPU 2코어, RAM 2GB
- Z.ai API 속도 제한 확인 (글당 1회 호출, 병렬 5개 동시)
- 유사도 게이트 통과 후 발행 → 중복 콘텐츠 자동 차단
- `state/newsroom-log-{date}.json` 로 일일 상태 추적
