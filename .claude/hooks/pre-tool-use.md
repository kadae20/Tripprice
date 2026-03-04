# Hook: PreToolUse

## 목적
파일 생성/수정 전 구조 적합성을 가볍게 검사한다.

## 실행 파일
.claude/hooks/scripts/pre-tool-use.sh (필요 시 구현)

## 검사 항목 (가벼운 수준)

### 파일 생성 시
- state/campaigns/ 외부에 임시 초안 파일 생성 시 경고
- API 키 패턴 감지 시 즉시 차단
  - 패턴: `sk-`, `AIza`, `Bearer `, `password=` 등

### 파일 수정 시
- .claude/rules/, .claude/skills/, .claude/agents/ 수정 시
  → "규칙/스킬/에이전트 변경은 chief-editor 승인 후 권장" 경고 출력

### 네트워크 요청 시
- WordPress API: status="publish" 포함된 페이로드 감지 시 차단
- 환경변수 없이 API 키 하드코딩 감지 시 차단

## 차단 메시지 형식
```
🚫 [PreToolUse 차단]
이유: [차단 이유]
권장 조치: [대안]
```

## 주의사항
- 과도한 검사로 워크플로우 방해 금지
- 명백한 위반만 차단, 나머지는 경고로 처리
