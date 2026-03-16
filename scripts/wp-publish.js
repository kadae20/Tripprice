#!/usr/bin/env node
/**
 * wp-publish.js
 *
 * WordPress REST API 기반 글 발행 스크립트.
 *
 * 사용법:
 *   WP_URL=https://example.com WP_USER=admin WP_APP_PASS="xxxx xxxx xxxx" \
 *     node scripts/wp-publish.js wordpress/sample-post.json
 *   node scripts/wp-publish.js wordpress/sample-post.json --status=publish
 *
 * 옵션:
 *   --status=draft|publish   발행 상태 (기본: draft)
 *
 * 필수 환경변수:
 *   WP_URL      — 워드프레스 사이트 URL (예: https://tripprice.net)
 *   WP_USER     — WordPress 사용자명
 *   WP_APP_PASS — WordPress Application Password (대시/공백 포함 그대로)
 *
 * 요구 Node 버전: 18+ (내장 fetch 사용)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────
// Node 버전 확인 (fetch는 Node 18+)
// ──────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(
    `[오류] Node.js 18 이상이 필요합니다. (현재: ${process.versions.node})\n` +
    `  → https://nodejs.org 에서 최신 LTS 버전을 설치하세요.`
  );
  process.exit(1);
}

// ──────────────────────────────────────────────
// 경로 설정
// ──────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const DIR_CAMPAIGNS = path.join(ROOT, 'state', 'campaigns');

// ──────────────────────────────────────────────
// .env 파일 파서 (dotenv 없이, 외부 패키지 0)
// - 이미 process.env에 있는 키는 절대 덮어쓰지 않음
// - 반환: 로드된 키 수 (파일 없음 = -1)
// ──────────────────────────────────────────────
function loadEnvFile(filePath) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    let loaded = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx < 1) continue;
      const key = line.slice(0, eqIdx).trim();
      let val   = line.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) {
        process.env[key] = val;
        loaded++;
      }
    }
    return loaded;
  } catch { return -1; }
}

// ── WP 환경변수 자동 로드 (.env.local → .env 우선순위) ───────────────────────
// 로그: 파일명 + 키 수만 출력 (값 절대 미출력)
function loadEnvIfNeeded() {
  if (process.env.WP_URL && process.env.WP_USER && process.env.WP_APP_PASS) return;
  for (const fname of ['.env.local', '.env']) {
    const fp = path.join(ROOT, fname);
    const n  = loadEnvFile(fp);
    if (n >= 0) {
      console.log(`  [env] ${fname} 로드 완료 (신규 ${n}개 키 적용)`);
      break;
    }
  }
}

// ── 민감정보 마스킹 (마지막 4자만 노출) ─────────────────────────────────────
// 예) "abcd-efgh-ijkl" → "****-****-ijkl"
function maskSecret(s) {
  const str = String(s || '');
  if (!str) return '(없음)';
  if (str.length <= 4) return '****';
  return str.slice(0, -4).replace(/\S/g, '*') + str.slice(-4);
}

// ──────────────────────────────────────────────
// 환경변수 로드 및 검증
// ──────────────────────────────────────────────
function loadEnv() {
  const missing = [];
  const WP_URL = (process.env.WP_URL || '').replace(/\/$/, '');
  const WP_USER = process.env.WP_USER || '';
  const WP_APP_PASS = process.env.WP_APP_PASS || '';

  if (!WP_URL) missing.push('WP_URL');
  if (!WP_USER) missing.push('WP_USER');
  if (!WP_APP_PASS) missing.push('WP_APP_PASS');

  if (missing.length > 0) {
    console.error(
      `[오류] 환경변수 누락: ${missing.join(', ')}\n\n` +
      `  .env.local 파일에 다음 항목을 추가하세요:\n` +
      `    WP_URL=https://tripprice.net\n` +
      `    WP_USER=admin\n` +
      `    WP_APP_PASS=xxxx xxxx xxxx xxxx\n\n` +
      `  (cp .env.example .env.local 으로 템플릿 복사 후 값 입력)\n`
    );
    process.exit(1);
  }

  // Basic Auth 헤더 강제 생성 (OAuth 토큰이 아닌 Application Password 사용)
  // 값 자체는 절대 로그에 노출하지 않음
  const authHeader = buildBasicAuthHeader(WP_USER, WP_APP_PASS);

  return { WP_URL, WP_USER, WP_APP_PASS, authHeader };
}

// ──────────────────────────────────────────────
// Markdown → HTML 변환기 (외부 패키지 없음)
// 기본 요소 지원: H1~H3, bold, italic, lists,
//   blockquotes, code, links, paragraphs
// ──────────────────────────────────────────────
function markdownToHTML(md) {
  if (!md || typeof md !== 'string') return '';

  const lines = md.split('\n');
  const output = [];
  let inList = false;
  let inBlockquote = false;
  let paragraphBuf = [];

  function flushParagraph() {
    if (paragraphBuf.length > 0) {
      const text = paragraphBuf.join(' ').trim();
      if (text) output.push(`<p>${inlineFormat(text)}</p>`);
      paragraphBuf = [];
    }
  }

  function flushList() {
    if (inList) {
      output.push('</ul>');
      inList = false;
    }
  }

  function flushBlockquote() {
    if (inBlockquote) {
      output.push('</blockquote>');
      inBlockquote = false;
    }
  }

  function inlineFormat(text) {
    return text
      // 코드 (인라인)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Bold + Italic
      .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // 링크
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  }

  for (const rawLine of lines) {
    const line = rawLine;
    const trimmed = line.trim();

    // 빈 줄 — 진행 중인 블록 마무리
    if (trimmed === '') {
      flushParagraph();
      flushList();
      flushBlockquote();
      continue;
    }

    // 헤딩
    const h3 = trimmed.match(/^### (.+)/);
    const h2 = trimmed.match(/^## (.+)/);
    const h1 = trimmed.match(/^# (.+)/);

    if (h1) {
      flushParagraph(); flushList(); flushBlockquote();
      output.push(`<h1>${inlineFormat(h1[1])}</h1>`);
      continue;
    }
    if (h2) {
      flushParagraph(); flushList(); flushBlockquote();
      output.push(`<h2>${inlineFormat(h2[1])}</h2>`);
      continue;
    }
    if (h3) {
      flushParagraph(); flushList(); flushBlockquote();
      output.push(`<h3>${inlineFormat(h3[1])}</h3>`);
      continue;
    }

    // 수평선
    if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
      flushParagraph(); flushList(); flushBlockquote();
      output.push('<hr>');
      continue;
    }

    // 비정렬 목록 (-, *, +)
    const listMatch = trimmed.match(/^[-*+] (.+)/);
    if (listMatch) {
      flushParagraph(); flushBlockquote();
      if (!inList) {
        output.push('<ul>');
        inList = true;
      }
      output.push(`<li>${inlineFormat(listMatch[1])}</li>`);
      continue;
    }

    // 순서 목록
    const olMatch = trimmed.match(/^\d+\. (.+)/);
    if (olMatch) {
      flushParagraph(); flushBlockquote();
      if (!inList) {
        output.push('<ol>');
        inList = true;
      }
      output.push(`<li>${inlineFormat(olMatch[1])}</li>`);
      continue;
    }

    // Blockquote
    const bqMatch = trimmed.match(/^> (.+)/);
    if (bqMatch) {
      flushParagraph(); flushList();
      if (!inBlockquote) {
        output.push('<blockquote>');
        inBlockquote = true;
      }
      output.push(`<p>${inlineFormat(bqMatch[1])}</p>`);
      continue;
    }

    // 일반 텍스트 — 단락 버퍼에 누적
    flushList(); flushBlockquote();
    paragraphBuf.push(trimmed);
  }

  // 나머지 플러시
  flushParagraph();
  flushList();
  flushBlockquote();

  return output.join('\n');
}

// ──────────────────────────────────────────────
// 입력 JSON 검증
// ──────────────────────────────────────────────
function validateInput(data) {
  const errors = [];
  const warnings = [];

  // 필수 필드
  const requiredFields = ['post_title', 'slug', 'lang'];
  for (const field of requiredFields) {
    if (!data[field] || String(data[field]).trim() === '') {
      errors.push(`필수 필드 누락: ${field}`);
    }
  }

  // content_html 또는 content_markdown 중 하나 필수
  const hasContent =
    (data.content_html && data.content_html.trim() !== '') ||
    (data.content_markdown && data.content_markdown.trim() !== '');
  if (!hasContent) {
    errors.push('필수 필드 누락: content_html 또는 content_markdown 중 하나 필요');
  }

  // publish 차단
  if (data.post_status === 'publish') {
    errors.push(
      '차단됨: post_status="publish" — 이 스크립트는 draft만 허용합니다.\n' +
      '  → 발행은 WordPress 관리자 화면에서 사람이 직접 수행해야 합니다.'
    );
  }

  // 허용되지 않는 status 값
  const allowedStatuses = ['draft', 'pending', 'private'];
  if (data.post_status && !allowedStatuses.includes(data.post_status)) {
    errors.push(
      `허용되지 않는 post_status: "${data.post_status}"\n` +
      `  → 허용값: ${allowedStatuses.join(', ')}`
    );
  }

  // 권고 사항 (warnings)
  if (!data.post_excerpt || data.post_excerpt.trim() === '') {
    warnings.push('post_excerpt 없음 — 검색 결과 미리보기 품질에 영향');
  }
  if (!data.meta?.meta_description || data.meta.meta_description.trim() === '') {
    warnings.push('meta_description 없음 — SEO 영향');
  }
  if (!data.meta?.canonical_url) {
    warnings.push('canonical_url 없음 — 다국어 운영 시 중복 콘텐츠 리스크');
  }
  if (!data.lang || !['ko', 'en', 'ja'].includes(data.lang)) {
    warnings.push(`lang 값 확인 필요: "${data.lang}" — 권장값: ko, en, ja`);
  }

  // slug 형식 검사
  if (data.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.slug)) {
    warnings.push(`slug 형식 주의: "${data.slug}" — 소문자, 숫자, 하이픈만 권장`);
  }

  // SEO title 길이
  if (data.post_title && data.post_title.length > 60) {
    warnings.push(`post_title이 60자 초과 (${data.post_title.length}자) — SEO title 길이 권장: 60자 이하`);
  }

  // meta_description 길이
  const metaDesc = data.meta?.meta_description || '';
  if (metaDesc && (metaDesc.length < 120 || metaDesc.length > 155)) {
    warnings.push(
      `meta_description 길이 (${metaDesc.length}자) — 권장: 120~155자`
    );
  }

  return { errors, warnings, isValid: errors.length === 0 };
}

// ──────────────────────────────────────────────
// 미디어 업로드 — 로컬 파일 경로 → WP attachment ID
// featured_media_url이 로컬 경로(http 아님)일 때 호출.
// 실패 시 null 반환 (경고만, 발행은 계속).
// ──────────────────────────────────────────────
async function uploadMediaFromFile(localPath, { WP_URL, authHeader }) {
  const absPath = path.resolve(ROOT, localPath);
  if (!require('fs').existsSync(absPath)) {
    console.warn(`  ⚠  로컬 이미지 없음 (featured_media 건너뜀): ${absPath}`);
    return null;
  }

  const buffer = require('fs').readFileSync(absPath);
  const ext    = require('path').extname(absPath).toLowerCase();
  const ctMap  = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
  const contentType = ctMap[ext] || 'image/jpeg';
  const filename    = require('path').basename(absPath);

  const endpoint = `${WP_URL}/wp-json/wp/v2/media`;
  let uploadResponse;
  try {
    uploadResponse = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Authorization':       authHeader,
        'Content-Type':        contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: buffer,
    });
  } catch (err) {
    console.warn(`  ⚠  미디어 업로드 API 오류 (featured_media 건너뜀): ${err.message}`);
    return null;
  }

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => '');
    console.warn(`  ⚠  미디어 업로드 실패 HTTP ${uploadResponse.status} — featured_media 건너뜀`);
    console.warn(`       응답: ${text.substring(0, 120)}`);
    return null;
  }

  const media = await uploadResponse.json();
  console.log(`  ✓  미디어 업로드 완료 — attachment ID: ${media.id} (${filename})`);
  return media.id;
}

// ──────────────────────────────────────────────
// 미디어 업로드 (URL → WP attachment ID)
// featured_media_url을 WP 미디어 라이브러리에 업로드하고
// attachment ID를 반환. 실패 시 null 반환 (경고만, 발행은 계속).
// ──────────────────────────────────────────────
async function uploadMediaFromUrl(imageUrl, { WP_URL, authHeader }) {
  // 1) 이미지 다운로드
  let imgResponse;
  try {
    imgResponse = await fetch(imageUrl);
  } catch (err) {
    console.warn(`  ⚠  이미지 다운로드 실패 (featured_media 건너뜀): ${err.message}`);
    return null;
  }
  if (!imgResponse.ok) {
    console.warn(`  ⚠  이미지 다운로드 실패 HTTP ${imgResponse.status} — featured_media 건너뜀`);
    return null;
  }

  const buffer = Buffer.from(await imgResponse.arrayBuffer());
  const contentType = imgResponse.headers.get('content-type') || 'image/jpeg';
  const filename = imageUrl.split('/').pop().split('?')[0] || 'featured-image.jpg';

  // 2) WP 미디어 업로드
  const endpoint = `${WP_URL}/wp-json/wp/v2/media`;
  let uploadResponse;
  try {
    uploadResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization':        authHeader,
        'Content-Type':         contentType,
        'Content-Disposition':  `attachment; filename="${filename}"`,
      },
      body: buffer,
    });
  } catch (err) {
    console.warn(`  ⚠  미디어 업로드 API 오류 (featured_media 건너뜀): ${err.message}`);
    return null;
  }

  if (!uploadResponse.ok) {
    const text = await uploadResponse.text().catch(() => '');
    console.warn(`  ⚠  미디어 업로드 실패 HTTP ${uploadResponse.status} — featured_media 건너뜀`);
    console.warn(`       응답: ${text.substring(0, 120)}`);
    return null;
  }

  const media = await uploadResponse.json();
  console.log(`  ✓  미디어 업로드 완료 — attachment ID: ${media.id} (${filename})`);
  return media.id;
}

// ──────────────────────────────────────────────
// 본문 이미지 HTML 주입 지원
// ──────────────────────────────────────────────

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 이미지 섹션 1개 → figure HTML.
 * 1장: wp-block-image, 2장 이상: wp-block-gallery.
 *
 * @param {{ local_path, alt }[]} imgs
 * @param {Object} mediaMap  localPath → { id, url }
 * @returns {string}
 */
