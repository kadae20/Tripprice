#!/usr/bin/env node
/**
 * agoda-partner-fetch-url.js
 * Playwright로 partners.agoda.com에 로그인 → hoteldata 다운로드 URL 추출
 * → AGODA_HOTELDATA_URL을 .env.local에 자동 갱신
 *
 * 사용법:
 *   node scripts/_run-with-env.js scripts/agoda-partner-fetch-url.js
 *   node scripts/_run-with-env.js scripts/agoda-partner-fetch-url.js --dry-run
 *
 * 환경변수:
 *   AGODA_PARTNER_EMAIL     — 필수
 *   AGODA_PARTNER_PASSWORD  — 필수
 *
 * 성공 시: .env.local의 AGODA_HOTELDATA_URL 갱신 후 exit 0
 * 실패 시: 오류 출력 후 exit 1 (기존 URL 유지)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.local');

const DRY_RUN = process.argv.includes('--dry-run');

// ── 로그 ──────────────────────────────────────────────────────────────────────
function log(msg)  { console.log(`  [partner-fetch] ${msg}`); }
function warn(msg) { console.warn(`  [partner-fetch] ⚠  ${msg}`); }
function err(msg)  { console.error(`  [partner-fetch] ❌ ${msg}`); }

// ── .env.local 갱신 (AGODA_HOTELDATA_URL 키만 업데이트) ─────────────────────
function updateEnvLocal(key, value) {
  let content = '';
  if (fs.existsSync(ENV_FILE)) {
    content = fs.readFileSync(ENV_FILE, 'utf8');
  }

  const lines = content.split('\n');
  const keyLine = `${key}=${value}`;
  let found = false;

  const updated = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith(key + '=') || trimmed.startsWith(key + ' =')) {
      found = true;
      return keyLine;
    }
    return line;
  });

  if (!found) {
    // 파일 끝에 추가
    updated.push(keyLine);
  }

  // 빈 줄 정리 (연속 2개 이상 빈 줄 → 1개)
  const cleaned = updated.join('\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(ENV_FILE, cleaned, 'utf8');
  log(`${key} 갱신 완료 (.env.local)`);
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
(async () => {
  const email    = process.env.AGODA_PARTNER_EMAIL    || '';
  const password = process.env.AGODA_PARTNER_PASSWORD || '';

  if (!email || !password) {
    err('AGODA_PARTNER_EMAIL / AGODA_PARTNER_PASSWORD 환경변수 필요');
    process.exit(1);
  }

  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    err('playwright 미설치 — npm install playwright && npx playwright install chromium');
    process.exit(1);
  }

  log('Chromium 브라우저 시작...');
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'ko-KR',
  });
  const page = await context.newPage();

  try {
    // ── [1] 로그인 페이지 접속 ──────────────────────────────────────────────
    log('로그인 페이지 접속...');
    await page.goto('https://partners.agoda.com/en-us/login.html', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // ── [2] 이메일/비밀번호 입력 ────────────────────────────────────────────
    log(`로그인 시도: ${email}`);

    // 로그인 폼은 iframe 내부에 있음 — iframe 렌더링 대기
    log('  로그인 iframe 로딩 대기...');
    await page.waitForSelector('iframe[src*="ul/login"]', { timeout: 15000 });
    const iframeEl = await page.$('iframe[src*="ul/login"]');
    if (!iframeEl) throw new Error('로그인 iframe을 찾을 수 없음');

    const frame = await iframeEl.contentFrame();
    if (!frame) throw new Error('iframe contentFrame 접근 실패');

    log('  iframe 내부 대기...');
    await frame.waitForLoadState('domcontentloaded');
    await frame.waitForTimeout(2000);

    // 이메일 필드 (iframe 내부)
    const emailSelectors = [
      'input[type="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="이메일"]',
      'input[name="email"]',
      'input[name="Email"]',
      'input[id*="email" i]',
    ];
    let emailFilled = false;
    for (const sel of emailSelectors) {
      try {
        await frame.waitForSelector(sel, { timeout: 5000 });
        await frame.fill(sel, email);
        emailFilled = true;
        log(`  이메일 입력 완료 (${sel})`);
        break;
      } catch { /* 다음 selector 시도 */ }
    }
    if (!emailFilled) {
      // iframe 내부 input 목록 출력 (디버그)
      const iframeInputs = await frame.$$eval('input', els => els.map(e => ({
        type: e.type, name: e.name, placeholder: e.placeholder, id: e.id,
      }))).catch(() => []);
      log(`  iframe inputs: ${JSON.stringify(iframeInputs)}`);
      throw new Error('이메일 입력 필드를 찾을 수 없음 (iframe 내부)');
    }

    // 비밀번호 필드 (iframe 내부)
    const pwSelectors = [
      'input[type="password"]',
      'input[placeholder*="password" i]',
      'input[placeholder*="비밀번호"]',
      'input[name="password"]',
      'input[name="Password"]',
    ];
    let pwFilled = false;
    for (const sel of pwSelectors) {
      try {
        await frame.fill(sel, password, { timeout: 3000 });
        pwFilled = true;
        log(`  비밀번호 입력 완료 (${sel})`);
        break;
      } catch { /* 다음 selector 시도 */ }
    }
    if (!pwFilled) throw new Error('비밀번호 입력 필드를 찾을 수 없음 (iframe)');

    // ── [3] 제출 (iframe 내부) ───────────────────────────────────────────────
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'button:has-text("로그인")',
      'input[type="submit"]',
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        await frame.click(sel, { timeout: 3000 });
        submitted = true;
        log(`  제출 버튼 클릭 (${sel})`);
        break;
      } catch { /* 다음 selector 시도 */ }
    }
    if (!submitted) {
      await frame.keyboard.press('Enter');
      log('  Enter 키로 제출');
    }

    // ── [4] 로그인 완료 대기 ────────────────────────────────────────────────
    log('로그인 완료 대기...');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});

    const currentUrl = page.url();
    log(`  현재 URL: ${currentUrl}`);

    // 로그인 실패 감지
    if (currentUrl.includes('login')) {
      const errorText = await page.$eval('body', el => el.innerText.slice(0, 300)).catch(() => '');
      if (errorText.toLowerCase().includes('invalid') || errorText.toLowerCase().includes('error') ||
          errorText.includes('잘못된') || errorText.includes('오류')) {
        throw new Error(`로그인 실패: ${errorText.slice(0, 100)}`);
      }
      // 아직 login URL이지만 오류 메시지 없으면 계속 시도
      warn('로그인 후에도 login URL — 추가 대기');
      await page.waitForTimeout(3000);
    }

    // ── [5] hotelData 페이지 접속 ───────────────────────────────────────────
    log('호텔 데이터 페이지 접속...');
    await page.goto('https://partners.agoda.com/tools/hotelData', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    const hdUrl = page.url();
    log(`  현재 URL: ${hdUrl}`);

    if (hdUrl.includes('login')) {
      throw new Error('hotelData 페이지 접속 실패 — 로그인 상태가 아님');
    }

    // ── [6] 다운로드 URL 추출 ───────────────────────────────────────────────
    log('다운로드 URL 추출 중...');
    const pageContent = await page.content();

    // 패턴 1: xml.agoda.com ZIP URL
    const zipPatterns = [
      /https?:\/\/xml\.agoda\.com\/hoteldatafiles\/[^\s"'<>]+\.zip[^\s"'<>]*/,
      /https?:\/\/xml\.agoda\.com\/[^\s"'<>]+\.zip[^\s"'<>]*/,
      /https?:\/\/[^\s"'<>]+hoteldatafiles[^\s"'<>]+\.zip[^\s"'<>]*/,
    ];

    let downloadUrl = null;
    for (const pat of zipPatterns) {
      const m = pageContent.match(pat);
      if (m) { downloadUrl = m[0]; break; }
    }

    // 패턴 2: 링크 href에서 추출
    if (!downloadUrl) {
      const links = await page.$$eval('a[href]', els =>
        els.map(el => el.href).filter(h => h.includes('.zip') || h.includes('hoteldata') || h.includes('hotel-data'))
      );
      if (links.length > 0) {
        downloadUrl = links[0];
        log(`  링크에서 URL 발견: ${links.length}개`);
      }
    }

    // 패턴 3: 다운로드 버튼 클릭하여 네트워크 요청 캡처
    if (!downloadUrl) {
      log('  다운로드 버튼 클릭으로 URL 캡처 시도...');
      const downloadPromise = page.waitForRequest(req =>
        req.url().includes('.zip') || req.url().includes('hoteldata'),
        { timeout: 10000 }
      ).catch(() => null);

      // "Download" 버튼 클릭 시도
      const dlSelectors = ['button:has-text("Download")', 'a:has-text("Download")', 'button:has-text("다운로드")', 'a[download]'];
      for (const sel of dlSelectors) {
        try {
          await page.click(sel, { timeout: 2000 });
          break;
        } catch { /* 다음 시도 */ }
      }

      const capturedReq = await downloadPromise;
      if (capturedReq) {
        downloadUrl = capturedReq.url();
        log(`  네트워크 캡처로 URL 발견`);
      }
    }

    if (!downloadUrl) {
      // 페이지 스냅샷 (디버그용)
      const bodyText = await page.$eval('body', el => el.innerText.slice(0, 500)).catch(() => '');
      warn(`URL 추출 실패. 페이지 내용:\n${bodyText}`);
      throw new Error('hoteldata 다운로드 URL을 찾을 수 없음');
    }

    log(`✅ URL 발견: ${downloadUrl.slice(0, 80)}...`);

    if (DRY_RUN) {
      log('[dry-run] .env.local 갱신 건너뜀');
      log(`[dry-run] URL: ${downloadUrl}`);
    } else {
      updateEnvLocal('AGODA_HOTELDATA_URL', downloadUrl);
      // process.env도 갱신 (같은 프로세스 내 재사용 시)
      process.env.AGODA_HOTELDATA_URL = downloadUrl;
    }

    await browser.close();
    log('완료');
    process.exit(0);

  } catch (e) {
    err(`실패: ${e.message}`);
    // 스크린샷 저장 (디버그용)
    try {
      const dir = path.join(ROOT, '.tmp');
      fs.mkdirSync(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, 'partner-login-error.png') });
      log(`스크린샷 저장: .tmp/partner-login-error.png`);
    } catch { /* ignore */ }
    await browser.close();
    process.exit(1);
  }
})();
