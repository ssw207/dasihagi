# 메타프롬프트 — iframe 기반 사이트 녹화 불능 검토

## 목표

사용자 요구 원문: **「iframe 기반 사이트는 녹화하기 기능이 동작하지 않는다 검토필요.」**

같은 origin·이미 로드된 iframe(E2E H)은 된다. 사내 어드민처럼 **껍데기 로드 후 iframe이 늦게 생기거나 src가 바뀌는 경우**에는 `tabs.onUpdated`(탭 단위 complete)만으로 `RECORD_START`가 iframe에 안 간다. 새 프레임이 세션에 합류하지 못해 입력이 기록되지 않는다.

## 변경 범위

| 파일 | 내용 |
|------|------|
| `content.js` | 로드 시 `RECORD_STATUS`로 활성 세션이면 녹화 합류. 칩/리스너 재개 보강 |
| `background.js` | `RECORD_STATUS`에 `sender.tab.id` 폴백. `webNavigation.onCompleted`로 프레임 complete 시 재개 + iframe 호스트 허용 |
| `test/iframe-host-late.html` | 지연 iframe 호스트 |
| `test/browser-e2e-verify.mjs` | 녹화 시작 후 iframe이 뜨는 시나리오 |
| `test/record-replay-verify.mjs` | webNavigation mock, RECORD_STATUS tabId 생략 |
| `REQUIREMENTS.md` `decisions.md` `README.md` `기획서.md` | R18 보강, D35 |

## 구현 상세

1. iframe 문서는 부모가 DOM을 읽지 않는다. 각 프레임 content script가 합류한다.
2. iframe URL을 탭 `navigate`로 기록하지 않는다. 재생이 껍데기 대신 iframe URL로 탭을 옮겨 버리기 때문.
3. 기존 같은 origin 즉시 iframe(H) 회귀 유지.

## MUST NOT

- 부모에서 cross-origin iframe DOM 접근
- 사이트 하드코딩
- sandbox iframe을 되는 것처럼 약속
- 기존 테스트 삭제

## 검증

- `npm run check` / `test:encrypt` / `test:pii` / `test:replay`
- `npm run test:e2e` — 기존 H + 지연 iframe
