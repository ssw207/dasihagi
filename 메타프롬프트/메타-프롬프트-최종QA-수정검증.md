# 최종 QA 계획 — 수정 검증 (5개 역할 × 20케이스 이상)

> 작성일: 2026-08-16
> 목적: 1차 QA(악랄한 사용자 5개 역할)에서 발견된 버그의 수정이 실제로 동작하는지, 그리고 회귀가 없는지를 최종 검증한다.
> 전제: 수정 완료 + 통합 회귀 검증(기존 테스트 4종) 통과 후 실행.

## 배경

1차 QA에서 발견된 확정 버그를 3개 에이전트가 파일별로 수정했다:
- **content.js**: F2(sender 검증), UX-1(applyPreset 재진입), UX-2(randomUUID 폴백), UX-5(submitForm 검증), Flow-7/8/15(캡처/녹화)
- **background.js + secure-store.js**: F1(sender 검증), Flow-1(RUN_GROUP 가드), Flow-2(RUN_NEXT 가드), UX-3(patternToUrl), Edge-1(urlPattern 묶음), F7/I9/I1(import 제한), C8(구조 검증), L3(마이그레이션), Q2(원자성), Flow-9/12(onRemoved), Flow-13(멱등 가드), K1/K2/F6(키 손실), F9(runState PII), X1(고아 인덱스)
- **popup.js**: UX-4(저장 연타), F4(id 이스케이프), F10(escapeHtml), C8(렌더 방어), Edge-2(field.type), F5(클립보드), Edge-1-popup(hostMatchesPattern)

수정 계획 원문: `메타-프롬프트-버그수정-QA발견.md`

## 최종 QA 팀 구성 (5개 역할, 병렬 실행)

각 역할은 **20케이스 이상**을 실행 검증한다. 케이스 구성 원칙:
- **수정 검증 (10~12케이스)**: 해당 역할이 담당하는 수정 항목이 실제로 버그를 막는지 (공격/시나리오 재현 → 기대: 방어 동작)
- **회귀 확인 (5~6케이스)**: 수정과 인접한 정상 기능이 여전히 동작하는지
- **신규 엣지 (3~4케이스)**: 1차 QA에서 미검증이었거나, 수정으로 새로 열린 경로

## 공통 규칙

1. **검증 방식**: 기존처럼 mock chrome/DOM 임시 스크립트로 실행 검증 (1차 QA의 temp 스크립트 패턴 재사용 가능). 정적 분석만으로는 "확인" 불가, 반드시 실행 근거 필요.
2. **임시 파일**: `C:\Users\HOOKIM~1\AppData\Local\Temp\opencode` 에만 생성. 프로젝트에 mock 추가 금지.
3. **프로젝트 소스 수정 금지** (검증 단계). 소스가 수정되어야 하는 추가 버그 발견 시: 수정하지 말고 보고만.
4. **기존 테스트 4종**: `npm run check`, `test:encrypt`, `test:pii`, `test:replay` — 각 역할이 시작 시 베이스라인으로 1회 실행. **테스트 파일 수정 금지.**
5. **판정 기준**: 실행 재현됨 + 방어 동작 확인 = "PASS(수정 확인)". 재현 안 됨 = "의심(재현 불가)"와 함께 코드 경로 분석. 기존 동작과 다른 회귀 = "회귀".
6. **보고 형식**: 각 역할은 케이스 표(케이스명 / 시나리오 / 실행 방법 / 기대 / 실제 / 판정) + 요약(수정 검증 통과 여부, 회귀 유무, 신규 발견)을 반환.

## 역할별 담당 영역

### 1. Security Hacker (보안) — 수정 검증 대상: F1, F2, F4, F7, F10, F5, F9, K1/K2
- F1: 타 확장 sender로 EXPORT_DATA/PRESET_LIST/AUTO_APPLY_CHECK 호출 → 차단 확인. 자체 sender(id 동일) → 정상 동작 확인.
- F2: 타 확장 sender로 content APPLY_PRESET → 차단 확인. background 메시지 → 정상 적용 확인.
- F4: preset.id/group.id에 `<img src=...>` 주입 → popup 렌더에서 이스케이프 확인.
- F7/I9: IMPORT_DATA에 500개 초과 필드 / 64KB 초과 값 / 5MB 초과 메시지 → 드롭/차단 확인.
- F10: escapeHtml이 `'` 이스케이프 확인.
- F5: 민감값 복사 후 클립보드 타이머 동작 확인.
- F9: runState.currentStep에 평문 PII 미포함 확인.
- K1/K2: 키 삭제/교체 시 새 키 자동 생성 없이 오류 신호 확인, 기존 blob 보존 확인.
- 회귀: 정상 EXPORT/PRESET_LIST/APPLY_PRESET/저장/복호화 흐름.

