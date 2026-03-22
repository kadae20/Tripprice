#!/usr/bin/env node
/**
 * desk-seo.js — SEO Desk
 *
 * draft JSON의 meta_description / internal_links / schema_markup(FAQPage)를 점검·보강한다.
 * - meta_description < 120자 → 템플릿 생성
 * - internal_links < 2 → state/internal-links/index.json 참조 후 추가
 * - schema_markup에 FAQPage 없음 → content에서 FAQ 추출하여 생성
 *
 * Usage: node scripts/desk-seo.js <draft_json_path> [--dry-run]
 * Exit: 0 = 정상, 1 = 파일 오류
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT           = path.resolve(__dirname, '..');
const INT_LINKS_FILE = path.join(ROOT, 'state', 'internal-links', 'index.json');

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  return { file: args.find(a => !a.startsWith('--')), dryRun: args.includes('--dry-run') };
}

// ── 소스 탐지 ─────────────────────────────────────────────────────────────────
function detectSource(draft) {
  const htmlRaw = String(
    draft.content_html || draft.html || draft.body_html ||
    draft.content || draft.post_content || ''
  ).trim();
  const mdRaw = String(draft.content_markdown || draft.markdown || '').trim();
  const useHtml = !!htmlRaw;
  const content = useHtml ? htmlRaw : mdRaw;
  const field = useHtml
    ? (draft.content_html !== undefined ? 'content_html' : draft.html !== undefined ? 'html' : 'content')
    : (draft.content_markdown !== undefined ? 'content_markdown' : 'markdown');
  return { useHtml, content, field };
}

// ── slug에서 도시 추출 ──────────────────────────────────────────────────────────
function extractCity(slug) {
  const CITIES = ['seoul', 'busan', 'jeju', 'incheon', 'daegu', 'gwangju', 'ulsan', 'daejeon'];
  const s = String(slug || '').toLowerCase();
  return CITIES.find(c => s.includes(c)) || '';
}

// ── meta_description 생성 ─────────────────────────────────────────────────────
function buildMetaDesc(draft) {
  const title = String(draft.post_title || draft.title || '').trim();
  const slug  = String(draft.slug || '').trim();
  const lang  = draft.lang || 'ko';
  let desc;
  if (lang === 'en') {
    desc = `${title} — Honest review with location, amenities, pricing & tips. Compare Agoda rates before booking.`;
  } else if (lang === 'ja') {
    desc = `${title} — 実際のデータで徹底解説。アゴダ最安値チェック必須。`;
  } else {
    desc = `${title} — 위치·시설·가격대·체크인 팁까지 실제 데이터로 분석. 아고다 최저가 비교 후 예약하세요.`;
  }
  return desc.slice(0, 155);
}

// ── 내부 링크 인덱스 로드 ──────────────────────────────────────────────────────
function loadInternalLinks() {
  try {
    if (fs.existsSync(INT_LINKS_FILE)) {
      const j = JSON.parse(fs.readFileSync(INT_LINKS_FILE, 'utf8'));
      return Array.isArray(j.links) ? j.links : [];
    }
  } catch { /* skip */ }
  return [];
}

// ── 관련 내부 링크 2개 선택 ────────────────────────────────────────────────────
function pickInternalLinks(draft, existingLinks) {
  const allLinks = loadInternalLinks();
  const slug     = String(draft.slug || '').trim();
  const city     = extractCity(slug);
  const lang     = draft.lang || 'ko';
  const existing = new Set((existingLinks || []).map(l => l.url || l.slug || ''));

  // 같은 언어 + 같은 도시 우선, 자기 자신 제외, 이미 포함된 것 제외
  const candidates = allLinks
    .filter(l => l.slug !== slug && !existing.has(l.url) && !existing.has(l.slug))
    .sort((a, b) => {
      const cityMatch = (city && a.city === city ? 1 : 0) - (city && b.city === city ? 1 : 0);
      const langMatch = ((a.lang || 'ko') === lang ? 1 : 0) - ((b.lang || 'ko') === lang ? 1 : 0);
      return -(cityMatch + langMatch);
    });

  const needed = Math.max(0, 2 - (existingLinks || []).length);
  return candidates.slice(0, needed).map(l => ({ anchor: l.title, url: l.url, slug: l.slug }));
}

