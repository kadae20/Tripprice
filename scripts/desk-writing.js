#!/usr/bin/env node
/**
 * desk-writing.js — Writing Desk
 *
 * draft JSON의 본문에 FAQ / 체크리스트 / H3(≥2) 섹션을 보강한다.
 * 순서: (1) FAQ 미존재 시 추가 (H3 3개 포함) →
 *       (2) 체크리스트 미존재 시 추가 →
 *       (3) 그래도 H3 < 2이면 standalone H3 추가
 * content_html 우선, 없으면 content_markdown 폴백 (qa-wp-post.js 동일 기준).
 *
 * Usage: node scripts/desk-writing.js <draft_json_path> [--dry-run]
 * Exit: 0 = 정상 (변경 없어도 0), 1 = 파일 오류
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  return { file: args.find(a => !a.startsWith('--')), dryRun: args.includes('--dry-run') };
}

// ── 소스 탐지 (qa-wp-post.js / patch-draft-minimums.js 동일) ─────────────────
function detectSource(draft) {
  const htmlRaw = String(
    draft.content_html || draft.html || draft.body_html ||
    draft.content || draft.post_content || ''
  ).trim();
  const mdRaw = String(draft.content_markdown || draft.markdown || '').trim();

  if (htmlRaw) {
    const field =
      draft.content_html  !== undefined ? 'content_html'  :
      draft.html          !== undefined ? 'html'          :
      draft.body_html     !== undefined ? 'body_html'     :
      draft.content       !== undefined ? 'content'       : 'post_content';
    return { useHtml: true, content: htmlRaw, field };
  }
  if (mdRaw) {
    const field = draft.content_markdown !== undefined ? 'content_markdown' : 'markdown';
    return { useHtml: false, content: mdRaw, field };
  }
  return null;
}

// ── H3 카운트 ────────────────────────────────────────────────────────────────
function countH3(content, useHtml) {
  return useHtml
    ? (content.match(/<h3/gi)    || []).length
    : (content.match(/^###\s+/gm) || []).length;
}

// ── FAQ 존재 여부 ─────────────────────────────────────────────────────────────
function hasFAQ(content) {
  return /FAQ|자주\s*묻|자주\s*하는|질문/i.test(content);
}

// ── 체크리스트 존재 여부 ───────────────────────────────────────────────────────
function hasChecklist(content) {
  return /체크리스트|checklist|\[\s*[ xX]\s*\]/i.test(content);
}

// ── FAQ 블록 생성 ─────────────────────────────────────────────────────────────
function buildFAQ(slug, name, useHtml) {
  const label = (name || slug || '이 호텔').slice(0, 30);
  const items = [
    {
      q: `${label} 체크인 시간은 언제인가요?`,
      a: '체크인은 보통 오후 2~3시이며, 얼리 체크인은 당일 객실 상황에 따라 무료로 가능한 경우가 있습니다. 사전에 프런트에 문의하는 것을 추천합니다.',
    },
    {
      q: `${label} 조식이 포함되어 있나요?`,
      a: '객실 타입과 예약 옵션에 따라 다릅니다. 아고다 예약 페이지에서 "조식 포함" 여부를 반드시 확인한 뒤 예약하세요.',
    },
    {
      q: `${label} 주차 및 교통편은 어떻게 되나요?`,
      a: '호텔 자체 주차장 또는 인근 공영주차장을 이용할 수 있습니다. 대중교통 이용 시 가장 가까운 지하철역까지 도보 시간을 미리 확인해두세요.',
    },
  ];

  if (useHtml) {
    const body = items.map(({ q, a }) => `<h3>${q}</h3>\n<p>${a}</p>`).join('\n');
    return `\n<h2>자주 묻는 질문 (FAQ)</h2>\n${body}`;
  }
  const body = items.map(({ q, a }) => `### ${q}\n\n${a}`).join('\n\n');
  return `\n\n## 자주 묻는 질문 (FAQ)\n\n${body}`;
}

// ── 체크리스트 블록 생성 ───────────────────────────────────────────────────────
function buildChecklist(useHtml) {
  const items = [
    '체크인/체크아웃 시간 확인',
    '무료 취소 기간 내 예약 여부 확인',
    '조식 포함 여부 선택',
    '특별 요청 사항(고층·비흡연·연결 객실 등) 메모 기재',
    '주차 가능 여부 확인 (자차 이용 시)',
    '아고다 최종 요금 및 혜택 재확인',
  ];

  if (useHtml) {
    const lis = items.map(i => `<li>${i}</li>`).join('\n');
    return `\n<h2>예약 전 최종 체크리스트</h2>\n<ul>\n${lis}\n</ul>`;
  }
  const mds = items.map(i => `- [ ] ${i}`).join('\n');
  return `\n\n## 예약 전 최종 체크리스트\n\n${mds}`;
}

// ── standalone H3 블록 ────────────────────────────────────────────────────────
function buildStandaloneH3(slug, idx, useHtml) {
  const label = slug ? ` — ${slug}` : '';
  const blocks = [
    {
      heading: `실전 여행 팁${label}`,
      body: '체크인 전 짐 보관 서비스를 활용하면 가볍게 주변 탐방이 가능합니다. 카카오T·우버를 미리 설치해두면 늦은 귀환 시에도 편리하며, 24시간 프런트 운영 여부를 미리 확인해두세요.',
    },
    {
      heading: `주의사항 & 안내${label}`,
      body: '환불 정책은 예약 플랫폼마다 다르므로 "무료 취소 기간"을 반드시 확인하세요. 성수기·연휴에는 최소 2~4주 전 예약을 권장하며, 특별 요청은 예약 메모란에 미리 기재해두면 반영 가능성이 높아집니다.',
    },
  ];
  const b = blocks[idx % blocks.length];
  return useHtml
    ? `\n<h3>${b.heading}</h3>\n<p>${b.body}</p>`
    : `\n\n### ${b.heading}\n\n${b.body}`;
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
function main() {
  const { file, dryRun } = parseArgs();
  if (!file) { console.error('사용법: node scripts/desk-writing.js <draft_json_path>'); process.exit(1); }

  const absPath = path.resolve(ROOT, file);
  if (!fs.existsSync(absPath)) { console.error(`파일 없음: ${absPath}`); process.exit(1); }

  let draft;
  try { draft = JSON.parse(fs.readFileSync(absPath, 'utf8')); }
  catch (e) { console.error(`JSON 파싱 실패: ${e.message}`); process.exit(1); }

  const src = detectSource(draft);
  if (!src) { console.log('  [writing] 본문 없음 — 스킵'); process.exit(0); }

  const { useHtml, field } = src;
  let content = src.content;
  const slug  = String(draft.slug || draft.hotel_id || '').trim();
  const name  = String(draft.post_title || draft.title || '').trim();
  const changes = [];

  // (1) FAQ 없으면 추가 (내부에 H3 3개 포함)
  if (!hasFAQ(content)) {
    content += buildFAQ(slug, name, useHtml);
    changes.push('FAQ 추가 (H3 3개 포함)');
  }

  // (2) 체크리스트 없으면 추가
  if (!hasChecklist(content)) {
    content += buildChecklist(useHtml);
    changes.push('체크리스트 추가');
  }

  // (3) 그래도 H3 < 2이면 standalone H3 추가
  const h3Count = countH3(content, useHtml);
  if (h3Count < 2) {
    const needed = 2 - h3Count;
    for (let i = 0; i < needed; i++) {
      content += buildStandaloneH3(slug, i, useHtml);
      changes.push(`standalone H3 추가 ${i + 1}/${needed}`);
    }
  }

  if (changes.length === 0) {
    console.log(`  [writing] 이미 충족 — 변경 없음`);
    process.exit(0);
  }

  if (dryRun) {
    console.log(`  [writing] DRY-RUN: ${changes.join(', ')}`);
    process.exit(0);
  }

  draft[field] = content;
  if (!draft.workflow_state) draft.workflow_state = {};
  draft.workflow_state.writing_desk  = true;
  draft.workflow_state.writing_at    = new Date().toISOString();

  fs.writeFileSync(absPath, JSON.stringify(draft, null, 2), 'utf8');
  console.log(`  [writing] ${path.basename(absPath)}: ${changes.join(', ')}`);
}

if (require.main === module) main();