function buildFigureHtml(imgs, mediaMap) {
  const resolved = (imgs || [])
    .filter(img => mediaMap[img.local_path])
    .map(img => ({ url: mediaMap[img.local_path].url, alt: img.alt }));

  if (resolved.length === 0) return '';

  if (resolved.length === 1) {
    const { url, alt } = resolved[0];
    return `\n<figure class="wp-block-image size-large">` +
           `<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}" loading="lazy"/></figure>\n`;
  }

  const cols  = Math.min(resolved.length, 3);
  const items = resolved.map(({ url, alt }) =>
    `<figure class="wp-block-gallery-item">` +
    `<img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}" loading="lazy"/></figure>`
  ).join('');
  return `\n<figure class="wp-block-gallery columns-${cols}">${items}</figure>\n`;
}

/**
 * HTML content에 content_images를 주입.
 * - post-summary → <h1> 직후
 * - hotel-section → 해당 호텔명 포함 <h2> 직후
 *
 * @param {string}   html
 * @param {object[]} contentImages
 * @param {Object}   mediaMap
 * @returns {string}
 */
function injectImagesIntoHtml(html, contentImages, mediaMap) {
  let result = html;

  for (const section of (contentImages || [])) {
    const fig = buildFigureHtml(section.images || [], mediaMap);
    if (!fig) continue;

    if (section.position === 'post-summary') {
      // <h1>...</h1> 직후
      result = result.replace(/(<h1>[^<]*<\/h1>)/, `$1${fig}`);

    } else if (section.position === 'hotel-section' && section.hotel_name) {
      // <h2>...{hotel_name}...</h2> 직후
      const re = new RegExp(
        `(<h2>[^<]*${escapeRe(section.hotel_name)}[^<]*<\\/h2>)`, 'i'
      );
      result = result.replace(re, `$1${fig}`);
    }
  }

  return result;
}

