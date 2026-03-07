#!/usr/bin/env node
/**
 * make-post-image.js
 *
 * 글(post) 단위 대표 이미지 생성.
 *
 * 우선순위:
 *   1) assets/raw/{first_hotel}/featured.* (또는 첫 번째 이미지) → WebP 변환
 *   2) 이미지 없으면 → SVG 요약 카드 자동 생성 (로컬, 외부 서비스 없음)
 *
 * 출력:
 *   assets/processed/{post_slug}/featured.webp
 *   assets/processed/{post_slug}/alt-texts.json
 *
 * 사용법:
 *   node scripts/make-post-image.js --brief=brief-seoul-luxury-comparison-2026-03-06
 *   node scripts/make-post-image.js --post=seoul-luxury-comparison --hotels=grand-hyatt-seoul,lotte-hotel-seoul
 *   node scripts/make-post-image.js --brief=... --watermark --lang=ko
 *
 * 실패 시 exit(0) — 파이프라인을 중단시키지 않음 (WARN만 출력).
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..');
const DIR_RAW       = path.join(ROOT, 'assets', 'raw');
const DIR_PROCESSED = path.join(ROOT, 'assets', 'processed');
const DIR_DRAFTS    = path.join(ROOT, 'wordpress', 'drafts');

const SUPPORTED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff']);
const FEATURED_RE   = /featured|main|hero|cover|01/i;

// ── 순수 함수 (테스트 가능) ────────────────────────────────────────────────────

/**
 * 슬러그 → 표시용 제목 (ASCII 영어, sharp 렌더 안전)
 * "grand-hyatt-seoul" → "Grand Hyatt Seoul"
 */
function slugToTitle(slug) {
  return String(slug)
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * SVG 특수문자 이스케이프.
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 대표 이미지 요약 카드 SVG 생성.
 * 외부 폰트/서비스 불필요. 영문 텍스트만 사용(sharp 렌더 안전).
 *
 * @param {object} opts
 * @param {string}   opts.postSlug    - e.g. "seoul-luxury-comparison"
 * @param {string[]} opts.hotelSlugs  - e.g. ["grand-hyatt-seoul","lotte-hotel-seoul"]
 * @param {boolean}  [opts.watermark] - 워터마크 강조 여부
 * @returns {Buffer} SVG buffer
 */
function buildCardSvg({ postSlug, hotelSlugs, watermark = false }) {
  const title     = slugToTitle(postSlug);         // "Seoul Luxury Comparison"
  const hotelLine = hotelSlugs.slice(0, 2).map(slugToTitle).join(' vs ');

  // 타이틀 줄바꿈 (22자 기준)
  const words = title.split(' ');
  const titleLines = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length <= 22) { cur = candidate; }
    else { if (cur) titleLines.push(cur); cur = w; }
  }
  if (cur) titleLines.push(cur);
  const tl = titleLines.slice(0, 2);  // 최대 2줄

  const titleSvg = tl.map((l, i) =>
    `<text x="60" y="${185 + i * 72}" font-family="Arial, sans-serif" ` +
    `font-size="54" fill="white" font-weight="bold">${escapeXml(l)}</text>`
  ).join('\n    ');

  const hotelY = 185 + tl.length * 72 + 24;

  const wmOpacity = watermark ? 0.65 : 0.40;

  return Buffer.from(
    `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#12172b"/>
      <stop offset="100%" style="stop-color:#1a3a5c"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="7" fill="#e8a045"/>
  <rect x="0" y="623" width="1200" height="7" fill="#e8a045"/>

  <!-- 태그 필 -->
  <rect x="60" y="68" width="200" height="36" fill="#e8a045" rx="4"/>
  <text x="72" y="92" font-family="Arial, sans-serif" font-size="17"
        fill="#12172b" font-weight="bold">HOTEL COMPARISON</text>

  <!-- 제목 -->
  ${titleSvg}

  <!-- 호텔명 -->
  <text x="60" y="${hotelY}" font-family="Arial, sans-serif" font-size="27"
        fill="#e8a045" font-weight="bold">${escapeXml(hotelLine.slice(0, 50))}</text>

  <!-- 구분선 -->
  <rect x="60" y="580" width="220" height="1" fill="rgba(255,255,255,0.18)"/>
  <text x="60" y="606" font-family="Arial, sans-serif" font-size="16"
        fill="rgba(255,255,255,0.30)">tripprice.net</text>
  <text x="1140" y="606" font-family="Arial, sans-serif" font-size="22"
        fill="rgba(255,255,255,${wmOpacity})" text-anchor="end"
        font-weight="bold">Tripprice</text>
</svg>`
  );
}

