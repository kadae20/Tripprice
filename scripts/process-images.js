#!/usr/bin/env node
/**
 * process-images.js
 *
 * 호텔 이미지를 WebP로 변환·최적화하고, alt 텍스트를 자동 생성합니다.
 * 워터마크 적용은 --watermark 옵션 사용 시에만 활성화됩니다.
 *
 * 사용법:
 *   node scripts/process-images.js --hotel=grand-hyatt-seoul
 *   node scripts/process-images.js --hotel=grand-hyatt-seoul --watermark
 *   node scripts/process-images.js --all
 *   node scripts/process-images.js --all --dry-run
 *
 * 옵션:
 *   --hotel=[hotel_id]   특정 호텔 처리
 *   --all                assets/raw/ 하위 모든 호텔 처리
 *   --watermark          워터마크 삽입 (파트너 정책 허용 확인 후 사용)
 *   --dry-run            실제 파일 저장 없이 처리 대상과 alt 텍스트만 출력
 *
 * 필요 패키지: sharp (npm install)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ──────────────────────────────────────────────
// 경로 설정
// ──────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const DIR_RAW = path.join(ROOT, 'assets', 'raw');
const DIR_PROCESSED = path.join(ROOT, 'assets', 'processed');
const DIR_HOTEL_DATA = path.join(ROOT, 'data', 'processed');
const DIR_CAMPAIGNS = path.join(ROOT, 'state', 'campaigns');

// ──────────────────────────────────────────────
// 이미지 처리 설정
// ──────────────────────────────────────────────
const IMAGE_CONFIG = {
  featured: { width: 1200, height: 630, fit: 'cover', maxKB: 200 },
  content:  { width: 1080, height: null, fit: 'inside', maxKB: 200 },
};

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.avif']);

// 워터마크 설정 (--watermark 옵션 사용 시)
const WATERMARK_CONFIG = {
  text: 'tripprice',
  sizeRatio: 0.08,   // 이미지 너비의 8%
  opacity: 0.6,
  position: 'bottom-right',
  margin: 16,        // px
};

// ──────────────────────────────────────────────
// 파일명 → 특징어 매핑 (alt 텍스트 생성용)
// ──────────────────────────────────────────────
const FILENAME_FEATURE_MAP = {
  // 시설
  pool:        '수영장',
  swim:        '수영장',
  lobby:       '로비',
  room:        '객실',
  bedroom:     '객실',
  suite:       '스위트룸',
  restaurant:  '레스토랑',
  dining:      '다이닝',
  gym:         '피트니스',
  fitness:     '피트니스',
  spa:         '스파',
  bar:         '바',
  lounge:      '라운지',
  garden:      '정원',
  rooftop:     '루프탑',
  terrace:     '테라스',
  balcony:     '발코니',
  view:        '전망',
  exterior:    '외관',
  facade:      '외관',
  entrance:    '입구',
  reception:   '프런트',
  breakfast:   '조식',
  buffet:      '뷔페',
  meeting:     '회의실',
  conference:  '컨퍼런스',
  bathroom:    '욕실',
  bath:        '욕실',
  shower:      '샤워',
  // 방향/전경
  night:       '야경',
  aerial:      '항공뷰',
  panorama:    '파노라마뷰',
  city:        '도심전망',
  sea:         '오션뷰',
  ocean:       '오션뷰',
  mountain:    '마운틴뷰',
  // 일반
  interior:    '인테리어',
  hallway:     '복도',
  corridor:    '복도',
  elevator:    '엘리베이터',
  parking:     '주차장',
  pool_side:   '풀사이드',
  featured:    '대표이미지',
  main:        '대표이미지',
  hero:        '대표이미지',
  thumbnail:   '썸네일',
};

// ──────────────────────────────────────────────
// 파일명에서 특징어 추출 (pure JS — 테스트 가능)
// ──────────────────────────────────────────────
function parseFilenameFeature(filename) {
  const base = path.basename(filename, path.extname(filename))
    .toLowerCase()
    .replace(/[-_]/g, ' ');

  const words = base.split(/\s+/);
  for (const word of words) {
    if (FILENAME_FEATURE_MAP[word]) return FILENAME_FEATURE_MAP[word];
  }

  // 복합어 매칭 (예: pool_side → pool side)
  for (const [key, val] of Object.entries(FILENAME_FEATURE_MAP)) {
    if (base.includes(key.replace('_', ' '))) return val;
  }

  return null;
}

// ──────────────────────────────────────────────
// alt 텍스트 생성 (pure JS — 테스트 가능)
// ──────────────────────────────────────────────
function generateAltText(filename, hotelData, index) {
  const hotelName = hotelData?.hotel_name || hotelData?.hotel_id || '';
  const city = hotelData?.city || '';

  const feature = parseFilenameFeature(filename);

  // 형식: "[호텔명] [특징] [도시]"
  // 특징 없으면: "[호텔명] [도시] 호텔 [번호]"
  let alt;
  if (feature) {
    alt = [hotelName, feature, city].filter(Boolean).join(' ');
  } else {
    const num = index > 0 ? ` ${index + 1}` : '';
    alt = [hotelName, city, `호텔${num}`].filter(Boolean).join(' ');
  }

  // 길이 제한 (100자)
  if (alt.length > 100) alt = alt.substring(0, 97) + '...';

  return alt;
}

// ──────────────────────────────────────────────
// 이미지 타입 판별 (대표 이미지 vs 본문 이미지)
// ──────────────────────────────────────────────
function detectImageType(filename) {
  const base = path.basename(filename, path.extname(filename)).toLowerCase();
  const featuredKeywords = ['featured', 'main', 'hero', 'cover', 'thumbnail', '01', '001'];
  for (const kw of featuredKeywords) {
    if (base.includes(kw)) return 'featured';
  }
  return 'content';
}

// ──────────────────────────────────────────────
// sharp 가용성 확인
// ──────────────────────────────────────────────
function requireSharp() {
  try {
    return require('sharp');
  } catch {
    console.error(
      '\n[오류] sharp 패키지가 설치되어 있지 않습니다.\n\n' +
      '  설치 방법:\n' +
      `  cd ${ROOT}\n` +
      '  npm install\n\n' +
      '  또는:\n' +
      '  npm install sharp\n'
    );
    process.exit(1);
  }
}

// ──────────────────────────────────────────────
// 워터마크 SVG 생성 (텍스트 기반, 외부 파일 불필요)
// ──────────────────────────────────────────────
function createWatermarkSVG(imageWidth) {
  const fontSize = Math.round(imageWidth * WATERMARK_CONFIG.sizeRatio);
  const padding = 8;
  const textWidth = fontSize * WATERMARK_CONFIG.text.length * 0.6;
  const svgWidth = Math.round(textWidth + padding * 2);
  const svgHeight = Math.round(fontSize + padding * 2);

  return Buffer.from(
    `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${svgWidth}" height="${svgHeight}" fill="rgba(0,0,0,0.35)" rx="4"/>
      <text
        x="${padding}"
        y="${fontSize + padding / 2}"
        font-family="Arial, sans-serif"
        font-size="${fontSize}"
        font-weight="bold"
        fill="rgba(255,255,255,${WATERMARK_CONFIG.opacity})"
        letter-spacing="1"
      >${WATERMARK_CONFIG.text}</text>
    </svg>`
  );
}

// ──────────────────────────────────────────────
// 단일 이미지 처리
// ──────────────────────────────────────────────
async function processImage(sharp, srcPath, outPath, { type, applyWatermark, dryRun }) {
  const config = IMAGE_CONFIG[type] || IMAGE_CONFIG.content;

  if (dryRun) {
    return { skipped: false, dryRun: true, outPath };
  }

  // 1) 로드 + 리사이즈
  let pipeline = sharp(srcPath).rotate(); // auto-rotate from EXIF

  if (config.height) {
    pipeline = pipeline.resize(config.width, config.height, { fit: config.fit });
  } else {
    pipeline = pipeline.resize(config.width, null, { fit: config.fit, withoutEnlargement: true });
  }

  // 2) 워터마크 합성 (옵션)
  if (applyWatermark) {
    const metadata = await sharp(srcPath).metadata();
    const imgWidth = Math.min(metadata.width || config.width, config.width);
    const watermarkSVG = createWatermarkSVG(imgWidth);

    const margin = WATERMARK_CONFIG.margin;
    pipeline = pipeline.composite([{
      input: watermarkSVG,
      gravity: 'southeast',
      top: undefined,
      left: undefined,
    }]);
  }

  // 3) WebP 변환 + 용량 제어
  // quality를 조정해 maxKB 이하로 맞춤 (단순 접근: quality 80 → 초과 시 60)
  let outputBuffer = await pipeline.webp({ quality: 80 }).toBuffer();

  if (outputBuffer.length > config.maxKB * 1024) {
    outputBuffer = await sharp(srcPath)
      .rotate()
      .resize(config.width, config.height || null, { fit: config.fit, withoutEnlargement: true })
      .webp({ quality: 60 })
      .toBuffer();
  }

  // 4) 저장
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, outputBuffer);

  const sizeKB = Math.round(outputBuffer.length / 1024);
  return { sizeKB, outPath };
}

// ──────────────────────────────────────────────
// 호텔 한 건 처리
// ──────────────────────────────────────────────
async function processHotel(sharp, hotelId, { applyWatermark, dryRun }) {
  const rawDir = path.join(DIR_RAW, hotelId);
  const outDir = path.join(DIR_PROCESSED, hotelId);

  if (!fs.existsSync(rawDir)) {
    return { hotelId, status: 'skipped', reason: `assets/raw/${hotelId}/ 폴더 없음` };
  }

  // 호텔 메타데이터 로드 (있으면)
  const hotelDataPath = path.join(DIR_HOTEL_DATA, `${hotelId}.json`);
  let hotelData = null;
  if (fs.existsSync(hotelDataPath)) {
    try { hotelData = JSON.parse(fs.readFileSync(hotelDataPath, 'utf8')); } catch {}
  }
  if (!hotelData) {
    hotelData = { hotel_id: hotelId, hotel_name: hotelId, city: '' };
  }

  // 이미지 파일 목록
  const files = fs.readdirSync(rawDir).filter(
    (f) => SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase())
  );

  if (files.length === 0) {
    return { hotelId, status: 'skipped', reason: '처리할 이미지 없음' };
  }

  const results = [];
  const altTexts = {};

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const srcPath = path.join(rawDir, filename);
    const type = detectImageType(filename);
    const outFilename = path.basename(filename, path.extname(filename)) + '.webp';
    const outPath = path.join(outDir, outFilename);
    const altText = generateAltText(filename, hotelData, i);

    let result;
    try {
      result = await processImage(sharp, srcPath, outPath, { type, applyWatermark, dryRun });
      const icon = dryRun ? '○' : '✓';
      const sizeInfo = dryRun ? '(dry-run)' : `${result.sizeKB}KB`;
      console.log(`    ${icon} ${filename} → ${outFilename} [${type}] ${sizeInfo}`);
      console.log(`      alt: "${altText}"`);

      results.push({ filename, outFilename, type, altText, sizeKB: result.sizeKB, status: 'success' });
      altTexts[outFilename] = altText;
    } catch (err) {
      console.log(`    ✗ ${filename}: ${err.message}`);
      results.push({ filename, type, altText, status: 'failed', error: err.message });
    }
  }

  // alt-texts.json 저장
  if (!dryRun && results.some((r) => r.status === 'success')) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'alt-texts.json'),
      JSON.stringify(altTexts, null, 2),
      'utf8'
    );
  }

  const successCount = results.filter((r) => r.status === 'success').length;
  const failCount = results.filter((r) => r.status === 'failed').length;

  return {
    hotelId,
    status: 'done',
    total: files.length,
    success: successCount,
    failed: failCount,
    dryRun,
    results,
    altTexts,
  };
}

// ──────────────────────────────────────────────
// 리포트 생성
// ──────────────────────────────────────────────
function generateReport(allResults, { applyWatermark, dryRun }) {
  const date = new Date().toISOString().split('T')[0];
  const ts = new Date().toISOString();

  let md = `# Tripprice 이미지 처리 리포트\n\n`;
  md += `- 실행 일시: ${ts}\n`;
  md += `- 워터마크: ${applyWatermark ? '적용' : '미적용'}\n`;
  md += `- 모드: ${dryRun ? 'dry-run (저장 없음)' : '실제 처리'}\n\n`;

  md += `## 처리 결과 요약\n\n`;
  md += `| 호텔 ID | 이미지 수 | 성공 | 실패 | 상태 |\n`;
  md += `|---------|----------|------|------|------|\n`;

  for (const r of allResults) {
    if (r.status === 'skipped') {
      md += `| ${r.hotelId} | — | — | — | 건너뜀: ${r.reason} |\n`;
    } else {
      md += `| ${r.hotelId} | ${r.total} | ${r.success} | ${r.failed} | ${r.failed > 0 ? '⚠ 일부 실패' : '✓'} |\n`;
    }
  }
  md += '\n';

  // 실패 상세
  const withFailures = allResults.filter((r) => r.status === 'done' && r.failed > 0);
  if (withFailures.length > 0) {
    md += `## 실패 이미지 목록\n\n`;
    for (const r of withFailures) {
      md += `### ${r.hotelId}\n`;
      for (const img of r.results.filter((i) => i.status === 'failed')) {
        md += `- ${img.filename}: ${img.error}\n`;
      }
      md += '\n';
    }
  }

  // alt 텍스트 목록
  md += `## 생성된 alt 텍스트\n\n`;
  for (const r of allResults.filter((r) => r.status === 'done')) {
    md += `### ${r.hotelId}\n`;
    for (const img of r.results.filter((i) => i.status === 'success')) {
      md += `- \`${img.outFilename}\`: "${img.altText}"\n`;
    }
    md += '\n';
  }

  md += `---\n`;
  md += `*출력 위치: assets/processed/ | alt 텍스트: assets/processed/[hotel_id]/alt-texts.json*\n`;

  const reportPath = path.join(DIR_CAMPAIGNS, `image-report-${date}.md`);
  if (!dryRun) {
    fs.mkdirSync(DIR_CAMPAIGNS, { recursive: true });
    fs.writeFileSync(reportPath, md, 'utf8');
  }
  return reportPath;
}

// ──────────────────────────────────────────────
// CLI 인자 파싱
// ──────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    hotelId: null,
    all: false,
    applyWatermark: false,
    dryRun: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--hotel=')) opts.hotelId = arg.replace('--hotel=', '');
    else if (arg === '--all') opts.all = true;
    else if (arg === '--watermark') opts.applyWatermark = true;
    else if (arg === '--dry-run') opts.dryRun = true;
  }

  return opts;
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────
async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' Tripprice — 이미지 처리 파이프라인');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const opts = parseArgs();

  if (!opts.hotelId && !opts.all) {
    console.error(
      '[오류] 처리 대상이 지정되지 않았습니다.\n\n' +
      '사용법:\n' +
      '  node scripts/process-images.js --hotel=[hotel_id]\n' +
      '  node scripts/process-images.js --all\n' +
      '  node scripts/process-images.js --all --dry-run\n\n' +
      '옵션:\n' +
      '  --watermark   워터마크 삽입 (파트너 정책 허용 시)\n' +
      '  --dry-run     저장 없이 처리 대상 및 alt 텍스트만 출력\n'
    );
    process.exit(1);
  }

  // sharp 로드 (미설치 시 안내 후 종료)
  const sharp = requireSharp();

  if (opts.applyWatermark) {
    console.log('⚠  워터마크 모드: 파트너 정책 허용 확인 후 사용하세요.');
    console.log('   정책: .claude/rules/image-policy-and-processing.md\n');
  }

  if (opts.dryRun) {
    console.log('○  dry-run 모드: 실제 파일 저장 없이 결과만 출력합니다.\n');
  }

  // 처리할 호텔 목록
  let hotelIds = [];
  if (opts.hotelId) {
    hotelIds = [opts.hotelId];
  } else {
    if (!fs.existsSync(DIR_RAW)) {
      console.error(`[오류] assets/raw/ 폴더가 없습니다: ${DIR_RAW}`);
      process.exit(1);
    }
    hotelIds = fs.readdirSync(DIR_RAW).filter(
      (f) => fs.statSync(path.join(DIR_RAW, f)).isDirectory()
    );
    if (hotelIds.length === 0) {
      console.log('처리할 호텔 폴더가 없습니다 (assets/raw/ 비어있음).');
      process.exit(0);
    }
  }

  console.log(`처리 대상: ${hotelIds.join(', ')}\n`);

  // 호텔별 처리
  const allResults = [];
  for (const hotelId of hotelIds) {
    console.log(`\n[${hotelId}]`);
    const result = await processHotel(sharp, hotelId, {
      applyWatermark: opts.applyWatermark,
      dryRun: opts.dryRun,
    });
    allResults.push(result);
  }

  // 리포트 생성
  const reportPath = generateReport(allResults, opts);

  // 최종 요약
  const totalSuccess = allResults.reduce((s, r) => s + (r.success || 0), 0);
  const totalFailed = allResults.reduce((s, r) => s + (r.failed || 0), 0);
  const totalImages = allResults.reduce((s, r) => s + (r.total || 0), 0);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(` 완료: 총 ${totalImages}장 | 성공 ${totalSuccess} | 실패 ${totalFailed}`);
  if (!opts.dryRun) {
    console.log(` 출력: assets/processed/`);
    console.log(` 리포트: ${path.relative(ROOT, reportPath)}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (totalFailed > 0) process.exit(1);
}

if (require.main === module) {
  main();
}

// 테스트용 export (pure JS 함수만)
module.exports = { generateAltText, parseFilenameFeature, detectImageType, generateReport };
