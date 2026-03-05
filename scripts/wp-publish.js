#!/usr/bin/env node
/**
 * wp-publish.js
 *
 * WordPress REST API 기반 Draft 발행 스크립트.
 * publish 상태는 차단됩니다. draft만 허용.
 *
 * 사용법:
 *   WP_URL=https://example.com WP_USER=admin WP_APP_PASS="xxxx xxxx xxxx" \
 *     node scripts/wp-publish.js wordpress/sample-post.json
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
      `  실행 예시:\n` +
      `  WP_URL=https://tripprice.net \\\n` +
      `  WP_USER=admin \\\n` +
      `  WP_APP_PASS="xxxx xxxx xxxx xxxx" \\\n` +
      `    node scripts/wp-publish.js wordpress/sample-post.json\n`
    );
    process.exit(1);
  }

  // Basic Auth 헤더 생성
  // WP Application Password는 공백 포함된 상태로 base64 인코딩
  const credentials = Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString('base64');

  return { WP_URL, WP_USER, WP_APP_PASS, authHeader: `Basic ${credentials}` };
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
// WP REST API 페이로드 빌드
// ──────────────────────────────────────────────
function buildPayload(data) {
  // 콘텐츠: HTML 우선, 없으면 Markdown 변환
  let contentHTML;
  if (data.content_html && data.content_html.trim() !== '') {
    contentHTML = data.content_html;
  } else {
    contentHTML = markdownToHTML(data.content_markdown || '');
  }

  const payload = {
    title: data.post_title,
    slug: data.slug,
    status: 'draft', // 항상 draft 강제
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

  // 메타 필드 (SEO 플러그인 연동)
  const metaFields = {};

  if (data.meta?.meta_description) {
    // Yoast SEO (가장 일반적)
    metaFields._yoast_wpseo_metadesc = data.meta.meta_description;
    // Rank Math 사용 시: metaFields.rank_math_description = data.meta.meta_description;
    // All in One SEO 사용 시: metaFields._aioseop_description = data.meta.meta_description;
  }

  if (data.meta?.canonical_url) {
    metaFields._yoast_wpseo_canonical = data.meta.canonical_url;
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
// WordPress REST API 호출
// ──────────────────────────────────────────────
async function publishToWP(payload, { WP_URL, authHeader }) {
  const endpoint = `${WP_URL}/wp-json/wp/v2/posts`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(
      `네트워크 오류: ${err.message}\n` +
      `  → WP_URL(${WP_URL})이 올바른지, 서버가 실행 중인지 확인하세요.`
    );
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
      hint = '\n  힌트: 인증 실패 — WP_USER/WP_APP_PASS를 확인하세요.\n' +
             '  → WordPress 관리자 > 사용자 > 프로필 > Application Passwords에서 생성';
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

  // 응답에서 publish 상태 이중 확인 (방어적)
  if (body?.status === 'publish') {
    throw new Error(
      '이상 감지: 응답 status가 "publish"입니다. 즉시 WordPress에서 확인하세요.\n' +
      `  post_id: ${body.id}\n` +
      `  edit_url: ${body.link}`
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
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' Tripprice — WordPress Draft 발행');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // 1) 인자 확인
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error(
      '[오류] 입력 파일이 지정되지 않았습니다.\n\n' +
      '사용법:\n' +
      '  node scripts/wp-publish.js [JSON 파일 경로]\n\n' +
      '예시:\n' +
      '  WP_URL=https://tripprice.net WP_USER=admin WP_APP_PASS="xxxx xxxx" \\\n' +
      '    node scripts/wp-publish.js wordpress/sample-post.json'
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
  console.log(`slug: ${data.slug}`);
  console.log(`언어: ${data.lang}`);
  console.log(`상태: draft (강제)\n`);

  // 5) 페이로드 빌드
  const payload = buildPayload(data);

  // 6) 발행
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
  console.log('\n✓  Draft 발행 성공!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` post_id  : ${record.post_id}`);
  console.log(` status   : ${result.status}`);
  console.log(` slug     : ${result.slug}`);
  console.log(` edit_url : ${env.WP_URL}/wp-admin/post.php?post=${record.post_id}&action=edit`);
  console.log(` 결과 저장: ${path.relative(ROOT, outPath)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n다음 단계: WordPress 관리자 화면에서 검토 후 Publish 하세요.\n');
}

// 직접 실행 시에만 main() 호출 (require로 불러올 때는 실행 안 함)
if (require.main === module) {
  main();
}

// 테스트에서 사용할 수 있도록 핵심 함수 export
module.exports = { validateInput, markdownToHTML, buildPayload };