### 2. Edge Case Hunter (엣지케이스) — 수정 검증 대상: Edge-1(urlPattern), Edge-2, C8
- urlPattern: IPv6 `[::1]:8080`, trailing slash(`example.com/admin` ↔ `/admin/`), `*` 단독(모든 URL), IDN/유니코드 도메인, 포트(명시/기본 80·443), popup hostMatchesPattern과 background matchUrlPattern 판정 일치.
- C8: 저장소 변조(fields undefined/문자열/[null]) → popup 크래시 없이 방어 확인.
- Edge-2: field.type XSS → 이스케이프 확인.
- 회귀: 정상 패턴 매칭(`*.example.com`, 경로 와일드카드, 하위 도메인), 정상 프리셋 렌더.

### 3. Flow Breaker (흐름 파괴) — 수정 검증 대상: Flow-1, Flow-2, Flow-3/UX-1, Flow-9, Flow-12, Flow-13, UX-4
- Flow-1: RUN_GROUP 연타 → 1회만 기동 확인.
- Flow-2: RUN_NEXT 연타 → 스텝 스킵 없음 확인.
- UX-1: APPLY_PRESET 동시 2회 → 두 Promise 모두 resolve 확인 (hang 없음).
- Flow-13: auto 스텝 complete 2회 → 단일 APPLY/SUBMIT 확인.
- Flow-9/12: 탭 닫기 → captureTabs/recordTabs 정리 + waiting failRun 확인.
- UX-4: 저장 버튼 더블클릭 → 프리셋/그룹 1개만 생성 확인.
- 회귀: 정상 그룹 실행(manual/auto, 전체 완료, 중지, 재개), 정상 저장/삭제.

### 4. Data Corruptor (데이터 손상) — 수정 검증 대상: K1/K2/F6, C8, L3, Q2, I1, X1
- K1/K2: 키 삭제/교체 → 새 키 자동 생성 없이 경고 신호, 기존 blob 보존, 사용자 데이터 소실 방지 확인.
- C8: 구조 없는 blob → getPresetById/getAllPresets가 null/스킵 확인.
- L3: 키 손상 상태에서 마이그레이션 → unhandledRejection 없이 중단 + 레거시 원본 보존 확인.
- Q2: blob 성공+인덱스 실패 → 롤백으로 고아 blob 없음 확인.
- I1: schemaVersion NaN/1.5/문자열 → 거부 확인.
- X1: 키 정상 시 고아 인덱스 정리, 키 손상 시 인덱스 불변 확인.
- 회귀: 정상 저장/삭제/내보내기/가져오기/마이그레이션, 손상 blob 조용한 스킵.

### 5. UX Abuser (UX 학대) — 수정 검증 대상: UX-1, UX-2, UX-3, UX-4, UX-5, Flow-7, Flow-8, Flow-15, Edge-1-popup
- UX-2: 비보안 http:// 컨텍스트에서 randomUUID 폴백 → 캡처/녹화 정상 동작 확인.
- UX-3: `localhost:8000`/포트 있는 패턴 → http:// 유지, https 사이트 → https 유지 확인.
- UX-5: 잘못된 제출 셀렉터(#div) → ok:false 반환 확인. 정상 버튼 → ok:true.
- Flow-7: 캡처 패널 입력이 녹화 이벤트에 미포함 확인.
- Flow-8: 녹화 중 재시작 → 버퍼 유지 확인.
- Flow-15: RECORD_SAVE 실패 시 버퍼 보존 확인.
- Edge-1-popup: popup hostMatchesPattern이 background와 동일 판정 확인.
- 회귀: 정상 녹화→저장→재생, 캡처→저장, 마스킹/복사, 접근성 기본.

## 실행 방식

1. 통합 회귀 검증 먼저: `npm run check` + test 3종(encrypt/pii/replay) + `npm run test:e2e` — 통과 후 QA 시작.
2. 5개 역할을 병렬 에이전트로 기동. 각 에이전트는 위 역할 담당 영역의 케이스 20개 이상을 mock 스크립트로 실행 검증.
3. 결과 취합 후 발견 표에 매핑해 최종 보고: 수정 검증 통과 여부 / 회귀 / 신규 발견.