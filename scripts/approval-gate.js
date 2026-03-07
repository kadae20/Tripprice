#!/usr/bin/env node
/**
 * approval-gate.js
 * 파이프라인 결과물 자동 승인 판정.
 *
 * 규칙:
 *   1. seo-qa publishable === true (FAIL 0)
 *   2. Yoast 3종 모두 비어있지 않음 (focus_keyphrase, seo_title, meta_description)
 *   3. featured_media_url 존재 여부 (경고)
 *   4. content_images 1개 이상 (경고)
 *   5. 중복 감지: SimHash(1차) + MinHash Jaccard(2차) — Supabase 또는 로컬 폴백
 *
 * 시그니처 저장소:
 *   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY 있으면 Supabase published_signatures 테이블 사용
 *   - 없으면 state/published/signatures.json 로컬 폴백 (해시만, 텍스트 없음)
 *
 * Supabase DDL:
 *   create table published_signatures (
 *     slug        text primary key,
 *     date        date,
 *     simhash     text not null,      -- 16진수 64-bit
 *     minhash     integer[] not null, -- 64개 MinHash 값
 *     created_at  timestamptz default now()
 *   );
 *
 * 사용법:
 *   node scripts/approval-gate.js --slug=seoul-luxury-comparison-2026-03-05
 *   node scripts/approval-gate.js --slug=... --date=2026-03-05
 *
 * 출력:
 *   state/campaigns/approval-{slug}-{date}.json
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');
const { URL } = require('url');

const ROOT         = path.join(__dirname, '..');
const CAMPAIGN_DIR = path.join(ROOT, 'state', 'campaigns');
const DRAFTS_DIR   = path.join(ROOT, 'wordpress', 'drafts');
const LOCAL_SIG_DB = path.join(ROOT, 'state', 'published', 'signatures.json');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

if (!args.slug) {
  console.error('오류: --slug 옵션이 필요합니다.');
  process.exit(1);
}

const slug  = args.slug;
const today = args.date || new Date().toISOString().split('T')[0];

// ── 파일 탐색 ─────────────────────────────────────────────────────────────────
function findLatest(dir, prefix, ext) {
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).filter(n => n.startsWith(prefix) && n.endsWith(ext)).sort().reverse();
  return f.length ? path.join(dir, f[0]) : null;
}

// ════════════════════════════════════════════════════════════════════════════
//  SimHash + MinHash (순수 JS, 의존성 없음)
// ════════════════════════════════════════════════════════════════════════════

// 32-bit 정수 다항식 해시 (seed 기반)
function polyHash(str, seed = 0) {
  let h = seed ^ 0x9e3779b9;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x517cc1b7);
    h ^= (h >>> 16);
  }
  return h >>> 0;  // unsigned 32-bit
}

// 5-word shingle 생성
function toShingles5(text) {
  const words = text.toLowerCase().replace(/[^\w가-힣\s]/g, ' ').split(/\s+/).filter(Boolean);
  const s = [];
  for (let i = 0; i <= words.length - 5; i++) s.push(words.slice(i, i + 5).join(' '));
  return s;
}

// SimHash: 64-bit → 16진수 문자열
function computeSimHash(shingles) {
  const BITS = 64;
  const v    = new Float64Array(BITS);

  for (const s of shingles) {
    const h1 = polyHash(s, 0x01234567);
    const h2 = polyHash(s, 0x89abcdef);
    for (let i = 0; i < 32; i++) v[i]      += (h1 >> i & 1) ? 1 : -1;
    for (let i = 0; i < 32; i++) v[32 + i] += (h2 >> i & 1) ? 1 : -1;
  }

  let hex = '';
  for (let chunk = 0; chunk < 4; chunk++) {
    let word = 0;
    for (let b = 0; b < 16; b++) {
      if (v[chunk * 16 + b] > 0) word |= (1 << b);
    }
    hex += (word >>> 0).toString(16).padStart(4, '0');
  }
  return hex;  // 16-char hex = 64-bit
}

// Hamming distance between two 16-char hex SimHashes
function hammingDist(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i += 4) {
    let x = parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16);
    while (x) { dist += x & 1; x >>>= 1; }
  }
  return dist;
}

// MinHash: k개 해시 함수의 최솟값 → Jaccard 추정용
const MINHASH_K   = 64;
const MINHASH_MAX = 0x7fffffff;
const SEEDS = Array.from({ length: MINHASH_K }, (_, i) => (i * 0x9e3779b9 + 0x12345678) >>> 0);

function computeMinHash(shingles) {
  const mins = new Array(MINHASH_K).fill(MINHASH_MAX);
  for (const s of shingles) {
    for (let i = 0; i < MINHASH_K; i++) {
      const h = polyHash(s, SEEDS[i]);
      if (h < mins[i]) mins[i] = h;
    }
  }
  return mins;
}

// Jaccard 추정 (MinHash)
function estimateJaccard(a, b) {
  let eq = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] === b[i]) eq++; }
  return eq / a.length;
}

// ════════════════════════════════════════════════════════════════════════════
//  Supabase REST (해시 전용, 텍스트 저장 없음)
// ════════════════════════════════════════════════════════════════════════════
function supabaseReq(method, table, body = null, qs = '') {
  return new Promise((resolve, reject) => {
    const base   = process.env.SUPABASE_URL;
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !apiKey) return reject(new Error('SUPABASE 환경변수 없음'));

    const fullUrl = new URL(`${base}/rest/v1/${table}${qs}`);
    const isHttps = fullUrl.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: fullUrl.hostname,
      port:     fullUrl.port || (isHttps ? 443 : 80),
      path:     fullUrl.pathname + fullUrl.search,
      method,
      headers: {
        'apikey':         apiKey,
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Type':   'application/json',
        'Prefer':         'return=representation,resolution=merge-duplicates',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Supabase ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(data ? JSON.parse(data) : []); } catch { resolve([]); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('Supabase 타임아웃')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function fetchAllSignatures() {
  return supabaseReq('GET', 'published_signatures', null, '?select=slug,simhash,minhash&limit=5000');
}

async function upsertSignature(slug, simhash, minhash) {
  return supabaseReq('POST', 'published_signatures', { slug, date: today, simhash, minhash });
}

// ── 로컬 폴백 ─────────────────────────────────────────────────────────────────
function localLoadSigs() {
  if (!fs.existsSync(LOCAL_SIG_DB)) return [];
  try { return JSON.parse(fs.readFileSync(LOCAL_SIG_DB, 'utf8')); } catch { return []; }
}

function localSaveSig(slug, simhash, minhash) {
  const dir = path.dirname(LOCAL_SIG_DB);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = localLoadSigs().filter(e => e.slug !== slug);
  db.push({ slug, date: today, simhash, minhash });
  fs.writeFileSync(LOCAL_SIG_DB, JSON.stringify(db, null, 2), 'utf8');
}

// ── 파일 로드 ─────────────────────────────────────────────────────────────────
const qaJsonPath   = findLatest(CAMPAIGN_DIR, `seo-qa-${slug}`, '.json');
const postJsonPath = findLatest(DRAFTS_DIR,   `post-${slug}`,   '.json');
const draftMdPath  = findLatest(DRAFTS_DIR,   `draft-${slug}`,  '.md');

const reasons  = [];
let canPublish = true;
let score      = 100;

function fail(reason, deduct = 20) { reasons.push(reason); canPublish = false; score -= deduct; }
function warn(reason, deduct = 5)  { reasons.push(`[경고] ${reason}`); score -= deduct; }

// ── RULE 1: SEO QA ────────────────────────────────────────────────────────────
let qaData = null;
if (!qaJsonPath) {
  fail('seo-qa JSON 없음 — pipeline --json 플래그 확인');
} else {
  try {
    qaData = JSON.parse(fs.readFileSync(qaJsonPath, 'utf8'));
    if (qaData.publishable !== true) fail(`seo-qa FAIL ${qaData.counts?.FAIL || '?'}개 — 발행 불가`);
    if (qaData.counts?.WARN > 0)     warn(`seo-qa WARN ${qaData.counts.WARN}개`);
  } catch (e) { fail(`seo-qa JSON 파싱 실패: ${e.message}`); }
}

// ── RULE 2: Yoast 3종 ─────────────────────────────────────────────────────────
let postData = null;
if (!postJsonPath) {
  fail('post JSON 없음 — build-wp-post 실행 여부 확인');
} else {
  try {
    postData = JSON.parse(fs.readFileSync(postJsonPath, 'utf8'));
    const meta = postData.meta || {};
    if (!((meta.yoast_wpseo_focuskw   || meta.focus_keyphrase  || '').trim())) fail('Yoast focus_keyphrase 없음', 15);
    if (!((meta.yoast_wpseo_title     || meta.seo_title        || '').trim())) fail('Yoast seo_title 없음', 15);
    if (!((meta.yoast_wpseo_metadesc  || meta.meta_description || '').trim())) fail('Yoast meta_description 없음', 15);
  } catch (e) { fail(`post JSON 파싱 실패: ${e.message}`); }
}

// ── RULE 3: Featured Image ────────────────────────────────────────────────────
if (postData && !(postData.featured_media_url || postData.featured_media || postData.featured_media_id)) {
  warn('featured_media_url 없음');
}

// ── RULE 4: Content Images ────────────────────────────────────────────────────
if (postData && (postData.content_images || []).length < 1) {
  warn('content_images 0개 — 본문 이미지 없음');
}

// ── RULE 5: SimHash + MinHash 중복 감지 ───────────────────────────────────────
let currentSig = null;

(async () => {
  if (draftMdPath) {
    try {
      const text    = fs.readFileSync(draftMdPath, 'utf8');
      const shingles = toShingles5(text);

      if (shingles.length >= 5) {
        const simhash = computeSimHash(shingles);
        const minhash = computeMinHash(shingles);
        currentSig = { simhash, minhash };

        // DB 로드 (Supabase 우선, 로컬 폴백)
        const useSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
        let allSigs = [];
        try {
          allSigs = useSupabase ? await fetchAllSignatures() : localLoadSigs();
        } catch (e) {
          console.error(`  ⚠  시그니처 DB 로드 실패 (${e.message}) — 유사도 검사 건너뜀`);
        }

        // 비교: 자기 자신 제외
        let maxJaccard = 0;
        let mostSimilar = null;

        for (const entry of allSigs) {
          if (entry.slug === slug) continue;
          // 1차: SimHash Hamming distance (빠른 필터)
          const hd = hammingDist(simhash, entry.simhash || '');
          if (hd > 12) continue;  // 12비트 이상 차이 → 확실히 다름
          // 2차: MinHash Jaccard 추정
          const j = estimateJaccard(minhash, entry.minhash || []);
          if (j > maxJaccard) { maxJaccard = j; mostSimilar = entry.slug; }
        }

        if (maxJaccard > 0.7) {
          fail(`중복 콘텐츠 (Jaccard ~${(maxJaccard * 100).toFixed(1)}%) — 유사: ${mostSimilar}`, 30);
        } else if (maxJaccard > 0.5) {
          warn(`유사 콘텐츠 (Jaccard ~${(maxJaccard * 100).toFixed(1)}%) — ${mostSimilar}`);
        }
      } else {
        warn('shingle 수 부족 (텍스트 너무 짧음) — 유사도 검사 건너뜀');
      }
    } catch (e) {
      warn(`유사도 검사 실패: ${e.message}`);
    }
  } else {
    warn('draft MD 없음 — 유사도 검사 건너뜀');
  }

  // ── 결과 ────────────────────────────────────────────────────────────────────
  score = Math.max(0, score);

  const result = {
    slug,
    date:        today,
    can_publish: canPublish,
    score,
    reasons,
    qa_path:     qaJsonPath   ? path.relative(ROOT, qaJsonPath)   : null,
    post_path:   postJsonPath ? path.relative(ROOT, postJsonPath) : null,
    draft_path:  draftMdPath  ? path.relative(ROOT, draftMdPath)  : null,
  };

  // 승인 시 시그니처 저장 (hash만, 텍스트 없음)
  if (canPublish && currentSig) {
    const useSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
    try {
      if (useSupabase) {
        await upsertSignature(slug, currentSig.simhash, currentSig.minhash);
      } else {
        localSaveSig(slug, currentSig.simhash, currentSig.minhash);
      }
    } catch (e) {
      console.error(`  ⚠  시그니처 저장 실패: ${e.message}`);
    }
  }

  // ── 파일 저장 ──────────────────────────────────────────────────────────────
  if (!fs.existsSync(CAMPAIGN_DIR)) fs.mkdirSync(CAMPAIGN_DIR, { recursive: true });
  const outPath = path.join(CAMPAIGN_DIR, `approval-${slug}-${today}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  // ── 콘솔 출력 ──────────────────────────────────────────────────────────────
  const icon = canPublish ? '✅' : '❌';
  console.log(`\n승인 게이트 판정`);
  console.log(`  ${icon} ${canPublish ? '승인' : '거부'}  (점수: ${score}/100)`);
  console.log(`  슬러그: ${slug}`);
  if (reasons.length > 0) {
    console.log(`\n  사유:`);
    reasons.forEach(r => console.log(`    - ${r}`));
  }
  console.log(`\n  파일: ${outPath}`);
  if (canPublish) {
    const wpUrl = process.env.WP_URL || 'https://tripprice.net';
    console.log(`\n  발행 명령:`);
    console.log(`  WP_URL=${wpUrl} WP_USER=admin WP_APP_PASS="xxxx xxxx" \\`);
    console.log(`    node scripts/wp-publish.js ${result.post_path} --status=publish`);
  }

  process.exit(canPublish ? 0 : 1);
})().catch(err => {
  console.error('approval-gate 오류:', err.message);
  process.exit(1);
});
