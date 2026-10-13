# 배포지원 인력 투입관리 시스템 — Claude 컨텍스트

> 이 파일은 Claude가 이 폴더를 열 때 자동으로 읽는 프로젝트 메모리입니다.
> **최종 코드 검증일: 2026-10-13** · 코드를 바꾸면 이 파일도 같이 고칠 것.

---

## ⚠️ Claude 행동 규칙 (반드시 준수)

> 2026-06-09 담당자 지적 사항 — 동일 실수 절대 반복 금지

1. **계획 설명 ≠ 수정 승인**: 개선 계획을 설명하고 질의응답을 진행했더라도, 사용자가 명시적으로 **"수정해줘" / "진행해줘" / "OK"** 라고 말하기 전에는 **절대 코드를 수정하지 않는다.**
2. **계획 단계와 실행 단계를 분리**: 계획 → 사용자 최종 확인 → 실행.
3. **질의 중 코드 수정 금지**: 질문을 던지고 답변을 받는 과정에서 임의로 코드를 수정하는 행위는 치명적 실수로 간주한다.

---

## 프로젝트 개요

| 항목 | 값 |
|------|-----|
| 시스템명 | 배포지원 인력 투입관리 대시보드 |
| 목적 | 아웃룩 일정으로 가용 인원을 판별해 **공정하게 1명을 배정**하고 근거를 남긴다 |
| 담당자 | 이하영 (hayoung.lee@softcamp.co.kr) — 파트너프로그램팀 |
| 팀장 | 윤이나 (ina.yun@softcamp.co.kr) |
| 대시보드 | https://emitlight.github.io/deploy-schedule/ |
| Worker | https://deploycalendar.hayoung-lee.workers.dev |
| GitHub | https://github.com/emitlight/deploy-schedule (**public** — 주의) |

---

## 설계 원칙 (2026-10-13 개편)

> **판단은 서버가, 화면은 표시만.**

가용 판정 규칙은 **`cloudflare-worker.js` 한 곳에만** 둔다. 과거엔 규칙이 `index.html`에도
있어 PC마다 다른 답이 나왔고, 두 파일의 `OUT_KEYWORDS`가 서로 달라지는 사고도 있었다.
규칙을 바꿀 때는 **반드시 Worker만** 고칠 것. (CI가 공통 상수 불일치를 자동 차단한다)

`index.html`에 남아 있는 판정 함수는 **서버 장애 시 폴백 전용**이며, 이때 화면에
"이 PC 기준"이라고 표시된다.

---

## 파일 구조

```
배포지원 일정관리/
├── index.html              ← 대시보드 SPA (GitHub Pages, 약 3,250줄)
├── cloudflare-worker.js    ← Worker — 가용 판정·외부 연동 (약 1,000줄)
├── wrangler.toml           ← Cron·관측성 설정
├── .github/workflows/      ← CI (Worker 자동 배포 + 문법·상수 검사)
├── 사용가이드.md            ← ⭐ 단일 기준 문서. 대시보드가 GitHub raw에서 실시간 fetch
├── 본부공지_아웃룩_태깅규칙.md ← 전 직원 공지용
├── 시스템정리.md            ← 개발자용 기술 개요
├── 테스트시나리오_배포지원시스템.md
├── 고도화_계획서.md         ← 2026-10-13 개편 배경·계획
├── _archive/               ← 미사용 파일 보관 (운영 무관)
└── CLAUDE.md               ← 이 파일
```

---

## 아키텍처

```
브라우저 (화면 그리기만)
    │  get-availability / get-roster / get-stats
    ▼
Cloudflare Worker  ← 유일한 판단 주체
    ├─ Microsoft Graph : 아웃룩 캘린더 읽기 (가용성 원천, 3분 캐시)
    ├─ Notion          : 배정·스핀이력·수동분류 저장
    └─ vtiger CRM      : 티켓 담당자 변경 (⛔ Cloudflare IP 차단으로 미동작)
```

---

## 대상 인원

기본 8명 (ID 1~8): 이송민 · 이하영 · 강진혁 · 김선우 · 김요엘 · 윤이나 · 이정기 · 김정환
추가 후보 3명 (ID 9~11): 문병린 · 문정일 · 양창호

**후보 명단은 서버 공유 설정을 따른다.** 대시보드 헤더의 `➕ 추가 인원` 버튼을 누르면
Worker의 KV(`SETTINGS` / 키 `roster-config`)에 저장되어 **모든 PC에 즉시 반영**된다.

