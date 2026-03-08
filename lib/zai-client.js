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
// EC2→중국 API 구간 지연 감안: 기본 30초 (env로 확장 가능)
const TIMEOUT_MS  = Math.min(parseInt(process.env.ZAI_TIMEOUT_MS         || '30000', 10), 120_000);
const MAX_RETRIES = Math.min(parseInt(process.env.ZAI_MAX_RETRIES         || '1', 10), 4);

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

  const hotelList = hotels.map(h => {
    const name     = h.hotel_name_ko || h.hotel_name || h.hotel_id;
    const pros     = (h.pros || []).slice(0, 3).join(', ') || '정보없음';
    const cons     = (h.cons || []).slice(0, 3).join(', ') || '정보없음';
    const location = h.location_summary || h.address || '정보없음';
    const price    = h.price_range      || (h.price_min ? `${Math.round(h.price_min / 10000)}만원~` : '정보없음');
    return `- **${name}**: 장점(${pros}), 단점(${cons}), 위치(${location}), 가격대(${price})`;
  }).join('\n');

  const criteriaText = selection_criteria.join(', ') || '위치, 가격, 시설, 리뷰';
  const personaText  = target_persona || '서울 호텔을 검토 중인 여행자';
  const title        = suggested_title || `서울 호텔 추천 ${new Date().getFullYear()}`;
  const type         = post_type || 'hotel-comparison';

  const systemPrompt = [
    '당신은 한국어 여행 콘텐츠 에디터입니다.',
    '독자에게 실질적인 선택 기준과 균형 잡힌 호텔 분석을 제공하는 의사결정형 글을 씁니다.',
    '광고·홍보 문체 금지. 장점과 단점 모두 서술. 사실 기반. 자연스러운 구어체 한국어.',
    'front-matter(---) 없이 마크다운 본문만 출력.',
  ].join('\n');

  const userPrompt = [
    `다음 브리프를 바탕으로 호텔 비교/추천 글 본문을 한국어 마크다운으로 작성하세요.`,
    ``,
    `제목: ${title}`,
    `타겟 독자: ${personaText}`,
    `선택 기준: ${criteriaText}`,
    `글 유형: ${type}`,
    ``,
    `## 호텔 목록`,
    hotelList,
    ``,
    `## 요구사항`,
    `- 총 1800~2200자 (한국어 기준)`,
    `- H1(# )으로 시작: 이 제목 그대로 → "${title}"`,
    `- 필수 H2 섹션 (## ):`,
    `  1. 빠른 결론 요약 (선택 기준 3줄 요약)`,
    `  2. 이 글이 필요한 사람 (타겟 독자 명시)`,
    `  3. 선택 기준`,
    `  4. 호텔별 분석 (H3으로 "### [호텔명] — [한 줄 포지셔닝]", 추천대상/장점/단점/위치·동선/주의점)`,
    `  5. 자주 묻는 질문 (3개 이상, **Q:** / **A:** 형식)`,
    `- 각 호텔 섹션 끝에 CTA: "[호텔명] 현재 가격 확인하기 →"`,
    `- 글 상단 또는 첫 CTA 앞 제휴 고지: "이 글에는 아고다 파트너 링크가 포함되어 있습니다."`,
    `- 글 하단 면책 문구 필수: "가격·혜택·환불 규정은 시기에 따라 변동될 수 있으며, 최종 조건은 예약 페이지에서 직접 확인하시기 바랍니다."`,
    `- 키워드 반복 남발 금지. 동일 키워드 최대 2회.`,
    `- front-matter(---) 없이 본문만 출력.`,
  ].join('\n');

  return await chat([
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt },
  ]);
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
