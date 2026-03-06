#!/usr/bin/env node
/**
 * pipeline.js
 * 콘텐츠 작성 파이프라인 전체 실행 래퍼.
 *
 * 기본 (안전 모드): build-brief → generate-draft → seo-qa → build-wp-post
 * --publish 옵션:  위 4단계 + wp-publish (WP 환경변수 필요)
 *
 * 사용법:
 *   node scripts/pipeline.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul
 *   node scripts/pipeline.js --hotels=grand-hyatt-seoul --lang=en
 *   node scripts/pipeline.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul --publish
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const { execFileSync } = require('child_process');

const SCRIPTS = path.join(__dirname);
const ROOT    = path.join(__dirname, '..');
const NODE    = process.execPath;

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

if (!args.hotels) {
  console.error('오류: --hotels 옵션이 필요합니다.');
  console.error('  예: node scripts/pipeline.js --hotels=grand-hyatt-seoul,lotte-hotel-seoul');
  console.error('  옵션:');
  console.error('    --lang=ko|en|ja    언어 (기본 ko)');
  console.error('    --publish          wp-publish까지 실행 (기본: build-wp-post에서 중단)');
  console.error('    --html             build-wp-post에 HTML 변환 포함');
  process.exit(1);
}

const lang       = args.lang || 'ko';
const doPublish  = args.publish === true;
const withHtml   = args.html    === true;
const skipImages = args['no-images'] === true;  // --no-images 로 이미지 스텝 건너뜀
const today      = new Date().toISOString().split('T')[0];

// ── 실행 헬퍼 ─────────────────────────────────────────────────────────────────
function run(label, scriptName, scriptArgs) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`▶  ${label}`);
  console.log(`   node scripts/${scriptName} ${scriptArgs.join(' ')}`);
  console.log(line);
  try {
    const out = execFileSync(NODE, [path.join(SCRIPTS, scriptName), ...scriptArgs], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
    });
    process.stdout.write(out);
    return out;
  } catch (err) {
    process.stderr.write(err.stdout || '');
    process.stderr.write(err.stderr || '');
    console.error(`\n❌ [${label}] 실패 — 파이프라인을 중단합니다.`);
    process.exit(err.status ?? 1);
  }
}

// ── 출력 파일명 파싱 헬퍼 ────────────────────────────────────────────────────
// "파일: /path/to/file.ext" 줄에서 파일명(확장자 포함) 추출
function parseOutputFile(stdout, ext) {
  const match = stdout.split('\n')
    .map(l => l.trim())
    .find(l => l.startsWith('파일:') && l.endsWith(ext));
  if (!match) return null;
  return path.basename(match.replace('파일:', '').trim());
}

// ── 파이프라인 시작 ───────────────────────────────────────────────────────────
const divider = '═'.repeat(60);
console.log(divider);
console.log('  Tripprice 콘텐츠 파이프라인');
console.log(`  호텔: ${args.hotels}`);
console.log(`  언어: ${lang}`);
console.log(`  모드: ${doPublish ? '전체 (wp-publish 포함)' : '안전 (build-wp-post까지)'}`);
console.log(divider);

// ── STEP 1: build-brief ───────────────────────────────────────────────────────
const briefOut = run(
  'STEP 1/4  build-brief',
  'build-brief.js',
  [`--hotels=${args.hotels}`, `--lang=${lang}`]
);

const briefFile = parseOutputFile(briefOut, '.json');
if (!briefFile) {
  console.error('브리프 파일명을 파싱할 수 없습니다. 파이프라인 중단.');
  process.exit(1);
}
const briefId = briefFile.replace('.json', '');

// ── STEP 2: generate-draft ────────────────────────────────────────────────────
const draftOut = run(
  'STEP 2/4  generate-draft',
  'generate-draft.js',
  [`--brief=${briefId}`]
);

const draftFile = parseOutputFile(draftOut, '.md');
if (!draftFile) {
  console.error('초안 파일명을 파싱할 수 없습니다. 파이프라인 중단.');
  process.exit(1);
}
const draftId = draftFile.replace('.md', '');

// ── STEP 2.3: 이미지 수집 (fetch → download → process, 기본 ON) ─────────────
// 실패해도 항상 계속 (모든 스텝 exit(0) 보장).
// API 키 없거나 도메인 미승인(로컬) → URL 0개 → SVG 카드 폴백.
if (!skipImages) {
  const hotelList      = args.hotels.split(',').map(h => h.trim()).filter(Boolean);
  const watermarkFlag  = args.watermark ? ['--watermark'] : [];
  const stepLabel      = doPublish ? '5' : '4';

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`▶  STEP 2.3/${stepLabel}  이미지 자동 수집`);
  console.log(`   hotels: ${hotelList.join(', ')}`);
  console.log('─'.repeat(60));

  for (const hotelId of hotelList) {
    // fetch-hotel-images (Agoda Content API → cache/urls.json)
    try {
      const out = execFileSync(NODE, [
        path.join(SCRIPTS, 'fetch-hotel-images.js'),
        `--hotel=${hotelId}`,
      ], { cwd: ROOT, env: process.env, encoding: 'utf8' });
      process.stdout.write(out);
    } catch (err) {
      process.stdout.write(err.stdout || '');
      console.log(`  ⚠  [fetch-hotel-images:${hotelId}] 실패 — 건너뜀`);
    }

    // download-images (cache/urls.json → assets/raw/{hotel}/)
    try {
      const out = execFileSync(NODE, [
        path.join(SCRIPTS, 'download-images.js'),
        `--hotel=${hotelId}`,
      ], { cwd: ROOT, env: process.env, encoding: 'utf8' });
      process.stdout.write(out);
    } catch (err) {
      process.stdout.write(err.stdout || '');
      console.log(`  ⚠  [download-images:${hotelId}] 실패 — 건너뜀`);
    }

    // process-images (assets/raw/{hotel}/ → assets/processed/{hotel}/)
    // exit(1)이어도 파이프라인 계속 (sharp 미설치 / 이미지 없음 포함)
    try {
      const out = execFileSync(NODE, [
        path.join(SCRIPTS, 'process-images.js'),
        `--hotel=${hotelId}`,
        ...watermarkFlag,
      ], { cwd: ROOT, env: process.env, encoding: 'utf8' });
      process.stdout.write(out);
    } catch (err) {
      process.stdout.write(err.stdout || '');
      console.log(`  ⚠  [process-images:${hotelId}] — 건너뜀`);
    }
  }
}

// ── STEP 2.5: make-post-image (기본 ON, --no-images 로 건너뜀) ────────────────
// 실패해도 파이프라인 계속 (make-post-image.js가 항상 exit(0)을 보장)
if (!skipImages) {
  const imgLabel = doPublish ? 'STEP 2.5/5  make-post-image' : 'STEP 2.5/4  make-post-image';
  const watermarkFlag = args.watermark ? ['--watermark'] : [];
  try {
    const imgOut = execFileSync(NODE, [
      path.join(SCRIPTS, 'make-post-image.js'),
      `--brief=${briefId}`,
      `--lang=${lang}`,
      ...watermarkFlag,
    ], { cwd: ROOT, env: process.env, encoding: 'utf8' });
    const line = '─'.repeat(60);
    console.log(`\n${line}\n▶  ${imgLabel}\n${line}`);
    process.stdout.write(imgOut);
  } catch (err) {
    console.log(`\n⚠  [make-post-image] 실패 — featured_media 없이 계속`);
    process.stdout.write(err.stdout || '');
  }
}

// ── STEP 3: seo-qa ────────────────────────────────────────────────────────────
run(
  'STEP 3/4  seo-qa',
  'seo-qa.js',
  [`--draft=${draftId}`, '--json']
);

// ── STEP 4: build-wp-post ─────────────────────────────────────────────────────
const postArgs = [`--draft=${draftId}`];
if (withHtml) postArgs.push('--html');

const postOut = run(
  'STEP 4/4  build-wp-post',
  'build-wp-post.js',
  postArgs
);

const postFile = parseOutputFile(postOut, '.json');

// ── 안전 모드 완료 ────────────────────────────────────────────────────────────
console.log(`\n${divider}`);
if (!doPublish) {
  console.log('  파이프라인 완료 (안전 모드)');
  console.log('');
  console.log('  생성 파일:');
  console.log(`    브리프:  wordpress/drafts/${briefFile}`);
  console.log(`    초안:    wordpress/drafts/${draftFile}`);
  if (postFile) console.log(`    발행번들: wordpress/drafts/${postFile}`);
  console.log('');
  console.log('  사람 검토 후 발행:');
  if (postFile) {
    const wpUrl = process.env.WP_URL || 'https://tripprice.net';
    console.log(`  WP_URL=${wpUrl} WP_USER=admin WP_APP_PASS="xxxx xxxx" \\`);
    console.log(`    node scripts/wp-publish.js wordpress/drafts/${postFile}`);
  }
  console.log('');
  console.log('  또는 파이프라인에서 직접 발행하려면:');
  console.log(`    node scripts/pipeline.js --hotels=${args.hotels} --publish`);
  console.log(divider);
  process.exit(0);
}

// ── STEP 5: wp-publish (--publish 옵션 시) ────────────────────────────────────
const missingEnv = ['WP_URL', 'WP_USER', 'WP_APP_PASS'].filter(k => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`❌ --publish 옵션에 필요한 환경변수 없음: ${missingEnv.join(', ')}`);
  console.error('  설정 후 재실행하거나, 발행 번들을 직접 전달하세요:');
  if (postFile) console.error(`    node scripts/wp-publish.js wordpress/drafts/${postFile}`);
  process.exit(1);
}

if (!postFile) {
  console.error('발행 번들 파일명을 파싱할 수 없어 wp-publish를 건너뜁니다.');
  process.exit(1);
}

run(
  'STEP 5/5  wp-publish',
  'wp-publish.js',
  [`wordpress/drafts/${postFile}`]
);

console.log(`\n${divider}`);
console.log('  파이프라인 전체 완료');
console.log(divider);
