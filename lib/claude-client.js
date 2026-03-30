'use strict';
/**
 * lib/claude-client.js
 *
 * Anthropic Claude API 클라이언트.
 * lib/zai-client.js와 동일한 인터페이스(generateHotelDraft, health)를 구현.
 *
 * Env:
 *   ANTHROPIC_API_KEY  — 필수 (sk-ant-api03-...)
 *   CLAUDE_MODEL       — 기본: claude-sonnet-4-6
 *   CLAUDE_MAX_TOKENS  — 기본: 6000 (상한: 8192)
 *   CLAUDE_TIMEOUT_MS  — 기본: 90000
 */

const https   = require('https');
const { URL } = require('url');

const API_KEY    = process.env.ANTHROPIC_API_KEY || '';
const MODEL      = process.env.CLAUDE_MODEL        || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = Math.min(parseInt(process.env.CLAUDE_MAX_TOKENS || '8000', 10), 8192);
const TIMEOUT_MS = Math.min(parseInt(process.env.CLAUDE_TIMEOUT_MS || '120000', 10), 180_000);

// ── HTTP POST ─────────────────────────────────────────────────────────────────
function post(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'x-api-key':         API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'content-length':    Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            return reject(new Error(
              `Claude API 오류 ${res.statusCode}: ${parsed?.error?.message || data.slice(0, 200)}`
            ));
          }
          resolve(parsed);
        } catch {
          reject(new Error(`Claude 응답 파싱 실패: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs || TIMEOUT_MS, () => {
      req.destroy(new Error(`Claude 요청 타임아웃 (${timeoutMs || TIMEOUT_MS}ms)`));
    });
    req.write(payload);
    req.end();
  });
}

// ── generateHotelDraft ────────────────────────────────────────────────────────
/**
 * brief JSON → 한국어 호텔 비교/추천 마크다운 본문
 * (zai-client.js의 generateHotelDraft와 동일한 인터페이스)
 * Returns: markdown string starting with "# " (front-matter 미포함)
 */
async function generateHotelDraft(brief) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');

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

  const hotelsJson = JSON.stringify(
    hotels.map(h => ({ ...h, cta_url: buildPartnerUrlFromHotel(h) || h.partner_url || '' }))
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

  const res = await post({
    model:      MODEL,
    max_tokens: MAX_TOKENS,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: userPrompt }],
  });

  const content = res.content?.[0]?.text;
  if (!content) throw new Error('Claude 응답에 content 없음');
  return content;
}

/**
 * @returns {Promise<boolean>}
 */
async function health() {
  try {
    const res = await post({
      model:      MODEL,
      max_tokens: 10,
      messages:   [{ role: 'user', content: '답장: OK' }],
    }, 8000);
    return !!(res.content?.[0]?.text);
  } catch {
    return false;
  }
}

module.exports = { generateHotelDraft, health };
