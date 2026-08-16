# 메타-프롬프트: 실제 브라우저 E2E + 엣지케이스 검증

작성일: 2026-08-16
근거: 사용자 요청 "실제 E2E. 테스트도 진행했어?" → "엣지케이스도 도출해서 테스트하도록해. 메타프롬프트로 변환해서 요청"

## 1. 목표 (사용자 요구 원문)

> "실제 E2E. 테스트도 진행했어?"
> "엣지케이스도 도출해서 테스트하도록해. 메타프롬프트로 변환해서 요청"

- 지금까지 mock 기반 통합 테스트만 수행(record-replay 28/28, encryption 12/12, pii 30/30).
- 이번에 **실제 Chrome(Chromium)에 확장을 로드**해 녹화→저장→재생·PII 암호화·마이그레이션을 검증하고,
  **엣지케이스를 도출**해 함께 테스트한다.

## 2. 준비

- `npm install playwright` (devDependency — NFR-2에서 playwright만 허용됨)
- 브라우저 바이너리: `%LOCALAPPDATA%\ms-playwright\chromium-1234` 등 이미 존재 (설치 완료 확인)
- E2E 대상: `npm run build` 산출물 `dist/` (확장 로드 경로)
- 테스트 폼: `test/test-form.html` (기존, localhost 서버로 서빙 — file:// 접근 제한 회피)

## 3. E2E 아키텍처 (test/browser-e2e-verify.mjs)

- `chromium.launchPersistentContext(userDataDir, { headless: false, args: [--disable-extensions-except=<dist>, --load-extension=<dist>] })`
  — MV3 확장은 headful에서 안정적으로 동작 (headless로 속이기 금지)
- 테스트가 직접 localhost http 서버(Node http)로 `test/test-form.html` 서빙
- 확장 service worker attach (`context.waitForEvent('serviceworker')`) → 확장 ID 획득
- storage 검증: SW `evaluate`에서 `chrome.storage.local.get(null)` 호출 (확장 컨텍스트에서 직접 조회)
- popup 조작: `chrome-extension://<id>/popup/popup.html` 페이지로 직접 열어 실제 버튼 클릭
- 녹화 칩/마스킹 등 content/UI 확인은 페이지 DOM에서 검증

## 4. 검증 시나리오 (기본 + 엣지케이스)

### A. 기본 흐름
- A1: popup에서 프리셋 생성 (이름 + urlPattern=localhost:PORT)
- A2: test-form 페이지에서 녹화 시작 → 이름/이메일/부서/약관 입력 → 종료 칩 클릭 → 자동 저장
- A3: **저장소 검증** — `presets`는 인덱스만(필드 없음), `sec:preset:<id>` blob 존재, 저장소 JSON에 입력 값 평문 0
- A4: 재생 → 페이지 4개 필드 값 채워짐 (순서: 이름→이메일→부서→약관)

### B. 녹화 엣지케이스
- B1: **같은 필드 연속 입력 머지** — 이름을 2회 입력 → 이벤트 1개, 최종값만 저장
- B2: **필드 전환 flush** — 텍스트 입력 직후 다른 필드 클릭/입력 → 이전 필드 대기 입력이 먼저 기록 (순서 보존)
- B3: **radio 그룹** — 같은 `name`의 radio 여러 개 (셀렉터 충돌: 두 radio를 연속 선택하면 어떻게 되는가 — 같은 셀렉터라 값만 갱신 or 별도 필드?)
- B4: **checkbox 해제 상태** — 체크했던 것을 해제 → 값 `false` 저장
- B5: **텍스트 입력 직후 change 이벤트** — 입력 중 select/checkbox 변경 → pending flush 순서
- B6: **빈 값** — 입력 후 값을 모두 지우고 다른 필드로 이동 → 빈 값 이벤트

### C. PII/암호화 엣지케이스
- C1: 이메일 입력 → `sensitive: true` (마스킹 신호) + storage에 평문 없음
- C2: popup 목록에서 민감 필드 `••••••` 마스킹 표시
- C3: `vault_key_v1` 존재, `presets` 인덱스에 필드 값 없음
- C4: 비민감 필드 값도 storage 평문 없음 (전체 blob 암호화)

### D. 재생/적용 엣지케이스
- D1: **delay 순차 재생** — 입력 간격을 두고 녹화 → 재생 시 같은 순서로 지연 적용
- D2: **urlPattern 불일치** — 대상이 아닌 페이지에서 재생 → 오류 메시지
- D3: **autoApply** — 프리셋에 자동 적용 켜고 페이지 재진입 → 자동 채움

### E. 마이그레이션 엣지케이스
- E1: SW evaluate로 **레거시 형식 시드**(presets 배열에 fields + `sec:<pid>:<fid>`) → `chrome.runtime.reload()` → SW 재시작 → `migrateLegacyStorage` 실행 확인 (인덱스 + `sec:preset:<id>` + 레거시 키 정리)

## 5. MUST NOT (금지)

- 실제 코드(background/content/popup/pii-detect/secure-store)의 **동작 로직 변경 금지** — E2E로 발견된 실제 버그만 최소 수정 허용
- 기존 mock 테스트(encrypt/replay/pii) 삭제·대체 금지 — 회귀 유지
- `headless`/가짜 확장으로 "E2E 통과" 속이기 금지 — 실제 확장 로드 검증
- `as any`, `@ts-ignore`, 빈 catch로 통과 금지
- 오래 걸리는 안정화 시도(랜덤 대기)로 시간 낭비 금지 — Playwright auto-wait/selector 활용

## 6. 검증 방법

1. `npm run build` (dist 최신화) → E2E 실행 `node --experimental-default-type=module test/browser-e2e-verify.mjs` 전체 PASS
2. 기존 회귀: `npm run check` / `test:encrypt` 12/12 / `test:pii` 30/30 / `test:replay` 28/28 유지
3. 발견 버그 수정 시 `lsp_diagnostics`/`node --check` + 해당 시나리오 재실행
4. REQUIREMENTS.md: R8-3(브라우저 E2E) 추가, §8 보류 해제, 변경 이력 Round 7, decisions.md D18 추가