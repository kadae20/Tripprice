'use strict';
/**
 * zai-client.js
 * Z.ai (ZhipuAI) OpenAI-compatible API 클라이언트.
 *
 * Env:
 *   ZAI_API_KEY            — 필수
 *   ZAI_MODEL              — 기본: glm-4.7-flashx
 *   ZAI_BASE_URL           — 기본: https://open.bigmodel.cn/api/paas/v4
 *   ZAI_MAX_OUTPUT_TOKENS  — 기본: 2500 (상한: 4096)
 *   ZAI_TIMEOUT_MS         — 기본: 60000 (상한: 120000)
 *   ZAI_MAX_RETRIES        — 기본: 2 (상한: 4)
 */

const https   = require('https');
const http    = require('http');
const { URL } = require('url');

const BASE_URL    = process.env.ZAI_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const MODEL       = process.env.ZAI_MODEL    || 'glm-4.7-flashx';

// 상한 클램프
const MAX_TOKENS  = Math.min(parseInt(process.env.ZAI_MAX_OUTPUT_TOKENS || '2500', 10), 4096);
// EC2→중국 API 구간 지연 감안: 기본 90초 (env로 확장 가능, 상한 120초)
const TIMEOUT_MS  = Math.min(parseInt(process.env.ZAI_TIMEOUT_MS         || '90000', 10), 120_000);
const MAX_RETRIES = Math.min(parseInt(process.env.ZAI_MAX_RETRIES         || '2', 10), 4);

