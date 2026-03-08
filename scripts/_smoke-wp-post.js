#!/usr/bin/env node
/**
 * _smoke-wp-post.js
 * WordPress에 올라간 초안(post_id)을 REST로 검증합니다.
 *
 * 검증 항목:
 *   1. 본문 이미지 블록 존재 (wp-block-image 또는 wp-block-gallery)
 *   2. 파트너 링크 존재 (CID 파라미터 cid=1926938)
 *   3. Yoast 3종 비어있지 않음 (focuskw / seo_title / meta_desc)
 *   4. 대표 이미지(featured_media) 존재
 *
 * 사용법:
 *   node scripts/_run-with-env.js scripts/_smoke-wp-post.js --post-id=34
 *
 * 결과: OK/FAIL만 출력. 민감값 출력 금지.
 * exit(0) = 전체 OK, exit(1) = 1개 이상 FAIL
 */
'use strict';

const https = require('https');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const POST_ID = parseInt(args['post-id'] || args['postId'] || '0', 10);
if (!POST_ID) {
  console.error('사용법: node scripts/_run-with-env.js scripts/_smoke-wp-post.js --post-id=<ID>');
  process.exit(1);
}

const WP_URL  = (process.env.WP_URL || '').replace(/\/$/, '');
const WP_USER = process.env.WP_USER || '';
const WP_PASS = process.env.WP_APP_PASS || '';

if (!WP_URL || !WP_USER || !WP_PASS) {
  console.error('FAIL: WP_URL / WP_USER / WP_APP_PASS 환경변수 확인 필요');
  process.exit(1);
}

const AUTH = Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');

function wpGet(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${WP_URL}/wp-json/wp/v2${path}`);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      headers:  { Authorization: `Basic ${AUTH}`, Accept: 'application/json' },
    };
    https.get(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    }).on('error', reject)
      .setTimeout(15000, function() { this.destroy(); reject(new Error('WP REST 타임아웃')); });
  });
}

(async () => {
  console.log(`WP 초안 검증 — post_id: ${POST_ID}`);
  console.log(`  대상: ${WP_URL}/wp-admin/post.php?post=${POST_ID}&action=edit`);
  console.log('');

  let allOk = true;

  try {
    const { status, body: post } = await wpGet(`/posts/${POST_ID}?context=edit`);
    if (status !== 200) {
      console.error(`  FAIL: WP REST 응답 HTTP ${status} (post_id ${POST_ID} 없음?)`);
      process.exit(1);
    }

    const html = (post.content?.rendered || '') + (post.content?.raw || '');
    const meta = post.meta || {};

    // 1. 이미지 블록
    const imgOk = html.includes('wp-block-image') || html.includes('wp-block-gallery');
    console.log(`  [1] 이미지 블록 존재      : ${imgOk ? 'OK' : 'FAIL'}`);
    if (!imgOk) allOk = false;

    // 2. 파트너 링크 (cid= 파라미터 포함 agoda.com href, 또는 Affiliate Lite landingURL)
    const CID     = process.env.AGODA_CID || '1926938';
    const cidOk   = html.includes(`cid=${CID}`) ||
                    /href="https?:\/\/(?:www\.)?agoda\.com\//.test(html);
    console.log(`  [2] 파트너 링크 존재       : ${cidOk ? 'OK' : 'FAIL'}`);
    if (!cidOk) allOk = false;

    // 3. Yoast 3종
    const fkw  = meta['_yoast_wpseo_focuskw'];
    const seoT = meta['_yoast_wpseo_title'];
    const seoM = meta['_yoast_wpseo_metadesc'];
    const yoastOk = !!(fkw && seoT && seoM);
    console.log(`  [3] Yoast 3종 (fkw/title/desc): ${yoastOk ? 'OK' : 'FAIL (mu-plugin 미배포?)'}`);
    if (!yoastOk) {
      allOk = false;
      if (!fkw)  console.log('       focuskw   : 비어있음');
      if (!seoT) console.log('       seo_title : 비어있음');
      if (!seoM) console.log('       meta_desc : 비어있음');
    }

    // 4. 대표 이미지
    const featOk = post.featured_media > 0;
    console.log(`  [4] 대표 이미지 존재       : ${featOk ? `OK (id=${post.featured_media})` : 'FAIL'}`);
    if (!featOk) allOk = false;

    // 추가 정보 (값 노출 없이)
    console.log('');
    console.log(`  status : ${post.status === 'draft' ? 'OK (draft)' : post.status}`);
    console.log(`  slug   : ${post.slug || '(없음)'}`);
    console.log(`  제목길이: ${(post.title?.rendered || '').length}자`);
    console.log('');
    console.log(allOk ? '결과: 전체 OK' : '결과: FAIL 항목 있음 — 위 내용 확인');
    process.exit(allOk ? 0 : 1);

  } catch (err) {
    console.error(`  오류: ${err.message}`);
    process.exit(1);
  }
})();
