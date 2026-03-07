#!/usr/bin/env node
/**
 * .env.local을 파싱해 환경변수로 주입 후 지정 스크립트 실행.
 * 공백 포함 WP_APP_PASS 등 source 방식으로는 처리 어려운 값 대응.
 * 사용: node scripts/_run-with-env.js scripts/wp-publish.js [arg...]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env.local');

const env = {};
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(function(line) {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const idx = line.indexOf('=');
    if (idx === -1) return;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    // 따옴표 제거 (앞뒤 " 또는 ')
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  });
}

const targetScript = process.argv[2];
if (!targetScript) {
  console.error('사용법: node scripts/_run-with-env.js [스크립트 경로] [인자...]');
  process.exit(1);
}

const scriptArgs = process.argv.slice(3);
const merged = Object.assign({}, process.env, env);

const result = spawnSync(process.execPath, [targetScript].concat(scriptArgs), {
  env: merged,
  stdio: 'inherit',
  cwd: ROOT,
});

process.exit(result.status !== null ? result.status : 1);