/**
 * 대표 이미지 alt 텍스트 생성 (언어별).
 *
 * @param {object} opts
 * @param {string}   opts.postSlug
 * @param {string[]} opts.hotelNames  - 표시용 호텔명 (한국어/영어 모두 가능)
 * @param {string}   [opts.lang]      - ko|en|ja
 * @param {boolean}  [opts.isCard]    - 자동 생성 카드 여부
 * @returns {string}
 */
function buildCardAltText({ postSlug, hotelNames, lang = 'ko', isCard = true }) {
  const pair  = hotelNames.slice(0, 2).join(' vs ');
  const title = slugToTitle(postSlug);

  const templates = {
    ko: isCard
      ? `${title} 대표 이미지 — ${pair}`
      : `${pair} 비교 대표 이미지`,
    en: `${title} — ${pair} Featured Image`,
    ja: `${title} 代表画像 — ${pair}`,
  };

  const alt = templates[lang] || templates.ko;
  return alt.length > 100 ? alt.slice(0, 97) + '...' : alt;
}

// ── 내부 헬퍼 ─────────────────────────────────────────────────────────────────

function findRawFeatured(hotelId) {
  const dir = path.join(DIR_RAW, hotelId);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => SUPPORTED_EXT.has(path.extname(f).toLowerCase()));
  if (files.length === 0) return null;
  return path.join(dir, files.find(f => FEATURED_RE.test(f)) || files[0]);
}

function requireSharp() {
  try { return require('sharp'); } catch { return null; }
}

// ── 처리 함수 ─────────────────────────────────────────────────────────────────

/**
 * 원본 호텔 이미지 → WebP 리사이즈 + 선택적 워터마크.
 */
async function processRawImage(sharp, srcPath, outPath, { watermark = false } = {}) {
  let pipe = sharp(srcPath)
    .rotate()
    .resize(1200, 630, { fit: 'cover' });

  if (watermark) {
    const wm = Buffer.from(
      `<svg width="160" height="36" xmlns="http://www.w3.org/2000/svg">
        <rect width="160" height="36" fill="rgba(0,0,0,0.45)" rx="4"/>
        <text x="10" y="26" font-family="Arial, sans-serif" font-size="20"
              fill="rgba(255,255,255,0.65)" font-weight="bold">Tripprice</text>
      </svg>`
    );
    pipe = pipe.composite([{ input: wm, gravity: 'southeast' }]);
  }

  let buf = await pipe.webp({ quality: 82 }).toBuffer();
  if (buf.length > 200 * 1024) {
    buf = await sharp(srcPath).rotate()
      .resize(1200, 630, { fit: 'cover' })
      .webp({ quality: 62 }).toBuffer();
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return Math.round(buf.length / 1024);
}

/**
 * SVG 카드 → WebP.
 */
async function renderCardToWebP(sharp, svgBuf, outPath) {
  const buf = await sharp(svgBuf).webp({ quality: 90 }).toBuffer();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return Math.round(buf.length / 1024);
}

// ── CLI + 메인 ────────────────────────────────────────────────────────────────

function parseArgs() {
  const raw = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
  );
  return {
    briefId:   raw.brief   || null,
    postSlug:  raw.post    || null,
    hotels:    raw.hotels  ? raw.hotels.split(',') : [],
    lang:      raw.lang    || 'ko',
    watermark: raw.watermark === true || raw.watermark === 'true',
  };
}

