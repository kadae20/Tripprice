'use strict';
/**
 * test-editorial-upgrade.js
 * 편집국 업그레이드 모듈 단위 테스트.
 * 대상: build-internal-links.js, agoda-link-builder.js (ensureUtm/UTM), scheduler helpers
 * 실행: node scripts/test-editorial-upgrade.js
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const {
  loadIndex,
  updateIndex,
  selectLinks,
  injectInternalLinks,
  extractCityFromSlug,
  parseDraftMeta,
} = require('./build-internal-links');

const {
  buildPartnerUrl,
  ensureUtm,
  getCID,
} = require('../lib/agoda-link-builder');

const {
  pickPostType,
  hotelCountForType,
} = (() => {
  // Inline the helpers for testing (they are not exported separately)
  const playbookPath = path.join(__dirname, '..', 'config', 'editorial-playbook.json');
  const playbook = fs.existsSync(playbookPath)
    ? JSON.parse(fs.readFileSync(playbookPath, 'utf8'))
    : null;

  function pickPostType(pb) {
    if (!pb || !pb.post_types) return 'hotel-comparison';
    const types = Object.entries(pb.post_types);
    const total = types.reduce((s, [, t]) => s + (t.scheduling_weight || 0), 0);
    if (total <= 0) return 'hotel-comparison';
    let r = Math.random() * total;
    for (const [name, t] of types) {
      r -= (t.scheduling_weight || 0);
      if (r <= 0) return name;
    }
    return types[types.length - 1][0];
  }

  function hotelCountForType(postType, pb, available) {
    const def = pb?.post_types?.[postType];
    if (!def) return Math.min(2, available);
    const min = def.min_hotels || 1;
    const max = def.max_hotels || 3;
    const n   = min + Math.floor(Math.random() * (max - min + 1));
    return Math.min(n, available);
  }

  return { pickPostType: (pb = playbook) => pickPostType(pb), hotelCountForType, playbook };
})();

// ── 테스트 러너 ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        → ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ── 임시 파일 헬퍼 ────────────────────────────────────────────────────────────
function tmpFile(content, ext = '.md') {
  const p = path.join(os.tmpdir(), `tripprice-test-${Date.now()}${ext}`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ── build-internal-links: extractCityFromSlug ─────────────────────────────────
console.log('\n[build-internal-links] extractCityFromSlug');

test('서울 슬러그에서 도시 추출', () => {
  assertEqual(extractCityFromSlug('seoul-luxury-comparison'), 'seoul');
});
test('부산 슬러그에서 도시 추출', () => {
  assertEqual(extractCityFromSlug('busan-hotel-review-2026'), 'busan');
});
test('제주 슬러그에서 도시 추출', () => {
  assertEqual(extractCityFromSlug('jeju-resort-guide'), 'jeju');
});
test('알 수 없는 슬러그 → 빈 문자열', () => {
  assertEqual(extractCityFromSlug('unknown-topic'), '');
});

// ── build-internal-links: selectLinks ────────────────────────────────────────
console.log('\n[build-internal-links] selectLinks');

const sampleLinks = [
  { slug: 'seoul-a', title: '서울 A', url: '/ko/seoul-a', city: 'seoul', lang: 'ko', post_type: 'hotel-comparison' },
  { slug: 'seoul-b', title: '서울 B', url: '/ko/seoul-b', city: 'seoul', lang: 'ko', post_type: 'hotel-review' },
  { slug: 'busan-a', title: '부산 A', url: '/ko/busan-a', city: 'busan', lang: 'ko', post_type: 'hotel-comparison' },
  { slug: 'en-seoul', title: 'Seoul A EN', url: '/en/en-seoul', city: 'seoul', lang: 'en', post_type: 'hotel-comparison' },
];

test('같은 언어만 선택', () => {
  const result = selectLinks(sampleLinks, 'seoul', 'ko', [], 2);
  assert(result.every(l => l.lang === 'ko'), '영어 링크가 섞였음');
});
test('제외 슬러그 필터링', () => {
  const result = selectLinks(sampleLinks, 'seoul', 'ko', ['seoul-a'], 2);
  assert(!result.find(l => l.slug === 'seoul-a'), 'excluded slug 포함됨');
});
test('최소 2개 반환 (가능한 경우)', () => {
  const result = selectLinks(sampleLinks, 'seoul', 'ko', [], 2);
  assert(result.length >= 2, `링크 ${result.length}개 반환`);
});
test('같은 도시 우선 배치', () => {
  const result = selectLinks(sampleLinks, 'seoul', 'ko', [], 1);
  assert(result.length > 0, '결과 없음');
  assert(result[0].city === 'seoul', '같은 도시가 앞에 와야 함');
});
test('링크 없으면 빈 배열', () => {
  const result = selectLinks([], 'seoul', 'ko', [], 2);
  assertEqual(result.length, 0, '빈 배열이어야 함');
});

// ── build-internal-links: injectInternalLinks ─────────────────────────────────
console.log('\n[build-internal-links] injectInternalLinks');

test('내부 링크 제안 섹션 교체', () => {
  const content = `---\ntitle: "테스트"\nslug: "test"\nlang: ko\n---\n\n# 제목\n\n## 내부 링크 제안 (발행 전 삽입)\n\n- [예시](/ko/example)\n\n> 위 URL은 예시입니다.\n\n---\n\n*이 글에는 아고다 파트너 링크가 포함되어 있습니다.*\n`;
  const p       = tmpFile(content);
  const links   = [{ title: '서울 가이드', url: '/ko/seoul-guide' }];
  injectInternalLinks(p, links);
  const result  = fs.readFileSync(p, 'utf8');
  assert(result.includes('## 관련 글'), '섹션이 교체되지 않음');
  assert(result.includes('[서울 가이드](/ko/seoul-guide)'), '링크가 삽입되지 않음');
  assert(!result.includes('위 URL은 예시'), '이전 내용이 남아있음');
  fs.unlinkSync(p);
});

test('섹션 없을 때 푸터 앞에 삽입', () => {
  const content = `---\ntitle: "테스트"\n---\n\n# 제목\n\n본문 내용.\n\n---\n\n*이 글에는 아고다 파트너 링크가 포함되어 있습니다.*\n`;
  const p       = tmpFile(content);
  const links   = [{ title: '서울 가이드', url: '/ko/seoul-guide' }];
  injectInternalLinks(p, links);
  const result  = fs.readFileSync(p, 'utf8');
  assert(result.includes('[서울 가이드](/ko/seoul-guide)'), '링크가 삽입되지 않음');
  fs.unlinkSync(p);
});

test('파일 없으면 false 반환', () => {
  const ok = injectInternalLinks('/nonexistent/file.md', [{ title: 'A', url: '/ko/a' }]);
  assertEqual(ok, false, 'false를 반환해야 함');
});

// ── build-internal-links: parseDraftMeta ─────────────────────────────────────
console.log('\n[build-internal-links] parseDraftMeta');

test('front-matter에서 slug/lang 파싱', () => {
  const content = `---\ntitle: "테스트"\nslug: "seoul-hotel-guide"\nlang: ko\npost_type: hotel-comparison\n---\n\n# 본문\n`;
  const p       = tmpFile(content);
  const meta    = parseDraftMeta(p);
  assertEqual(meta.slug, 'seoul-hotel-guide', 'slug 파싱 실패');
  assertEqual(meta.lang, 'ko', 'lang 파싱 실패');
  assertEqual(meta.city, 'seoul', 'city 추출 실패');
  fs.unlinkSync(p);
});

test('front-matter 없으면 빈 객체', () => {
  const p    = tmpFile('# 제목만 있음\n');
  const meta = parseDraftMeta(p);
  assertEqual(meta.slug, undefined, 'slug이 있으면 안됨');
  fs.unlinkSync(p);
});

// ── agoda-link-builder: buildPartnerUrl (UTM 포함) ────────────────────────────
console.log('\n[agoda-link-builder] buildPartnerUrl UTM');

test('UTM 파라미터 포함', () => {
  const url = buildPartnerUrl('535922', 'grand-hyatt-seoul');
  assert(url.includes('utm_source=tripprice'), 'utm_source 없음');
  assert(url.includes('utm_medium=affiliate'), 'utm_medium 없음');
  assert(url.includes('utm_campaign='), 'utm_campaign 없음');
});

test('CID 포함', () => {
  const url = buildPartnerUrl('535922', 'test');
  const CID = getCID();
  assert(url.includes(`cid=${CID}`), `CID(${CID}) 없음`);
});

test('tag 기반 campaign 생성', () => {
  const url = buildPartnerUrl('535922', 'grand-hyatt-seoul', 'my-campaign');
  assert(url.includes('utm_campaign=my-campaign'), 'campaign 값 불일치');
});

test('공백 포함 tag 정규화', () => {
  const url = buildPartnerUrl('535922', 'Grand Hyatt Seoul');
  assert(!url.includes(' '), '공백이 URL에 포함됨');
});

// ── agoda-link-builder: ensureUtm ────────────────────────────────────────────
console.log('\n[agoda-link-builder] ensureUtm');

test('UTM 없는 URL에 추가', () => {
  const url    = 'https://www.agoda.com/hotel/535922?cid=1926938';
  const result = ensureUtm(url, 'test-slug');
  assert(result.includes('utm_source=tripprice'), 'utm_source 미추가');
  assert(result.includes('utm_medium=affiliate'), 'utm_medium 미추가');
});

test('이미 UTM 있으면 유지', () => {
  const url    = 'https://www.agoda.com/hotel/535922?utm_source=other&utm_medium=cpc';
  const result = ensureUtm(url, 'test');
  assert(result.includes('utm_source=other'), '기존 UTM이 변경됨');
  assert(!result.includes('utm_source=tripprice'), 'tripprice UTM이 중복 추가됨');
});

test('빈 URL은 그대로', () => {
  assertEqual(ensureUtm('', 'test'), '', '빈 URL이 변경됨');
  assertEqual(ensureUtm(null, 'test'), null, 'null이 변경됨');
});

test('? 없는 URL에 ? 추가', () => {
  const url    = 'https://www.agoda.com/hotel/535922';
  const result = ensureUtm(url, 'slug');
  assert(result.includes('?utm_source='), '? 없이 파라미터 추가됨');
  assert(!result.includes('&&'), '&& 중복');
});

// ── editorial-playbook: post_type 선택 ────────────────────────────────────────
console.log('\n[editorial-playbook] post_type 선택');

const playbook = (() => {
  const p = path.join(__dirname, '..', 'config', 'editorial-playbook.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
})();

test('playbook 로드 성공', () => {
  assert(playbook !== null, 'editorial-playbook.json 없음');
  assert(typeof playbook.post_types === 'object', 'post_types 필드 없음');
});

test('모든 post_type에 scheduling_weight 있음', () => {
  if (!playbook) return;
  for (const [name, t] of Object.entries(playbook.post_types)) {
    assert(typeof t.scheduling_weight === 'number',
      `${name}.scheduling_weight 없음`);
    assert(t.scheduling_weight >= 0, `${name}.scheduling_weight < 0`);
  }
});

test('scheduling_weight 합계 > 0', () => {
  if (!playbook) return;
  const total = Object.values(playbook.post_types)
    .reduce((s, t) => s + (t.scheduling_weight || 0), 0);
  assert(total > 0, `weight 합계 0: ${total}`);
});

test('pickPostType이 유효한 type 반환', () => {
  if (!playbook) return;
  const knownTypes = Object.keys(playbook.post_types);
  // 100번 샘플
  for (let i = 0; i < 100; i++) {
    const t = pickPostType(playbook);
    assert(knownTypes.includes(t), `알 수 없는 post_type: ${t}`);
  }
});

test('hotelCountForType이 min~max 범위 반환', () => {
  if (!playbook) return;
  for (const [typeName, def] of Object.entries(playbook.post_types)) {
    const min = def.min_hotels || 1;
    const max = def.max_hotels || 3;
    for (let i = 0; i < 20; i++) {
      const n = hotelCountForType(typeName, playbook, 10);
      assert(n >= min && n <= max, `${typeName}: ${n} not in [${min},${max}]`);
    }
  }
});

test('min_hotels/max_hotels 필드 있음', () => {
  if (!playbook) return;
  for (const [name, t] of Object.entries(playbook.post_types)) {
    assert(typeof t.min_hotels === 'number', `${name}.min_hotels 없음`);
    assert(typeof t.max_hotels === 'number', `${name}.max_hotels 없음`);
    assert(t.min_hotels <= t.max_hotels, `${name}: min > max`);
  }
});

// ── state 파일 존재 확인 ──────────────────────────────────────────────────────
console.log('\n[state files]');

test('state/internal-links/index.json 존재', () => {
  const p = path.join(__dirname, '..', 'state', 'internal-links', 'index.json');
  assert(fs.existsSync(p), '파일 없음');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert(Array.isArray(data.links), 'links 배열 없음');
});

test('state/kpi/hotel-performance.json 존재', () => {
  const p = path.join(__dirname, '..', 'state', 'kpi', 'hotel-performance.json');
  assert(fs.existsSync(p), '파일 없음');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert(typeof data === 'object', '객체가 아님');
});

test('config/editorial-playbook.json 존재', () => {
  const p = path.join(__dirname, '..', 'config', 'editorial-playbook.json');
  assert(fs.existsSync(p), '파일 없음');
});

// ── 결과 ──────────────────────────────────────────────────────────────────────
console.log(`\n결과: PASS ${passed} / FAIL ${failed} / 합계 ${passed + failed}`);
if (failed > 0) {
  console.error(`\n❌ ${failed}개 테스트 실패`);
  process.exit(1);
}
console.log('\n✅ 모든 테스트 통과');
