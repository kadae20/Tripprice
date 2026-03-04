# Skill: insert-affiliate-cta

## 역할
완성된 초안에 제휴 CTA 블록을 자연스럽게 삽입한다.

## 호출 방식
수동 호출 — humanize-copy 완료 후 실행.

## 허용 도구
- 파일 읽기/쓰기

## 입력
- state/campaigns/[slug]-draft.md
- 호텔별 아고다 제휴 링크 목록

## CTA 삽입 위치 규칙

1. 각 호텔 분석 섹션 끝 (호텔당 1개)
2. 비교 결론 섹션 후 (1개)
3. 글 하단 최종 CTA (1개)
4. 총 최대 4개 초과 금지

## CTA 형식

```markdown
> **[호텔명] 현재 가격 확인하기 →**
> [아고다 링크 | UTM 포함]
```

또는 버튼형 블록:
```html
<div class="cta-block">
  <a href="[affiliate_url]" rel="sponsored noopener" target="_blank">
    아고다에서 [호텔명] 가격 확인
  </a>
</div>
```

## 필수 삽입 요소

- 글 상단 또는 첫 CTA 앞: 제휴 고지 문구
  > "이 글에는 아고다 파트너 링크가 포함되어 있습니다."
- 글 하단: 가격 변동 고지 문구

## 금지
- 글 첫 문단에 CTA 배치
- 본문 중간 맥락 없이 링크 삽입
- rel="sponsored" 없이 제휴 링크 사용
- UTM 파라미터 없는 링크 삽입

## 출력
- state/campaigns/[slug]-with-cta.md
- wp-post-schema.json의 affiliate_links 필드 업데이트
