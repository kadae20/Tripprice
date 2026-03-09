#!/usr/bin/env node
'use strict';
/**
 * build-internal-links.js
 * 내부링크 인덱스 갱신 + 초안 마크다운에 실제 링크 2개 이상 삽입.
 *
 * 사용법:
 *   node scripts/build-internal-links.js --draft=draft-xxx   (삽입 + 인덱스 갱신)
 *   node scripts/build-internal-links.js --update-index      (인덱스 갱신만)
 *
 * 입력:
 *   state/campaigns/*-published.json  — 발행 기록
 *   wordpress/drafts/post-*.json      — 발행 번들 메타 (draft 포함)
 *   state/internal-links/index.json   — 현재 인덱스
 *
 * 출력:
 *   state/internal-links/index.json   — 갱신된 인덱스
 *   wordpress/drafts/{draftFile}.md   — 내부링크 실제 삽입된 초안
 *
 * 실패 시 exit(0) — 파이프라인을 중단시키지 않음.
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const CAMPAIGNS  = path.join(ROOT, 'state', 'campaigns');
const DRAFTS_DIR = path.join(ROOT, 'wordpress', 'drafts');
const INDEX_DIR  = path.join(ROOT, 'state', 'internal-links');
const INDEX_PATH = path.join(INDEX_DIR, 'index.json');

// ── 도시 추출 헬퍼 ────────────────────────────────────────────────────────────
function extractCityFromSlug(slug) {
  const cities = ['seoul', 'busan', 'jeju', 'incheon', 'gyeongju', 'jeonju'];
  for (const city of cities) {
    if (slug && slug.includes(city)) return city;
  }
  return '';
}

// ── 인덱스 I/O ────────────────────────────────────────────────────────────────
function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) return { updated_at: '', links: [] };
  try { return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8')); }
  catch { return { updated_at: '', links: [] }; }
}

function saveIndex(idx) {
  if (!fs.existsSync(INDEX_DIR)) fs.mkdirSync(INDEX_DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2), 'utf8');
}

// ── 발행 기록/초안에서 링크 항목 수집 ────────────────────────────────────────
function collectLinksFromPublished() {
  const entries = [];
  const seen    = new Set();

  // 1) state/campaigns/*-published.json
  if (fs.existsSync(CAMPAIGNS)) {
    const pubFiles = fs.readdirSync(CAMPAIGNS).filter(f => f.endsWith('-published.json'));
    for (const f of pubFiles) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS, f), 'utf8'));
        if (!rec.slug || seen.has(rec.slug)) continue;
        seen.add(rec.slug);
        const lang = rec.lang || 'ko';
        entries.push({
          slug:         rec.slug,
          title:        rec.post_title || rec.title || rec.slug,
          url:          `/${lang}/${rec.slug}`,
          city:         rec.city || extractCityFromSlug(rec.slug),
          lang,
          post_type:    rec.post_type || 'hotel-comparison',
          hotel_ids:    Array.isArray(rec.hotel_ids) ? rec.hotel_ids : [],
          published_at: rec.published_at || rec.created_at || '',
        });
      } catch {}
    }
  }

  // 2) wordpress/drafts/post-*.json (WP payload — title/slug/lang/city 있는 것만)
  if (fs.existsSync(DRAFTS_DIR)) {
    const postFiles = fs.readdirSync(DRAFTS_DIR)
      .filter(f => f.startsWith('post-') && f.endsWith('.json'));
    for (const f of postFiles) {
      try {
        const rec  = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8'));
        const slug = rec.slug;
        if (!slug || seen.has(slug) || !rec.post_title) continue;
        seen.add(slug);
        const lang = rec.lang || 'ko';
        const hotelIds = Array.isArray(rec.hotels)
          ? rec.hotels.map(h => h.hotel_id || h.id).filter(Boolean)
          : [];
        entries.push({
          slug,
          title:        rec.post_title,
          url:          `/${lang}/${slug}`,
          city:         rec.city || extractCityFromSlug(slug),
          lang,
          post_type:    rec.post_type || 'hotel-comparison',
          hotel_ids:    hotelIds,
          published_at: '',
        });
      } catch {}
    }
  }

  return entries;
}

// ── 인덱스 갱신 (병합, slug 기준 dedup) ──────────────────────────────────────
function updateIndex() {
  const idx   = loadIndex();
  const fresh = collectLinksFromPublished();
  const today = new Date().toISOString().split('T')[0];

  const slugMap = {};
  for (const l of idx.links) slugMap[l.slug] = l;

  for (const e of fresh) {
    if (!slugMap[e.slug]) {
      slugMap[e.slug] = e;
    } else {
      // title/url/published_at만 갱신
      Object.assign(slugMap[e.slug], e);
    }
  }

  idx.links      = Object.values(slugMap);
  idx.updated_at = today;
  saveIndex(idx);
  return idx;
}

// ── 링크 선택 (같은 도시·언어 우선, 랜덤 shuffle) ────────────────────────────
function selectLinks(allLinks, targetCity, targetLang, excludeSlugs = [], count = 2) {
  const eligible = allLinks.filter(l =>
    l.lang === targetLang && !excludeSlugs.includes(l.slug)
  );

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const sameCity  = eligible.filter(l => l.city === targetCity);
  const otherCity = eligible.filter(l => l.city !== targetCity);
  const ordered   = [...shuffle(sameCity), ...shuffle(otherCity)];
  return ordered.slice(0, Math.max(count, 2));
}

// ── 초안 front-matter 파싱 ────────────────────────────────────────────────────
function parseDraftMeta(draftPath) {
  if (!fs.existsSync(draftPath)) return {};
  try {
    const content  = fs.readFileSync(draftPath, 'utf8');
    const fmMatch  = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};
    const fm       = fmMatch[1];
    const slug     = (fm.match(/^slug:\s*"?([^"\n]+)"?/m) || [])[1] || '';
    const lang     = (fm.match(/^lang:\s*(\S+)/m) || [])[1] || 'ko';
    return { slug, lang, city: extractCityFromSlug(slug) };
  } catch { return {}; }
}

// ── 초안에 내부링크 실제 삽입 ────────────────────────────────────────────────
function injectInternalLinks(draftPath, selectedLinks) {
  if (!fs.existsSync(draftPath)) return false;

  let content = fs.readFileSync(draftPath, 'utf8');

  const linkLines = selectedLinks.map(l => `- [${l.title}](${l.url})`).join('\n');
  const newSection = `## 관련 글\n\n${linkLines}\n`;

  // "내부 링크 제안" 섹션 교체 (H2 경계까지)
  const sectionRe = /## 내부 링크 제안[^\n]*\n[\s\S]*?(?=\n## |\n---\n|$)/;
  if (sectionRe.test(content)) {
    content = content.replace(sectionRe, newSection + '\n');
  } else if (/\n---\n\n\*이 글에는 아고다/.test(content)) {
    // 푸터 앞에 삽입
    content = content.replace(
      /\n---\n\n\*이 글에는 아고다/,
      `\n${newSection}\n---\n\n*이 글에는 아고다`
    );
  } else {
    // 맨 끝에 추가
    content = content.trimEnd() + '\n\n' + newSection;
  }

  fs.writeFileSync(draftPath, content, 'utf8');
  return true;
}

// ── exports (테스트용) ────────────────────────────────────────────────────────
module.exports = {
  loadIndex,
  updateIndex,
  selectLinks,
  injectInternalLinks,
  extractCityFromSlug,
  collectLinksFromPublished,
  parseDraftMeta,
};

// ── CLI 실행부 ────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
  );

  (async () => {
    const idx        = updateIndex();
    const totalLinks = idx.links.length;

    console.log(`\n내부링크 빌더 (인덱스: ${totalLinks}개)`);

    if (args['update-index']) {
      console.log(`  인덱스 갱신 완료: ${INDEX_PATH}`);
      process.exit(0);
    }

    if (!args.draft) {
      console.error('사용법: node scripts/build-internal-links.js --draft=draft-xxx');
      process.exit(1);
    }

    // 초안 경로 해석
    let draftPath = args.draft;
    if (!path.isAbsolute(draftPath)) {
      const base = path.basename(draftPath);
      const withExt = base.endsWith('.md') ? base : `${base}.md`;
      const c1 = path.join(ROOT, draftPath);
      const c2 = path.join(DRAFTS_DIR, withExt);
      draftPath = fs.existsSync(c1) ? c1 : fs.existsSync(c2) ? c2 : c1;
    }

    if (totalLinks === 0) {
      console.log('  ⚠  링크 인덱스 비어있음 — 삽입 건너뜀');
      process.exit(0);
    }

    const meta     = parseDraftMeta(draftPath);
    const city     = meta.city || '';
    const lang     = meta.lang || 'ko';
    const slug     = meta.slug || '';
    const selected = selectLinks(idx.links, city, lang, [slug], 2);

    if (selected.length === 0) {
      console.log(`  ⚠  적합한 링크 없음 (city=${city}, lang=${lang}) — 건너뜀`);
      process.exit(0);
    }

    const ok = injectInternalLinks(draftPath, selected);
    if (ok) {
      console.log(`  내부링크 ${selected.length}개 삽입:`);
      selected.forEach(l => console.log(`    - [${l.title}](${l.url})`));
      console.log(`  파일: ${draftPath}`);
    } else {
      console.log(`  ⚠  초안 파일 없음: ${draftPath}`);
    }
    process.exit(0);
  })().catch(err => {
    console.error('build-internal-links 오류:', err.message);
    process.exit(0); // soft-fail: 파이프라인 중단 금지
  });
}