/**
 * content_images 배열의 이미지를 전부 WP 미디어 라이브러리에 업로드.
 * 업로드 성공 시 mediaMap에 { local_path → { id, url } } 추가.
 * 개별 실패는 WARN만 출력하고 계속.
 *
 * @returns {Object} mediaMap
 */
async function uploadContentImages(contentImages, env) {
  const mediaMap = {};

  for (const section of (contentImages || [])) {
    for (const img of (section.images || [])) {
      const lp = img.local_path;
      if (!lp || mediaMap[lp]) continue; // 이미 업로드된 경우 스킵

      const id = await uploadMediaFromFile(lp, env);
      if (!id) continue;

      // source_url 확보
      try {
        const res = await fetch(`${env.WP_URL}/wp-json/wp/v2/media/${id}`, {
          headers: { Authorization: env.authHeader },
        });
        if (res.ok) {
          const media = await res.json();
          mediaMap[lp] = { id, url: media.source_url };
        }
      } catch (err) {
        console.warn(`  ⚠  source_url 조회 실패 (${lp}): ${err.message}`);
      }
    }
  }

  return mediaMap;
}

// ──────────────────────────────────────────────
// Basic Auth 헤더 강제 생성 (항상 WP_USER:WP_APP_PASS 기반)
// OAuth Bearer 토큰은 사용하지 않음.
// WP Application Password는 공백 포함된 상태로 base64 인코딩.
// ──────────────────────────────────────────────
function buildBasicAuthHeader(WP_USER, WP_APP_PASS) {
  return `Basic ${Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString('base64')}`;
}