// ── HTTP POST ─────────────────────────────────────────────────────────────────
function post(endpoint, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ZAI_API_KEY;
    if (!apiKey) return reject(new Error('ZAI_API_KEY 환경변수가 설정되지 않았습니다.'));

    const fullUrl = new URL(endpoint, BASE_URL.endsWith('/') ? BASE_URL : BASE_URL + '/chat/completions');
    // endpoint가 절대 경로(/chat/completions)이면 BASE_URL과 합쳐서 처리
    const targetUrl = endpoint.startsWith('/')
      ? new URL(BASE_URL.replace(/\/+$/, '') + endpoint)
      : fullUrl;

    const isHttps = targetUrl.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const payload = JSON.stringify(body);

    const options = {
      hostname: targetUrl.hostname,
      port:     targetUrl.port || (isHttps ? 443 : 80),
      path:     targetUrl.pathname + targetUrl.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Authorization':  `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 429) {
            const err = new Error(`Z.ai Rate Limit (429)`);
            err.retryAfter = parseInt(res.headers['retry-after'] || '5', 10);
            err.isRateLimit = true;
            return reject(err);
          }
          if (res.statusCode >= 400) {
            return reject(new Error(
              `Z.ai API 오류 ${res.statusCode}: ${parsed?.error?.message || JSON.stringify(parsed).slice(0, 200)}`
            ));
          }
          resolve(parsed);
        } catch {
          reject(new Error(`Z.ai 응답 파싱 실패: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs || TIMEOUT_MS, () => {
      req.destroy(new Error(`Z.ai 요청 타임아웃 (${timeoutMs || TIMEOUT_MS}ms)`));
    });
    req.write(payload);
    req.end();
  });
}

// ── chat (retry + exponential backoff) ───────────────────────────────────────
async function chat(messages, opts = {}) {
  const body = {
    model:       opts.model       || MODEL,
    messages,
    max_tokens:  Math.min(opts.max_tokens || MAX_TOKENS, 4096),
    temperature: opts.temperature ?? 0.7,
  };

  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const retries   = opts.retries   !== undefined ? Math.min(opts.retries, MAX_RETRIES) : MAX_RETRIES;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res     = await post('/chat/completions', body, timeoutMs);
      const content = res.choices?.[0]?.message?.content;
      if (!content) throw new Error('Z.ai 응답에 content 없음');
      return content;
    } catch (err) {
      lastErr = err;
      if (attempt >= retries) break;

      // Rate limit → retry-after 헤더 존재 시 해당 시간만큼 대기
      const baseDelay = err.isRateLimit
        ? (err.retryAfter || 5) * 1000
        : Math.min(1000 * Math.pow(2, attempt), 16_000);  // 지수 백오프 (최대 16초)

      const jitter = Math.floor(Math.random() * 500);
      const delay  = baseDelay + jitter;
      console.error(`  ⚠  Z.ai 재시도 ${attempt + 1}/${retries} — ${delay}ms 후 (${err.message.slice(0, 80)})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── generateHotelDraft ────────────────────────────────────────────────────────
/**
 * brief JSON → 한국어 호텔 비교/추천 마크다운 본문
 * Returns: markdown string starting with "# " (front-matter 미포함)
 */
async function generateHotelDraft(brief) {
  const { hotels = [], suggested_title, selection_criteria = [],
          target_persona, post_type } = brief;

  const { buildPartnerUrlFromHotel } = require('./agoda-link-builder');

  // 발행된 포스트 목록 로드 (내부링크 전용)
  let publishedPostsList = '(발행된 글 없음)';
  try {
    const postsIndexPath = require('path').join(__dirname, '..', 'state', 'published', 'posts-index.json');
    const idx = JSON.parse(require('fs').readFileSync(postsIndexPath, 'utf8'));
    const currentSlug = brief.slug || '';
    const available = (idx.posts || []).filter(p => !currentSlug || !p.slug.includes(currentSlug.split('-')[0]));
    if (available.length > 0) {
      publishedPostsList = available.map(p => `[${p.title}](${p.url})`).join(', ');
    }
  } catch { /* 파일 없으면 무시 */ }

  // 호텔 데이터: cta_url 추가 후 JSON 한 줄 압축
  const hotelsJson = JSON.stringify(
    hotels.map(h => ({ ...h, cta_url: h.partner_url || buildPartnerUrlFromHotel(h) || '' }))
  );

  const title        = suggested_title || `서울 호텔 추천 ${new Date().getFullYear()}`;
  const type         = post_type || 'hotel-comparison';
  const isComparison = type === 'hotel-comparison';
  const criteriaText = selection_criteria.join(', ') || '위치, 가격, 시설, 리뷰';
  const personaText  = target_persona || '서울 호텔을 검토 중인 여행자';

  const systemPrompt =
    '한국 여성 여행 블로거(30대, 10년차). 구어체 경어(~했어요/~이에요/~거든요/~더라고요). ' +
    '1인칭("솔직히 말씀드리면","제가 리뷰 200개를 읽어봤는데"). 단점 솔직히. ' +
    '근거없는 최고/최강 단정 금지. 수치로 뒷받침. front-matter 없이 마크다운만 출력.';

  const sections = isComparison
    ? '빠른결론요약/이글필요한사람/선택기준/한눈에비교(테이블:위치·가격대·평점·조식·추천대상)/호텔분석/FAQ'
    : '빠른결론요약/이글필요한사람/선택기준/호텔분석/FAQ';

  const userPrompt = [
    `제목:"${title}" 독자:${personaText} 기준:${criteriaText} 유형:${type}`,
    `호텔JSON:${hotelsJson}`,
    `발행글(내부링크 이 목록에서만):${publishedPostsList}`,
    ``,
    `[요구사항]`,
    `- 3500~5000자. H1=제목 그대로. H2순서: ${sections}`,
    `- 각호텔 H3 "### [호텔명] — [한줄포지셔닝]": 위치교통(역·도보분·공항이동)/가격대(만원~)/평점(X.X/10 N건)/주요시설/장점3개+(수치포함)/단점2개+/주변맛집카페(가게명·메뉴)/관광명소2곳+/여행코스1줄/지역팁1줄`,
    `- 각호텔 블록쿼트: > **추천:** ... / > **비추천:** ... / > **주의:** ...`,
    `- 각호텔 CTA: [호텔명 현재 가격 확인하기 →](cta_url) — JSON의 cta_url 그대로 사용`,
    `- FAQ 3개 이상(**Q.** / **A.**). 모든수치(평점·도보·가격) 본문필수등장.`,
    `- 글상단: "이 글에는 아고다 파트너 링크가 포함되어 있습니다."`,
    `- 글하단: "가격·혜택·환불 규정은 시기에 따라 변동될 수 있으며, 최종 조건은 예약 페이지에서 직접 확인하시기 바랍니다."`,
    `- 내부링크 2개 이상(발행글 목록에서만, 목록없는URL 금지). 글맨끝: META_DESC:{120~155자}`,
  ].join('\n');

  return await chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    { max_tokens: 6000, temperature: 0.65 }
  );
}

/**
 * 5초 내 ping 응답 여부만 확인 (파이프라인 사전 체크용).
 * @returns {Promise<boolean>}
 */
async function health() {
  try {
    await chat(
      [{ role: 'user', content: '답장: OK' }],
      { max_tokens: 10, temperature: 0, retries: 0, timeoutMs: 8000 }
    );
    return true;
  } catch {
    return false;
  }
}

module.exports = { chat, generateHotelDraft, health };
