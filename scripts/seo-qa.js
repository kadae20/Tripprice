#!/usr/bin/env node
/**
 * seo-qa.js
 * 마크다운 초안의 SEO·발행 품질을 자동 점검.
 *
 * 사용법:
 *   node scripts/seo-qa.js --draft=draft-seoul-luxury-comparison-2026-03-05
 *   node scripts/seo-qa.js --draft=wordpress/drafts/draft-xxx.md
 *   node scripts/seo-qa.js --draft=draft-xxx --json
 */

const fs = require('fs');
const path = require('path');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

if (!args.draft) {
  console.error('오류: --draft 옵션이 필요합니다.');
  console.error('  예: node scripts/seo-qa.js --draft=draft-seoul-luxury-comparison-2026-03-05');
  process.exit(1);
}

const DRAFTS_DIR   = path.join(__dirname, '..', 'wordpress', 'drafts');
const CAMPAIGN_DIR = path.join(__dirname, '..', 'state', 'campaigns');
fs.mkdirSync(CAMPAIGN_DIR, { recursive: true });

function resolveDraftPath(input) {
  for (const candidate of [
    input,
    input.endsWith('.md') ? input : `${input}.md`,
    path.join(DRAFTS_DIR, input.endsWith('.md') ? input : `${input}.md`),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const draftPath = resolveDraftPath(args.draft);
if (!draftPath) {
  console.error(`초안 파일을 찾을 수 없습니다: ${args.draft}`);
  process.exit(1);
}

const raw = fs.readFileSync(draftPath, 'utf8');
const today = new Date().toISOString().split('T')[0];

// ── front-matter 파싱 ─────────────────────────────────────────────────────────
function parseFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return Object.fromEntries(
    match[1].split('\n')
      .filter(l => l.includes(':'))
      .map(l => {
        const idx = l.indexOf(':');
        const key = l.slice(0, idx).trim();
        const val = l.slice(idx + 1).trim().replace(/^"|"$/g, '');
        return [key, val];
      })
  );
}

const fm = parseFrontMatter(raw);
const body = raw.replace(/^---[\s\S]*?---\n/, '');
const lines = body.split('\n');

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────
const hasSection = (keyword) =>
  lines.some(l => l.startsWith('## ') && l.includes(keyword));

const countH1 = lines.filter(l => l.startsWith('# ') && !l.startsWith('## ')).length;
const h2s     = lines.filter(l => l.startsWith('## ')).map(l => l.replace('## ', '').trim());
const ctaCount = (raw.match(/현재 가격 확인하기|Check current prices/g) || []).length;
const internalLinkCount = (body.match(/\[.*?\]\(\/ko\//g) || []).length;

const hasPriceNotice    = raw.includes('가격·혜택·환불 규정');
const hasAffiliateNotice = raw.includes('아고다 파트너 링크');

// ── 점검 규칙 ─────────────────────────────────────────────────────────────────
// 각 항목: { id, label, check() → { status, message } }

const CHECKS = [
  {
    id: 'title-exists',
    label: 'SEO title 존재',
    check() {
      if (!fm.title) return fail('title 필드가 없습니다');
      return pass(`"${fm.title}"`);
    },
  },
  {
    id: 'title-length',
    label: 'SEO title 길이 (≤60자)',
    check() {
      if (!fm.title) return skip('title 없음');
      const len = fm.title.length;
      if (len > 60) return fail(`${len}자 — 60자 이하로 줄이세요`);
      if (len < 20) return warn(`${len}자 — 너무 짧을 수 있습니다`);
      return pass(`${len}자`);
    },
  },
  {
    id: 'slug-exists',
    label: 'slug 존재',
    check() {
      if (!fm.slug) return fail('slug 필드가 없습니다');
      return pass(`"${fm.slug}"`);
    },
  },
  {
    id: 'slug-format',
    label: 'slug 형식 (소문자-하이픈)',
    check() {
      if (!fm.slug) return skip('slug 없음');
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.slug))
        return fail(`"${fm.slug}" — 소문자+하이픈 형식이 아닙니다`);
      const words = fm.slug.split('-').length;
      if (words < 3) return warn(`단어 ${words}개 — 3~5단어 권장`);
      if (words > 5) return warn(`단어 ${words}개 — 3~5단어 권장`);
      return pass(`${words}단어`);
    },
  },
  {
    id: 'meta-exists',
    label: 'meta_description 존재',
    check() {
      if (!fm.meta_description) return fail('meta_description 필드가 없습니다');
      return pass('존재');
    },
  },
  {
    id: 'meta-length',
    label: 'meta_description 길이 (120~155자)',
    check() {
      if (!fm.meta_description) return skip('meta_description 없음');
      const len = fm.meta_description.length;
      if (len < 120) return warn(`${len}자 — 120자 이상 권장`);
      if (len > 155) return fail(`${len}자 — 155자 이하로 줄이세요`);
      return pass(`${len}자`);
    },
  },
  {
    id: 'h1-count',
    label: 'H1 정확히 1개',
    check() {
      if (countH1 === 0) return fail('H1이 없습니다');
      if (countH1 > 1)  return fail(`H1이 ${countH1}개 — 1개만 허용`);
      return pass('1개');
    },
  },
  {
    id: 'h2-count',
    label: 'H2 최소 3개',
    check() {
      if (h2s.length < 3) return fail(`H2 ${h2s.length}개 — 최소 3개 필요`);
      return pass(`${h2s.length}개`);
    },
  },
  {
    id: 'section-target-reader',
    label: '"이 글이 필요한 사람" 섹션',
    check() {
      if (!hasSection('이 글이 필요한 사람')) return fail('섹션 없음');
      return pass('존재');
    },
  },
  {
    id: 'section-criteria',
    label: '"선택 기준" 섹션',
    check() {
      if (!hasSection('선택 기준')) return fail('섹션 없음');
      return pass('존재');
    },
  },
  {
    id: 'section-faq',
    label: 'FAQ 섹션',
    check() {
      if (!hasSection('자주 묻는 질문') && !hasSection('FAQ')) return fail('FAQ 섹션 없음');
      const qCount = (raw.match(/\*\*Q\./g) || []).length;
      if (qCount < 3) return warn(`FAQ ${qCount}개 — 3개 이상 권장`);
      return pass(`${qCount}개 항목`);
    },
  },
  {
    id: 'cta-exists',
    label: 'CTA 존재 (≥1, ≤4개)',
    check() {
      if (ctaCount === 0) return fail('CTA가 없습니다');
      if (ctaCount > 4)  return warn(`CTA ${ctaCount}개 — 4개 이하 권장`);
      return pass(`${ctaCount}개`);
    },
  },
  {
    id: 'internal-links',
    label: '내부 링크 제안 (≥2개)',
    check() {
      if (!hasSection('내부 링크')) return warn('내부 링크 섹션 없음');
      if (internalLinkCount < 2) return warn(`내부 링크 ${internalLinkCount}개 — 2개 이상 권장`);
      return pass(`${internalLinkCount}개`);
    },
  },
  {
    id: 'price-notice',
    label: '가격 변동 고지 문구',
    check() {
      if (!hasPriceNotice) return fail('가격 고지 문구 없음 (필수)');
      return pass('존재');
    },
  },
  {
    id: 'affiliate-notice',
    label: '제휴 링크 고지 문구',
    check() {
      if (!hasAffiliateNotice) {
        if (ctaCount > 0) return fail('CTA 있으나 제휴 고지 문구 없음 (필수)');
        return warn('제휴 고지 문구 없음 (CTA 삽입 시 필수)');
      }
      return pass('존재');
    },
  },
  {
    id: 'lang-declared',
    label: 'lang 필드 선언',
    check() {
      if (!fm.lang) return warn('lang 필드 없음 — ko/en/ja 명시 권장');
      if (!['ko', 'en', 'ja'].includes(fm.lang)) return warn(`알 수 없는 lang: "${fm.lang}"`);
      return pass(fm.lang);
    },
  },
];

// ── 결과 생성 ─────────────────────────────────────────────────────────────────
function pass(msg)  { return { status: 'PASS', message: msg }; }
function warn(msg)  { return { status: 'WARN', message: msg }; }
function fail(msg)  { return { status: 'FAIL', message: msg }; }
function skip(msg)  { return { status: 'SKIP', message: msg }; }

const results = CHECKS.map(c => ({ ...c, result: c.check() }));

const counts = { PASS: 0, WARN: 0, FAIL: 0, SKIP: 0 };
results.forEach(r => counts[r.result.status]++);

const publishable = counts.FAIL === 0;
const slug = fm.slug || path.basename(draftPath, '.md').replace(/^draft-/, '');

// ── 리포트 마크다운 생성 ──────────────────────────────────────────────────────
const ICON = { PASS: '✅', WARN: '⚠️', FAIL: '❌', SKIP: '⏭️' };

const reportLines = [
  `# SEO QA 리포트`,
  ``,
  `- **초안 파일:** \`${path.basename(draftPath)}\``,
  `- **슬러그:** \`${slug}\``,
  `- **점검 일시:** ${today}`,
  `- **발행 가능:** ${publishable ? '✅ 가능' : '❌ 불가 (FAIL 항목 해결 필요)'}`,
  ``,
  `---`,
  ``,
  `## 점검 결과`,
  ``,
  `| 상태 | 항목 | 결과 |`,
  `|------|------|------|`,
];

results.forEach(r => {
  const icon = ICON[r.result.status];
  reportLines.push(`| ${icon} ${r.result.status} | ${r.label} | ${r.result.message} |`);
});

reportLines.push('');
reportLines.push('---');
reportLines.push('');
reportLines.push('## 요약');
reportLines.push('');
reportLines.push(`| 구분 | 건수 |`);
reportLines.push(`|------|------|`);
reportLines.push(`| ✅ PASS | ${counts.PASS} |`);
reportLines.push(`| ⚠️ WARN | ${counts.WARN} |`);
reportLines.push(`| ❌ FAIL | ${counts.FAIL} |`);
reportLines.push(`| ⏭️ SKIP | ${counts.SKIP} |`);
reportLines.push(`| 합계 | ${results.length} |`);
reportLines.push('');
reportLines.push(`**발행 가능 여부:** ${publishable ? '✅ 발행 가능' : '❌ 발행 불가 — FAIL 항목을 수정한 후 재점검하세요.'}`);

if (counts.FAIL > 0) {
  reportLines.push('');
  reportLines.push('### FAIL 항목 목록');
  results.filter(r => r.result.status === 'FAIL').forEach(r => {
    reportLines.push(`- **${r.label}:** ${r.result.message}`);
  });
}

if (counts.WARN > 0) {
  reportLines.push('');
  reportLines.push('### WARN 항목 목록');
  results.filter(r => r.result.status === 'WARN').forEach(r => {
    reportLines.push(`- **${r.label}:** ${r.result.message}`);
  });
}

reportLines.push('');
if (publishable) {
  reportLines.push('---');
  reportLines.push('');
  reportLines.push('*다음 단계:*');
  reportLines.push('```');
  reportLines.push(`node scripts/build-wp-post.js --draft=${path.basename(draftPath, '.md')}`);
  reportLines.push('```');
}

const reportMd = reportLines.join('\n');

// ── 파일 저장 ─────────────────────────────────────────────────────────────────
const reportFilename = `seo-qa-${slug}-${today}.md`;
const reportPath = path.join(CAMPAIGN_DIR, reportFilename);
fs.writeFileSync(reportPath, reportMd, 'utf8');

if (args.json) {
  const jsonPath = reportPath.replace('.md', '.json');
  fs.writeFileSync(jsonPath, JSON.stringify({
    draft: path.basename(draftPath),
    slug,
    date: today,
    publishable,
    counts,
    results: results.map(r => ({ id: r.id, label: r.label, status: r.result.status, message: r.result.message })),
  }, null, 2), 'utf8');
  console.log(`  JSON: ${jsonPath}`);
}

// ── 콘솔 출력 ─────────────────────────────────────────────────────────────────
console.log('\nSEO QA 점검 완료');
console.log(`  리포트: ${reportPath}`);
console.log('');
results.forEach(r => {
  const icon = ICON[r.result.status];
  const label = r.label.padEnd(30);
  console.log(`  ${icon} ${label} ${r.result.message}`);
});
console.log('');
console.log(`  총 ${results.length}개 항목  |  PASS ${counts.PASS}  WARN ${counts.WARN}  FAIL ${counts.FAIL}  SKIP ${counts.SKIP}`);
console.log(`  발행 가능: ${publishable ? '✅ 가능' : '❌ 불가'}`);

if (!publishable) {
  console.log('\n  FAIL 항목:');
  results.filter(r => r.result.status === 'FAIL').forEach(r => {
    console.log(`    ❌ ${r.label}: ${r.result.message}`);
  });
  process.exit(1);
}

console.log('\n다음 단계:');
console.log(`  node scripts/build-wp-post.js --draft=${path.basename(draftPath, '.md')}`);
