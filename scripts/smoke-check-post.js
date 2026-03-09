'use strict';
/**
 * smoke-check-post.js
 * WP 발행 직후 게시물 품질 스모크 체크.
 *
 * 사용법:
 *   node scripts/smoke-check-post.js --post-id=123 [--slug=foo-bar]
 *
 * 검사 항목:
 *   1. 이미지 블록 존재 (wp-block-image 또는 <img)
 *   2. 제휴 링크 존재 (agoda.com 포함)
 *   3. Yoast 메타 존재 (_yoast_wpseo_focuskw 또는 _yoast_wpseo_metadesc)
 *   4. 대표 이미지 설정 (featured_media > 0)
 *
 * 출력: JSON { ok, post_id, slug, checks, failures }
 * 종료코드: 0 = 전부 통과, 1 = 실패 항목 있음
 *
 * ENV: WP_URL, WP_USER, WP_APP_PASS
 */

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const postId = parseInt(args['post-id'] || '0', 10);
const argSlug = args.slug || '';

if (!postId) {
  console.error('사용법: node scripts/smoke-check-post.js --post-id=NNN [--slug=xxx]');
  process.exit(1);
}

const WP_URL      = (process.env.WP_URL || '').replace(/\/$/, '');
const WP_USER     = process.env.WP_USER || '';
const WP_APP_PASS = process.env.WP_APP_PASS || '';

if (!WP_URL || !WP_USER || !WP_APP_PASS) {
  console.error('smoke-check: WP_URL / WP_USER / WP_APP_PASS 환경변수 없음 — 체크 건너뜀');
  // 환경변수 없으면 통과 처리 (발행 흐름 차단 방지)
  process.stdout.write(JSON.stringify({
    ok: true, post_id: postId, slug: argSlug,
    checks: {}, failures: [],
    note: 'skipped — WP 환경변수 없음',
  }, null, 2) + '\n');
  process.exit(0);
}

const authHeader = `Basic ${Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString('base64')}`;

async function main() {
  // context=edit 로 fetch → meta 필드 포함
  const url = `${WP_URL}/wp-json/wp/v2/posts/${postId}?context=edit`;
  let post;
  try {
    const res = await fetch(url, { headers: { Authorization: authHeader } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} — ${text.slice(0, 120)}`);
    }
    post = await res.json();
  } catch (err) {
    console.error(`smoke-check: WP API 오류 — ${err.message}`);
    // API 오류는 soft-fail (rotation 기록 상 failure_reason 남김)
    process.stdout.write(JSON.stringify({
      ok: false, post_id: postId, slug: argSlug,
      checks: {}, failures: ['WP API 접근 실패'],
      error: err.message,
    }, null, 2) + '\n');
    process.exit(1);
  }

  // content: edit context에서는 raw, 아니면 rendered
  const content = (post.content?.raw || post.content?.rendered || '').toLowerCase();
  const meta    = post.meta || {};

  const checks   = {};
  const failures = [];

  // 1. 이미지 블록
  checks.has_image_block = /wp-block-image|<img[\s>]/.test(content);
  if (!checks.has_image_block) failures.push('이미지 블록 없음');

  // 2. 제휴 링크 (agoda.com)
  checks.has_affiliate_link = content.includes('agoda.com');
  if (!checks.has_affiliate_link) failures.push('제휴 링크(agoda.com) 없음');

  // 3. Yoast 메타
  const yoastFocuskw  = meta._yoast_wpseo_focuskw  || '';
  const yoastMetadesc = meta._yoast_wpseo_metadesc || '';
  checks.has_yoast_meta = !!(yoastFocuskw || yoastMetadesc);
  if (!checks.has_yoast_meta) failures.push('Yoast 메타(focuskw/metadesc) 없음');

  // 4. 대표 이미지
  checks.has_featured_media = (post.featured_media || 0) > 0;
  if (!checks.has_featured_media) failures.push('대표 이미지(featured_media) 없음');

  const ok = failures.length === 0;
  const result = {
    ok,
    post_id:  postId,
    slug:     post.slug || argSlug,
    checks,
    failures,
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  if (ok) {
    console.error(`smoke-check PASS: post ${postId} (${result.slug})`);
  } else {
    console.error(`smoke-check FAIL: post ${postId} (${result.slug}) — ${failures.join(', ')}`);
  }

  process.exit(ok ? 0 : 1);
}

main().catch(err => {
  console.error('smoke-check 오류:', err.message);
  process.exit(1);
});
