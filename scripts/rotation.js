'use strict';
/**
 * rotation.js
 * 작업 로테이션 상태 관리 (state/rotation/rotation.json).
 * hoteldata-extract 용 hotel-rotation.json 과는 별개 파일.
 *
 * key:   hotel_id 단일 또는 정렬된 hotel_id 조합 (comboKey)
 * value: last_used_at, used_count, last_period, last_outcome, failure_reason
 *
 * ENV:
 *   JOB_COOLDOWN_DAYS — 재선정 금지 기간 (기본 14, 0=비활성)
 */

const fs   = require('fs');
const path = require('path');

const ROOT          = path.join(__dirname, '..');
const ROTATION_PATH = path.join(ROOT, 'state', 'rotation', 'rotation.json');
const COOLDOWN_DAYS = Math.max(0, parseInt(process.env.JOB_COOLDOWN_DAYS || '14', 10));

// ── 상태 I/O ─────────────────────────────────────────────────────────────────

function load() {
  if (!fs.existsSync(ROTATION_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(ROTATION_PATH, 'utf8')); } catch { return {}; }
}

function save(state) {
  fs.mkdirSync(path.dirname(ROTATION_PATH), { recursive: true });
  fs.writeFileSync(ROTATION_PATH, JSON.stringify(state, null, 2), 'utf8');
}

// ── 키 생성 ──────────────────────────────────────────────────────────────────

/**
 * 비교 작업 등 다중 호텔의 조합키.
 * 정렬 후 "+" 연결 → 순서 무관하게 동일 조합은 같은 키.
 * 단일: comboKey(['a']) → 'a'
 * 복수: comboKey(['b','a']) → 'a+b'
 */
function comboKey(hotelIds) {
  return hotelIds.slice().sort().join('+');
}

// ── 냉각 판정 ─────────────────────────────────────────────────────────────────

function isOnCooldown(key, state) {
  if (COOLDOWN_DAYS <= 0) return false;
  const e = state[key];
  if (!e || !e.last_used_at) return false;
  const elapsedDays = (Date.now() - new Date(e.last_used_at).getTime()) / 86400000;
  return elapsedDays < COOLDOWN_DAYS;
}

/** 냉각 잔여일 (0이면 사용 가능) */
function cooldownRemaining(key, state) {
  if (COOLDOWN_DAYS <= 0) return 0;
  const e = state[key];
  if (!e || !e.last_used_at) return 0;
  const elapsed = (Date.now() - new Date(e.last_used_at).getTime()) / 86400000;
  return Math.max(0, COOLDOWN_DAYS - elapsed);
}

// ── 상태 업데이트 ─────────────────────────────────────────────────────────────

/**
 * 작업 시작 시 기록.
 * last_used_at, used_count, last_period 갱신.
 */
function markUsed(key, state) {
  const now  = new Date().toISOString();
  const prev = state[key] || {};
  state[key] = {
    last_used_at:  now,
    used_count:    (prev.used_count || 0) + 1,
    last_period:   now.slice(0, 7),         // YYYY-MM
    last_outcome:  prev.last_outcome || 'pending',
    last_slug:     prev.last_slug,
  };
  return state;
}

/**
 * 발행/검증 결과 기록.
 * 실패 시 last_used_at을 now로 재설정해 cooldown 기간을 연장.
 */
function markOutcome(key, state, { success, slug, failure_reason } = {}) {
  const e   = state[key] || {};
  const now = new Date().toISOString();
  state[key] = {
    ...e,
    last_outcome:    success ? 'success' : 'failed',
    last_outcome_at: now,
    last_slug:       slug || e.last_slug,
    // 실패 시 cooldown 리셋 (같은 대상 재선택 방지)
    ...(success ? {} : {
      last_used_at:    now,
      failure_reason:  failure_reason || 'unknown',
    }),
  };
  if (success) delete state[key].failure_reason;
  return state;
}

module.exports = {
  load, save,
  comboKey,
  isOnCooldown, cooldownRemaining,
  markUsed, markOutcome,
  ROTATION_PATH, COOLDOWN_DAYS,
};
