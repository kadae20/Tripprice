# Rule: 다국어 품질 기준

## 운영 언어
- `/ko/` — 한국어 (기본)
- `/en/` — 영어
- `/ja/` — 일본어

## 번역 품질 기준

### 허용
- 현지 편집자 검토를 거친 번역
- 현지 독자 관점에서 재작성된 현지화 콘텐츠
- 동일 주제라도 현지 페르소나/동선/가격 기준이 반영된 버전

### 금지
- 단순 기계번역(Google Translate/DeepL) 그대로 발행
- 번역본이 원본의 단순 복사본인 경우 (다른 URL에 중복 발행)
- 현지 문화/여행 맥락 무시한 직역

## hreflang 요구사항

모든 다국어 글은 반드시 hreflang 태그 포함:

```html
<link rel="alternate" hreflang="ko" href="https://tripprice.com/ko/[slug]" />
<link rel="alternate" hreflang="en" href="https://tripprice.com/en/[slug]" />
<link rel="alternate" hreflang="ja" href="https://tripprice.com/ja/[slug]" />
<link rel="alternate" hreflang="x-default" href="https://tripprice.com/ko/[slug]" />
```

## canonical 규칙

- 각 언어 페이지의 canonical은 자기 자신 URL을 가리킴
- 번역본이 원본보다 품질이 낮으면 발행 전 현지화 편집 필수
- 파라미터 URL(예: ?lang=en)은 사용 금지, 서브디렉토리 구조 유지

## 현지화 콘텐츠 차이 기준

번역이 아닌 "현지화"가 되려면:
- 현지 독자가 실제로 쓸 법한 교통/동선 표현 사용
- 현지 여행 시즌/가격대 기준 반영
- 현지 독자가 궁금해할 FAQ로 교체
- 현지 검색 의도 키워드로 재최적화

## 발행 전 확인 체크리스트

- [ ] hreflang 태그 삽입 완료
- [ ] canonical URL 자기 자신 가리킴
- [ ] 기계번역 수준이 아닌 편집 완료
- [ ] 현지 키워드로 SEO title/meta 재작성
- [ ] 다른 언어 버전과 내부 링크로 연결
