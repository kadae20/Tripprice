#!/usr/bin/env node
/**
 * qa-wp-post.js
 *
 * wordpress/drafts/post-*.json 단일 파일을 입력받아 발행 전 QA를 수행한다.
 *
 * 사용법:
 *   node scripts/qa-wp-post.js wordpress/drafts/post-xxx.json
 *   node scripts/qa-wp-post.js wordpress/drafts/post-xxx.json --json
 *
 * 종료코드: 0 = PASS, 1 = FAIL or 오류
 *
 * Hard gates (하나라도 실패 시 FAIL):
 *   - post_title 길이 >= 10
 *   - slug 길이 >= 5
 *   - 본문 텍스트 길이 >= 2000자 (HTML 태그 제거 후)
 *   - 이미지 수 >= 1 (content_html <img> + content_images 합산)
 *     ※ draft 단계에서 이미지는 content_images[]에 참조만 됨.
 *       wp-publish 시 실제 <img>로 주입되므로 두 소스 합산으로 판단.
 *   - featured_media_url 존재
 *
 * Soft warnings (점수에 반영, FAIL 아님):
 *   - H2 개수 < 4
 *   - H3 개수 < 2
 *   - 금칙어 포함
 *
 * 결과 JSON:
 *   { pass, seoScore, errors, warnings, stats, draftFile }
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── 금칙어 (간단 리스트) ──────────────────────────────────────────────────────
const FORBIDDEN_WORDS = [
  '최고의', '가성비 최강', '절대', '완벽한', '세계 최초', '역대급',
  '무조건', '보장합니다', '100%', '극강',
];

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const draftFile = args.find(a => !a.startsWith('--'));
  return { draftFile, jsonMode };
}

// ── HTML에서 텍스트 추출 ──────────────────────────────────────────────────────
function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Markdown에서 텍스트 추출 (외부 라이브러리 없이) ──────────────────────────
function stripMarkdown(md) {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' ')        // 코드블록 제거
    .replace(/`[^`]+`/g, ' ')               // 인라인 코드 제거
    .replace(/!\[.*?\]\(.*?\)/g, ' ')       // 이미지 링크 제거
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')  // 링크 → 텍스트만
    .replace(/^#{1,6}\s+/gm, ' ')           // 헤딩 기호 제거
    .replace(/[*_~>|]/g, ' ')               // 강조/인용 기호 제거
    .replace(/^\s*[-+*]\s+/gm, ' ')         // 목록 기호 제거
    .replace(/\s+/g, ' ')
    .trim();
}

// ── content_images 총 이미지 수 ───────────────────────────────────────────────
function countContentImages(contentImages) {
  if (!Array.isArray(contentImages)) return 0;
  return contentImages.reduce((sum, sec) => {
    const imgs = sec.images || sec.media || sec.gallery || [];
    return sum + (Array.isArray(imgs) ? imgs.length : 0);
  }, 0);
}

// ── SEO 점수 계산 (0~100) ─────────────────────────────────────────────────────
function calcSeoScore({ titleLen, slugLen, textLen, totalImg, h2, h3, hasFeatured }) {
  let score = 0;
  // title 30~60자 → 20점
  if (titleLen >= 30 && titleLen <= 60) score += 20;
  else if (titleLen >= 10) score += 10;
  // slug 10~50자 → 10점
  if (slugLen >= 10 && slugLen <= 50) score += 10;
  else if (slugLen >= 5) score += 5;
  // 본문 길이 → 20점
  if (textLen >= 3000) score += 20;
  else if (textLen >= 2000) score += 15;
  else if (textLen >= 1000) score += 8;
  // H2 → 20점
  if (h2 >= 6) score += 20;
  else if (h2 >= 4) score += 15;
  else if (h2 >= 2) score += 8;
  // H3 → 10점
  if (h3 >= 3) score += 10;
  else if (h3 >= 2) score += 8;
  else if (h3 >= 1) score += 4;
  // 이미지 → 10점
  if (totalImg >= 5) score += 10;
  else if (totalImg >= 2) score += 7;
  else if (totalImg >= 1) score += 4;
  // featured image → 10점
  if (hasFeatured) score += 10;
  return Math.min(100, score);
}

// ── 메인 QA ───────────────────────────────────────────────────────────────────
function runQA(draftFilePath) {
  const absPath = path.resolve(ROOT, draftFilePath);
  if (!fs.existsSync(absPath)) {
    return {
      pass: false, seoScore: 0, draftFile: draftFilePath,
      errors: [`파일 없음: ${absPath}`], warnings: [], stats: {},
    };
  }

  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (e) {
    return {
      pass: false, seoScore: 0, draftFile: draftFilePath,
      errors: [`JSON 파싱 실패: ${e.message}`], warnings: [], stats: {},
    };
  }

  const title = String(draft.post_title || draft.title || '');
  const slug  = String(draft.slug || '');

  // ── 본문 소스 탐지: HTML 우선, 없으면 markdown 폴백 ──────────────────────
  const htmlRaw = String(
    draft.content_html || draft.html || draft.body_html ||
    draft.content || draft.post_content || ''
  ).trim();
  const mdRaw = String(draft.content_markdown || draft.markdown || '').trim();

  let plainText, textLen, imgInHtml, h2, h3;
  if (htmlRaw) {
    plainText  = stripHtml(htmlRaw);
    textLen    = plainText.length;
    imgInHtml  = (htmlRaw.match(/<img/gi) || []).length;
    h2         = (htmlRaw.match(/<h2/gi) || []).length;
    h3         = (htmlRaw.match(/<h3/gi) || []).length;
  } else if (mdRaw) {
    plainText  = stripMarkdown(mdRaw);
    textLen    = plainText.length;
    imgInHtml  = 0; // markdown 이미지는 content_images로 집계
    h2         = (mdRaw.match(/^##\s+/gm) || []).length;
    h3         = (mdRaw.match(/^###\s+/gm) || []).length;
  } else {
    plainText = ''; textLen = 0; imgInHtml = 0; h2 = 0; h3 = 0;
  }

  // ── 이미지 집계: featured(1) + content_images + html inline ──────────────
  const hasFeatured  = !!(draft.featured_media_url && String(draft.featured_media_url).trim());
  const featuredCount = hasFeatured ? 1 : 0;
  const imgInSecs    = countContentImages(draft.content_images);
  const totalImg     = featuredCount + imgInHtml + imgInSecs;

  const stats = {
    titleLen:      title.length,
    slugLen:       slug.length,
    contentSource: htmlRaw ? 'html' : (mdRaw ? 'markdown' : 'none'),
    textLen,
    imgInHtml,
    imgInSecs,
    featuredCount,
    totalImg,
    h2,
    h3,
    hasFeatured,
    coverageScore: draft.coverage_score || 0,
  };

  // ── Hard gates ──────────────────────────────────────────────────────────────
  const errors = [];
  if (title.length < 10)  errors.push(`title 길이 부족: ${title.length}자 (최소 10자)`);
  if (slug.length < 5)    errors.push(`slug 길이 부족: ${slug.length}자 (최소 5자)`);
  if (textLen < 2000)     errors.push(`본문 텍스트 부족: ${textLen}자 (최소 2000자)`);
  if (h2 < 4)             errors.push(`H2 개수 부족: ${h2}개 (최소 4개)`);
  if (totalImg < 5)       errors.push(`이미지 부족: featured ${featuredCount} + html ${imgInHtml} + content_images ${imgInSecs} = ${totalImg}개 (최소 5개)`);
  if (!hasFeatured)       errors.push(`featured_media_url 없음`);

  // ── Soft warnings ───────────────────────────────────────────────────────────
  const warnings = [];
  if (h3 < 2)  warnings.push(`H3 개수 부족: ${h3}개 (권장 2개 이상)`);

  const found = FORBIDDEN_WORDS.filter(w => plainText.includes(w));
  if (found.length > 0) warnings.push(`금칙어 감지: ${found.join(', ')}`);

  const seoScore = calcSeoScore({
    titleLen: title.length, slugLen: slug.length, textLen,
    totalImg, h2, h3, hasFeatured,
  });

  const pass = errors.length === 0;
  return { pass, seoScore, errors, warnings, stats, draftFile: draftFilePath };
}

// ── CLI 실행 ──────────────────────────────────────────────────────────────────
function main() {
  const { draftFile, jsonMode } = parseArgs();

  if (!draftFile) {
    console.error('사용법: node scripts/qa-wp-post.js <draft-file> [--json]');
    console.error('예시:   node scripts/qa-wp-post.js wordpress/drafts/post-xxx.json');
    process.exit(1);
  }

  const result = runQA(draftFile);

  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const icon = result.pass ? '✅ PASS' : '❌ FAIL';
    console.log(`\n${icon}  ${path.basename(draftFile)}`);
    console.log(`  SEO 점수: ${result.seoScore}/100`);
    console.log(`  통계: 텍스트 ${result.stats.textLen}자(${result.stats.contentSource}) | H2 ${result.stats.h2} | H3 ${result.stats.h3} | 이미지 ${result.stats.totalImg}개(featured ${result.stats.featuredCount}+secs ${result.stats.imgInSecs}+html ${result.stats.imgInHtml}) | coverage ${result.stats.coverageScore}점`);
    if (result.errors.length > 0) {
      console.log(`\n  [Hard Fail]`);
      result.errors.forEach(e => console.log(`    ✗ ${e}`));
    }
    if (result.warnings.length > 0) {
      console.log(`\n  [Warnings]`);
      result.warnings.forEach(w => console.log(`    ⚠ ${w}`));
    }
    console.log('');
  }

  process.exit(result.pass ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runQA };
