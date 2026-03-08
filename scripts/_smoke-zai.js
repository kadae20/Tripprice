#!/usr/bin/env node
/**
 * _smoke-zai.js
 * Z.ai 단독 호출 스모크 테스트 (1회, 짧은 요청).
 *
 * 사용법:
 *   node scripts/_run-with-env.js scripts/_smoke-zai.js
 *
 * 성공: 응답 본문 길이 200~400자 확인 후 exit(0)
 * 실패: 원인 출력 후 exit(1)
 */
'use strict';

const { chat } = require('../lib/zai-client');

(async () => {
  console.log('Z.ai 스모크 테스트 시작...');
  console.log(`  모델: ${process.env.ZAI_MODEL || 'glm-4.7-flashx'}`);
  console.log(`  키 존재: ${process.env.ZAI_API_KEY ? 'YES' : 'NO'}`);

  if (!process.env.ZAI_API_KEY) {
    console.error('FAIL: ZAI_API_KEY 환경변수 없음');
    process.exit(1);
  }

  const started = Date.now();
  try {
    const result = await chat(
      [{ role: 'user', content: '서울 호텔 한 줄 소개를 한국어로 작성해 주세요. (200자 내외)' }],
      { max_tokens: 300, temperature: 0.5, retries: 1, timeoutMs: 20000 }
    );
    const elapsed = Date.now() - started;
    const len = (result || '').length;

    if (len >= 50) {
      console.log(`OK: 응답 수신 (${len}자, ${elapsed}ms)`);
      process.exit(0);
    } else {
      console.error(`FAIL: 응답이 너무 짧음 (${len}자)`);
      process.exit(1);
    }
  } catch (err) {
    const elapsed = Date.now() - started;
    console.error(`FAIL: ${err.message} (${elapsed}ms)`);
    console.error('  → ZAI_API_KEY 유효성, open.bigmodel.cn 네트워크 접근 확인 필요');
    process.exit(1);
  }
})();