- KV 바인딩이 없으면: 토글은 **그 PC에만** 적용되고 화면이 그렇게 안내한다.
  기본값은 환경변수 `INCLUDE_EXTRA`(0/1).
- KV 설정: `npx wrangler kv namespace create SETTINGS` → 출력된 id를 `wrangler.toml`의
  `[[kv_namespaces]]` 블록에 넣고 주석 해제 → 재배포.

과거엔 이 토글이 PC별 localStorage라 운영자마다 후보군(8명/11명)이 달랐다.

---

## 가용 판정 규칙 (cloudflare-worker.js)

판정 순서:

| # | 조건 | 결과 |
|---|---|---|
| 1 | Notion 수동 분류(가능/불가/긴급) | 그대로 적용 (최우선·전사 공유) |
| 2 | 이 시스템이 만든 배포지원 일정 | **불가** (이미 투입 중) |
| 3 | 가용 키워드 태그 | **가능** |
| 3a | └ 시간제 + 제목에 `원격` | **불가** (원격 지원 중) |
| 3b | └ `[긴급]` 동반 | **긴급** (후보 포함, ⚠️ 표시) |
| 4 | 부재 키워드 | **불가** |
| 5 | 가용 키워드 없는 `[태그]` | **불가** (고객사·전담 업무) |
| 6 | 태그 없는 일반 회의 | **가능** |

- **가용 키워드 5개**: `티켓 · 파트너 · 내부 · 교육 · 대기`
  대괄호 안을 `/ _ 공백 · : , -` 로 쪼갠 토큰 중 하나만 맞으면 인식.
  `[티켓]` `[티켓 고객사]` `[완료/티켓]` `[내부/LMS]` 모두 가능. `[내부업무]`→`[내부]` 정규화.
- **부재 키워드 12개**: `연차 반차 휴가 외근 출장 재택 공휴일 경조 병가 조퇴 OOF 부재중`
  ⚠️ `index.html`의 `OUT_KEYWORDS`와 **반드시 동일**해야 함 (CI가 검사)
- **기간 판정은 `every`** — 기간 내 **모든 평일**이 가능해야 후보.
- **주말 제외** — 주말만 선택하면 후보 0명.

---

## 공정성 (중요 — 자주 오해됨)

- **당첨자는 가용 인원 중 균등 확률 추첨**이다. `Math.random()` 한 줄.
- **`rrOrder`(우선순위)는 표시 순서와 배정 이력 기록용이며, 확률에 영향을 주지 않는다.**
- 따라서 **같은 사람이 연속 당첨될 수 있고, 그것은 버그가 아니다.**
- 운영자 결정(2026-10-13): 가중 추첨을 제안했으나 **균등 추첨 유지**를 선택.
  대신 **📊 배정 통계 탭**으로 쏠림 여부를 수치로 확인·증명한다.
- 재스핀하면 **같은 사람에게 수렴**한다(`currentWinner` + `localStorage.pendingWinner` 잠금).
  다시 뽑으려면 `✕ 당첨자 초기화`.

> 문서·UI에 "후순위로 밀려 공정하게 순환" 류의 표현을 다시 넣지 말 것. 사실이 아니다.

---

## Worker X-Action 목록

| 액션 | 용도 |
|------|------|
| `get-availability` | ⭐ 가용 판정 (가용/불가·사유·중복배정) — 화면의 주 경로 |
| `get-roster` | 멤버 명단 + 공유 설정 (가벼움, 외부 API 호출 없음) |
| `set-roster-config` | 추가 인원 포함/제외 설정 저장 (KV, 전 PC 공유) |
| `get-stats` | 멤버별 배정 통계 (공정성 증명) |
| `sync-outlook` | 아웃룩 조회 (Notion 저장 안 함) |
| `run-sync` | Cron과 동일한 동기화 수동 실행 → 실제 집계 반환 |
| `load-events` / `save-event` / `delete-event` | Notion 일정 CRUD |
| `set-classification` | 수동 분류 저장 (전사 공유) |
| `add-spinlog` / `get-spinlog` / `delete-spinlog` / `cancel-spinlog` / `add-resetlog` | 배정 이력 |
| `list-calendars` | 캘린더 접근 테스트 |
| `send-email` / `create-outlook-event` | 구현돼 있으나 **온프레미스 Exchange라 미동작** |
| `vtiger-get-ticket` / `vtiger-update-ticket` / `vtiger-test` / `vtiger-list-users` | CRM (⛔ IP 차단) |

---

