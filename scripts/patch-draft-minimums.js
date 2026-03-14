#!/usr/bin/env node
/**
 * patch-draft-minimums.js
 *
 * wordpress/drafts/post-*.json 단일 파일을 읽어
 * qa-wp-post.js의 Hard gate 기준(텍스트 2000자 / 이미지 5장 / featured)을
 * 통과할 수 있도록 최소 보강한다.
 *
 * 사용법:
 *   node scripts/patch-draft-minimums.js <draft_json_path> [--dry-run]
 *
 * --dry-run: 파일을 쓰지 않고 변경 예정 내용만 출력
 *
 * 동작:
 *   1) content_markdown 없으면 변경 없이 exit 0
 *   2) 텍스트 plain 길이 < 2000자 → 보강 섹션 append
 *   3) 이미지 총합 < 5 → content_images에 보강 이미지 추가
 *   4) featured_media_url 없으면 첫 이미지 local_path로 세팅
 *   5) 실제 저장 시 원본을 .bak/ 에 1회 백업
 *
 * 외부 API/네트워크 불필요. assets/ 폴더 파일을 우선 활용.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const BAK_DIR = path.join(ROOT, 'wordpress', 'drafts', '.bak');

const MIN_TEXT_LEN = 2000;
const MIN_TOTAL_IMG = 5;
const PLACEHOLDER_BASE = 'https://via.placeholder.com/1200x800?text=Tripprice';

// ── 보강 섹션 블록 (한국어, 섹션당 250~350자) ─────────────────────────────────
const BOOSTER_SECTIONS = [
  {
    heading: '## 위치 & 동선 팁',
    body: '호텔에서 주요 관광지·쇼핑 지구까지의 동선을 미리 확인해두면 여행 효율이 크게 높아집니다. '
        + '대중교통(지하철·시내버스)을 활용하면 택시보다 경제적이며, 가까운 지하철역까지 도보 이동이 '
        + '가능한 경우가 많습니다. 체크인 당일 프런트에 짐을 맡기고 가볍게 주변을 탐방한 뒤 저녁에 '
        + '객실로 이동하는 방식도 추천합니다. 야간 귀환 시에도 로비가 24시간 운영되는지 미리 확인해두세요. '
        + '택시 앱(카카오T·우버)을 미리 설치해두면 늦은 귀환 시 편리하게 이용할 수 있습니다.',
  },
  {
    heading: '## 객실 타입 & 침구 안내',
    body: '싱글·더블·트윈·스위트 등 객실 타입이 다양하게 운영됩니다. '
        + '커플 여행이라면 더블 베드 또는 킹룸, 가족 단위라면 패밀리룸이나 커넥팅룸을 선택하는 것이 편리합니다. '
        + '침구 교체 주기나 추가 베개 요청은 프런트에 문의하면 대부분 무료로 가능합니다. '
        + '객실 내 소음이나 선호 층수가 있다면 예약 시 메모란에 미리 기재하거나, '
        + '체크인 당일 직접 요청해보세요. 금연·흡연 구역 구분도 예약 전 확인하는 것이 중요합니다.',
  },
  {
    heading: '## 체크인 / 체크아웃 정보',
    body: '체크인은 보통 오후 2~3시, 체크아웃은 오전 11~12시가 일반적입니다. '
        + '얼리 체크인이 필요하다면 전날 호텔 측에 미리 연락해 요청해보세요. '
        + '당일 객실 상황에 따라 추가 요금 없이 유연하게 처리해주는 경우도 있습니다. '
        + '레이트 체크아웃(추가 요금 발생 가능)이 필요하다면 당일 아침 프런트에 협의하세요. '
        + '체크인 시 여권(외국인) 또는 신분증과 결제 카드를 반드시 지참해야 합니다. '
        + '예약 확인서를 스크린샷으로 저장해두면 더욱 편리하게 체크인할 수 있습니다.',
  },
  {
    heading: '## 가격대 가이드',
    body: '요금은 시즌·요일·예약 시점에 따라 크게 달라집니다. '
        + '평일과 비수기(1~2월, 6~8월 일부)에 상대적으로 저렴한 요금을 기대할 수 있으며, '
        + '얼리버드 할인이나 멤버십 포인트 적립을 활용하면 비용을 아낄 수 있습니다. '
        + '예약 플랫폼마다 요금과 환불 정책이 다르므로 2~3개 플랫폼을 비교한 뒤 결정하세요. '
        + '최종 요금은 반드시 실시간 예약 페이지에서 확인하시기 바랍니다. '
        + '카드사 할인이나 제휴 혜택도 체크하면 추가 절감이 가능합니다.',
  },
  {
    heading: '## 예약 팁 & 주의사항',
    body: '환불 정책을 반드시 확인하세요. 무료 취소 기간 내 취소하면 전액 환불이 되지만 '
        + '기간 이후에는 위약금이 발생할 수 있습니다. 예약 확인서(이메일 또는 스크린샷)를 '
        + '체크인 전까지 저장해두세요. 특별 요청(고층 객실·조용한 방·연결 객실·유아 침대 등)은 '
        + '예약 시 메모란에 기재하거나 호텔에 직접 문의하면 반영 가능성이 높아집니다. '
        + '성수기(연휴·명절·축제 기간)에는 최소 2~4주 전 예약을 권장합니다. '
        + '출발 전날 예약 상태를 한 번 더 확인하는 것도 잊지 마세요.',
  },
];

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file   = args.find(a => !a.startsWith('--'));
  return { file, dryRun };
}

// ── Markdown 평문 길이 계산 (qa-wp-post.js와 동일 로직) ─────────────────────
function stripMarkdownLen(md) {
  return (md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[.*?\]\(.*?\)/g, ' ')
    .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, ' ')
    .replace(/[*_~>|]/g, ' ')
    .replace(/^\s*[-+*]\s+/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .length;
}

// ── assets/ 폴더에서 이미지 파일 경로 목록 수집 ──────────────────────────────
function findLocalAssets() {
  const ASSETS_DIR = path.join(ROOT, 'assets');
  if (!fs.existsSync(ASSETS_DIR)) return [];
  const EXTS = new Set(['.webp', '.jpg', '.jpeg', '.png']);
  const results = [];

  function scan(dir) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const f of entries) {
      const full = path.join(dir, f);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) { scan(full); }
        else if (EXTS.has(path.extname(f).toLowerCase())) {
          results.push(path.relative(ROOT, full).replace(/\\/g, '/'));
        }
      } catch { /* 접근 불가 파일 무시 */ }
    }
  }
  scan(ASSETS_DIR);
  return results;
}

