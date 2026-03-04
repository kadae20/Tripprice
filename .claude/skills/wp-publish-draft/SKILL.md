# Skill: wp-publish-draft

## 역할
최종 검토된 글을 WordPress에 Draft 상태로 발행한다.
사람이 검토 후 수동으로 Publish하는 것이 기본값.

## 호출 방식
수동 호출 — insert-affiliate-cta 완료 + 편집장 최종 확인 후 실행.

## 허용 도구
- 파일 읽기
- 네트워크 (WordPress REST API 호출)
- 환경변수 읽기 전용

## 필수 환경변수 (파일 저장 금지)
```
WP_SITE_URL     # 예: https://tripprice.com
WP_USERNAME     # WP 계정명
WP_APP_PASSWORD # WP Application Password (대시 포함)
```

## 입력
- state/campaigns/[slug]-with-cta.md (최종 초안)
- wordpress/wp-post-schema.json (필드 스키마)

## 발행 프로세스

1. 초안 파일에서 메타 필드 파싱 (title, slug, meta, excerpt 등)
2. 본문 Markdown → HTML 변환
3. WordPress REST API POST 요청
   - endpoint: `$WP_SITE_URL/wp-json/wp/v2/posts`
   - status: **"draft"** (publish 절대 금지)
   - lang 필드 포함 (다국어 플러그인 연동)
4. 업로드된 이미지 ID 연결 (featured_media)
5. 발행 결과(post_id, edit_url) 기록

## 출력
state/campaigns/[slug]-published.json
```json
{
  "post_id": 1234,
  "status": "draft",
  "edit_url": "https://tripprice.com/wp-admin/post.php?post=1234&action=edit",
  "published_at": "2025-01-01T00:00:00Z"
}
```

## 금지
- status: "publish" 직접 전송
- API 키/비밀번호를 파일/로그에 출력
- 검토 미완료 글 자동 발행

## 대안: WP-CLI 방식
스크립트 기반 발행은 scripts/ 폴더에 추가 예정.
