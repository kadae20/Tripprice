#!/usr/bin/env node
/**
 * coverage-report.js
 *
 * 전체 호텔 coverage 상태를 요약하고 발행 가능 여부를 한눈에 보여줍니다.
 *
 * 사용법:
 *   node scripts/coverage-report.js               # 전체 요약
 *   node scripts/coverage-report.js --top=10      # 상위/하위 10개
 *   node scripts/coverage-report.js --grade=A     # A등급만
 *   node scripts/coverage-report.js --action=needs-enrichment
 *   node scripts/coverage-report.js --json        # JSON 요약 파일 추가 저장
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ──────────────────────────────────────────────
// 경로 설정
// ──────────────────────────────────────────────
const ROOT         = path.resolve(__dirname, '..');
const DIR_COVERAGE = path.join(ROOT, 'state', 'coverage');
const DIR_CAMPAIGNS = path.join(ROOT, 'state', 'campaigns');

// ──────────────────────────────────────────────
// 액션 분류
// ──────────────────────────────────────────────
const ACTION_MAP = {
  A: { key: 'publish-ready',     label: '발행 가능',       icon: '✓' },
  B: { key: 'publish-ready',     label: '발행 가능',       icon: '✓' },
  C: { key: 'needs-enrichment',  label: '보강 필요',       icon: '⚠' },
  D: { key: 'exclude',           label: '발행 제외 권장',  icon: '✗' },
};

// ──────────────────────────────────────────────
// 데이터 로더
// ──────────────────────────────────────────────
function loadAllCoverage() {
  if (!fs.existsSync(DIR_COVERAGE)) return [];
  return fs.readdirSync(DIR_COVERAGE)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(DIR_COVERAGE, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
}

// ──────────────────────────────────────────────
// CLI 인수 파싱
// ──────────────────────────────────────────────
function parseArgs(argv) {
  const args = { top: 5, grade: null, action: null, json: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') {
      args.json = true;
    } else if (arg.startsWith('--top=')) {
      const n = parseInt(arg.split('=')[1], 10);
      if (!isNaN(n) && n > 0) args.top = n;
    } else if (arg.startsWith('--grade=')) {
      args.grade = arg.split('=')[1].toUpperCase();
    } else if (arg.startsWith('--action=')) {
      args.action = arg.split('=')[1].toLowerCase();
    }
  }
  return args;
}

// ──────────────────────────────────────────────
// 전체 통계 계산
// ──────────────────────────────────────────────
function calcStats(hotels) {
  const gradeDist = { A: 0, B: 0, C: 0, D: 0 };
  const actionDist = { 'publish-ready': 0, 'needs-enrichment': 0, 'exclude': 0 };
  let totalScore = 0;

  for (const h of hotels) {
    gradeDist[h.grade] = (gradeDist[h.grade] || 0) + 1;
    const action = ACTION_MAP[h.grade];
    if (action) actionDist[action.key]++;
    totalScore += h.score;
  }

  return {
    total: hotels.length,
    gradeDist,
    actionDist,
    avgScore: hotels.length > 0 ? Math.round(totalScore / hotels.length) : 0,
  };
}

// ──────────────────────────────────────────────
// 콘솔 테이블 출력
// ──────────────────────────────────────────────
function printTable(hotels, title) {
  if (hotels.length === 0) return;
  console.log(`\n  ${title}`);
  console.log('  ' + '─'.repeat(72));
  console.log(`  ${'호텔 ID'.padEnd(32)} ${'점수'.padStart(4)} ${'등급'.padEnd(4)} ${'액션'}`);
  console.log('  ' + '─'.repeat(72));
  for (const h of hotels) {
    const action = ACTION_MAP[h.grade];
    const icon   = action ? action.icon : '?';
    const label  = action ? action.label : '-';
    const name   = h.hotel_name ? ` (${h.hotel_name})` : '';
    const idLine = (h.hotel_id + name).substring(0, 31).padEnd(32);
    console.log(`  ${icon} ${idLine} ${String(h.score).padStart(4)}점  ${h.grade}   ${label}`);
  }
  console.log('  ' + '─'.repeat(72));
}

// ──────────────────────────────────────────────
// Markdown 리포트 생성
// ──────────────────────────────────────────────
function generateMarkdown(all, filtered, stats, args) {
  const date = new Date().toISOString().split('T')[0];
  const sorted = [...all].sort((a, b) => b.score - a.score);
  const top    = sorted.slice(0, args.top);
  const bottom = sorted.slice(-args.top).reverse();

  let md = `# Tripprice — Coverage 현황 리포트\n\n`;
  md += `- 실행 일시: ${new Date().toISOString()}\n`;
  if (args.grade)  md += `- 필터: 등급 ${args.grade}\n`;
  if (args.action) md += `- 필터: 액션 ${args.action}\n`;
  md += `\n`;

  // 전체 요약 (필터와 무관하게 항상 전체 기준)
  md += `## 전체 요약\n\n`;
  md += `| 항목 | 수 |\n|------|----|\n`;
  md += `| 총 호텔 수 | ${stats.total} |\n`;
  md += `| 평균 coverage 점수 | ${stats.avgScore}점 |\n`;
  md += `| A등급 (80~100점) | ${stats.gradeDist.A} |\n`;
  md += `| B등급 (60~79점) | ${stats.gradeDist.B} |\n`;
  md += `| C등급 (40~59점) | ${stats.gradeDist.C} |\n`;
  md += `| D등급 (0~39점) | ${stats.gradeDist.D} |\n`;
  md += `| ✓ 발행 가능 (A+B) | ${stats.actionDist['publish-ready']} |\n`;
  md += `| ⚠ 보강 필요 (C) | ${stats.actionDist['needs-enrichment']} |\n`;
  md += `| ✗ 발행 제외 권장 (D) | ${stats.actionDist['exclude']} |\n\n`;

  // 상위 TOP N
  md += `## 상위 커버리지 호텔 TOP ${args.top}\n\n`;
  md += `| hotel_id | 호텔명 | 점수 | 등급 | 액션 |\n`;
  md += `|----------|--------|------|------|------|\n`;
  for (const h of top) {
    const action = ACTION_MAP[h.grade] || { label: '-' };
    md += `| \`${h.hotel_id}\` | ${h.hotel_name || '-'} | ${h.score}점 | ${h.grade} | ${action.label} |\n`;
  }
  md += '\n';

  // 하위 TOP N
  md += `## 하위 커버리지 호텔 TOP ${args.top} (보강 우선순위)\n\n`;
  md += `| hotel_id | 호텔명 | 점수 | 등급 | 액션 |\n`;
  md += `|----------|--------|------|------|------|\n`;
  for (const h of bottom) {
    const action = ACTION_MAP[h.grade] || { label: '-' };
    md += `| \`${h.hotel_id}\` | ${h.hotel_name || '-'} | ${h.score}점 | ${h.grade} | ${action.label} |\n`;
  }
  md += '\n';

  // 필터 적용 목록 (필터가 없으면 전체 목록)
  const listTitle = (args.grade || args.action)
    ? `## 필터 결과 (${filtered.length}개)`
    : `## 전체 호텔 목록`;
  md += `${listTitle}\n\n`;
  md += `| hotel_id | 호텔명 | 점수 | 등급 | 액션 |\n`;
  md += `|----------|--------|------|------|------|\n`;
  for (const h of filtered) {
    const action = ACTION_MAP[h.grade] || { label: '-' };
    md += `| \`${h.hotel_id}\` | ${h.hotel_name || '-'} | ${h.score}점 | ${h.grade} | ${action.label} |\n`;
  }
  md += '\n';

  md += `---\n`;
  md += `*보강 대상 상세 계획: \`node scripts/enrich-missing-data.js\`*\n`;

  return { md, date };
}

// ──────────────────────────────────────────────
// 파일 저장 헬퍼
// ──────────────────────────────────────────────
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────
function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' Tripprice — Coverage 현황 리포트');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const args = parseArgs(process.argv);

  if (!fs.existsSync(DIR_COVERAGE)) {
    console.error('[오류] state/coverage/ 없음. ingest-hotel-data.js를 먼저 실행하세요.');
    process.exit(1);
  }

  const all = loadAllCoverage();
  if (all.length === 0) {
    console.log('coverage 데이터 없음. ingest-hotel-data.js를 먼저 실행하세요.');
    process.exit(0);
  }

  // 점수 내림차순 정렬
  all.sort((a, b) => b.score - a.score);

  // 필터 적용
  let filtered = all;
  if (args.grade) {
    filtered = filtered.filter((h) => h.grade === args.grade);
  }
  if (args.action) {
    filtered = filtered.filter((h) => {
      const action = ACTION_MAP[h.grade];
      return action && action.key === args.action;
    });
  }

  const stats = calcStats(all);

  // ── 콘솔 출력 ──────────────────────────────
  console.log(`  총 호텔: ${stats.total}개 | 평균 점수: ${stats.avgScore}점`);
  console.log(`  ✓ 발행 가능: ${stats.actionDist['publish-ready']}  ` +
              `⚠ 보강 필요: ${stats.actionDist['needs-enrichment']}  ` +
              `✗ 발행 제외: ${stats.actionDist['exclude']}`);
  console.log(`  등급 분포: A=${stats.gradeDist.A}  B=${stats.gradeDist.B}  C=${stats.gradeDist.C}  D=${stats.gradeDist.D}`);

  // 상위/하위
  const top    = all.slice(0, args.top);
  const bottom = [...all].reverse().slice(0, args.top);
  printTable(top, `상위 TOP ${args.top}`);
  printTable(bottom, `하위 TOP ${args.top} (보강 우선순위)`);

  // 필터 결과
  if (args.grade || args.action) {
    const filterDesc = [args.grade && `등급=${args.grade}`, args.action && `액션=${args.action}`]
      .filter(Boolean).join(', ');
    printTable(filtered, `필터 결과 [${filterDesc}] — ${filtered.length}개`);
  }

  // ── 파일 저장 ──────────────────────────────
  ensureDir(DIR_CAMPAIGNS);
  const { md, date } = generateMarkdown(all, filtered, stats, args);
  const reportPath = path.join(DIR_CAMPAIGNS, `coverage-report-${date}.md`);
  fs.writeFileSync(reportPath, md, 'utf8');

  if (args.json) {
    const summary = {
      generated_at: new Date().toISOString(),
      stats,
      hotels: all.map((h) => ({
        hotel_id: h.hotel_id,
        hotel_name: h.hotel_name,
        score: h.score,
        grade: h.grade,
        action: ACTION_MAP[h.grade]?.key || 'unknown',
        action_label: ACTION_MAP[h.grade]?.label || '-',
        missing: h.missing || [],
      })),
    };
    const jsonPath = path.join(DIR_CAMPAIGNS, `coverage-summary-${date}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`\n  JSON: state/campaigns/coverage-summary-${date}.json`);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(` 리포트: state/campaigns/coverage-report-${date}.md`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main();