// ──────────────────────────────────────────────
// WP REST API 페이로드 빌드
// ──────────────────────────────────────────────
function buildPayload(data, { featuredMediaId = null, injectedContentHtml = null, status = 'draft' } = {}) {
  // 콘텐츠: 주입된 HTML > content_html > content_markdown 변환
  let contentHTML;
  if (injectedContentHtml) {
    contentHTML = injectedContentHtml;
  } else if (data.content_html && data.content_html.trim() !== '') {
    contentHTML = data.content_html;
  } else {
    contentHTML = markdownToHTML(data.content_markdown || '');
  }

  const payload = {
    title:   data.post_title,
    slug:    data.slug,
    status,
    content: contentHTML,
    excerpt: data.post_excerpt || '',
  };

  // 카테고리 / 태그 (ID 배열)
  if (Array.isArray(data.categories) && data.categories.length > 0) {
    payload.categories = data.categories;
  }
  if (Array.isArray(data.tags) && data.tags.length > 0) {
    payload.tags = data.tags;
  }

  // 대표 이미지: URL이 아닌 WP attachment ID 사용 (WP REST API 규격)
  // featured_media_url은 draft JSON 전용 필드. 실제 ID는 uploadMediaFromUrl()로 획득.
  if (featuredMediaId) {
    payload.featured_media = featuredMediaId;
  }

  // 메타 필드 (SEO 플러그인 연동)
  // yoast_meta 우선, 없으면 meta 폴백
  const metaFields = {};

  // Yoast SEO 4개 필드 자동 주입
  // 전제: wordpress/mu-plugin/tripprice-seo-meta.php 가 WP 서버에 배포되어 있어야 실제 저장됨
  const focusKeyphrase = data.yoast_meta?.focus_keyphrase || '';
  if (focusKeyphrase) {
    metaFields._yoast_wpseo_focuskw = focusKeyphrase;
  }

  const yoastSeoTitle = data.yoast_meta?.seo_title || '';
  if (yoastSeoTitle) {
    metaFields._yoast_wpseo_title = yoastSeoTitle;
  }

  const metaDesc = data.yoast_meta?.meta_description || data.meta?.meta_description || '';
  if (metaDesc) {
    metaFields._yoast_wpseo_metadesc = metaDesc;
  }

  const canonicalUrl = data.yoast_meta?.canonical_url || data.meta?.canonical_url || '';
  if (canonicalUrl) {
    metaFields._yoast_wpseo_canonical = canonicalUrl;
  }

  if (Object.keys(metaFields).length > 0) {
    payload.meta = metaFields;
  }

  // 다국어 플러그인 연동
  // Polylang: lang 파라미터 직접 지원
  // WPML: 별도 endpoint 필요 (현재 미지원)
  if (data.lang) {
    payload.lang = data.lang; // Polylang REST API 지원 시 동작
  }

  return payload;
}

