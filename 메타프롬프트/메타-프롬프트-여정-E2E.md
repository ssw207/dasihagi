# 메타 프롬프트: 멀티페이지 여정 녹화 Playwright E2E

## 역할

너는 폼 프리셋 확장의 실제 브라우저 E2E를 확장하는 엔지니어다. 기존 `test/browser-e2e-verify.mjs`(A~E)를 **유지**하고, 여정 녹화/재생(R11)을 **같은 Playwright 하니스**로 검증한다.

## 사용자 요구 원문

> E2E 테스트 까지 진행

직전 합의: 제품 런타임은 확장, Playwright는 E2E 도구(D21). 이번에는 그 E2E를 **실행**하고, 여정(검색→클릭→페이지 이동→상품 선택)이 실제 Chromium에서 도는지 확인한다.

## 목표

1. 네이버를 치지 않는다. localhost에 홈→결과→가격비교→상품 4페이지를 둔다.
2. 시나리오 F를 기존 러너에 추가한다 (E 마이그레이션 **이전** — E가 context를 재시작한다).
3. 기존 A~E가 깨지면 여정 추가가 원인인지 먼저 보고, 제품 버그면 최소 수정한다.
4. `npm run test:e2e`(또는 동등 명령)를 **실제로 실행**해 PASS/FAIL을 보고한다.
5. REQUIREMENTS R8-3, decisions, README를 갱신한다.

## F 시나리오 (수용 기준)

| ID | 내용 |
|----|------|
| F1 | 홈에서 녹화 → 검색어 입력 → 검색 클릭 → 결과에서 「가격비교 더보기」→ 비교 검색 → 상품 클릭 → 종료. `fields`에 text·click·navigate가 있고 `startUrl`이 홈이다. |
| F2 | 페이지가 바뀐 뒤 `.fp-record-chip`이 다시 보인다. |
| F3 | 다른 경로(`/`)에서 재생 → 같은 탭으로 상품 페이지에 도착한다. |
| F4 | 여정 프리셋에 자동 적용을 켜도 홈 재진입 시 상품으로 점프하지 않는다. |

## 변경 범위

- `test/journey-*.html` (신규)
- `test/browser-e2e-verify.mjs` (서버 라우트 + F)
- 문서. 제품 코드는 E2E가 발견한 실제 버그만.

## 금지

- 네이버 실접속
- headless로 속이기
- A~E 삭제/약화
- Playwright를 제품 런타임으로 넣기 (D21)

## 검증

- [x] `npm run test:e2e` 종료 코드 0, F 포함 PASS
- [x] A~E 회귀 유지
- [x] 문서에 여정 E2E가 반영됨

## 실행 결과

`npm run test:e2e` **49/49 PASS**, FAIL 0. 시나리오 F 9건(칩 복원, text/click/navigate, startUrl, 재생 상품 도착, 자동적용 제외) 포함.
