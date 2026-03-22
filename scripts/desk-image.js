#!/usr/bin/env node
/**
 * desk-image.js — Image Desk
 *
 * featured_media_url 보장 + content_images 총합 5장 미달 시 보강.
 * fallback 우선순위:
 *   1) assets/processed/<slug>/featured.webp (or .jpg)
 *   2) assets/placeholder/featured.webp (or .jpg)
 *   3) placeholder URL
 *
 * Usage: node scripts/desk-image.js <draft_json_path> [--dry-run]
 * Exit: 0 = 정상, 1 = 파일 오류
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT             = path.resolve(__dirname, '..');
const ASSETS_DIR       = path.join(ROOT, 'assets');
const MIN_TOTAL_IMG    = 5;
const PLACEHOLDER_FEAT = 'https://via.placeholder.com/1200x630?text=Tripprice+Hotel';
const PLACEHOLDER_BASE = 'https://via.placeholder.com/1200x800?text=Tripprice';

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  return { file: args.find(a => !a.startsWith('--')), dryRun: args.includes('--dry-run') };
}

// ── content_images 총 이미지 수 (qa-wp-post.js 동일) ─────────────────────────
function countContentImages(contentImages) {
  if (!Array.isArray(contentImages)) return 0;
  return contentImages.reduce((sum, sec) => {
    const imgs = sec.images || sec.media || sec.gallery || [];
    return sum + (Array.isArray(imgs) ? imgs.length : 0);
  }, 0);
}

// ── 로컬 featured 이미지 경로 탐색 ──────────────────────────────────────────
function findLocalFeatured(slug) {
  const EXTS = ['.webp', '.jpg', '.jpeg', '.png'];
  const dirs = [
    path.join(ASSETS_DIR, 'processed', slug),
    path.join(ASSETS_DIR, 'placeholder'),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const ext of EXTS) {
      const p = path.join(dir, `featured${ext}`);
      try { if (fs.existsSync(p) && fs.statSync(p).size > 0) return path.relative(ROOT, p).replace(/\\/g, '/'); } catch {}
    }
    // 첫 번째 이미지 파일이라도 사용 (0바이트 제외)
    try {
      const files = fs.readdirSync(dir).filter(f => {
        if (!EXTS.some(e => f.toLowerCase().endsWith(e))) return false;
        try { return fs.statSync(path.join(dir, f)).size > 0; } catch { return false; }
      });
      if (files.length > 0) return path.relative(ROOT, path.join(dir, files[0])).replace(/\\/g, '/');
    } catch { /* skip */ }
  }
  return null;
}

// ── 로컬 보조 이미지 목록 ─────────────────────────────────────────────────────
function findLocalAssets(slug) {
  const EXTS = new Set(['.webp', '.jpg', '.jpeg', '.png']);
  const dirs = [
    path.join(ASSETS_DIR, 'processed', slug),
    path.join(ASSETS_DIR, 'raw', slug),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const files = fs.readdirSync(dir).filter(f => {
        if (!EXTS.has(path.extname(f).toLowerCase())) return false;
        try { return fs.statSync(path.join(dir, f)).size > 0; } catch { return false; }
      });
      if (files.length > 0) return files.map(f => path.relative(ROOT, path.join(dir, f)).replace(/\\/g, '/'));
    } catch { /* skip */ }
  }
  return [];
}

// ── 이미지 상태 계산 ──────────────────────────────────────────────────────────
function calcImageState(draft) {
  const featured   = String(draft.featured_media_url || '').trim();
  const htmlRaw    = String(draft.content_html || draft.html || draft.body_html || draft.content || draft.post_content || '').trim();
  const imgInHtml  = htmlRaw ? (htmlRaw.match(/<img/gi) || []).length : 0;
  const imgInSecs  = countContentImages(draft.content_images);
  const hasFeat    = !!featured;
  const total      = (hasFeat ? 1 : 0) + imgInHtml + imgInSecs;
  return { featured, hasFeat, imgInHtml, imgInSecs, total };
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
function main() {
  const { file, dryRun } = parseArgs();
  if (!file) { console.error('사용법: node scripts/desk-image.js <draft_json_path>'); process.exit(1); }

  const absPath = path.resolve(ROOT, file);
  if (!fs.existsSync(absPath)) { console.error(`파일 없음: ${absPath}`); process.exit(1); }

  let draft;
  try { draft = JSON.parse(fs.readFileSync(absPath, 'utf8')); }
  catch (e) { console.error(`JSON 파싱 실패: ${e.message}`); process.exit(1); }

  const slug      = String(draft.slug || draft.hotel_id || '').trim();
  const hotelName = String(draft.post_title || draft.title || slug || 'Hotel').trim();
  const changes   = [];

  let { hasFeat, imgInHtml, imgInSecs, total } = calcImageState(draft);

  // (1) featured_media_url 없으면 설정
  if (!hasFeat) {
    const local = findLocalFeatured(slug);
    const newFeat = local || (slug ? `${PLACEHOLDER_FEAT}&hotel=${encodeURIComponent(slug)}` : PLACEHOLDER_FEAT);
    draft.featured_media_url = newFeat;
    hasFeat = true;
    total += 1;
    changes.push(`featured 설정: ${newFeat.slice(0, 60)}`);
  }

  // (2) 총 이미지 < 5이면 보강
  if (total < MIN_TOTAL_IMG) {
    const needed      = MIN_TOTAL_IMG - total;
    const localAssets = findLocalAssets(slug);
    const extras      = [];

    for (let i = 0; i < needed; i++) {
      const imgUrl = localAssets.length > 0
        ? localAssets[i % localAssets.length]
        : `${PLACEHOLDER_BASE}&n=${imgInSecs + i + 1}&hotel=${encodeURIComponent(slug)}`;
      extras.push({ local_path: imgUrl, alt: `${hotelName} 호텔 이미지 ${imgInSecs + i + 1}` });
    }

    let ci = JSON.parse(JSON.stringify(draft.content_images || []));
    if (ci.length > 0) {
      if (!ci[0].images) ci[0].images = [];
      ci[0].images.push(...extras);
    } else {
      ci.push({ position: 'desk-image-extra', images: extras });
    }
    draft.content_images = ci;
    changes.push(`이미지 +${needed}장 → 총 ${MIN_TOTAL_IMG}장`);
  }

  if (changes.length === 0) {
    console.log(`  [image] 이미 충족 — 변경 없음`);
    process.exit(0);
  }

  if (dryRun) {
    console.log(`  [image] DRY-RUN: ${changes.join(', ')}`);
    process.exit(0);
  }

  if (!draft.workflow_state) draft.workflow_state = {};
  draft.workflow_state.image_desk = true;
  draft.workflow_state.image_at   = new Date().toISOString();

  fs.writeFileSync(absPath, JSON.stringify(draft, null, 2), 'utf8');
  console.log(`  [image] ${path.basename(absPath)}: ${changes.join(', ')}`);
}

if (require.main === module) main();
