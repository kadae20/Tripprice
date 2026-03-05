#!/usr/bin/env node
/**
 * secrets-audit.js
 * 코드베이스에서 하드코딩된 시크릿·URL을 스캔합니다.
 * 진단 전용 — 파일을 수정하지 않습니다.
 *
 * 사용법:
 *   node scripts/secrets-audit.js
 *   node scripts/secrets-audit.js --dir=scripts
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── 스캔 설정 ─────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, '..');

// 스캔할 확장자
const SCAN_EXTS = new Set(['.js', '.ts', '.json', '.env', '.sh', '.md']);

// 제외 경로 (prefix 매칭)
const EXCLUDE_DIRS = [
  'node_modules', '.git', 'assets/raw', 'assets/processed',
  'data/processed', 'state',
];

// 패턴 정의
const PATTERNS = [
  {
    id:      'hardcoded-wp-url',
    label:   '하드코딩 WP URL',
    re:      /https?:\/\/tripprice\.com/g,
    note:    '→ process.env.WP_URL 사용 권장',
    severity: 'WARN',
    // .example 파일 또는 README에서는 기대되는 값이므로 INFO 처리
    allowedFiles: ['.env.example'],
  },
  {
    id:      'agoda-api-secret',
    label:   '아고다 API Secret',
    re:      /\b[0-9]{7}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g,
    note:    '→ 즉시 키 교체 + AGODA_API_KEY 환경변수 사용',
    severity: 'FAIL',
    allowedFiles: ['.env.example'],
  },
  {
    id:      'wp-app-pass-real',
    label:   'WP Application Password (실제 값 의심)',
    // 6그룹 * 4자 영숫자 공백 구분 (예: NpvM jY16 ZZJm Zdc9 N3Hx H3GI)
    re:      /\b[A-Za-z0-9]{4}(?:\s[A-Za-z0-9]{4}){5}\b/g,
    note:    '→ 즉시 WP 비밀번호 교체 + WP_APP_PASS 환경변수 사용',
    severity: 'FAIL',
    allowedFiles: ['.env.example'],
  },
  {
    id:      'inline-password',
    label:   '인라인 패스워드 패턴',
    re:      /(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*['"][^'"]{6,}['"]/gi,
    note:    '→ 환경변수 또는 secrets manager로 이동',
    severity: 'WARN',
    allowedFiles: ['.env.example', '.env.local'],
  },
];

// ── 파일 수집 ─────────────────────────────────────────────────────────────────

function shouldExclude(relPath) {
  return EXCLUDE_DIRS.some(d => relPath.startsWith(d + '/') || relPath.startsWith(d + '\\'));
}

function collectFiles(dir, baseDir) {
  const results = [];
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel  = path.relative(baseDir, full).replace(/\\/g, '/');
    if (shouldExclude(rel)) continue;
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectFiles(full, baseDir));
    } else if (SCAN_EXTS.has(path.extname(entry).toLowerCase())) {
      results.push({ full, rel });
    }
  }
  return results;
}

// ── 스캔 실행 ─────────────────────────────────────────────────────────────────

function scanFile(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); }
  catch { return []; }

  const findings = [];
  for (const pattern of PATTERNS) {
    const basename = path.basename(filePath);
    const isAllowed = (pattern.allowedFiles || []).includes(basename);
    pattern.re.lastIndex = 0;
    let m;
    while ((m = pattern.re.exec(text)) !== null) {
      const lineNo = text.slice(0, m.index).split('\n').length;
      const lineText = text.split('\n')[lineNo - 1].trim().slice(0, 120);
      findings.push({
        patternId: pattern.id,
        label:     pattern.label,
        note:      pattern.note,
        severity:  isAllowed ? 'INFO' : pattern.severity,
        lineNo,
        lineText,
        match:     m[0].slice(0, 40) + (m[0].length > 40 ? '…' : ''),
      });
    }
  }
  return findings;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const scanDir = args.dir ? path.resolve(ROOT, args.dir) : ROOT;
const files   = collectFiles(scanDir, ROOT);

let totalFindings = 0;
let failCount     = 0;
let warnCount     = 0;

const byFile = [];

for (const { full, rel } of files) {
  const findings = scanFile(full);
  if (findings.length > 0) {
    byFile.push({ rel, findings });
    for (const f of findings) {
      totalFindings++;
      if (f.severity === 'FAIL') failCount++;
      if (f.severity === 'WARN') warnCount++;
    }
  }
}

// ── 결과 출력 ──────────────────────────────────────────────────────────────────

const divider = '─'.repeat(64);
console.log('\nSecrets Audit 결과');
console.log(divider);

if (byFile.length === 0) {
  console.log('  ✅ 의심 항목 없음');
} else {
  for (const { rel, findings } of byFile) {
    console.log(`\n📄 ${rel}`);
    for (const f of findings) {
      const icon = f.severity === 'FAIL' ? '❌' : f.severity === 'WARN' ? '⚠️ ' : 'ℹ️ ';
      console.log(`  ${icon} [${f.severity}] ${f.label}  (줄 ${f.lineNo})`);
      console.log(`       → ${f.lineText}`);
      console.log(`       ${f.note}`);
    }
  }
}

console.log(`\n${divider}`);
console.log(`스캔 파일: ${files.length}개  |  FAIL: ${failCount}  WARN: ${warnCount}  INFO: ${totalFindings - failCount - warnCount}`);

if (failCount > 0) {
  console.log('\n❌ FAIL 항목이 있습니다. 즉시 조치 필요.');
  process.exit(1);
} else if (warnCount > 0) {
  console.log('\n⚠️  WARN 항목이 있습니다. 환경변수로 이동을 권장합니다.');
  process.exit(0);
} else {
  console.log('\n✅ 시크릿 감사 통과');
  process.exit(0);
}
