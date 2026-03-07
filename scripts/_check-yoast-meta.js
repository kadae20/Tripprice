'use strict';
const fs   = require('fs');
const path = require('path');

// .env.local 파싱
const envPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    process.env[m[1]] = val;
  }
}

const POST_ID   = process.argv[2] || '23';
const WP_URL    = (process.env.WP_URL || '').replace(/\/$/, '');
const WP_USER   = process.env.WP_USER || '';
const WP_APP_PASS = process.env.WP_APP_PASS || '';

if (!WP_URL || !WP_USER || !WP_APP_PASS) {
  console.error('환경변수 WP_URL / WP_USER / WP_APP_PASS 확인 필요');
  process.exit(1);
}

const authHeader = 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString('base64');

const YOAST_KEYS = [
  '_yoast_wpseo_focuskw',
  '_yoast_wpseo_title',
  '_yoast_wpseo_metadesc',
  '_yoast_wpseo_canonical',
];

async function main() {
  const url = `${WP_URL}/wp-json/wp/v2/posts/${POST_ID}?context=edit`;
  const res  = await fetch(url, { headers: { Authorization: authHeader } });

  if (!res.ok) {
    console.error(`REST API 오류 HTTP ${res.status}`);
    process.exit(1);
  }

  const body = await res.json();
  const meta = body.meta || {};

  console.log(`\n=== Yoast meta 주입 확인 (post_id=${POST_ID}) ===`);

  let pass = 0;
  for (const k of YOAST_KEYS) {
    const val = meta[k];
    if (val === undefined) {
      console.log(`❌ 키없음  ${k}`);
      console.log(`   → 플러그인 미활성화 가능성`);
    } else if (val === '') {
      console.log(`⚠️  빈값   ${k}`);
      console.log(`   → 키는 등록됐지만 값이 저장되지 않음`);
    } else {
      console.log(`✅ 주입됨  ${k}`);
      console.log(`   → ${val}`);
      pass++;
    }
  }

  console.log('');
  if (pass === YOAST_KEYS.length) {
    console.log('결과: 4개 전부 주입 성공 ✅');
    console.log(`편집 화면: ${WP_URL}/wp-admin/post.php?post=${POST_ID}&action=edit`);
  } else if (pass === 0 && Object.keys(meta).length <= 1) {
    console.log('결과: ❌ Yoast 키가 REST에 노출되지 않음');
    console.log('  → tripprice-seo-meta 플러그인 활성화 여부를 WP 관리자에서 확인하세요.');
  } else {
    console.log(`결과: ⚠️  ${pass}/${YOAST_KEYS.length}개 성공`);
  }
  console.log('');
}

main().catch(e => { console.error(e.message); process.exit(1); });
