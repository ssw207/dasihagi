# 버그 수정 계획 — QA 발견 종합 (악랄한 사용자 QA 5개 역할)

> 작성일: 2026-08-16
> 근거: QA 팀 5개 역할(Security Hacker / Edge Case Hunter / Flow Breaker / Data Corruptor / UX Abuser) 실행 결과 + 기존 테스트 전부 통과 확인

## 배경

폼 프리셋 Chrome 확장(MV3, 네이티브 JS, PII AES-256-GCM)에 대해 5개 QA 역할이 악랄한 사용자 관점에서 분석했다.
모든 발견은 mock chrome/DOM 임시 스크립트로 실행 검증되었거나 정적 분석으로 확정된 것만 수정 대상에 포함한다 (의심/기각 항목은 제외).

## 확정 수정 대상 (심각도순)

### S0 — 치명 (즉시 수정)

| # | 발견 | 위치 | 증상 |
|---|---|---|---|
| F1 | background `onMessage` sender 무검증 | `background.js:592-597` (handleMessage `background.js:351`) | 타 확장이 `EXPORT_DATA`/`PRESET_LIST`/`AUTO_APPLY_CHECK`로 복호화 PII 전체 유출, `IMPORT_DATA` 주입, `PRESET_UPDATE` 변조 |
| F2 | content.js `onMessage` sender 무검증 | `content.js:720-754` | 타 확장이 `APPLY_PRESET`로 폼 임의 값 주입, `SUBMIT_FORM` 제출 트리거 |
| UX-1 | applyPreset 재진입 → 그룹 실행 영구 중단 | `content.js:615-679` (applyAbort 싱글턴 663-668, 15s 타임아웃 671-677), `background.js:275` | autoApply+그룹 실행 경합 또는 재생 연타 시 두 번째 호출이 영원히 미해소 → badge `1/N` 영구 중단 |
| UX-2 | 비보안 http://에서 `crypto.randomUUID` TypeError | `content.js:253, 396` | 캡처 저장/녹화 이벤트가 조용히 유실 (secure context 전용 API) |

### S1 — 높음

| # | 발견 | 위치 | 증상 |
|---|---|---|---|
| Flow-1 | RUN_GROUP 연타 → 그룹 2회 기동 | `background.js:314-339` | 중복 차단 검사가 첫 await 전에만 → 탭 2개 생성, stepResults 유실 |
| Flow-2 | RUN_NEXT 연타 → 스텝 스킵 | `background.js:341-349` | stepIdx 2 증가 → 스텝 적용 없이 done |
| Flow-3/UX-1 | APPLY_PRESET 동시 2회 → background hang | `content.js:615`, `background.js:275` | 첫 응답 유실, 그룹 실행 'running'에 갇힘 (UX-1과 동일 수정) |
| UX-3 | 그룹 실행 http→https 강제 변환 | `background.js:156-161` (patternToUrl) | `http://localhost:8000` → `https://localhost:8000` 실패 |
| UX-4 | 저장 버튼 연타 → 중복 프리셋/그룹 생성 | `popup/popup.js:619-657, 693-714` | 동일 이름 프리셋 2개 생성 |
| UX-5 | 잘못된 제출 셀렉터가 성공 보고 | `content.js:681-718` (submitForm) | div에 click() 후 ok:true → 폼 미제출, 데이터 유실 |
| K1/K2 | vault 키 손상/누락 → 전체 프리셋 영구 소멸 | `secure-store.js:29-45, 47-58, 60-75` | SW 재시작 후 새 키 생성 → 기존 blob 복호화 불가, 경고 없이 소멸 |

### S2 — 중간

