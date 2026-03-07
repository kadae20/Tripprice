#!/usr/bin/env node
/**
 * WP REST API를 통해 필요한 카테고리·태그를 일괄 생성하고
 * config/category-map.json / config/tag-map.json을 자동으로 업데이트.
 *
 * 사용: node scripts/_run-with-env.js scripts/_create-wp-taxonomy.js
 *
 * 이미 존재하는 슬러그는 건너뛰고 기존 ID를 재사용합니다.
 */
'use strict';
const fs   = require('fs');
const path = require('path');

const WP_URL  = (process.env.WP_URL  || '').replace(/\/$/, '');
const WP_USER = process.env.WP_USER  || '';
const WP_PASS = process.env.WP_APP_PASS || '';

if (!WP_URL || !WP_USER || !WP_PASS) {
  console.error('WP_URL / WP_USER / WP_APP_PASS 환경변수 필요');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${WP_USER}:${WP_PASS}`).toString('base64');
const ROOT  = path.resolve(__dirname, '..');

// ── 생성할 카테고리 목록 ───────────────────────────────────────────────────────
const CATEGORIES_TO_CREATE = [
  { name: 'Hotel Comparison', slug: 'hotel-comparison', description: '호텔 비교 글' },
  { name: 'Hotel Review',     slug: 'hotel-review',     description: '호텔 단독 리뷰' },
  { name: 'Seoul',            slug: 'city-seoul',        description: '서울 호텔' },
  { name: 'Busan',            slug: 'city-busan',        description: '부산 호텔' },
  { name: 'Jeju',             slug: 'city-jeju',         description: '제주 호텔' },
  { name: 'Tokyo',            slug: 'city-tokyo',        description: '도쿄 호텔' },
  { name: 'Osaka',            slug: 'city-osaka',        description: '오사카 호텔' },
  { name: 'Bangkok',          slug: 'city-bangkok',      description: '방콕 호텔' },
  { name: 'Luxury',           slug: 'luxury',            description: '럭셔리 호텔' },
  { name: 'Budget',           slug: 'budget',            description: '가성비 호텔' },
];

// ── 생성할 태그 목록 ───────────────────────────────────────────────────────────
const TAGS_TO_CREATE = [
  { name: '서울 호텔',     slug: 'seoul-hotel'     },
  { name: '부산 호텔',     slug: 'busan-hotel'     },
  { name: '제주 호텔',     slug: 'jeju-hotel'      },
  { name: '럭셔리 호텔',   slug: 'luxury-hotel'    },
  { name: '가성비 호텔',   slug: 'budget-hotel'    },
  { name: '호텔 비교',     slug: 'hotel-comparison-tag' },
  { name: '호텔 추천',     slug: 'hotel-recommendation' },
  { name: '아고다',        slug: 'agoda'           },
];

// ── REST API 헬퍼 ────────────────────────────────────────────────────────────
async function getExisting(type) {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/${type}?per_page=100`);
  if (!res.ok) throw new Error(`GET ${type} 실패: HTTP ${res.status}`);
  return res.json();
}

