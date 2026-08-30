# 메타프롬프트 — QA 팀 엣지케이스 도출 및 실행

## 목표

사용자 요구 원문: **「QA 팀으로 엣지케이스 테스트 케이스를 도출하고 QA진행」**

5역할(보안 / 엣지 / 흐름 / 데이터 / UX)으로 R1~R18·D35(지연 iframe)까지 엣지케이스를 도출한다. 기존 스위트로 커버되는 것은 재실행하고, 빈틈은 `test/qa-edge-verify.mjs`와 E2E(중첩·src 교체·작은 iframe·유니코드)로 실행한다. 치명 버그가 나오면 같은 턴에서 고친다.

## 변경 범위

| 파일 | 내용 |
|------|------|
| `QA-엣지케이스.md` | 케이스 카탈로그 + 실행 결과 |
| `test/qa-edge-verify.mjs` | mock chrome 엣지 실행 |
| `test/iframe-host-nested.html` `test/iframe-host-swap.html` `test/iframe-host-tiny.html` | E2E 픽스처 |
| `test/browser-e2e-verify.mjs` | I/J/K/L 시나리오 |
| `package.json` | `test:qa` |
| `REQUIREMENTS.md` `decisions.md` `README.md` | R8-4, D36 |

## MUST NOT

- 기존 테스트 삭제·약화 금지
- sandbox iframe·실 사내 사이트를 되는 것처럼 통과 처리 금지
- 사이트 하드코딩 금지
- 추측만으로 치명 판정 금지

## 검증

- `npm run check` / `test:encrypt` / `test:pii` / `test:replay` / `test:qa`
- `npm run test:e2e`