// ──────────────────────────────────────────────
// WP slug 중복 확인 + 내부 suffix 부여
// ENV: WP_SLUG_CHECK=1 일 때만 활성화.
// 중복이면 -{baseSlug}-a1, -a2, ... 를 붙여 반환.
// ──────────────────────────────────────────────
async function ensureUniqueWpSlug(slug, env) {
  if (!process.env.WP_SLUG_CHECK) return slug;

  // 기존 -aN suffix 제거 후 베이스 슬러그 확보
  const base = slug.replace(/-a\d+$/, '');
  let candidate = base;
  let suffix = 0;

  for (let attempt = 0; attempt < 10; attempt++) {
    const url = `${env.WP_URL}/wp-json/wp/v2/posts?slug=${encodeURIComponent(candidate)}&status=any&per_page=1`;
    let posts;
    try {
      const res = await fetch(url, { headers: { Authorization: env.authHeader } });
      if (!res.ok) break;  // API 오류 → 현재 candidate 그대로 사용
      posts = await res.json();
    } catch {
      break;  // 네트워크 오류 → 진행
    }
    if (!Array.isArray(posts) || posts.length === 0) break;  // 사용 가능
    suffix++;
    candidate = `${base}-a${suffix}`;
  }

  if (candidate !== slug) {
    console.log(`  slug 중복 감지 — 변경: ${slug} → ${candidate}`);
  }
  return candidate;
}

