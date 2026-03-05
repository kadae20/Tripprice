# SEO QA 리포트

- **초안 파일:** `draft-seoul-luxury-comparison-2026-03-05.md`
- **슬러그:** `seoul-luxury-comparison`
- **점검 일시:** 2026-03-05
- **발행 가능:** ✅ 가능

---

## 점검 결과

| 상태 | 항목 | 결과 |
|------|------|------|
| ✅ PASS | SEO title 존재 | "서울 럭셔리 호텔 비교 추천" |
| ⚠️ WARN | SEO title 길이 (≤60자) | 15자 — 너무 짧을 수 있습니다 |
| ✅ PASS | slug 존재 | "seoul-luxury-comparison" |
| ✅ PASS | slug 형식 (소문자-하이픈) | 3단어 |
| ✅ PASS | meta_description 존재 | 존재 |
| ⚠️ WARN | meta_description 길이 (120~155자) | 58자 — 120자 이상 권장 |
| ✅ PASS | H1 정확히 1개 | 1개 |
| ✅ PASS | H2 최소 3개 | 8개 |
| ✅ PASS | "이 글이 필요한 사람" 섹션 | 존재 |
| ✅ PASS | "선택 기준" 섹션 | 존재 |
| ✅ PASS | FAQ 섹션 | 3개 항목 |
| ✅ PASS | CTA 존재 (≥1, ≤4개) | 2개 |
| ✅ PASS | 내부 링크 제안 (≥2개) | 3개 |
| ✅ PASS | 가격 변동 고지 문구 | 존재 |
| ✅ PASS | 제휴 링크 고지 문구 | 존재 |
| ✅ PASS | lang 필드 선언 | ko |

---

## 요약

| 구분 | 건수 |
|------|------|
| ✅ PASS | 14 |
| ⚠️ WARN | 2 |
| ❌ FAIL | 0 |
| ⏭️ SKIP | 0 |
| 합계 | 16 |

**발행 가능 여부:** ✅ 발행 가능

### WARN 항목 목록
- **SEO title 길이 (≤60자):** 15자 — 너무 짧을 수 있습니다
- **meta_description 길이 (120~155자):** 58자 — 120자 이상 권장

---

*다음 단계:*
```
node scripts/build-wp-post.js --draft=draft-seoul-luxury-comparison-2026-03-05
```