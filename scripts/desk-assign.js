#!/usr/bin/env node
/**
 * desk-assign.js — Assignment Desk
 *
 * 발행 대상 초안을 선정해 JSON 배열로 stdout 출력.
 * 우선순위: drafts (--since 이후) → campaigns grade A/B → processed by score
 * 이미 발행된 slug(published/ 디렉토리 + publish-auto 로그)는 제외 (idempotency).
 *
 * Usage: node scripts/desk-assign.js [--since=YYYY-MM-DD] [--limit=N] [--min-score=N] [--hotels=a,b]
 * Output: JSON array → [{draftFile, slug, name, score}, ...]
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT          = path.resolve(__dirname, '..');
const DRAFTS_DIR    = path.join(ROOT, 'wordpress', 'drafts');
const PUBLISHED_DIR = path.join(ROOT, 'wordpress', 'published');
const CAMPAIGNS_DIR = path.join(ROOT, 'state', 'campaigns');
const PROCESSED_DIR = path.join(ROOT, 'data', 'processed');
const LOGS_DIR      = path.join(ROOT, 'logs');

// ── CLI 파싱 ──────────────────────────────────────────────────────────────────
function parseArgs() {
  const raw = process.argv.slice(2);
  const obj = {};
  for (const a of raw) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      obj[k] = v === undefined ? true : v;
    }
  }
  return {
    hotels:   obj.hotels   ? obj.hotels.split(',').map(h => h.trim()).filter(Boolean) : null,
    limit:    parseInt(obj.limit    || '50',  10),
    minScore: parseInt(obj['min-score'] || '60', 10),
    since:    obj.since    || new Date().toISOString().split('T')[0],
    match:    obj.match    || null,
  };
}

// ── 이미 발행된 slug 수집 (idempotency) ────────────────────────────────────────
function getPublishedSlugs() {
  const slugs = new Set();

  // wordpress/published/ 디렉토리
  if (fs.existsSync(PUBLISHED_DIR)) {
    fs.readdirSync(PUBLISHED_DIR)
      .filter(f => f.startsWith('post-') && f.endsWith('.json') && !f.endsWith('.qa.json'))
      .forEach(f => {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(PUBLISHED_DIR, f), 'utf8'));
          if (d.slug) slugs.add(d.slug);
        } catch { /* skip */ }
      });
  }

  // logs/publish-auto-*.json
  if (fs.existsSync(LOGS_DIR)) {
    fs.readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('publish-auto-') && f.endsWith('.json'))
      .forEach(f => {
        try {
          const records = JSON.parse(fs.readFileSync(path.join(LOGS_DIR, f), 'utf8'));
          if (Array.isArray(records)) {
            records.filter(r => r.published && r.draftFile).forEach(r => {
              // draftFile = 'post-{slug}-{date}.json' 역산
              const base = r.draftFile.replace(/^post-/, '').replace(/-\d{4}-\d{2}-\d{2}\.json$/, '').replace(/\.json$/, '');
              slugs.add(base);
              // 또는 JSON 내 slug 필드가 있으면 직접 사용
              if (r.slug) slugs.add(r.slug);
            });
          }
        } catch { /* skip */ }
      });
  }

  return slugs;
}

// ── "발행 불가" hotel_id 수집 ─────────────────────────────────────────────────
function getBlockedIds() {
  const blocked = new Set();
  if (!fs.existsSync(CAMPAIGNS_DIR)) return blocked;
  fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.endsWith('.json')).forEach(f => {
    try {
      const raw = fs.readFileSync(path.join(CAMPAIGNS_DIR, f), 'utf8');
      if (!raw.includes('현재 발행 불가')) return;
      const j = JSON.parse(raw);
      if (j.hotel_id) blocked.add(j.hotel_id);
    } catch { /* skip */ }
  });
  return blocked;
}

// ── drafts 선정 (since 이후 post-*.json, .qa.json 제외) ───────────────────────
function selectFromDrafts(since, publishedSlugs, match) {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  const sinceMs = new Date(since).getTime();

  return fs.readdirSync(DRAFTS_DIR)
    .filter(f => f.startsWith('post-') && f.endsWith('.json') && !f.endsWith('.qa.json'))
    .filter(f => !match || f.includes(match))
    .filter(f => {
      try { return fs.statSync(path.join(DRAFTS_DIR, f)).mtimeMs >= sinceMs; } catch { return false; }
    })
    .map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8'));
        const slug = d.slug || f.replace(/^post-/, '').replace(/\.json$/, '');
        if (publishedSlugs.has(slug)) return null; // idempotency
        return { draftFile: path.join(DRAFTS_DIR, f), slug, name: d.post_title || d.title || '', score: d.coverage_score || 0 };
      } catch { return null; }
    })
    .filter(Boolean);
}

// ── campaigns grade A/B 선정 ────────────────────────────────────────────────
function selectFromCampaigns(blocked, publishedSlugs, limit) {
  if (!fs.existsSync(CAMPAIGNS_DIR)) return [];
  const seen = new Set();
  return fs.readdirSync(CAMPAIGNS_DIR)
    .filter(f => f.endsWith('.json'))
    .reduce((acc, f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, f), 'utf8'));
        const grade = j.grade || j.coverage_grade || '';
        if ((grade === 'A' || grade === 'B') && j.hotel_id
            && !blocked.has(j.hotel_id) && !publishedSlugs.has(j.hotel_id) && !seen.has(j.hotel_id)) {
          seen.add(j.hotel_id);
          acc.push({ draftFile: null, slug: j.hotel_id, name: j.hotel_name || '', score: j.coverage_score || 0 });
        }
      } catch { /* skip */ }
      return acc;
    }, [])
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── processed 선정 (score 기준) ───────────────────────────────────────────────
function selectFromProcessed(limit, minScore, blocked, publishedSlugs) {
  if (!fs.existsSync(PROCESSED_DIR)) return [];
  return fs.readdirSync(PROCESSED_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(PROCESSED_DIR, f), 'utf8'));
        return { draftFile: null, slug: j.hotel_id, name: j.hotel_name || '', score: j.coverage_score || 0 };
      } catch { return null; }
    })
    .filter(h => h && h.slug && h.score >= minScore && !blocked.has(h.slug) && !publishedSlugs.has(h.slug))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
function main() {
  const args         = parseArgs();
  const blocked      = getBlockedIds();
  const published    = getPublishedSlugs();

  let queue = [];

  if (args.hotels) {
    // 수동 지정
    queue = args.hotels.map(id => ({ draftFile: null, slug: id, name: '', score: 0 }));
  } else {
    const drafts = selectFromDrafts(args.since, published, args.match);
    if (drafts.length > 0) {
      queue = drafts;
    } else {
      const campaigns = selectFromCampaigns(blocked, published, args.limit);
      queue = campaigns.length > 0 ? campaigns : selectFromProcessed(args.limit, args.minScore, blocked, published);
    }
  }

  queue = queue.slice(0, args.limit);

  // draftFile이 절대경로면 그대로, 상대경로면 DRAFTS_DIR 기준으로
  process.stdout.write(JSON.stringify(queue, null, 2) + '\n');
}

if (require.main === module) main();
module.exports = { getPublishedSlugs, getBlockedIds };
