#!/usr/bin/env node
/**
 * aws-cost-fetch.js
 * AWS Cost Explorer API에서 전월 EC2 비용을 조회하여
 * SERVER_COST_MONTHLY_KRW 값을 stdout으로 출력합니다.
 *
 * 사용법:
 *   node scripts/_run-with-env.js scripts/aws-cost-fetch.js [--month=2026-02]
 *   node scripts/_run-with-env.js scripts/aws-cost-fetch.js --update-env
 *
 * 필요 환경변수:
 *   AWS_ACCESS_KEY_ID        — IAM 사용자 키
 *   AWS_SECRET_ACCESS_KEY    — IAM 사용자 시크릿
 *   AWS_REGION               — 기본값: ap-northeast-2
 *   USD_TO_KRW               — 환율 (기본값: 1350)
 *
 * IAM 최소 권한:
 *   {
 *     "Effect": "Allow",
 *     "Action": ["ce:GetCostAndUsage"],
 *     "Resource": "*"
 *   }
 *
 * --update-env 플래그 사용 시:
 *   .env.local의 SERVER_COST_MONTHLY_KRW 값을 자동으로 업데이트합니다.
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');

// ── CLI ───────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const updateEnv = args['update-env'] === true;
const region    = process.env.AWS_REGION || 'ap-northeast-2';
const usdToKrw  = parseInt(process.env.USD_TO_KRW || '1350', 10);

// ── 대상 월 계산 ─────────────────────────────────────────────────────────────
function getMonthRange(monthStr) {
  const d = monthStr ? new Date(`${monthStr}-01`) : (() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth() - 1, 1);
  })();
  const start = d.toISOString().slice(0, 10);
  const end   = new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString().slice(0, 10);
  return { start, end };
}

const { start, end } = getMonthRange(args.month);

// ── AWS Signature V4 ──────────────────────────────────────────────────────────
function sign(key, msg) {
  return crypto.createHmac('sha256', key).update(msg).digest();
}

function getSigningKey(secret, date, region, service) {
  const kDate    = sign('AWS4' + secret, date);
  const kRegion  = sign(kDate, region);
  const kService = sign(kRegion, service);
  return sign(kService, 'aws4_request');
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function awsRequest(service, host, path, body) {
  return new Promise((resolve, reject) => {
    const accessKey = process.env.AWS_ACCESS_KEY_ID;
    const secretKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!accessKey || !secretKey) {
      reject(new Error('AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY 환경변수 필요'));
      return;
    }

    const now         = new Date();
    const amzDate     = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
    const dateStamp   = amzDate.slice(0, 8);
    const bodyHash    = sha256Hex(body);
    const method      = 'POST';
    const contentType = 'application/x-amz-json-1.1';

    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-date:${amzDate}\n` +
      `x-amz-target:AWSInsightsIndexService.GetCostAndUsage\n`;

    const signedHeaders = 'content-type;host;x-amz-date;x-amz-target';

    const canonicalRequest = [
      method, path, '',
      canonicalHeaders, signedHeaders, bodyHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign    = [
      'AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey  = getSigningKey(secretKey, dateStamp, region, service);
    const signature   = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authHeader  =
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const options = {
      hostname: host,
      path,
      method,
      headers: {
        'Content-Type': contentType,
        'X-Amz-Date': amzDate,
        'X-Amz-Target': 'AWSInsightsIndexService.GetCostAndUsage',
        'Authorization': authHeader,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode !== 200) reject(new Error(json.message || data));
          else resolve(json);
        } catch (e) {
          reject(new Error(`응답 파싱 실패: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Cost Explorer 호출 ────────────────────────────────────────────────────────
async function fetchEc2Cost() {
  const host = 'ce.us-east-1.amazonaws.com'; // Cost Explorer는 us-east-1 전용
  const body = JSON.stringify({
    TimePeriod: { Start: start, End: end },
    Granularity: 'MONTHLY',
    Filter: {
      Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Compute Cloud - Compute'] },
    },
    Metrics: ['UnblendedCost'],
  });

  const result = await awsRequest('ce', host, '/', body);
  const usd    = parseFloat(
    result.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || '0'
  );
  return Math.round(usd * usdToKrw);
}

// ── .env.local 업데이트 ───────────────────────────────────────────────────────
function updateEnvLocal(krw) {
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) {
    console.error('.env.local 없음 — 자동 업데이트 생략');
    return;
  }
  let content = fs.readFileSync(envPath, 'utf8');
  if (/^SERVER_COST_MONTHLY_KRW=/m.test(content)) {
    content = content.replace(/^SERVER_COST_MONTHLY_KRW=.*/m, `SERVER_COST_MONTHLY_KRW=${krw}`);
  } else {
    content += `\nSERVER_COST_MONTHLY_KRW=${krw}\n`;
  }
  fs.writeFileSync(envPath, content, 'utf8');
  console.log(`  .env.local 업데이트: SERVER_COST_MONTHLY_KRW=${krw}`);
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`AWS Cost Explorer 조회: ${start} ~ ${end}`);
  try {
    const krw = await fetchEc2Cost();
    console.log(`EC2 비용: ${krw.toLocaleString()}원 (환율 ${usdToKrw}원/USD)`);
    console.log(`SERVER_COST_MONTHLY_KRW=${krw}`);

    if (updateEnv) updateEnvLocal(krw);
    process.exit(0);
  } catch (err) {
    console.error(`오류: ${err.message}`);
    console.error('  수동 override: .env.local → SERVER_COST_MONTHLY_KRW=NNNN');
    process.exit(1);
  }
})();
