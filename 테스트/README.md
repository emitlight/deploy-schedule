# 테스트

의존성 없이 Node 로 바로 실행합니다. 코드를 고친 뒤 돌려 보세요.

```bash
cd "C:/Users/Security365/Documents/start-claude-projects/배포지원 일정관리"
node 테스트/_test_toggle.mjs      # 추가 인원 공유 설정 (서버)
node 테스트/_test_toggle_ui.mjs   # 추가 인원 버튼 동작 (화면)
node 테스트/_test_bugfix_1019.mjs # 10/19 결함 수정 (보안·배정 취소·통계 등)
```

| 파일 | 확인 내용 |
|---|---|
| `_test_toggle.mjs` | 공유 설정 저장·조회, KV 미연결 시 폴백, KV 손상 시 서비스 지속 |
| `_test_toggle_ui.mjs` | 버튼 클릭 → 서버 저장 → 라벨·인원수 갱신, 다른 PC 동기화, 미연결 안내 |
| `_test_bugfix_1019.mjs` | 외부 문자열 이스케이프(XSS), 티켓·추첨 상태 누수, 여러 날 배정 취소·하루 삭제, 공유 분류 표시, 수정 시 정보 보존, 서버 날짜 사용·중복 생성 방지, 조회 실패 멤버 제외, 통계 집계 기준 |
