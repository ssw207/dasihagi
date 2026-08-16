# 메타프롬프트 — UI P0 Playwright E2E

## 목표

사용자 요구 원문: **「플레이어 라이트 이용해서 E2E 테스트 까지했어?」**

답: 이전 턴에서는 하지 않았다. 이번 턴에서 `npm run test:e2e`(Playwright, 실제 Chromium에 dist 확장 로드)를 실행하고, 실패하면 UI P0와 충돌하는 부분만 고친다.

## 변경 범위

- 실패 시에만 `test/browser-e2e-verify.mjs` 또는 popup 셀렉터 정합
- 통과하면 코드 변경 없음 (이 메타프롬프트 파일만 추가)

## 구현 상세

1. `npm run test:e2e` 실행 (내부에서 build 후 headful Chromium)
2. 실패하면 원인 분석. UI P0로 바뀐 버튼(`#btn-record`는 편집에 유지, 카드는 ⋯ 메뉴)과 테스트가 어긋나면 테스트를 새 UI에 맞춘다. 기능 회귀면 소스를 고친다.
3. 결과를 사용자에게 보고한다.

## MUST NOT

- E2E 케이스 삭제로 통과시키지 않는다.
- Playwright를 제품 런타임으로 바꾸지 않는다.

## 검증 방법

- `npm run test:e2e` 종료 코드 0, 기존 A~F 시나리오 PASS
