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

  const CID = process.env.AGODA_CID || '1926938';

  // ── 장점 사전 계산 (실제 필드 기반) ──────────────────────────────────────
  function buildPros(h) {
    const p = [];
    if (h.review_score >= 8.5) p.push(`아고다 평점 ${h.review_score}/10 — 투숙객 만족도 높음`);
    if (h.station_walk_min && h.station_walk_min <= 5) p.push(`${h.nearest_station} 도보 ${h.station_walk_min}분 — 교통 최적`);
    if ((h.amenities || []).some(a => a.includes('수영장'))) p.push('수영장 보유');
    if ((h.amenities || []).some(a => a.includes('스파'))) p.push('스파·웰니스 완비');
    if (h.star_rating >= 5) p.push('5성급 서비스 수준');
    if ((h.amenities || []).some(a => a.includes('조식'))) p.push('조식 옵션 있음');
    if (p.length < 2) p.push('주요 시설은 공식 페이지 확인 권장');
    return p.slice(0, 4);
  }

  // ── 단점 사전 계산 (실제 필드 기반) ──────────────────────────────────────
  function buildCons(h) {
    const c = [];
    const KRW = n => `${Math.round(n / 10000)}만원`;
    if (h.price_min >= 300000) c.push(`가격 부담: 1박 ${KRW(h.price_min)} 이상`);
    if (h.station_walk_min > 10) c.push(`${h.nearest_station}까지 도보 ${h.station_walk_min}분 — 접근성 다소 불리`);
    if ((h.amenities || []).length < 4) c.push('상세 시설 정보가 제한적');
    if (!h.transport_info && !h.location_description) c.push('주변 동선 직접 확인 필요');
    if (c.length < 1) c.push('단점 정보 추후 업데이트 예정');
    return c.slice(0, 3);
  }

  // ── 호텔 데이터 블록 생성 ─────────────────────────────────────────────────
  const hotelList = hotels.map(h => {
    const name    = h.hotel_name || h.hotel_name_en || h.hotel_id;
    const agodaId = h.agoda_hotel_id || '';
    const ctaUrl  = h.partner_url ||
      (agodaId
        ? `https://www.agoda.com/hotel/${agodaId}?cid=${CID}&tag=${h.hotel_id || agodaId}`
        : `https://www.agoda.com/?cid=${CID}`);

    const pros = buildPros(h);
    const cons = buildCons(h);

    const priceMin = h.price_min ? `${Math.round(h.price_min / 10000)}만원` : '정보없음';
    const priceMax = h.price_max ? `${Math.round(h.price_max / 10000)}만원` : '';
    const priceStr = priceMax ? `${priceMin}~${priceMax}` : `${priceMin}~`;

    const scoreStr = h.review_score
      ? `${h.review_score}/10 (${(h.review_count || 0).toLocaleString()}건)`
      : '정보없음';

    const lines = [
      `### ${name}${h.star_rating ? ` (${h.star_rating}성급${h.chain_name ? ', ' + h.chain_name : ''})` : ''}`,
      `- 위치: ${h.nearest_station ? `${h.nearest_station} 도보 ${h.station_walk_min}분` : '정보없음'} [${h.district || h.city || ''}]`,
      `- 가격대: ${priceStr}`,
      `- 아고다 평점: ${scoreStr}`,
    ];

    if (h.checkin_time || h.checkout_time) {
      lines.push(`- 체크인/아웃: ${h.checkin_time || '?'} / ${h.checkout_time || '?'}`);
    }
    if ((h.amenities || []).length > 0) {
      lines.push(`- 주요 시설: ${h.amenities.slice(0, 6).join(', ')}`);
    }
    if (h.yearopened || h.numberrooms) {
      const meta = [];
      if (h.yearopened)  meta.push(`개관: ${h.yearopened}년`);
      if (h.numberrooms) meta.push(`객실수: ${h.numberrooms}개`);
      lines.push(`- ${meta.join(' / ')}`);
    }
    if (h.overview) {
      lines.push(`- 소개: ${h.overview.slice(0, 120).trim()}`);
    }
    if (h.transport_info) {
      lines.push(`- 교통 정보: ${h.transport_info.slice(0, 100).trim()}`);
    } else if (h.location_description) {
      lines.push(`- 위치 설명: ${h.location_description.slice(0, 100).trim()}`);
    }
    if (h.review_summary) {
      lines.push(`- 후기 요약: ${h.review_summary}`);
    }
    lines.push(`- 장점(데이터기반): ${pros.join(' | ')}`);
    lines.push(`- 주의/단점: ${cons.join(' | ')}`);
    lines.push(`- CTA_URL: ${ctaUrl}`);

    return lines.join('\n');
  }).join('\n\n');

  const criteriaText = selection_criteria.join(', ') || '위치, 가격, 시설, 리뷰';
  const personaText  = target_persona || '서울 호텔을 검토 중인 여행자';
  const title        = suggested_title || `서울 호텔 추천 ${new Date().getFullYear()}`;
  const type         = post_type || 'hotel-comparison';

  const systemPrompt = [
    '당신은 10년 경력의 한국 여성 여행 블로거입니다. 직접 발로 뛰며 검증한 정보를 독자 친구에게 솔직하게 알려주듯 씁니다.',
    '',
    '## 페르소나',
    '- 30대 초반 여성, 서울 거주, 연 10회 이상 국내외 여행',
    '- 블로그 운영 10년차, 제휴 수익보다 독자 신뢰를 우선시함',
    '- 직접 경험 또는 수백 건의 실제 후기를 꼼꼼히 읽고 정리한 글임을 자연스럽게 드러냄',
    '',
    '## 말투 원칙 (필수)',
    '- 구어체 경어: "~했어요", "~이에요", "~거든요", "~더라고요", "~하더라구요"',
    '- 1인칭 감각 표현: "솔직히 말씀드리면", "제가 리뷰 200개를 읽어봤는데", "직접 가보신 분들 후기 보면"',
    '- 공감·감탄 표현 자연스럽게: "이건 진짜 꿀팁인데요", "생각보다 괜찮더라고요", "이 부분은 좀 아쉬웠어요"',
    '- 단점도 친구처럼 솔직하게: "근데 솔직히 이 가격대면 아쉬운 점도 있어요"',
    '- AI 투·번역 투·광고 투·격식체("~합니다") 절대 금지',
    '',
    '## 데이터 활용',
    '- 평점/가격/도보 거리 등 수치는 문장에 자연스럽게 녹임 ("아고다 후기 976건에서 9.1점이에요")',
    '- "아고다 리뷰 기준", "공개된 후기 취합 기준" 명시로 신뢰성 확보',
    '- 근거 없는 "최고", "가성비 최강" 단정 금지. 수치로 뒷받침.',
    '- front-matter(---) 없이 마크다운 본문만 출력.',
  ].join('\n');

  const isComparison = type === 'hotel-comparison';
  const userPrompt = [
    `다음 브리프를 바탕으로 호텔 비교/추천 글 본문을 한국어 마크다운으로 작성하세요. 반드시 여성 블로거 페르소나와 말투("~했어요", "~이에요" 등 구어체 경어)를 유지하세요.`,
    ``,
    `제목: ${title}`,
    `타겟 독자: ${personaText}`,
    `선택 기준: ${criteriaText}`,
    `글 유형: ${type}`,
    ``,
    `## 호텔 데이터`,
    hotelList,
    ``,
    `## 요구사항`,
    `- 총 3500~5000자 (한국어 기준) — 주변 명소/맛집 섹션으로 실질적 정보 제공`,
    `- H1(# )으로 시작: 이 제목 그대로 → "${title}"`,
    `- 필수 H2 섹션 순서 (## ):`,
    `  1. 빠른 결론 요약`,
    `  2. 이 글이 필요한 사람`,
    `  3. 선택 기준`,
    isComparison ? `  4. 한눈에 비교 (마크다운 테이블: 위치/가격대/평점/조식/추천대상)` : '',
    `  ${isComparison ? 5 : 4}. 호텔 분석 (부모 H2) → 각 호텔은 H3 "### [호텔명] — [한 줄 포지셔닝]"`,
    `  ${isComparison ? 6 : 5}. 자주 묻는 질문 (FAQ 3개 이상 필수, **Q.** / **A.** 형식)`,
    `- 각 호텔 H3 섹션에 반드시 포함:`,
    `  · 위치+교통 (역명, 도보 N분, 버스/지하철 환승 방법, 공항에서 이동 시간)`,
    `  · 가격대 (X만원~ 형식, 실수치 사용)`,
    `  · 아고다 평점 (X.X/10, N건 기준)`,
    `  · 주요 시설 목록`,
    `  · 장점 3개 이상 (데이터 수치 포함)`,
    `  · 단점/주의 2개 이상`,
    `  · 호텔 주변 즐길거리 & 동선 (필수):`,
    `    - 도보 10~15분 내 맛집/카페 2~3곳 (구체적 가게명·메뉴 언급)`,
    `    - 근처 관광 명소/랜드마크 2곳 이상`,
    `    - 쇼핑·야경·액티비티 등 여행 코스 1줄 추천`,
    `    - 해당 지역 특색 있는 한 줄 팁 (예: "홍대는 주말 밤 버스킹 명소")`,
    `  · 추천/비추천/주의 블록쿼트:`,
    `    > **추천:** [이런 여행자에게 맞음 — 1줄]`,
    `    > **비추천:** [이런 경우 맞지 않음 — 1줄]`,
    `    > **주의:** [예약·투숙 시 주의사항 — 1줄]`,
    `  · CTA 링크: "[호텔명 현재 가격 확인하기 →](CTA_URL)" — 호텔 데이터의 CTA_URL 그대로 사용`,
    `- FAQ는 호텔별 구체적 질문 포함 (역명·가격·시설·주변 맛집 등 실제 데이터 활용)`,
    `- 호텔 데이터의 모든 수치(평점, 도보분, 가격)는 본문에 반드시 등장해야 함`,
    `- 글 상단 또는 첫 CTA 앞: "이 글에는 아고다 파트너 링크가 포함되어 있습니다."`,
    `- 글 하단 면책 문구: "가격·혜택·환불 규정은 시기에 따라 변동될 수 있으며, 최종 조건은 예약 페이지에서 직접 확인하시기 바랍니다."`,
    `- 내부링크 2개 이상 자연스럽게 삽입: [관련 글 제목](/ko/related-slug) 형식`,
    `- 글 맨 끝에: META_DESC: {120~155자 meta description}`,
    `- 사실·데이터 기반 서술. 근거 없는 "최고", "가성비 최강" 단정 금지.`,
    `- 키워드 반복 남발 금지. 동일 키워드 최대 2회.`,
    `- front-matter(---) 없이 본문만 출력.`,
  ].filter(l => l !== '').join('\n');

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