// ── content에서 FAQ 쌍 추출 ───────────────────────────────────────────────────
function extractFAQPairs(content, useHtml) {
  const pairs = [];

  if (useHtml) {
    // <h3>Q?</h3><p>A</p> 패턴
    const re = /<h3[^>]*>([^<]{5,100}?[?가요요])<\/h3>\s*<p>([^<]{10,400}?)<\/p>/gi;
    let m;
    while ((m = re.exec(content)) !== null && pairs.length < 5) {
      pairs.push({ question: m[1].trim(), answer: m[2].trim() });
    }
  } else {
    // ### Q?\n\nA 패턴
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && pairs.length < 5; i++) {
      if (/^###\s+/.test(lines[i]) && /[?가요]$/.test(lines[i])) {
        const q = lines[i].replace(/^###\s+/, '').trim();
        const a = lines.slice(i + 1).find(l => l.trim()) || '';
        if (a.trim()) pairs.push({ question: q, answer: a.trim() });
      }
    }
  }
  return pairs;
}

// ── FAQPage 스키마 생성 ───────────────────────────────────────────────────────
function buildFAQSchema(pairs) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: pairs.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  };
}

// ── schema에 FAQPage 존재 여부 ────────────────────────────────────────────────
function hasFAQSchema(draft) {
  const sm = draft.schema_markup;
  if (!sm) return false;
  if (typeof sm === 'string') return sm.includes('FAQPage');
  if (Array.isArray(sm)) return sm.some(s => s && (s['@type'] === 'FAQPage' || JSON.stringify(s).includes('FAQPage')));
  if (typeof sm === 'object') return sm['@type'] === 'FAQPage';
  return false;
}

// ── schema_markup에 append ────────────────────────────────────────────────────
function appendSchema(draft, schema) {
  if (!draft.schema_markup) {
    draft.schema_markup = schema;
  } else if (Array.isArray(draft.schema_markup)) {
    draft.schema_markup.push(schema);
  } else {
    draft.schema_markup = [draft.schema_markup, schema];
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
function main() {
  const { file, dryRun } = parseArgs();
  if (!file) { console.error('사용법: node scripts/desk-seo.js <draft_json_path>'); process.exit(1); }

  const absPath = path.resolve(ROOT, file);
  if (!fs.existsSync(absPath)) { console.error(`파일 없음: ${absPath}`); process.exit(1); }

  let draft;
  try { draft = JSON.parse(fs.readFileSync(absPath, 'utf8')); }
  catch (e) { console.error(`JSON 파싱 실패: ${e.message}`); process.exit(1); }

  const { useHtml, content } = detectSource(draft);
  const changes = [];

  // (1) meta_description
  const metaDesc = String(
    (draft.meta && draft.meta.meta_description) ||
    draft.meta_description || draft.yoast_meta_description || ''
  ).trim();
  if (metaDesc.length < 120) {
    const newMeta = buildMetaDesc(draft);
    draft.meta_description = newMeta;
    // yoast 필드도 함께 설정
    if (draft.meta) draft.meta.meta_description = newMeta;
    changes.push(`meta_description 생성 (${newMeta.length}자)`);
  }

  // (2) internal_links
  const existingLinks = Array.isArray(draft.internal_links) ? draft.internal_links : [];
  if (existingLinks.length < 2) {
    const newLinks = pickInternalLinks(draft, existingLinks);
    if (newLinks.length > 0) {
      draft.internal_links = [...existingLinks, ...newLinks];
      changes.push(`internal_links +${newLinks.length}개`);
    }
  }

  // (3) FAQPage schema
  if (!hasFAQSchema(draft)) {
    const pairs = extractFAQPairs(content, useHtml);
    if (pairs.length > 0) {
      appendSchema(draft, buildFAQSchema(pairs));
      changes.push(`FAQPage schema 생성 (${pairs.length}쌍)`);
    }
  }

  if (changes.length === 0) {
    console.log(`  [seo] 이미 충족 — 변경 없음`);
    process.exit(0);
  }

  if (dryRun) {
    console.log(`  [seo] DRY-RUN: ${changes.join(', ')}`);
    process.exit(0);
  }

  if (!draft.workflow_state) draft.workflow_state = {};
  draft.workflow_state.seo_desk = true;
  draft.workflow_state.seo_at   = new Date().toISOString();

  fs.writeFileSync(absPath, JSON.stringify(draft, null, 2), 'utf8');
  console.log(`  [seo] ${path.basename(absPath)}: ${changes.join(', ')}`);
}

if (require.main === module) main();
