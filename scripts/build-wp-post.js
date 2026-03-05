#!/usr/bin/env node
/**
 * build-wp-post.js
 * 마크다운 초안 → wp-post-schema.json 준수 발행 번들 JSON 생성.
 * wp-publish.js에 바로 전달 가능.
 *
 * 사용법:
 *   node scripts/build-wp-post.js --draft=draft-seoul-luxury-comparison-2026-03-05
 *   node scripts/build-wp-post.js --draft=draft-xxx --html
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── 순수 함수 (테스트 가능) ───────────────────────────────────────────────────

/**
 * front-matter 파싱.
 * @returns {{ fm: Object, body: string }}
 */
function parseFrontMatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { fm: {}, body: text };
  const fm = Object.fromEntries(
    match[1].split('\n')
      .filter(l => l.includes(':'))
      .map(l => {
        const idx = l.indexOf(':');
        return [l.slice(0, idx).trim(), l.slice(idx + 1).trim().replace(/^"|"$/g, '')];
      })
  );
  const body = text.slice(match[0].length).trimStart();
  return { fm, body };
}

/**
 * 마크다운 → 최소 HTML 변환 (외부 패키지 없음).
 */
function minimalMdToHtml(md) {
  return md
    .split('\n')
    .map(line => {
      if (/^### (.+)/.test(line)) return line.replace(/^### (.+)/, '<h3>$1</h3>');
      if (/^## (.+)/.test(line))  return line.replace(/^## (.+)/, '<h2>$1</h2>');
      if (/^# (.+)/.test(line))   return line.replace(/^# (.+)/, '<h1>$1</h1>');
      if (/^> (.+)/.test(line))   return line.replace(/^> (.+)/, '<blockquote>$1</blockquote>');
      if (/^- (.+)/.test(line))   return line.replace(/^- (.+)/, '<li>$1</li>');
      if (/^---$/.test(line))     return '<hr>';
      if (line.trim() === '')     return '';
      return `<p>${line}</p>`;
    })
    .join('\n')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * CTA 패턴에서 affiliate_links 추출.
 */
function extractAffiliateLinks(md) {
  const links = [];
  const pattern = /\[([^\]]+현재 가격 확인하기[^\]]*)\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = pattern.exec(md)) !== null) {
    const url = m[2];
    const tagMatch    = url.match(/[?&]tag=([a-z0-9-]+)/);
    const hotelMatch  = url.match(/\/hotel\/(\d+)/);
    links.push({
      hotel_id:   tagMatch ? tagMatch[1] : hotelMatch ? `agoda-${hotelMatch[1]}` : 'unknown',
      hotel_name: m[1].replace(/\s*현재 가격 확인하기.*/, '').trim(),
      url,
      utm_source: 'tripprice',
      position:   'hotel-section',
    });
  }
  return links;
}

/**
 * "내부 링크 제안" 섹션에서 internal_links 추출.
 */
function extractInternalLinks(md) {
  const sectionMatch = md.match(/## 내부 링크 제안[^\n]*\n([\s\S]*?)(?:\n##|$)/);
  if (!sectionMatch) return [];
  const links = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m;
  while ((m = pattern.exec(sectionMatch[1])) !== null) {
    if (m[2].startsWith('/')) links.push({ text: m[1], url: m[2] });
  }
  return links;
}

/**
 * FAQ Q&A 추출 (schema_markup용).
 */
function extractFAQ(md) {
  const items = [];
  const pattern = /\*\*Q\.\s*(.+?)\*\*\s*\nA\.\s*(.+)/g;
  let m;
  while ((m = pattern.exec(md)) !== null) {
    items.push({ question: m[1].trim(), answer: m[2].trim() });
  }
  return items;
}

// ── exports (require 시 함수만 노출) ─────────────────────────────────────────
module.exports = { parseFrontMatter, minimalMdToHtml, extractAffiliateLinks, extractInternalLinks, extractFAQ };

// ── CLI 실행부 (직접 실행할 때만) ─────────────────────────────────────────────
if (require.main === module) {
  const DRAFTS_DIR = path.join(__dirname, '..', 'wordpress', 'drafts');

  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
  );

  if (!args.draft) {
    console.error('오류: --draft 옵션이 필요합니다.');
    console.error('  예: node scripts/build-wp-post.js --draft=draft-seoul-luxury-comparison-2026-03-05');
    process.exit(1);
  }

  function resolveDraftPath(input) {
    for (const c of [
      input,
      input.endsWith('.md') ? input : `${input}.md`,
      path.join(DRAFTS_DIR, input.endsWith('.md') ? input : `${input}.md`),
    ]) { if (fs.existsSync(c)) return c; }
    return null;
  }

  const draftPath = resolveDraftPath(args.draft);
  if (!draftPath) {
    console.error(`초안 파일을 찾을 수 없습니다: ${args.draft}`);
    process.exit(1);
  }

  const raw   = fs.readFileSync(draftPath, 'utf8');
  const today = new Date().toISOString().split('T')[0];

  const { fm, body } = parseFrontMatter(raw);

  // brief 파일에서 coverage_score 평균 추정
  function loadCoverageScore(slug) {
    const briefPattern = `brief-${slug}-`;
    const files = fs.existsSync(DRAFTS_DIR)
      ? fs.readdirSync(DRAFTS_DIR).filter(f => f.startsWith(briefPattern) && f.endsWith('.json'))
      : [];
    if (files.length === 0) return null;
    const latest = files.sort().at(-1);
    try {
      const brief = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, latest), 'utf8'));
      const scores = (brief.hotels || []).map(h => h.coverage_score).filter(Boolean);
      if (scores.length === 0) return null;
      return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    } catch { return null; }
  }

  const slug           = fm.slug || path.basename(draftPath, '.md').replace(/^draft-/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const affiliateLinks = extractAffiliateLinks(raw);
  const internalLinks  = extractInternalLinks(raw);
  const faqItems       = extractFAQ(raw);
  const coverageScore  = loadCoverageScore(slug);

  const warnings = [];

  // wp-post-schema 필드 조립
  const post = {
    post_title:   fm.title || '',
    slug,
    post_status:  'draft',
    lang:         fm.lang || 'ko',
    post_excerpt: '',

    meta: {
      meta_description: fm.meta_description || '',
      canonical_url:    `https://tripprice.com/${fm.lang || 'ko'}/${slug}/`,
    },

    hreflang_links: ['ko', 'en', 'ja', 'x-default'].map(l => ({
      lang: l,
      url:  `https://tripprice.com/${l === 'x-default' ? 'ko' : l}/${slug}/`,
    })),

    content_markdown: body,
    ...(args.html ? { content_html: minimalMdToHtml(body) } : {}),

    featured_media: null,
    categories:     [],
    tags:           [],

    affiliate_links: affiliateLinks,
    internal_links:  internalLinks,

    ...(coverageScore != null ? { coverage_score: coverageScore } : {}),

    data_notice:      '가격·혜택·환불 규정은 시기에 따라 변동될 수 있으며, 최종 조건은 예약 페이지에서 직접 확인하시기 바랍니다.',
    affiliate_notice: '이 글에는 아고다 파트너 링크가 포함되어 있습니다. 링크를 통해 예약하시면 추가 비용 없이 운영에 도움이 됩니다.',

    schema_markup: faqItems.length > 0 ? {
      type: 'FAQPage',
      data: {
        '@context': 'https://schema.org',
        '@type':    'FAQPage',
        mainEntity: faqItems.map(({ question, answer }) => ({
          '@type':         'Question',
          name:            question,
          acceptedAnswer:  { '@type': 'Answer', text: answer },
        })),
      },
    } : undefined,

    published_at: new Date().toISOString(),

    workflow_state: {
      plan:           false,
      brief:          true,
      draft:          true,
      fact_check:     false,
      seo_qa:         true,
      humanize:       false,
      cta:            affiliateLinks.length > 0,
      internal_links: internalLinks.length > 0,
      wp_draft:       false,
      human_review:   false,
    },
  };

  // 경고 수집
  if (!post.post_title)             warnings.push('post_title 없음 — front-matter title 확인 필요');
  if (!post.meta.meta_description)  warnings.push('meta_description 없음');
  if (post.categories.length === 0) warnings.push('categories 비어있음 — WP 발행 전 채워야 합니다');
  if (post.tags.length === 0)       warnings.push('tags 비어있음 — WP 발행 전 채워야 합니다');
  if (affiliateLinks.length === 0)  warnings.push('affiliate_links 없음 — CTA 패턴을 찾지 못했습니다');
  if (coverageScore == null)        warnings.push('coverage_score 없음 — brief 파일을 찾지 못했습니다');

  // 필수 필드 검증
  const REQUIRED = ['post_title', 'slug', 'post_status', 'lang'];
  const missing  = REQUIRED.filter(f => !post[f]);
  if (missing.length > 0) {
    console.error(`❌ 필수 필드 누락: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (post.post_status !== 'draft') {
    console.error('❌ post_status가 draft가 아닙니다.');
    process.exit(1);
  }

  // 저장
  const outFilename = `post-${slug}-${today}.json`;
  const outPath     = path.join(DRAFTS_DIR, outFilename);
  fs.writeFileSync(outPath, JSON.stringify(post, null, 2), 'utf8');

  // 콘솔 출력
  console.log('\n발행 번들 JSON 생성 완료');
  console.log(`  파일: ${outPath}`);
  console.log('');
  console.log('핵심 필드 요약:');
  console.log(`  post_title:       "${post.post_title}"`);
  console.log(`  slug:             "${post.slug}"`);
  console.log(`  post_status:      "${post.post_status}"  ← 항상 draft`);
  console.log(`  lang:             "${post.lang}"`);
  console.log(`  meta_desc 길이:   ${post.meta.meta_description.length}자`);
  console.log(`  affiliate_links:  ${post.affiliate_links.length}개`);
  console.log(`  internal_links:   ${post.internal_links.length}개`);
  console.log(`  faq 항목:         ${faqItems.length}개`);
  console.log(`  coverage_score:   ${coverageScore ?? '없음 (brief 미참조)'}`);
  console.log(`  data_notice:      포함`);
  console.log(`  affiliate_notice: 포함`);
  console.log(`  workflow_state:   brief/draft/seo_qa=true, cta=${post.workflow_state.cta}, internal_links=${post.workflow_state.internal_links}`);

  if (warnings.length > 0) {
    console.log('\n⚠️  경고:');
    warnings.forEach(w => console.log(`  - ${w}`));
  }

  console.log('\n다음 단계:');
  console.log(`  WP_URL=https://tripprice.com WP_USER=admin WP_APP_PASS="xxxx xxxx" \\`);
  console.log(`    node scripts/wp-publish.js wordpress/drafts/${outFilename}`);
}
