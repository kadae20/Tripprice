# Hook: PostToolUse

## 목적
도구 실행 후 결과를 가볍게 검증하고, 다음 단계를 안내한다.

## 실행 파일
.claude/hooks/scripts/post-tool-use.sh (필요 시 구현)

## 검증 항목

### 파일 생성/수정 후
- state/campaigns/[slug]-draft.md 생성 완료 시
  → "다음 단계: seo-review 실행 권장" 안내
- state/campaigns/[slug]-published.json 생성 완료 시
  → "WordPress Draft 발행 완료. 편집장 검토 후 Publish하세요." 안내

### WordPress API 호출 후
- 응답 status 확인
  - draft: 정상 → post_id/edit_url 기록 확인
  - publish: 경고 출력 (자동 발행은 정책 위반)
  - 오류: 오류 내용 기록

### 이미지 업로드 후
- alt 텍스트 포함 여부 확인
- 미포함 시 경고

## 안내 메시지 형식
```
✅ [PostToolUse]
완료: [작업 내용]
다음 단계: [권장 다음 액션]
```

## 주의사항
- 무거운 검증 작업 금지
- 오류 감지 시 로그만 남기고 작업 중단은 사용자 판단에 맡김
