#!/usr/bin/env node
/**
 * 실패한 WP taxonomy 항목 재시도 (요청 간 딜레이 추가).
 * 사용: node scripts/_run-with-env.js scripts/_create-wp-taxonomy-retry.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const WP_URL  = (process.env.WP_URL  || '').replace(/\/$/, '');
const WP_USER = process.env.WP_USER  || '';
const WP_PASS = process.env.WP_APP_PASS || '';
const auth    = 'Basic ' + Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');
const ROOT    = path.resolve(__dirname, '..');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function createItem(type, body) {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/${type}`, {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`비JSON 응답 (HTTP ${res.status}): ${text.slice(0, 80)}`); }
  if (!res.ok) {
    if (data.code === 'term_exists') return { id: data.data.term_id, slug: body.slug, existed: true };
    throw new Error(`${data.message || res.status}`);
  }
  return { ...data, existed: false };
}

// 미생성 항목만
const CATS = [
  { name: 'Tokyo',    slug: 'city-tokyo',   description: '도쿄 호텔' },
  { name: 'Osaka',    slug: 'city-osaka',   description: '오사카 호텔' },
  { name: 'Bangkok',  slug: 'city-bangkok', description: '방콕 호텔' },
  { name: 'Luxury',   slug: 'luxury',       description: '럭셔리 호텔' },
  { name: 'Budget',   slug: 'budget',       description: '가성비 호텔' },
];

const TAGS = [
  { name: '호텔 비교', slug: 'hotel-comparison-tag' },
  { name: '호텔 추천', slug: 'hotel-recommendation' },
  { name: '아고다',    slug: 'agoda' },
];

async function main() {
  const catResults = {};
  const tagResults = {};

  console.log('\n── 카테고리 재시도 ──────────────────────────────────────');
  for (const cat of CATS) {
    await sleep(800);
    try {
      const item = await createItem('categories', { name: cat.name, slug: cat.slug, description: cat.description });
      catResults[cat.slug] = item.id;
      console.log(`  ${item.existed ? '(기존)' : '(신규)'} id=${item.id}  slug=${item.slug}`);
    } catch (e) { console.error(`  ✗ ${cat.slug}: ${e.message}`); }
  }

  console.log('\n── 태그 재시도 ──────────────────────────────────────────');
  for (const tag of TAGS) {
    await sleep(800);
    try {
      const item = await createItem('tags', { name: tag.name, slug: tag.slug });
      tagResults[tag.slug] = item.id;
      console.log(`  ${item.existed ? '(기존)' : '(신규)'} id=${item.id}  slug=${item.slug}`);
    } catch (e) { console.error(`  ✗ ${tag.slug}: ${e.message}`); }
  }

  // category-map.json 보완
  const catMapPath = path.join(ROOT, 'config', 'category-map.json');
  const catMap = JSON.parse(fs.readFileSync(catMapPath, 'utf8'));
  if (catResults['city-tokyo'])   { catMap.city['도쿄']  = [catResults['city-tokyo']];   catMap.city['tokyo']   = [catResults['city-tokyo']]; }
  if (catResults['city-osaka'])   { catMap.city['오사카'] = [catResults['city-osaka']];  catMap.city['osaka']   = [catResults['city-osaka']]; }
  if (catResults['city-bangkok']) { catMap.city['방콕']   = [catResults['city-bangkok']]; catMap.city['bangkok'] = [catResults['city-bangkok']]; }
  if (catResults['luxury'])  { catMap.type['럭셔리'] = [catResults['luxury']]; catMap.type['luxury'] = [catResults['luxury']]; }
  if (catResults['budget'])  { catMap.type['가성비'] = [catResults['budget']]; catMap.type['budget'] = [catResults['budget']]; }
  fs.writeFileSync(catMapPath, JSON.stringify(catMap, null, 2), 'utf8');
  console.log('\n  category-map.json 보완 완료');

  // tag-map.json 보완
  const tagMapPath = path.join(ROOT, 'config', 'tag-map.json');
  const tagMap = JSON.parse(fs.readFileSync(tagMapPath, 'utf8'));
  if (tagResults['hotel-comparison-tag']) { tagMap.type['비교'] = [tagResults['hotel-comparison-tag']]; }
  if (tagResults['hotel-recommendation']) { tagMap.type['추천'] = [tagResults['hotel-recommendation']]; }
  fs.writeFileSync(tagMapPath, JSON.stringify(tagMap, null, 2), 'utf8');
  console.log('  tag-map.json 보완 완료\n');
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