// ──────────────────────────────────────────────
// WordPress REST API 호출
// - WP_USER + WP_APP_PASS가 있으면 항상 Basic Auth 사용 (OAuth 미사용)
// - 401 수신 시: 자격증명을 재빌드해 1회 재시도 (만료된 세션 쿠키 등 대응)
// - 인증 정보(토큰/비밀번호)는 절대 stdout/stderr에 출력하지 않음
// ──────────────────────────────────────────────
async function publishToWP(payload, env) {
  const { WP_URL, WP_USER, WP_APP_PASS } = env;
  const endpoint = `${WP_URL}/wp-json/wp/v2/posts`;

  // Basic Auth 강제: 항상 WP_USER:WP_APP_PASS로 헤더를 새로 빌드
  const authHeader = buildBasicAuthHeader(WP_USER, WP_APP_PASS);

  async function doPost(auth) {
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  let response;
  try {
    response = await doPost(authHeader);
  } catch (err) {
    throw new Error(
      `네트워크 오류: ${err.message}\n` +
      `  → WP_URL(${WP_URL})이 올바른지, 서버가 실행 중인지 확인하세요.`
    );
  }

  // 401: Basic Auth 헤더를 재빌드 후 1회 재시도
  // (세션 캐시나 프록시 문제 대응 — 자격증명 값은 절대 로그에 미출력)
  if (response.status === 401 && WP_USER && WP_APP_PASS) {
    console.warn(
      `  [auth] HTTP 401 수신 — Basic Auth 헤더 재빌드 후 1회 재시도 중...\n` +
      `  (인증 실패 원인: WP_USER="${WP_USER}", WP_APP_PASS=****${maskSecret(WP_APP_PASS).slice(-4)})`
    );
    const freshAuth = buildBasicAuthHeader(WP_USER, WP_APP_PASS);
    try {
      response = await doPost(freshAuth);
    } catch (err) {
      throw new Error(`재시도 중 네트워크 오류: ${err.message}`);
    }
  }

  // 응답 본문 파싱 (오류 시에도 JSON 시도)
  let body;
  const rawText = await response.text();
  try {
    body = JSON.parse(rawText);
  } catch {
    body = null;
  }

  if (!response.ok) {
    // WP REST API 오류 응답 파싱
    const wpCode = body?.code || 'unknown';
    const wpMessage = body?.message || rawText.substring(0, 200);
    const wpData = body?.data || {};

    let hint = '';
    if (response.status === 401) {
      // 인증 실패 힌트: 절대 실제 자격증명 값 미출력
      hint = '\n  힌트: 인증 실패 (재시도 후에도 401) — WP_USER/WP_APP_PASS를 확인하세요.\n' +
             '  → WordPress 관리자 > 사용자 > 프로필 > Application Passwords에서 새 비밀번호 발급\n' +
             '  → OAuth/Bearer 토큰은 지원하지 않습니다. Application Password만 사용하세요.';
    } else if (response.status === 403) {
      hint = '\n  힌트: 권한 없음 — 해당 사용자에게 글 작성 권한이 있는지 확인하세요.';
    } else if (response.status === 404) {
      hint = '\n  힌트: REST API 엔드포인트를 찾을 수 없음\n' +
             `  → ${endpoint} 접근 가능한지 브라우저에서 확인\n` +
             '  → WordPress 고유주소 설정이 "기본"이 아닌지 확인';
    } else if (response.status === 400 && wpData.params) {
      hint = '\n  실패 필드:\n' +
        Object.entries(wpData.params)
          .map(([k, v]) => `    - ${k}: ${v}`)
          .join('\n');
    }

    throw new Error(
      `WordPress API 오류 (HTTP ${response.status})\n` +
      `  코드: ${wpCode}\n` +
      `  메시지: ${wpMessage}` +
      hint
    );
  }

  return body;
}

// ──────────────────────────────────────────────
// 결과 저장
// ──────────────────────────────────────────────
function saveResult(slug, result, inputPath) {
  if (!fs.existsSync(DIR_CAMPAIGNS)) {
    fs.mkdirSync(DIR_CAMPAIGNS, { recursive: true });
  }

  const record = {
    post_id: result.id,
    slug: result.slug,
    status: result.status,
    title: result.title?.rendered || '',
    edit_url: `${result.link}`.replace(/\/$/, '') || '',
    wp_admin_url: result.guid?.rendered
      ? result.guid.rendered.replace(/\?p=/, 'wp-admin/post.php?post=') + '&action=edit'
      : '',
    published_at: new Date().toISOString(),
    source_file: path.relative(ROOT, inputPath),
  };

  const outPath = path.join(DIR_CAMPAIGNS, `${slug}-published.json`);
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2), 'utf8');
  return { outPath, record };
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────
async function main() {
  // WP 환경변수 자동 로드 (.env.local → .env, 이미 있으면 스킵)
  loadEnvIfNeeded();

  // ── CLI 파싱 ────────────────────────────────────────────────────────────────
  const cliArgs    = process.argv.slice(2);
  const inputArg   = cliArgs.find(a => !a.startsWith('--'));
  const flagMap    = Object.fromEntries(
    cliArgs.filter(a => a.startsWith('--'))
      .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
  );
  const postStatus = ['draft', 'publish'].includes(flagMap.status) ? flagMap.status : 'draft';

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` Tripprice — WordPress 발행 (status: ${postStatus})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1) 인자 확인
  if (!inputArg) {
    console.error(
      '[오류] 입력 파일이 지정되지 않았습니다.\n\n' +
      '사용법:\n' +
      '  node scripts/wp-publish.js [JSON 파일 경로]\n\n' +
      '예시:\n' +
      '  node scripts/wp-publish.js wordpress/sample-post.json\n' +
      '  (WP 인증정보는 .env.local 파일에서 자동 로드됩니다)'
    );
    process.exit(1);
  }

  const inputPath = path.resolve(ROOT, inputArg);
  if (!fs.existsSync(inputPath)) {
    console.error(`[오류] 파일을 찾을 수 없음: ${inputPath}`);
    process.exit(1);
  }

  // 2) 환경변수 로드
  const env = loadEnv();
  console.log(`WP 사이트: ${env.WP_URL}`);
  console.log(`사용자: ${env.WP_USER}`);
  console.log(`입력 파일: ${path.relative(ROOT, inputPath)}\n`);

  // 3) 입력 JSON 파싱
  let data;
  try {
    data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  } catch (err) {
    console.error(`[오류] JSON 파싱 실패: ${err.message}`);
    process.exit(1);
  }

  // 4) 검증
  const { errors, warnings, isValid } = validateInput(data);

  if (warnings.length > 0) {
    console.log('⚠  경고:');
    for (const w of warnings) console.log(`   - ${w}`);
    console.log('');
  }

  if (!isValid) {
    console.error('✗  검증 실패 — 아래 오류를 수정 후 다시 실행하세요:\n');
    for (const e of errors) console.error(`   ✗ ${e}`);
    console.error('');
    process.exit(1);
  }

  console.log(`글 제목: ${data.post_title}`);
  console.log(`slug:    ${data.slug}`);
  console.log(`언어:    ${data.lang}`);
  console.log(`상태:    ${postStatus}\n`);

  // 5) 대표 이미지 업로드 (featured_media_url → attachment ID)
  // URL이면 원격 다운로드, 로컬 경로면 파일 직접 읽어 업로드
  let featuredMediaId = null;
  if (data.featured_media_url) {
    const fmu = data.featured_media_url;
    console.log(`대표 이미지 업로드 중: ${fmu}`);
    if (/^https?:\/\//.test(fmu)) {
      featuredMediaId = await uploadMediaFromUrl(fmu, env);
    } else {
      featuredMediaId = await uploadMediaFromFile(fmu, env);
    }
  } else {
    console.log('featured_media_url 없음 — 대표 이미지 업로드 건너뜀');
  }

  // 5.5) 본문 이미지 업로드 + HTML 주입
  let injectedContentHtml = null;
  if (Array.isArray(data.content_images) && data.content_images.length > 0) {
    const totalImgs = data.content_images.reduce((s, sec) => s + (sec.images || []).length, 0);
    console.log(`본문 이미지 업로드 중 (${data.content_images.length}개 섹션, 총 ${totalImgs}장)...`);
    const mediaMap = await uploadContentImages(data.content_images, env);
    const uploaded = Object.keys(mediaMap).length;
    if (uploaded > 0) {
      const baseHtml = data.content_html && data.content_html.trim()
        ? data.content_html
        : markdownToHTML(data.content_markdown || '');
      injectedContentHtml = injectImagesIntoHtml(baseHtml, data.content_images, mediaMap);
      console.log(`  ✓  본문 이미지 주입 완료 (${uploaded}장)`);
    } else {
      console.log('  ⚠  본문 이미지 업로드 실패 — 텍스트만 발행');
    }
  }

  // 5.8) slug 중복 확인 (WP_SLUG_CHECK=1 일 때만)
  data.slug = await ensureUniqueWpSlug(data.slug, env);
  console.log(`slug(확정): ${data.slug}`);

  // 6) 페이로드 빌드
  const payload = buildPayload(data, { featuredMediaId, injectedContentHtml, status: postStatus });

  // Yoast meta 주입 여부 안내
  if (data.yoast_meta?.focus_keyphrase) {
    console.log(`Yoast 포커스 키프레이즈: ${data.yoast_meta.focus_keyphrase}`);
  }
  if (data.yoast_meta?.seo_title) {
    console.log(`Yoast SEO 제목: ${data.yoast_meta.seo_title}`);
  }
  if (!data.yoast_meta?.focus_keyphrase && !data.yoast_meta?.seo_title) {
    console.log('yoast_meta 없음 — Yoast 필드 주입 건너뜀 (mu-plugin 배포 후 재실행 가능)');
  }

  // 7) 발행
  console.log('WordPress REST API 호출 중...');
  let result;
  try {
    result = await publishToWP(payload, env);
  } catch (err) {
    console.error(`\n✗  발행 실패\n${err.message}\n`);
    process.exit(1);
  }

  // 7) 결과 저장
  const { outPath, record } = saveResult(data.slug, result, inputPath);

  // 8) 성공 출력
  // machine-readable 한 줄 — editorial-chief.js가 post_id 파싱에 사용
  console.log(`WP_RESULT_JSON: ${JSON.stringify({
    post_id: record.post_id,
    slug:    record.slug,
    url:     record.edit_url,
    status:  result.status,
  })}`);

  const isPublished = result.status === 'publish';
  console.log(`\n✓  ${isPublished ? '발행 성공!' : 'Draft 저장 성공!'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` post_id  : ${record.post_id}`);
  console.log(` status   : ${result.status}`);
  console.log(` slug     : ${result.slug}`);
  console.log(` edit_url : ${env.WP_URL}/wp-admin/post.php?post=${record.post_id}&action=edit`);
  console.log(` 결과 저장: ${path.relative(ROOT, outPath)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (!isPublished) {
    console.log('\n다음 단계: WordPress 관리자 화면에서 검토 후 Publish 하세요.\n');
  }
}

// 직접 실행 시에만 main() 호출 (require로 불러올 때는 실행 안 함)
if (require.main === module) {
  main();
}

// 테스트에서 사용할 수 있도록 핵심 함수 export
module.exports = {
  validateInput, markdownToHTML, buildPayload, buildBasicAuthHeader,
  uploadMediaFromUrl, uploadMediaFromFile, uploadContentImages,
  buildFigureHtml, injectImagesIntoHtml, ensureUniqueWpSlug,
};
