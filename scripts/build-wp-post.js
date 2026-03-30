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
const { marked } = require('marked');
const log = require('../lib/logger');

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
 * 마크다운 → HTML 변환 (marked.js 사용).
 * - ~ 단독 사용 시 del 태그 오작동 방지 (HTML 엔티티로 이스케이프)
 * - 손상 문자(\uFFFD) 제거
 * - CTA 링크 → Gutenberg 버튼 블록 변환
 * - <hr> 제거
 */
function minimalMdToHtml(md) {
  if (!md) return '';

  // 손상 문자 제거
  let safe = md.replace(/\uFFFD/g, '');

  // 구버전 Agoda URL 정규화 (/ko-kr/hotel/{id}.html → partnersearch.aspx)
  safe = safe.replace(
    /https:\/\/www\.agoda\.com\/ko-kr\/hotel\/(\d+)\.html\?cid=(\d+)[^\s)"']*/g,
    (_, hid, cid) => `https://www.agoda.com/partners/partnersearch.aspx?hid=${hid}&cid=${cid}&currency=KRW&hl=ko`
  );

  // 단독 ~ 이스케이프 (~~취소선~~ 은 유지, 숫자 범위 표현 10~12 등)
  safe = safe.replace(/(?<!~)~(?!~)/g, '&#126;');

  // CTA 링크 → Gutenberg 버튼 블록 (발행 전 변환)
  safe = safe.replace(
    /\[([^\]]*현재\s*가격\s*확인하기[^\]]*)\]\((https?:\/\/[^)]+)\)/g,
    (_, label, url) =>
      `\n\n<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->\n` +
      `<div class="wp-block-buttons"><!-- wp:button {"backgroundColor":"vivid-red","textColor":"white","style":{"border":{"radius":"6px"}}} -->\n` +
      `<div class="wp-block-button"><a class="wp-block-button__link has-white-color has-vivid-red-background-color has-text-color has-background wp-element-button" href="${url}" target="_blank" rel="noopener noreferrer sponsored">${label}</a></div>\n` +
      `<!-- /wp:button --></div>\n<!-- /wp:buttons -->\n\n`
  );

  let html = marked.parse(safe);

  // <hr> 제거
  html = html.replace(/<hr\s*\/?>/gi, '');

  return html;
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
    log.error('--draft 옵션이 필요합니다. 예: node scripts/build-wp-post.js --draft=draft-xxx-2026-03-05');
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
    log.error(`필수 필드 누락: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (post.post_status !== 'draft') {
    log.error('post_status가 draft가 아닙니다.');
    process.exit(1);
  }

  const outFilename = `post-${slug}-${today}.json`;
  const outPath     = path.join(DRAFTS_DIR, outFilename);
  fs.writeFileSync(outPath, JSON.stringify(post, null, 2), 'utf8');

  const totalContentImages = (post.content_images || []).reduce((s, sec) => s + (sec.images || []).length, 0);
  log.info(`\n발행 번들 JSON 생성 완료`);
  log.info(`  파일: ${outPath}`);
  log.info(`  "${post.post_title}" | ${post.lang} | ${post.slug}`);
  log.info(`  affiliate:${post.affiliate_links.length} internal:${post.internal_links.length} faq:${faqItems.length} images:${totalContentImages}장`);
  log.info(`  coverage:${coverageScore ?? 'N/A'} | cta:${post.workflow_state.cta} | internal_links:${post.workflow_state.internal_links}`);

  if (warnings.length > 0) {
    warnings.forEach(w => log.warn(w));
  }

  log.info(`\n다음 단계: node scripts/wp-publish.js wordpress/drafts/${outFilename}`);
}