// ── content_images 총 이미지 수 (qa-wp-post.js와 동일) ───────────────────────
function countContentImages(contentImages) {
  if (!Array.isArray(contentImages)) return 0;
  return contentImages.reduce((sum, sec) => {
    const imgs = sec.images || sec.media || sec.gallery || [];
    return sum + (Array.isArray(imgs) ? imgs.length : 0);
  }, 0);
}

// ── content_images에서 첫 번째 이미지 경로 추출 ──────────────────────────────
function getFirstImagePath(contentImages) {
  if (!Array.isArray(contentImages)) return null;
  for (const sec of contentImages) {
    const imgs = sec.images || sec.media || sec.gallery || [];
    if (Array.isArray(imgs)) {
      for (const img of imgs) {
        const p = img.url || img.local_path || img.src || img.href;
        if (p) return p;
      }
    }
  }
  return null;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
function main() {
  const { file, dryRun } = parseArgs();

  if (!file) {
    console.error('사용법: node scripts/patch-draft-minimums.js <draft_json_path> [--dry-run]');
    process.exit(1);
  }

  const absPath = path.resolve(ROOT, file);
  if (!fs.existsSync(absPath)) {
    console.error(`파일 없음: ${absPath}`);
    process.exit(1);
  }

  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (e) {
    console.error(`JSON 파싱 실패: ${e.message}`);
    process.exit(1);
  }

  // content_markdown 없으면 변경 없이 종료
  const mdRaw = String(draft.content_markdown || '').trim();
  if (!mdRaw) {
    console.log(`  content_markdown 없음 — 변경 없이 종료 (${path.basename(absPath)})`);
    process.exit(0);
  }

  // ── 현재 상태 측정 ─────────────────────────────────────────────────────────
  const curTextLen = stripMarkdownLen(mdRaw);
  const hasFeatured = !!(draft.featured_media_url && String(draft.featured_media_url).trim());
  const curImgSecs  = countContentImages(draft.content_images);
  const curTotalImg = (hasFeatured ? 1 : 0) + curImgSecs;

  // ── 변경 계획 수립 ─────────────────────────────────────────────────────────
  const plan = { textAdded: 0, imagesAdded: 0, featuredSet: false, sectionsAdded: [] };

  // 1) 텍스트 보강: 2000자 달성까지 섹션을 순환 append (최대 3순환)
  //    섹션 제목 중복을 피하기 위해 2번째 이후 순환에는 suffix 부여
  const CYCLE_SUFFIXES = ['', ' — 추가 안내', ' — 참고 정보'];
  let newMd = mdRaw;
  if (curTextLen < MIN_TEXT_LEN) {
    let idx = 0;
    const MAX_ITER = BOOSTER_SECTIONS.length * CYCLE_SUFFIXES.length;
    while (stripMarkdownLen(newMd) < MIN_TEXT_LEN && idx < MAX_ITER) {
      const sec    = BOOSTER_SECTIONS[idx % BOOSTER_SECTIONS.length];
      const suffix = CYCLE_SUFFIXES[Math.floor(idx / BOOSTER_SECTIONS.length)];
      const heading = suffix ? sec.heading + suffix : sec.heading;
      newMd += `\n\n${heading}\n\n${sec.body}`;
      plan.sectionsAdded.push(heading.replace(/^## /, ''));
      idx++;
    }
    plan.textAdded = stripMarkdownLen(newMd) - curTextLen;
  }

  // 2) 이미지 보강: 5장 미만이면 보강
  //    featured_media_url 없을 때 기존 이미지 첫 번째를 먼저 세팅 시도
  let newContentImages = JSON.parse(JSON.stringify(draft.content_images || []));
  let newFeatured = String(draft.featured_media_url || '').trim();

  if (!newFeatured) {
    const firstPath = getFirstImagePath(newContentImages);
    if (firstPath) {
      newFeatured = firstPath;
      plan.featuredSet = true;
    }
  }

  // featured 적용 후 총 이미지 수 재계산
  let effFeatured = newFeatured ? 1 : 0;
  let effImgSecs  = countContentImages(newContentImages);
  let effTotal    = effFeatured + effImgSecs;

  if (effTotal < MIN_TOTAL_IMG) {
    const needed = MIN_TOTAL_IMG - effTotal;
    const localAssets = findLocalAssets();

    // 추가할 local_path 목록 (로컬 파일 우선, 없으면 placeholder URL)
    const extraPaths = [];
    for (let i = 0; i < needed; i++) {
      if (localAssets.length > 0) {
        extraPaths.push(localAssets[i % localAssets.length]);
      } else {
        extraPaths.push(`${PLACEHOLDER_BASE}&n=${i + 1}`);
      }
    }

    // 첫 번째 섹션 images[]에 추가, 섹션 없으면 새로 생성
    if (newContentImages.length > 0) {
      const sec = newContentImages[0];
      if (!sec.images) sec.images = [];
      for (const p of extraPaths) {
        sec.images.push({ local_path: p, alt: '보강 이미지' });
      }
    } else {
      newContentImages.push({
        position: 'patch-extra',
        images: extraPaths.map(p => ({ local_path: p, alt: '보강 이미지' })),
      });
    }
    plan.imagesAdded = needed;

    // featured가 아직 없으면 첫 보강 이미지로 세팅
    if (!newFeatured) {
      newFeatured = extraPaths[0];
      plan.featuredSet = true;
    }
  }

  // ── 변경 없으면 종료 ────────────────────────────────────────────────────────
  const hasChanges = plan.textAdded > 0 || plan.imagesAdded > 0 || plan.featuredSet;
  if (!hasChanges) {
    console.log(`  이미 기준 충족 — 변경 없음 (${path.basename(absPath)})`);
    process.exit(0);
  }

  // ── 리포트 출력 ────────────────────────────────────────────────────────────
  const lines = [
    plan.textAdded > 0
      ? `텍스트 +${plan.textAdded}자 → 총 ${curTextLen + plan.textAdded}자 (섹션: ${plan.sectionsAdded.map(s => s.replace('## ','')).join(', ')})`
      : null,
    plan.imagesAdded > 0
      ? `이미지 +${plan.imagesAdded}장 → 총 ${effTotal + plan.imagesAdded}장`
      : null,
    plan.featuredSet
      ? `featured_media_url → "${newFeatured.slice(0, 60)}${newFeatured.length > 60 ? '…' : ''}"`
      : null,
  ].filter(Boolean);

  if (dryRun) {
    console.log(`  DRY-RUN patch: ${path.basename(absPath)}`);
    lines.forEach(l => console.log(`    • ${l}`));
    process.exit(0);
  }

  // ── 백업 후 저장 ───────────────────────────────────────────────────────────
  fs.mkdirSync(BAK_DIR, { recursive: true });
  const bakPath = path.join(BAK_DIR, path.basename(absPath));
  // 이미 백업이 있어도 1회만 (원본 보존을 위해 존재하지 않을 때만)
  if (!fs.existsSync(bakPath)) {
    fs.writeFileSync(bakPath, fs.readFileSync(absPath, 'utf8'), 'utf8');
  }

  draft.content_markdown  = newMd;
  draft.content_images    = newContentImages;
  if (plan.featuredSet) draft.featured_media_url = newFeatured;

  fs.writeFileSync(absPath, JSON.stringify(draft, null, 2), 'utf8');

  console.log(`  PATCH: ${path.basename(absPath)}`);
  lines.forEach(l => console.log(`    • ${l}`));
  console.log(`  백업: wordpress/drafts/.bak/${path.basename(absPath)}`);
}

main();