async function createItem(type, body) {
  const res = await fetch(`${WP_URL}/wp-json/wp/v2/${type}`, {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    // 슬러그 중복(term_exists) → 기존 ID 반환
    if (data.code === 'term_exists') {
      return { id: data.data.term_id, slug: body.slug, name: body.name, existed: true };
    }
    throw new Error(`POST ${type} 실패: ${data.message || res.status}`);
  }
  return { ...data, existed: false };
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n WP taxonomy 생성 시작');
  console.log(`  사이트: ${WP_URL}\n`);

  // 카테고리 생성
  const catResults = {};
  console.log('── 카테고리 ────────────────────────────────────────────');
  for (const cat of CATEGORIES_TO_CREATE) {
    try {
      const item = await createItem('categories', { name: cat.name, slug: cat.slug, description: cat.description });
      catResults[cat.slug] = item.id;
      const mark = item.existed ? '(기존)' : '(신규)';
      console.log(`  ${mark} id=${item.id}  slug=${item.slug}`);
    } catch (e) {
      console.error(`  ✗ ${cat.slug}: ${e.message}`);
    }
  }

  // 태그 생성
  const tagResults = {};
  console.log('\n── 태그 ────────────────────────────────────────────────');
  for (const tag of TAGS_TO_CREATE) {
    try {
      const item = await createItem('tags', { name: tag.name, slug: tag.slug });
      tagResults[tag.slug] = item.id;
      const mark = item.existed ? '(기존)' : '(신규)';
      console.log(`  ${mark} id=${item.id}  slug=${item.slug}`);
    } catch (e) {
      console.error(`  ✗ ${tag.slug}: ${e.message}`);
    }
  }

  // ── category-map.json 업데이트 ────────────────────────────────────────────
  const catMapPath = path.join(ROOT, 'config', 'category-map.json');
  const catMap = JSON.parse(fs.readFileSync(catMapPath, 'utf8'));

  const slug2id = (slug) => catResults[slug] ? [catResults[slug]] : [];

  catMap.city['서울']   = slug2id('city-seoul');
  catMap.city['seoul']  = slug2id('city-seoul');
  catMap.city['부산']   = slug2id('city-busan');
  catMap.city['busan']  = slug2id('city-busan');
  catMap.city['제주']   = slug2id('city-jeju');
  catMap.city['jeju']   = slug2id('city-jeju');
  catMap.city['도쿄']   = slug2id('city-tokyo');
  catMap.city['tokyo']  = slug2id('city-tokyo');
  catMap.city['오사카'] = slug2id('city-osaka');
  catMap.city['osaka']  = slug2id('city-osaka');
  catMap.city['방콕']   = slug2id('city-bangkok');
  catMap.city['bangkok']= slug2id('city-bangkok');

  catMap.type['비교']   = [...slug2id('hotel-comparison'), ...slug2id('hotel-review')].filter((v,i,a) => a.indexOf(v) === i);
  catMap.type['추천']   = slug2id('hotel-review');
  catMap.type['가이드'] = slug2id('hotel-review');
  catMap.type['럭셔리'] = slug2id('luxury');
  catMap.type['luxury'] = slug2id('luxury');
  catMap.type['가성비'] = slug2id('budget');
  catMap.type['budget'] = slug2id('budget');

  fs.writeFileSync(catMapPath, JSON.stringify(catMap, null, 2), 'utf8');
  console.log(`\n  category-map.json 업데이트 완료: ${catMapPath}`);

  // ── tag-map.json 생성/업데이트 ───────────────────────────────────────────
  const tagMapPath = path.join(ROOT, 'config', 'tag-map.json');
  const tagMap = {
    _comment: 'WP 태그 ID 매핑. 키워드 → WP 태그 ID 배열.',
    _note:    '태그 ID는 WP 관리자 > 글 > 태그에서 확인. REST: GET /wp-json/wp/v2/tags',
    city: {
      '서울':   tagResults['seoul-hotel']   ? [tagResults['seoul-hotel']]   : [],
      'seoul':  tagResults['seoul-hotel']   ? [tagResults['seoul-hotel']]   : [],
      '부산':   tagResults['busan-hotel']   ? [tagResults['busan-hotel']]   : [],
      'busan':  tagResults['busan-hotel']   ? [tagResults['busan-hotel']]   : [],
      '제주':   tagResults['jeju-hotel']    ? [tagResults['jeju-hotel']]    : [],
      'jeju':   tagResults['jeju-hotel']    ? [tagResults['jeju-hotel']]    : [],
    },
    type: {
      '비교':   tagResults['hotel-comparison-tag'] ? [tagResults['hotel-comparison-tag']] : [],
      '추천':   tagResults['hotel-recommendation'] ? [tagResults['hotel-recommendation']] : [],
      '럭셔리': tagResults['luxury-hotel'] ? [tagResults['luxury-hotel']] : [],
      'luxury': tagResults['luxury-hotel'] ? [tagResults['luxury-hotel']] : [],
      '가성비': tagResults['budget-hotel'] ? [tagResults['budget-hotel']] : [],
      'budget': tagResults['budget-hotel'] ? [tagResults['budget-hotel']] : [],
    },
  };
  fs.writeFileSync(tagMapPath, JSON.stringify(tagMap, null, 2), 'utf8');
  console.log(`  tag-map.json 생성/업데이트 완료: ${tagMapPath}`);

  console.log('\n 완료. 이제 pipeline을 다시 실행하면 categories/tags가 자동으로 채워집니다.\n');
}

main().catch(e => { console.error('\n✗', e.message); process.exit(1); });
