# Skill: process-images

## 역할
수집된 원본 이미지를 최적화하고, alt 텍스트를 생성하여 WordPress 업로드 준비를 완료한다.

## 호출 방식
수동 호출 — 이미지 수집 후, wp-publish-draft 전에 실행.

## 허용 도구
- 파일 읽기/쓰기 (assets/)
- 스크립트 실행 (scripts/process-images.js — 작성 후 연결)
- 네트워크 (WordPress 미디어 API 업로드)

## 처리 파이프라인

### 1단계: 입력 확인
- assets/raw/[hotel_id]/ 폴더에서 원본 이미지 목록 확인
- 소스 출처 및 라이선스 메타데이터 확인
- 정책 위반 이미지 → 즉시 제외 (image-policy-and-processing.md 참고)

### 2단계: 최적화
```
대표 이미지: 1200×630px, WebP, 최대 200KB
본문 이미지: 최대 너비 1080px, WebP, 최대 200KB
처리 결과: assets/processed/[hotel_id]/
```

### 3단계: 워터마크 (조건부)
- 파트너 정책 허용 확인 후에만 적용
- 우하단, 크기 이미지 너비 10% 이하
- 불명확한 경우: 적용 생략, 자체 제작 대표 이미지 사용

### 4단계: alt 텍스트 생성
- 형식: "[호텔명] [장소/시설 특징] [위치]"
- 예: "더 플라자 서울 로비 전경 시청역 인근"
- 금지: 호텔명 반복, "이미지", "사진" 단어 사용
- 파일: assets/processed/[hotel_id]/alt-texts.json

### 5단계: WordPress 업로드
- 미디어 라이브러리에 호텔 ID 태그
- 업로드 완료 후 media_id 기록
- 결과: assets/processed/[hotel_id]/upload-result.json

## 출력 요약
```json
{
  "hotel_id": "...",
  "processed_count": 5,
  "featured_image_id": 456,
  "media_ids": [456, 457, 458, 459, 460],
  "alt_texts": { "456": "...", "457": "..." }
}
```

## 품질 게이트
- 대표 이미지 없으면 발행 진행 불가
- alt 텍스트 없는 이미지 발행 금지
- 라이선스 확인 안 된 이미지 발행 금지