| # | 발견 | 위치 | 증상 |
|---|---|---|---|
| C8 | getAllPresets 구조 검증 없음 → popup 크래시 | `background.js:58-66`, `popup/popup.js:199, 140-141` | 저장소 변조 시 `preset.fields.length`/`fields.map`/`field.type` TypeError |
| F4 | preset.id/group.id escapeHtml 없음 | `popup/popup.js:202-205, 258-260` | data-id에 HTML 주입 (`<img src=...>` 추적/UI 파괴) |
| F7 | IMPORT_DATA 필드 수/값 크기 무제한 → DoS | `background.js:702-711` | 50만 필드 2.5s, popup UI 프리즈, 5MB 제한 우회 |
| Edge-1 | urlPattern 버그 묶음 | `background.js:104-154`, `popup/popup.js:103-113` | IPv6 `[::1]:8080` 파싱 오류, trailing slash 불일치(`example.com/admin`≠`/admin/`), `*` 단독, IDN/유니코드 도메인 불일치, popup hostMatchesPattern과 판정 불일치, 포트 처리 |
| Edge-2 | field.type XSS + preset.id HTML 주입 | `popup/popup.js:360-408` (renderFields) | import된 field.type이 escapeHtml 없이 삽입 |
| Flow-9 | 탭 닫기 → captureTabs/recordTabs 좀비 | `background.js:625-629, 9-10` | 닫힌 탭이 Set에 영구 잔존 |
| Flow-12 | waiting 상태에서 탭 닫기 → run 미감지 | `background.js:625-629` | run이 'waiting'에 영구 잔존 |
| Flow-13 | auto 스텝 complete 2회 → 이중 제출 | `background.js:617-623, 287-307` | SUBMIT_FORM 2회 |
| Flow-7 | 캡처 모드 중 녹화 → 패널 입력 오염 | `content.js:424` (onRecordInput) | `.fp-panel` 내부 입력이 녹화 이벤트로 기록 |
| L3 | migrateLegacyStorage unhandledRejection | `background.js:683-685, 644-681` | 키 손상 시 InvalidCharacterError unhandled |
| Q2 | savePreset blob→인덱스 비원자적 | `background.js:69-83, 43-45` | 인덱스 실패 시 고아 blob / 불일치 |
| X4 | urlPattern 인덱스 vs blob 불일치 | `background.js:525-534` (AUTO_APPLY_CHECK) | 인덱스 기준 자동적용이 blob 패턴과 다른 페이지에 적용 |
| F6 | 키 손상 시 조용한 데이터 손실 | `secure-store.js:60-75` | getSecret null 무감지 (K1/K2와 함께 수정) |

### S3 — 낮음 (수정 비용 낮은 것만)

| # | 발견 | 위치 |
|---|---|---|
| F8/I1 | schemaVersion NaN/비정수 허용 | `background.js:691-696` → `Number.isInteger` |
| I9 | background IMPORT_DATA 크기 미검사 | `background.js:545-586` → 크기 제한 추가 |
| Flow-8 | RECORD_START 중 RECORD_START → 버퍼 리셋 | `content.js:453` → active 가드 |
| Flow-15 | RECORD_SAVE 실패 시 이벤트 유실 | `content.js:465-489` → 버퍼 보존 |
| F10 | escapeHtml 작은따옴표 미이스케이프 | `popup/popup.js:115-121` → `'` → `&#39;` |
| F5 | 클립보드 잔류 | `popup/popup.js:35-64` → 민감값 복사 후 타이머 클리어 |
| F9 | runState.currentStep에 평문 PII | `background.js:254-263` → preset 필드 제거 |
| X1 | 고아 인덱스 정리 없음 | `background.js:58-66` → 정리 로직 |

## 제외 항목 (의심/기각/설계 결정)

- Flow-5 (동시 UPDATE 인덱스 유실): 재현 실패, 코드 근거만 → Q2 원자성 수정에 포함
- UX-12 (chrome:// 그룹 실행 스턱): Chrome API 의존, 의심 → 패턴 저장 시 스킴 검증(Edge-1)으로 완화
- UX-21/22 (autoApply 경합): UX-1 재진입 수정으로 완화
- F3 (autoApply PII 노출): 설계 의도 → 별도 검토
- F15~F18, I8, Flow-16~18: 기각 (방어 확인)
- K3 (키 잘못된 형식): setSecret throw는 정상 동작 → 유지

## 수정 원칙

1. **파일별 소유권 분리로 병렬 수정**: background.js(+secure-store.js) / content.js / popup.js(+popup.css) — 교차 충돌 금지
2. **최소 변경**: 발견 항목만 수정. 리팩토링 금지. 기존 함수 시그니처 유지.
3. **기존 패턴 준수**: 인라인 이벤트 대신 기존 addEventListener 패턴, escapeHtml은 전역 유틸 사용, 메시지 타입/응답 형식 변경 금지 (테스트가 응답 형식에 의존).
4. **회귀 검증**: 수정 후 반드시 아래를 실행:
   - `npm run check`
   - `npm run test:encrypt` (12건)
   - `npm run test:pii` (30건)
   - `npm run test:replay` (28건)
   - 테스트 파일은 절대 수정 금지. 실패 시 테스트가 아니라 소스 수정으로 해결.
5. **테스트 하네스와 무관**: mock 스크립트는 temp에만 존재. 프로젝트에 mock 추가 금지.

## 실행 방식

1. 수정 작업을 3개 병렬 에이전트로 위임 (background/content/popup 파일별)
2. 각 에이전트는 위 표에서 자기 파일 범위의 발견만 수정
3. 완료 후 통합 회귀 검증 실행
4. 수정 결과를 발견 표에 매핑해 보고