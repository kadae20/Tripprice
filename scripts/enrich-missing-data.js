#!/usr/bin/env node
/**
 * enrich-missing-data.js
 *
 * coverage score가 낮은 호텔을 찾아 보강 계획(enrichment plan)을 생성합니다.
 * 실제 크롤링/API 호출 없이 진단 및 전략 제안만 수행합니다.
 *
 * 사용법:
 *   node scripts/enrich-missing-data.js                  # 60점 미만 전체
 *   node scripts/enrich-missing-data.js --threshold=80   # 80점 미만
 *   node scripts/enrich-missing-data.js --hotel=haeundae-no-data
 *   node scripts/enrich-missing-data.js --all            # 전체 호텔 진단
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────
// 경로 설정
// ──────────────────────────────────────────────
const ROOT        = path.resolve(__dirname, '..');
const DIR_COVERAGE   = path.join(ROOT, 'state', 'coverage');
const DIR_PROCESSED  = path.join(ROOT, 'data', 'processed');
const DIR_CAMPAIGNS  = path.join(ROOT, 'state', 'campaigns');

// ──────────────────────────────────────────────
// 보강 전략 정의
// 각 coverage 항목에 대해 소스 우선순위와 방법 안내
// ──────────────────────────────────────────────
const ENRICHMENT_STRATEGIES = {
  photos_count: {
    label: '사진 ≥ 5장',
    sources: [
      { key: 'agoda_hotel_id', label: 'Agoda API', method: 'GET /hotels/{id}/images — 공식 파트너 이미지 목록 수집' },
      { key: 'source_url',     label: '공식 사이트', method: '호텔 공식 웹사이트 미디어 갤러리 확인 후 파트너 정책 허용 여부 검토' },
      { key: 'fallback',       label: '자체 제작', method: '지도·동선 인포그래픽·주변 랜드마크 이미지로 대체 (image-policy 참고)' },
    ],
  },
  amenities: {
    label: '어메니티 ≥ 10개',
    sources: [
      { key: 'agoda_hotel_id', label: 'Agoda API', method: 'GET /hotels/{id}/facilities — 시설 목록 수집' },
      { key: 'source_url',     label: '공식 사이트', method: '호텔 공식 페이지 시설 섹션 수동 확인' },
      { key: 'fallback',       label: '수동 조사', method: 'Booking.com / TripAdvisor 시설 항목 참조 후 팩트체크' },
    ],
  },
  location_description: {
    label: '위치 설명',
    sources: [
      { key: 'source_url',     label: '공식 사이트', method: '호텔 About/Location 페이지 참조 후 편집 작성' },
      { key: 'fallback',       label: '수동 작성', method: `위도/경도 기반 Google Maps 확인 → "[랜드마크] 인근, [역명] 도보 N분" 형식으로 작성` },
    ],
  },
  review_summary: {
    label: '후기 요약',
    sources: [
      { key: 'agoda_hotel_id', label: 'Agoda API', method: 'GET /hotels/{id}/reviews — 최신 리뷰 수집 후 요약 생성' },
      { key: 'fallback',       label: '수동 조사', method: 'Google/TripAdvisor 최근 리뷰 3~5개 분석 → 장단점 요약 (팩트체크 필수)' },
    ],
  },
  room_types: {
    label: '객실 타입 설명',
    sources: [
      { key: 'agoda_hotel_id', label: 'Agoda API', method: 'GET /hotels/{id}/rooms — 객실 타입 및 설명 수집' },
      { key: 'source_url',     label: '공식 사이트', method: '호텔 공식 예약 페이지에서 객실 타입 목록 확인' },
    ],
  },
  transport_info: {
    label: '교통/동선 정보',
    sources: [
      { key: 'fallback',       label: '수동 작성', method: `nearest_station + station_walk_min 필드 활용 → "[역명] X호선 도보 N분" 형식 작성` },
      { key: 'fallback',       label: '지도 조회', method: '위도/경도 기반 Google Maps 대중교통 경로 확인' },
    ],
  },
  price_min: {
    label: '가격대 정보',
    sources: [
      { key: 'agoda_hotel_id', label: 'Agoda API', method: 'GET /availability — 최저가 조회 (동적 데이터, 캐시 24시간)' },
      { key: 'fallback',       label: '수동 조회', method: 'Agoda/Booking.com 검색 결과 기준 가격대 확인 후 기록' },
    ],
  },
  checkin_time: {
    label: '체크인/아웃 정보',
    sources: [
      { key: 'agoda_hotel_id', label: 'Agoda API', method: 'GET /hotels/{id}/policies — 체크인/아웃 정책 수집' },
      { key: 'source_url',     label: '공식 사이트', method: '호텔 공식 페이지 예약 정책 페이지 확인' },
      { key: 'fallback',       label: '수동 조사', method: 'Booking.com 호텔 정책 탭에서 체크인/아웃 시간 확인' },
    ],
  },
};

// ──────────────────────────────────────────────
// 대체 전략 (전체 권장)
// ──────────────────────────────────────────────
const ALTERNATIVE_STRATEGIES = {
  A_achievable: {
    label: '보강 후 단독 리뷰 발행',
    description: '핵심 누락 필드만 보강하면 A등급 도달 가능. 우선 보강 진행.',
  },
  comparison_card: {
    label: '비교표 카드 전용 노출',
    description: '단독 리뷰 발행 금지. 지역/예산 비교표에 카드 형식으로만 포함. 데이터 보강 진행 중 표시.',
  },
  regional_guide: {
    label: '지역 가이드 전용 포함',
    description: '단독 페이지 없이 "[도시] 호텔 가이드" 글의 한 항목으로만 언급. 위치·가격대 정도만 기재.',
  },
  exclude: {
    label: '발행 제외 — 데이터 보강 후 재검토',
    description: '현재 발행 불가. enrich-missing-data 재실행 후 재평가 필요.',
  },
};

// ──────────────────────────────────────────────
// 데이터 로더
// ──────────────────────────────────────────────
function loadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function loadAllCoverage() {
  if (!fs.existsSync(DIR_COVERAGE)) return [];
  return fs.readdirSync(DIR_COVERAGE)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadJSON(path.join(DIR_COVERAGE, f)))
    .filter(Boolean);
}

function loadProcessedHotel(hotelId) {
  return loadJSON(path.join(DIR_PROCESSED, `${hotelId}.json`));
}

// ──────────────────────────────────────────────
// Gap 분석 — 어떤 항목이 0점인지
// ──────────────────────────────────────────────
function analyzeGaps(coverage) {
  const gaps = [];
  for (const [key, detail] of Object.entries(coverage.breakdown || {})) {
    if (!detail.passed) {
      gaps.push({
        key,
        label: detail.label,
        points: detail.points,
      });
    }
  }
  // 점수 높은 항목(보강 효과 큰 것) 순서로 정렬
  gaps.sort((a, b) => b.points - a.points);
  return gaps;
}

// ──────────────────────────────────────────────
// 필드별 보강 전략 생성
// ──────────────────────────────────────────────
function buildFieldStrategies(gaps, hotel) {
  return gaps.map((gap) => {
    const strategies = ENRICHMENT_STRATEGIES[gap.key];
    if (!strategies) {
      return { ...gap, strategies: [{ label: '수동 조사', method: '직접 데이터 수집 필요' }] };
    }

    // 사용 가능한 소스 기준으로 전략 필터링
    const applicable = strategies.sources.filter((s) => {
      if (s.key === 'fallback') return true;
      if (s.key === 'agoda_hotel_id') return !!(hotel && hotel.agoda_hotel_id);
      if (s.key === 'source_url') return !!(hotel && (hotel.source_url || hotel.partner_url));
      return false;
    });

    return {
      ...gap,
      strategies: applicable,
    };
  });
}

// ──────────────────────────────────────────────
// 전체 권장 대체 전략 결정
// ──────────────────────────────────────────────
function recommendStrategy(coverage, gaps, hotel) {
  const { score, grade } = coverage;
  const potentialGain = gaps.reduce((sum, g) => sum + g.points, 0);
  const achievableScore = score + potentialGain;

  // agoda_hotel_id 있으면 보강 가능성 높음
  const hasAgodaId = !!(hotel && hotel.agoda_hotel_id);

  if (grade === 'A') {
    return { ...ALTERNATIVE_STRATEGIES.A_achievable, key: 'A_achievable' };
  }

  if (grade === 'B') {
    if (achievableScore >= 80 && hasAgodaId) {
      return { ...ALTERNATIVE_STRATEGIES.A_achievable, key: 'A_achievable' };
    }
    return { ...ALTERNATIVE_STRATEGIES.comparison_card, key: 'comparison_card' };
  }

  if (grade === 'C') {
    if (achievableScore >= 60 && hasAgodaId) {
      return { ...ALTERNATIVE_STRATEGIES.A_achievable, key: 'A_achievable' };
    }
    return { ...ALTERNATIVE_STRATEGIES.regional_guide, key: 'regional_guide' };
  }

  // D등급
  if (achievableScore >= 60 && hasAgodaId) {
    return { ...ALTERNATIVE_STRATEGIES.comparison_card, key: 'comparison_card' };
  }
  return { ...ALTERNATIVE_STRATEGIES.exclude, key: 'exclude' };
}

// ──────────────────────────────────────────────
// 호텔 단위 보강 계획 생성
// ──────────────────────────────────────────────
function buildEnrichmentPlan(coverage) {
  const hotel = loadProcessedHotel(coverage.hotel_id);
  const gaps = analyzeGaps(coverage);
  const fieldStrategies = buildFieldStrategies(gaps, hotel);
  const recommendation = recommendStrategy(coverage, gaps, hotel);
  const potentialScore = coverage.score + gaps.reduce((s, g) => s + g.points, 0);

  return {
    hotel_id: coverage.hotel_id,
    hotel_name: coverage.hotel_name,
    current_score: coverage.score,
    grade: coverage.grade,
    potential_score: potentialScore,
    recommendation,
    gaps: fieldStrategies,
    meta: {
      has_agoda_id: !!(hotel && hotel.agoda_hotel_id),
      has_source_url: !!(hotel && (hotel.source_url || hotel.partner_url)),
      agoda_hotel_id: (hotel && hotel.agoda_hotel_id) || null,
      publish_status: (hotel && hotel.publish_status) || 'unknown',
      analyzed_at: new Date().toISOString(),
    },
  };
}

// ──────────────────────────────────────────────
// 마크다운 리포트 생성
// ──────────────────────────────────────────────
function generateMarkdownReport(plans, threshold, totalScanned) {
  const date = new Date().toISOString().split('T')[0];

  const byRecommendation = {
    A_achievable:   plans.filter((p) => p.recommendation.key === 'A_achievable'),
    comparison_card: plans.filter((p) => p.recommendation.key === 'comparison_card'),
    regional_guide: plans.filter((p) => p.recommendation.key === 'regional_guide'),
    exclude:        plans.filter((p) => p.recommendation.key === 'exclude'),
  };

  let md = `# Tripprice — 데이터 보강 계획 리포트\n\n`;
  md += `- 실행 일시: ${new Date().toISOString()}\n`;
  md += `- 기준 threshold: ${threshold}점 미만\n`;
  md += `- 전체 스캔: ${totalScanned}개 호텔 / 대상: ${plans.length}개\n\n`;

  // 요약 테이블
  md += `## 처리 결과 요약\n\n`;
  md += `| 전략 | 수 |\n|------|----|\n`;
  md += `| 보강 후 단독 리뷰 발행 가능 | ${byRecommendation.A_achievable.length} |\n`;
  md += `| 비교표 카드 전용 노출 | ${byRecommendation.comparison_card.length} |\n`;
  md += `| 지역 가이드 전용 포함 | ${byRecommendation.regional_guide.length} |\n`;
  md += `| 발행 제외 권장 | ${byRecommendation.exclude.length} |\n\n`;

  // 호텔별 상세
  md += `---\n\n## 호텔별 보강 계획\n\n`;

  for (const plan of plans) {
    const scoreBar = '█'.repeat(Math.floor(plan.current_score / 10)) +
                     '░'.repeat(10 - Math.floor(plan.current_score / 10));
    const arrow = plan.potential_score > plan.current_score
      ? ` → 보강 시 최대 **${plan.potential_score}점** 가능`
      : '';

    md += `### ${plan.hotel_name} \`${plan.hotel_id}\`\n\n`;
    md += `- 현재 점수: **${plan.current_score}점** (${plan.grade}등급)  \`${scoreBar}\`${arrow}\n`;
    md += `- Agoda ID: ${plan.meta.agoda_hotel_id || '없음'}\n`;
    md += `- publish_status: \`${plan.meta.publish_status}\`\n`;
    md += `- **권장 전략: ${plan.recommendation.label}**\n`;
    md += `  > ${plan.recommendation.description}\n\n`;

    if (plan.gaps.length === 0) {
      md += `모든 항목 충족 중.\n\n`;
    } else {
      md += `#### 누락 항목 및 보강 방법\n\n`;
      for (const gap of plan.gaps) {
        md += `**[+${gap.points}점] ${gap.label}**\n`;
        for (const s of gap.strategies) {
          md += `- \`${s.label}\` — ${s.method}\n`;
        }
        md += '\n';
      }
    }

    md += `---\n\n`;
  }

  md += `*다음 단계: 보강 완료 후 \`node scripts/ingest-hotel-data.js\` 재실행하여 점수 갱신*\n`;

  return { md, date };
}

// ──────────────────────────────────────────────
// 파일 저장 헬퍼
// ──────────────────────────────────────────────
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function saveJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ──────────────────────────────────────────────
// CLI 인수 파싱
// ──────────────────────────────────────────────
function parseArgs(argv) {
  const args = { threshold: 60, hotelId: null, all: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--all') {
      args.all = true;
    } else if (arg.startsWith('--threshold=')) {
      const n = parseInt(arg.split('=')[1], 10);
      if (!isNaN(n)) args.threshold = n;
    } else if (arg.startsWith('--hotel=')) {
      args.hotelId = arg.split('=')[1];
    }
  }
  return args;
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────
function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' Tripprice — 데이터 보강 계획 생성');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const args = parseArgs(process.argv);

  if (!fs.existsSync(DIR_COVERAGE)) {
    console.error(`[오류] state/coverage/ 폴더 없음. 먼저 ingest-hotel-data.js를 실행하세요.`);
    process.exit(1);
  }

  // coverage 파일 로드
  let coverageList = loadAllCoverage();
  const totalScanned = coverageList.length;

  if (totalScanned === 0) {
    console.log('coverage 데이터 없음. ingest-hotel-data.js를 먼저 실행하세요.');
    process.exit(0);
  }

  // 필터링
  if (args.hotelId) {
    coverageList = coverageList.filter((c) => c.hotel_id === args.hotelId);
    if (coverageList.length === 0) {
      console.error(`[오류] hotel_id를 찾을 수 없음: ${args.hotelId}`);
      process.exit(1);
    }
    console.log(`단일 호텔 진단: ${args.hotelId}\n`);
  } else if (args.all) {
    console.log(`전체 호텔 진단 (${totalScanned}개)\n`);
  } else {
    coverageList = coverageList.filter((c) => c.score < args.threshold);
    console.log(`threshold ${args.threshold}점 미만 대상: ${coverageList.length}/${totalScanned}개\n`);
  }

  if (coverageList.length === 0) {
    console.log(`모든 호텔이 ${args.threshold}점 이상입니다. 보강 대상 없음.\n`);
    process.exit(0);
  }

  // 점수 낮은 순서로 정렬
  coverageList.sort((a, b) => a.score - b.score);

  // 보강 계획 생성
  const plans = [];
  for (const coverage of coverageList) {
    const plan = buildEnrichmentPlan(coverage);
    plans.push(plan);

    // 호텔별 JSON 저장
    const planPath = path.join(DIR_CAMPAIGNS, `enrichment-plan-${coverage.hotel_id}.json`);
    saveJSON(planPath, plan);

    const icon = { A_achievable: '↑', comparison_card: '▣', regional_guide: '◎', exclude: '✗' }[plan.recommendation.key];
    console.log(
      `  ${icon} ${coverage.hotel_id.padEnd(30)} ${String(coverage.score).padStart(3)}점 (${coverage.grade}) → ${plan.recommendation.label}`
    );
  }

  // 마크다운 리포트 저장
  ensureDir(DIR_CAMPAIGNS);
  const { md, date } = generateMarkdownReport(plans, args.threshold, totalScanned);
  const reportPath = path.join(DIR_CAMPAIGNS, `enrichment-report-${date}.md`);
  fs.writeFileSync(reportPath, md, 'utf8');

  // 요약
  const byKey = (key) => plans.filter((p) => p.recommendation.key === key).length;
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` 대상: ${plans.length}개 호텔`);
  console.log(` ↑ 보강 후 발행 가능:  ${byKey('A_achievable')}`);
  console.log(` ▣ 비교표 카드 전용:   ${byKey('comparison_card')}`);
  console.log(` ◎ 지역 가이드 전용:   ${byKey('regional_guide')}`);
  console.log(` ✗ 발행 제외 권장:     ${byKey('exclude')}`);
  console.log(` 리포트: state/campaigns/enrichment-report-${date}.md`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main();
