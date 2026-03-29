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
 * 인라인 마크다운 → HTML (bold, italic, code, link).
 */
function inlineMd(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * 마크다운 → Gutenberg 블록 HTML 변환.
 * Yoast SEO가 블록 에디터에서 분석하려면 <!-- wp:* --> 블록 마크업이 필요.
 */
function minimalMdToHtml(md) {
  const lines  = md.split('\n');
  const blocks = [];
  let listBuf  = [];

  function flushList() {
    if (listBuf.length === 0) return;
    const items = listBuf.map(l => `<li>${inlineMd(l)}</li>`).join('');
    blocks.push(`<!-- wp:list -->\n<ul>${items}</ul>\n<!-- /wp:list -->`);
    listBuf = [];
  }

  for (const raw of lines) {
    const line = raw;

    if (/^### (.+)/.test(line)) {
      flushList();
      const t = inlineMd(line.replace(/^### /, ''));
      blocks.push(`<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">${t}</h3>\n<!-- /wp:heading -->`);
    } else if (/^## (.+)/.test(line)) {
      flushList();
      const t = inlineMd(line.replace(/^## /, ''));
      blocks.push(`<!-- wp:heading {"level":2} -->\n<h2 class="wp-block-heading">${t}</h2>\n<!-- /wp:heading -->`);
    } else if (/^# (.+)/.test(line)) {
      flushList();
      const t = inlineMd(line.replace(/^# /, ''));
      blocks.push(`<!-- wp:heading {"level":1} -->\n<h1 class="wp-block-heading">${t}</h1>\n<!-- /wp:heading -->`);
    } else if (/^> (.+)/.test(line)) {
      flushList();
      const t = inlineMd(line.replace(/^> /, ''));
      blocks.push(`<!-- wp:quote -->\n<blockquote class="wp-block-quote"><p>${t}</p></blockquote>\n<!-- /wp:quote -->`);
    } else if (/^- (.+)/.test(line)) {
      listBuf.push(line.replace(/^- /, ''));
    } else if (/^---$/.test(line)) {
      flushList();
      blocks.push(`<!-- wp:separator -->\n<hr class="wp-block-separator"/>\n<!-- /wp:separator -->`);
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      blocks.push(`<!-- wp:paragraph -->\n<p>${inlineMd(line)}</p>\n<!-- /wp:paragraph -->`);
    }
  }
  flushList();
  return blocks.join('\n\n');
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

/**
 * config 파일 로드 공통 헬퍼.
 */
function loadConfigMap(filename) {
  const p = path.join(__dirname, '..', 'config', filename);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return { city: {}, type: {} }; }
}

function loadCategoryMap() { return loadConfigMap('category-map.json'); }
function loadTagMap()      { return loadConfigMap('tag-map.json'); }

/**
 * 글 제목/본문 키워드로 WP 카테고리 ID 배열 추론.
 * - 매핑은 config/category-map.json에서 로드 (하드코딩 없음)
 * - 매핑 ID가 비어있으면 빈 배열 반환 (WP ID 채우기 전까지 경고로 처리)
 *
 * @param {string} title
 * @param {string} body
 * @param {Object} categoryMap  loadCategoryMap() 반환값
 * @returns {number[]}
 */
function inferCategories(title, body, categoryMap) {
  const text = `${title} ${body}`.toLowerCase();
  const ids = new Set();

  for (const [keyword, wpIds] of Object.entries(categoryMap.city || {})) {
    if (text.includes(keyword.toLowerCase())) {
      wpIds.forEach(id => ids.add(id));
    }
  }
  for (const [keyword, wpIds] of Object.entries(categoryMap.type || {})) {
    if (text.includes(keyword.toLowerCase())) {
      wpIds.forEach(id => ids.add(id));
    }
  }

  return [...ids];
}

/**
 * 글 제목/본문 키워드로 WP 태그 ID 배열 추론.
 * inferCategories와 동일한 구조 — config/tag-map.json 기반.
 */
function inferTags(title, body, tagMap) {
  const text = `${title} ${body}`.toLowerCase();
  const ids = new Set();
  for (const [keyword, wpIds] of Object.entries(tagMap.city || {})) {
    if (text.includes(keyword.toLowerCase())) wpIds.forEach(id => ids.add(id));
  }
  for (const [keyword, wpIds] of Object.entries(tagMap.type || {})) {
    if (text.includes(keyword.toLowerCase())) wpIds.forEach(id => ids.add(id));
  }
  return [...ids];
}

/**
 * assets/processed/{post_slug}/featured.webp 존재 여부 확인.
 * make-post-image.js가 생성한 파일을 build-wp-post가 자동 감지.
 *
 * @param {string} postSlug
 * @returns {string|null} 상대 경로 or null
 */
function resolvePostFeaturedImage(postSlug) {
  const PROCESSED = path.join(__dirname, '..', 'assets', 'processed');
  const preferred  = path.join(PROCESSED, postSlug, 'featured.webp');
  if (fs.existsSync(preferred)) {
    return path.posix.join('assets/processed', postSlug, 'featured.webp');
  }
  // webp 외 다른 포맷도 허용
  const dir = path.join(PROCESSED, postSlug);
  if (!fs.existsSync(dir)) return null;
  const img = fs.readdirSync(dir).find(f => /\.(webp|jpg|jpeg|png)$/i.test(f) && !/alt/.test(f));
  return img ? path.posix.join('assets/processed', postSlug, img) : null;
}

// ── 본문 이미지 자동 삽입 지원 ────────────────────────────────────────────────

const IMG_EXTS   = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SKIP_FILE  = /alt-texts|\.gitkeep/i;

// 파일명 키워드 → 한국어 특징어
const FEATURE_MAP_KO = {
  featured: '대표이미지', main: '대표이미지', hero: '대표이미지', cover: '대표이미지',
  pool: '수영장', swim: '수영장', lobby: '로비', room: '객실', suite: '스위트룸',
  restaurant: '레스토랑', dining: '다이닝', gym: '피트니스', spa: '스파',
  rooftop: '루프탑', view: '전망', exterior: '외관', breakfast: '조식',
  bar: '바', lounge: '라운지', bathroom: '욕실', garden: '정원',
};

function getFilenameFeatureKo(filename) {
  const base = path.basename(filename, path.extname(filename))
    .toLowerCase().replace(/[-_]/g, ' ');
  for (const [kw, label] of Object.entries(FEATURE_MAP_KO)) {
    if (base.split(' ').includes(kw) || base.includes(kw)) return label;
  }
  return null;
}

/**
 * 호텔 이미지 목록 반환.
 * assets/processed/{hotelId}/ 우선, 없으면 assets/raw/{hotelId}/ 사용.
 *
 * @returns {{ local_path: string, alt: string }[]}
 */
function resolveHotelImages(hotelId, hotelName, city, max = 4) {
  const ROOT_DIR   = path.join(__dirname, '..');
  const candidates = [
    { dir: path.join(ROOT_DIR, 'assets', 'processed', hotelId), prefix: `assets/processed/${hotelId}` },
    { dir: path.join(ROOT_DIR, 'assets', 'raw',       hotelId), prefix: `assets/raw/${hotelId}` },
  ];

  // processed alt-texts.json 로드 (있으면)
  let altTexts = {};
  const altJsonPath = path.join(ROOT_DIR, 'assets', 'processed', hotelId, 'alt-texts.json');
  if (fs.existsSync(altJsonPath)) {
    try { altTexts = JSON.parse(fs.readFileSync(altJsonPath, 'utf8')); } catch {}
  }

  const results = [];
  for (const { dir, prefix } of candidates) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir)
      .filter(f => IMG_EXTS.has(path.extname(f).toLowerCase()) && !SKIP_FILE.test(f))
      .sort();
    for (const f of files) {
      if (results.length >= max) break;
      const localPath = `${prefix}/${f}`;
      // alt 우선순위: alt-texts.json → 파일명 특징어 → 기본
      const altKey = f.replace(/\.(jpg|jpeg|png)$/i, '.webp');
      const alt = altTexts[altKey] || altTexts[f] || (() => {
        const feat = getFilenameFeatureKo(f);
        return feat ? `${hotelName} ${feat}` : `${hotelName} ${city || ''} 호텔`.trim();
      })();
      results.push({ local_path: localPath, alt });
    }
    if (results.length >= max) break;
  }

  // 폴백: raw/processed 이미지가 0장이면 featured.webp 경로를 반환
  // (파일이 없어도 경로 반환 — wp-publish 단계에서 업로드 시도)
  if (results.length === 0) {
    results.push({
      local_path: `assets/processed/${hotelId}/featured.webp`,
      alt:        `${hotelName || hotelId} 대표 이미지`,
    });
  }

  return results;
}

/**
 * 글 전체 content_images 배열 생성.
 * - post-summary : H1 직후 삽입 (요약 카드)
 * - hotel-section: 각 호텔 H2 직후 삽입
 * 총 이미지 상한: 8장.
 *
 * @param {string}   postSlug
 * @param {object[]} briefHotels  [{hotel_id, hotel_name, city}]
 * @returns {object[]}
 */
function buildContentImages(postSlug, briefHotels) {
  const ROOT_DIR = path.join(__dirname, '..');
  const items = [];
  let total   = 0;

  // 1) 글 상단 요약 카드
  const summaryPath = `assets/processed/${postSlug}/featured.webp`;
  if (fs.existsSync(path.join(ROOT_DIR, summaryPath))) {
    const altJsonPath = path.join(ROOT_DIR, 'assets', 'processed', postSlug, 'alt-texts.json');
    let alt = `${postSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} 대표 이미지`;
    if (fs.existsSync(altJsonPath)) {
      try {
        const aj = JSON.parse(fs.readFileSync(altJsonPath, 'utf8'));
        alt = aj['featured.webp'] || alt;
      } catch {}
    }
    items.push({ position: 'post-summary', images: [{ local_path: summaryPath, alt }] });
    total++;
  }

  // 2) 호텔별 이미지
  for (const hotel of (briefHotels || [])) {
    if (total >= 8) break;
    const max    = Math.min(4, 8 - total);
    const images = resolveHotelImages(hotel.hotel_id, hotel.hotel_name, hotel.city || '', max);
    if (images.length === 0) continue; // WARN은 wp-publish 단계에서
    items.push({ position: 'hotel-section', hotel_id: hotel.hotel_id, hotel_name: hotel.hotel_name, images });
    total += images.length;
  }

  return items;
}

// ── exports (require 시 함수만 노출) ─────────────────────────────────────────
module.exports = {
  parseFrontMatter, minimalMdToHtml, extractAffiliateLinks, extractInternalLinks,
  extractFAQ, inferCategories, inferTags, resolvePostFeaturedImage,
  resolveHotelImages, buildContentImages, getFilenameFeatureKo,
};

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

  // brief 파일 로드 (coverage_score + hotels 공유)
  function loadBrief(slug) {
    const briefPattern = `brief-${slug}-`;
    const files = fs.existsSync(DRAFTS_DIR)
      ? fs.readdirSync(DRAFTS_DIR).filter(f => f.startsWith(briefPattern) && f.endsWith('.json'))
      : [];
    if (files.length === 0) return null;
    try { return JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, files.sort().at(-1)), 'utf8')); }
    catch { return null; }
  }

  const SITE_URL = (process.env.SITE_URL || process.env.WP_URL || 'https://tripprice.net').replace(/\/$/, '');
  const slug           = fm.slug || path.basename(draftPath, '.md').replace(/^draft-/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const affiliateLinks = extractAffiliateLinks(raw);
  const internalLinks  = extractInternalLinks(raw);
  const faqItems       = extractFAQ(raw);
  const brief          = loadBrief(slug);
  const coverageScore  = (() => {
    const scores = (brief?.hotels || []).map(h => h.coverage_score).filter(Boolean);
    return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  })();
  const categoryMap        = loadCategoryMap();
  const tagMap             = loadTagMap();
  const inferredCategories = inferCategories(fm.title || '', body, categoryMap);
  const inferredTags       = inferTags(fm.title || '', body, tagMap);

  const warnings = [];

  // wp-post-schema 필드 조립
  const post = {
    post_title:   fm.title || '',
    slug,
    post_status:  'draft',
    lang:         fm.lang || 'ko',
    post_excerpt: fm.excerpt || '',

    meta: {
      meta_description: fm.meta_description || '',
      canonical_url:    `${SITE_URL}/${fm.lang || 'ko'}/${slug}/`,
    },

    // Yoast SEO 자동 주입 필드.
    // wp-publish.js가 _yoast_wpseo_* 키로 REST API에 전달.
    // wordpress/mu-plugin/tripprice-seo-meta.php 배포 후 실제 저장 시작.
    yoast_meta: {
      focus_keyphrase:  fm.focus_keyphrase        || '',
      seo_title:        fm.yoast_seo_title         || '',
      meta_description: fm.yoast_meta_description  || fm.meta_description || '',
      canonical_url:    `${SITE_URL}/${fm.lang || 'ko'}/${slug}/`,
    },

    hreflang_links: ['ko', 'en', 'ja', 'x-default'].map(l => ({
      lang: l,
      url:  `${SITE_URL}/${l === 'x-default' ? 'ko' : l}/${slug}/`,
    })),

    content_markdown: body,
    content_html: minimalMdToHtml(body),  // 항상 Gutenberg 블록 포맷으로 생성

    // URL을 draft JSON에 저장. wp-publish 단계에서 미디어 업로드 후 attachment ID로 교체.
    // WP REST API의 featured_media 필드는 integer ID를 기대하므로 URL을 직접 넣지 않는다.
    // 우선순위: front-matter featured_image_url > assets/processed/{post_slug}/featured.webp
    featured_media_url: fm.featured_image_url || resolvePostFeaturedImage(slug) || null,

    // 본문 이미지 삽입 계획. wp-publish 단계에서 WP 업로드 후 HTML에 주입.
    // - post-summary: H1 직후 요약 카드 1장
    // - hotel-section: 각 호텔 H2 직후 2~4장
    content_images: buildContentImages(slug, brief?.hotels || []),

    // 이미지 폴더 매핑용 hotel_ids — wp-publish.js 가 assets/processed/{hotel_id}/ 를 찾는 데 사용
    hotel_ids: (brief?.hotels || []).map(h => h.hotel_id).filter(Boolean),

    categories: inferredCategories,
    tags:       inferredTags,

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
  if (!post.post_title)                   warnings.push('post_title 없음 — front-matter title 확인 필요');
  if (!post.meta.meta_description)        warnings.push('meta_description 없음');
  if (post.categories.length === 0)       warnings.push('categories 비어있음 — config/category-map.json에 WP ID를 채우거나 front-matter에 categories 지정 필요');
  if (post.tags.length === 0)             warnings.push('tags 비어있음 — config/tag-map.json에 WP ID를 채우거나 front-matter에 tags 지정 필요');
  if (!post.featured_media_url)           warnings.push('featured_media_url 없음 — front-matter featured_image_url 지정 필요. wp-publish 시 미디어 업로드 건너뜀');
  if (!post.yoast_meta.focus_keyphrase)  warnings.push('yoast focus_keyphrase 없음 — front-matter focus_keyphrase 확인 필요');
  if (!post.yoast_meta.seo_title)        warnings.push('yoast seo_title 없음 — front-matter yoast_seo_title 확인 필요');
  if (affiliateLinks.length === 0)        warnings.push('affiliate_links 없음 — CTA 패턴을 찾지 못했습니다');
  if (coverageScore == null)              warnings.push('coverage_score 없음 — brief 파일을 찾지 못했습니다');

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
  console.log(`  affiliate_links:    ${post.affiliate_links.length}개`);
  console.log(`  internal_links:     ${post.internal_links.length}개`);
  console.log(`  faq 항목:           ${faqItems.length}개`);
  console.log(`  categories (추론):  [${post.categories.join(', ') || '비어있음'}]`);
  console.log(`  tags (추론):        [${post.tags.join(', ') || '비어있음'}]`);
  console.log(`  featured_media_url: ${post.featured_media_url || '없음 (wp-publish 시 미디어 업로드 건너뜀)'}`);
  const totalContentImages = (post.content_images || []).reduce((s, sec) => s + (sec.images || []).length, 0);
  console.log(`  content_images:     ${post.content_images.length}개 섹션, 총 ${totalContentImages}장`);
  console.log(`  coverage_score:     ${coverageScore ?? '없음 (brief 미참조)'}`);
  console.log(`  data_notice:        포함`);
  console.log(`  affiliate_notice:   포함`);
  console.log(`  workflow_state:   brief/draft/seo_qa=true, cta=${post.workflow_state.cta}, internal_links=${post.workflow_state.internal_links}`);

  if (warnings.length > 0) {
    console.log('\n⚠️  경고:');
    warnings.forEach(w => console.log(`  - ${w}`));
  }

  console.log('\n다음 단계:');
  console.log(`  WP_URL=${SITE_URL} WP_USER=admin WP_APP_PASS="xxxx xxxx" \\`);
  console.log(`    node scripts/wp-publish.js wordpress/drafts/${outFilename}`);
}
