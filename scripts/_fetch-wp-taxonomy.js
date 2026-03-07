#!/usr/bin/env node
/**
 * WP REST API에서 카테고리·태그 목록을 조회해 출력.
 * 사용: node scripts/_run-with-env.js scripts/_fetch-wp-taxonomy.js
 */
'use strict';
const WP_URL = (process.env.WP_URL || '').replace(/\/$/, '');
if (!WP_URL) { console.error('WP_URL 환경변수 없음'); process.exit(1); }

async function fetchAll(endpoint) {
  const url = `${WP_URL}/wp-json/wp/v2/${endpoint}?per_page=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function main() {
  const [cats, tags] = await Promise.all([
    fetchAll('categories').catch(e => { console.error('categories 조회 실패:', e.message); return []; }),
    fetchAll('tags').catch(e => { console.error('tags 조회 실패:', e.message); return []; }),
  ]);

  console.log('\n=== CATEGORIES ===');
  if (cats.length === 0) {
    console.log('  (없음 — WP 관리자 > 글 > 카테고리에서 먼저 생성하세요)');
  } else {
    cats.forEach(c => console.log(`  id=${c.id}  slug=${c.slug}  name=${c.name}`));
  }

  console.log('\n=== TAGS ===');
  if (tags.length === 0) {
    console.log('  (없음 — WP 관리자 > 글 > 태그에서 먼저 생성하세요)');
  } else {
    tags.forEach(t => console.log(`  id=${t.id}  slug=${t.slug}  name=${t.name}`));
  }

  console.log('\n');
}

main().catch(e => { console.error(e.message); process.exit(1); });