function loadBrief(briefId) {
  // "brief-slug-date" → drafts/brief-slug-date.json
  for (const candidate of [
    path.join(DIR_DRAFTS, `${briefId}.json`),
    path.join(DIR_DRAFTS, `${briefId}`),
  ]) {
    if (fs.existsSync(candidate)) {
      try { return JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch {}
    }
  }
  // 날짜 없이 슬러그만 → 최신 파일 찾기
  if (fs.existsSync(DIR_DRAFTS)) {
    const pattern = `brief-${briefId}-`;
    const files = fs.readdirSync(DIR_DRAFTS)
      .filter(f => f.startsWith(pattern) && f.endsWith('.json'))
      .sort();
    if (files.length) {
      try { return JSON.parse(fs.readFileSync(path.join(DIR_DRAFTS, files.at(-1)), 'utf8')); } catch {}
    }
  }
  return null;
}

async function main() {
  const opts = parseArgs();

  let postSlug, hotelIds, hotelNames, lang;

  if (opts.briefId) {
    const brief = loadBrief(opts.briefId);
    if (!brief) {
      console.warn(`⚠  브리프 파일 없음: ${opts.briefId} — 이미지 스텝 건너뜀`);
      process.exit(0);
    }
    postSlug   = brief.slug || opts.briefId.replace(/^brief-/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
    hotelIds   = (brief.hotels || []).map(h => h.hotel_id).filter(Boolean);
    hotelNames = (brief.hotels || []).map(h => h.hotel_name || slugToTitle(h.hotel_id));
    lang       = brief.lang || opts.lang;
  } else if (opts.postSlug && opts.hotels.length > 0) {
    postSlug   = opts.postSlug;
    hotelIds   = opts.hotels;
    hotelNames = hotelIds.map(slugToTitle);
    lang       = opts.lang;
  } else {
    console.warn('⚠  --brief 또는 (--post + --hotels) 옵션이 필요합니다. 이미지 스텝 건너뜀.');
    process.exit(0);
  }

  const outDir      = path.join(DIR_PROCESSED, postSlug);
  const outPath     = path.join(outDir, 'featured.webp');
  const altJsonPath = path.join(outDir, 'alt-texts.json');

  console.log(`\n이미지 스텝: post=${postSlug}  hotels=${hotelIds.join(',')}`);

  // sharp 없으면 카드 생성 불가 — WARN + skip
  const sharp = requireSharp();
  if (!sharp) {
    console.warn('⚠  sharp 미설치 — 이미지 스텝 건너뜀 (npm install)');
    process.exit(0);
  }

  let usedCard = false;
  let sizeKB;

  // 이미 존재하면 재생성 생략
  if (fs.existsSync(outPath)) {
    console.log(`  → 기존 파일 사용: assets/processed/${postSlug}/featured.webp`);
  } else {
    // 1) 원본 이미지 우선
    const rawSrc = hotelIds.reduce((found, id) => found || findRawFeatured(id), null);

    if (rawSrc) {
      try {
        sizeKB = await processRawImage(sharp, rawSrc, outPath, { watermark: opts.watermark });
        console.log(`  ✓ 원본 이미지 처리: ${path.relative(ROOT, rawSrc)} → ${sizeKB}KB`);
      } catch (err) {
        console.warn(`  ⚠ 원본 이미지 처리 실패 (${err.message}) → 카드 생성으로 전환`);
        rawSrc && (usedCard = true);
      }
    }

    // 2) 폴백: SVG 요약 카드
    if (!fs.existsSync(outPath)) {
      usedCard = true;
      try {
        const svg = buildCardSvg({ postSlug, hotelSlugs: hotelIds, watermark: opts.watermark });
        sizeKB = await renderCardToWebP(sharp, svg, outPath);
        console.log(`  ✓ 요약 카드 생성: assets/processed/${postSlug}/featured.webp (${sizeKB}KB)`);
      } catch (err) {
        console.warn(`  ⚠ 카드 생성 실패: ${err.message} — featured_media 없이 계속`);
        process.exit(0);
      }
    }
  }

  // alt 텍스트 저장
  const altText = buildCardAltText({ postSlug, hotelNames, lang, isCard: usedCard });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(altJsonPath, JSON.stringify({ 'featured.webp': altText }, null, 2), 'utf8');
  console.log(`  alt: "${altText}"`);
  console.log(`  출력: assets/processed/${postSlug}/`);
}

if (require.main === module) {
  main().catch(err => {
    console.warn(`⚠  make-post-image 오류: ${err.message} — 이미지 없이 계속`);
    process.exit(0); // 파이프라인 중단 금지
  });
}

module.exports = { buildCardSvg, buildCardAltText, slugToTitle, escapeXml };
