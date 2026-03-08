#!/usr/bin/env node
/**
 * _diag-agoda-contentapi.js
 * Agoda Content API 연결 상태를 단독으로 진단합니다.
 *
 * 사용법:
 *   node scripts/_run-with-env.js scripts/_diag-agoda-contentapi.js
 *   node scripts/_run-with-env.js scripts/_diag-agoda-contentapi.js --hotel-id=535922
 *
 * 출력: status / content-type / location / body 앞 200자 (민감값 없음)
 * 결과에 따라 "코드 문제" vs "파트너 허브 권한 문제"를 분리 진단합니다.
 */
'use strict';

const https = require('https');
const { URL } = require('url');

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);

const AGODA_HOTEL_ID = args['hotel-id'] || '535922'; // 그랜드 하얏트 서울
const API_KEY  = process.env.AGODA_API_KEY || '';
const CID      = process.env.AGODA_CID     || '1926938';
const SITE_URL = process.env.SITE_URL      || 'https://tripprice.net';

let hostname;
try { hostname = new URL(SITE_URL).hostname; } catch { hostname = 'tripprice.net'; }

console.log('══════════════════════════════════════════════════');
console.log('  Agoda Content API 진단');
console.log('══════════════════════════════════════════════════');
console.log(`  SITE_URL        : ${SITE_URL}`);
console.log(`  Origin hostname : ${hostname}`);
console.log(`  API_KEY 존재    : ${API_KEY ? `YES (len=${API_KEY.length}, CID:secret=${API_KEY.includes(':')})` : 'NO'}`);
console.log(`  CID             : ${CID}`);
console.log(`  호텔 ID         : ${AGODA_HOTEL_ID}`);
console.log('');

if (!API_KEY) {
  console.error('FAIL: AGODA_API_KEY 환경변수 없음');
  process.exit(1);
}

const TARGET_URL = `https://contentapi.agoda.com/api/v1/properties/${AGODA_HOTEL_ID}?languageCode=ko-KR`;
console.log(`  요청 URL: ${TARGET_URL}`);
console.log('');

// ── HTTP GET (리다이렉트 직접 감지, Node 기본 https는 auto-redirect 없음) ────
function diagnose(targetUrl, hop = 0) {
  if (hop > 3) {
    console.error('  리다이렉트 3회 초과 — 진단 중단');
    return;
  }

  const parsedUrl = new URL(targetUrl);
  const options = {
    hostname: parsedUrl.hostname,
    path:     parsedUrl.pathname + parsedUrl.search,
    method:   'GET',
    headers: {
      'Authorization':    `apikey ${API_KEY}`,
      'Accept':           'application/json',
      'X-Site-ID':        CID,
      'User-Agent':       `TrippriceBot/1.0 (+${SITE_URL})`,
      'Origin':           SITE_URL,
      'Referer':          `${SITE_URL}/`,
      'X-Forwarded-Host': hostname,
    },
  };

  const req = https.request(options, res => {
    const statusCode  = res.statusCode;
    const contentType = res.headers['content-type'] || '(없음)';
    const location    = res.headers['location']     || '';

    console.log(`  ── 응답 (hop ${hop}) ─────────────────────────────`);
    console.log(`  status code  : ${statusCode}`);
    console.log(`  content-type : ${contentType}`);
    console.log(`  location     : ${location ? location.slice(0, 100) : '(없음)'}`);

    // ── 리다이렉트 처리 ──────────────────────────────────────────────────────
    if ([301, 302, 307, 308].includes(statusCode)) {
      res.resume();
      console.log('');
      if (location.includes('agoda.com') && !location.includes('contentapi')) {
        console.log('  ══ 진단 결과 ══════════════════════════════════════');
        console.log('  분류: 파트너 허브 권한/도메인 미설정 (코드 문제 아님)');
        console.log('  Agoda 서버가 www.agoda.com으로 리다이렉트 중');
        console.log('');
        console.log('  해결 방법:');
        console.log('    1) partners.agoda.com 로그인');
        console.log('    2) [Tools] → [API] → Content API 신청/활성화');
        console.log(`    3) Approval Sites에 "${hostname}" 추가`);
        console.log('    4) 승인 메일 수신 후 재시도');
        console.log('  ══════════════════════════════════════════════════');
      } else if (location) {
        console.log(`  리다이렉트 추적 → ${location.slice(0, 80)}`);
        console.log('');
        diagnose(location.startsWith('http') ? location : `https://${parsedUrl.hostname}${location}`, hop + 1);
      }
      return;
    }

    // ── 본문 읽기 ───────────────────────────────────────────────────────────
    let body = '';
    res.on('data', chunk => { if (body.length < 500) body += chunk; });
    res.on('end', () => {
      const isJson = contentType.includes('json');
      const isHtml = contentType.includes('html');
      const preview = body.replace(/\s+/g, ' ').slice(0, 200);

      console.log(`  body 앞 200자: ${preview}`);
      console.log('');
      console.log('  ══ 진단 결과 ══════════════════════════════════════');

      if (statusCode === 200 && isJson) {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        if (parsed) {
          console.log('  분류: 정상 — Content API 응답 수신');
          const keys = Object.keys(parsed).slice(0, 8).join(', ');
          console.log(`  응답 키: ${keys}`);
          console.log('  → fetch-hotel-images.js 실행 시 이미지 URL 수집 가능');
        } else {
          console.log('  분류: JSON 파싱 실패 — 응답 구조 확인 필요');
        }
      } else if (statusCode === 200 && isHtml) {
        console.log('  분류: 파트너 허브 권한 없음 (200 HTML — Agoda 홈 투명 리다이렉트)');
        console.log('  Agoda Content API가 홈페이지로 리다이렉트 후 200 반환');
        console.log('');
        console.log('  해결 방법:');
        console.log('    1) partners.agoda.com 로그인');
        console.log('    2) [Tools] → [API] → Content API 신청/활성화');
        console.log(`    3) Approval Sites에 "${hostname}" 추가`);
        console.log('    4) 승인 완료 후 재실행');
      } else if (statusCode === 401 || statusCode === 403) {
        console.log(`  분류: 인증/권한 오류 (HTTP ${statusCode})`);
        console.log('  AGODA_API_KEY 형식: CID:secret (예: 1926938:abcdef...)');
        console.log('  파트너 허브 > API 탭에서 키 재발급 또는 확인');
      } else {
        console.log(`  분류: 예상치 못한 응답 (HTTP ${statusCode})`);
      }
      console.log('  ══════════════════════════════════════════════════');
      process.exit(statusCode === 200 && isJson ? 0 : 1);
    });
  });

  req.on('error', err => {
    console.error(`  네트워크 오류: ${err.message}`);
    process.exit(1);
  });
  req.setTimeout(15000, () => {
    req.destroy();
    console.error('  타임아웃 (15초)');
    process.exit(1);
  });
  req.end();
}

diagnose(TARGET_URL);