## 환경변수

```
APP_PASSWORD(⭐필수)   ← 미설정 시 Worker가 503으로 전면 차단(fail-closed)
GRAPH_CLIENT_ID / GRAPH_TENANT_ID / GRAPH_CLIENT_SECRET(⭐)
MEMBER_EMAILS  {"이하영":"hayoung.lee@softcamp.co.kr", ...}
MEMBER_IDS     {"이하영":2, "이송민":1, ...}
INCLUDE_EXTRA  추가 후보 3명 포함 여부의 기본값 (KV 미설정 시에만 사용)
SETTINGS       KV 바인딩 — 공유 설정 저장소 (선택. 없으면 토글이 PC 로컬로 동작)
NOTION_SECRET(⭐) / SCHEDULES_DB_ID / SPINLOG_DB_ID
VTIGER_URL / VTIGER_USERNAME / VTIGER_ACCESS_KEY(⭐) / VTIGER_MEMBER_IDS
```

---

## 배포

| 대상 | 방법 |
|------|------|
| 대시보드 | `git push origin main` → GitHub Pages 자동 (1~2분) |
| Worker | CI 자동 (`cloudflare-worker.js`/`wrangler.toml` 변경 시). 수동은 `npx wrangler deploy --keep-vars` |

> ⚠️ **`--keep-vars` 필수.** `wrangler.toml`에 활성 `[vars]` 블록이 없어서,
> 이 옵션 없이 배포하면 대시보드 환경변수가 전부 삭제되고 Cron이 조용히 멈춘다.

CI 사전 설정: GitHub Secrets에 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` 등록 필요.

---

## Notion DB

| DB | ID | 용도 |
|----|-----|------|
| SCHEDULES_DB | `1e8e2648e253493db20e3f201f9aa0d4` | 모든 일정 |
| SPINLOG_DB | `0674e90b37fe4a6e8784c99df1c6006f` | 배정 이력 |

**SCHEDULES_DB 속성**: 제목 · 멤버ID · 날짜 · 시작시간 · 종료시간 · 타입 · 노트 ·
아웃룩여부 · 하루종일 · 아웃룩ID · **배포분류**(수동 분류) · **스핀로그ID**(배정↔이력 연결)

**SPINLOG_DB 속성**: 이름 · 날짜 · 스핀일 · 멤버ID
→ `[취소]`·`[초기화]` 로그는 **멤버ID를 비워** 우선순위·통계 계산에서 자동 제외된다.

---

## Softcamp 환경 특이사항

- **온프레미스 Exchange 하이브리드** → Graph **읽기만 가능, 쓰기 불가**.
  담당자 아웃룩 일정 자동 생성·메일 자동 발송 모두 **미동작**. 메일은 `mailto:` 수동 발송으로 대체.
- **vtiger CRM**: Cloudflare Worker IP가 차단됨. 코드는 완성 상태이며
  nginx 화이트리스트에 Cloudflare IP 대역(https://www.cloudflare.com/ips-v4/) 등록 시 즉시 동작.
- **SHIELD Gate 프록시**: 일부 PC에서 동기화 시 프록시를 꺼야 할 수 있음.

---

## Cron 자동 동기화 (KST)

| UTC | KST |
|-----|-----|
| `0 22 * * *` | 07:00 |
| `30 3 * * *` | 12:30 |
| `0 6 * * *` | 15:00 |

동기화 창: **과거 28일 ~ 미래 90일** (화면 표시 범위와 일치).
실패 시 로그에 남는다 — `npx wrangler tail deploycalendar` 또는 대시보드 Logs.

---

## 알려진 제약 / 남은 과제

| 항목 | 상태 |
|------|------|
| 저장소가 **public** | 대시보드·소스가 외부 공개. 데이터는 `APP_PASSWORD`로 보호 |
| 공유 비밀번호 방식 | 사용자 식별·만료 없음. **Cloudflare Access(SSO) 전환 권장** — 보안 검토 필요 |
| vtiger 연동 | IT 관리자에게 Cloudflare IP 화이트리스트 요청 필요 |
| 아웃룩 일정 자동 생성 | EWS `ApplicationImpersonation` 서비스 계정 필요 |
| 아웃룩ID 뒤 16자 사용 | 충돌 확률 낮으나 존재. 형식 변경 시 기존 사본·수동분류 소실되므로 유지 중 |
| `index.html` 3,250줄 단일 파일 | 모듈 분리 미완. 가용판정 → 통신 → 상태 순으로 분리 권장 |
