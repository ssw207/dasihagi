# 요구사항 정의서 — 폼 프리셋 Chrome Extension (Manifest V3)

> **이 문서의 역할**: 이 확장 프로그램이 **무엇을 해야 하는지**에 대한 단일 기준점(Source of Truth). 기능 추가/수정 시 반드시 이 문서를 기준으로 계획을 세우고, 병렬 처리 시 각 작업이 이 문서의 요구사항을 충족하는지로 진행 여부를 검증한다.
>
> **최신화 규칙**: 기능이 추가되거나 변경되면 반드시 이 문서를 갱신한다 (기능 요약, 데이터 모델, 메시지, 결정 사항). 갱신 주체는 해당 기능을 머지한 라운드.
>
> **관련 문서**: `.sisyphus/notepads/form-preset-extension/decisions.md`(결정 D1~), `.sisyphus/plans/*.md`(라운드 계획), `README.md`(사용자 매뉴얼)
>
> **최종 갱신**: 2026-08-16 (Round 6)

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|------|------|
| 이름 | 폼 프리셋 |
| 종류 | Chrome 확장 프로그램 (Manifest V3, 네이티브 JS — 번들러 없음) |
| 하는 일 | 특정 사이트의 폼에 들어가는 값을 프리셋으로 저장해 두고, 버튼 한 번으로 자동 채움 |
| 사용자 | 반복적으로 폼을 채워야 하는 일반 사용자 (개발자 아님, 한국어 사용자) |
| UI 언어 | 한국어 (모든 UI 문자열) |
| 저장소 | `chrome.storage.local` (프리셋/그룹/암호문), `chrome.storage.session` (실행 상태) |

## 2. 핵심 요구사항 (기능)

### R1. 프리셋 관리 (기본 CRUD) — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R1-1 | 사이트별 프리셋 생성/조회/수정/삭제 | popup에서 전 기능 동작, 하드코딩 사이트 없음 |
| R1-2 | 프리셋 = 이름 + 사이트 패턴(urlPattern) + 필드 목록 | 데이터 모델(§4) 준수 |
| R1-3 | 사이트 패턴 매칭 (호스트명 wildcard `*.example.com`, 경로 패턴 `example.com/*`) | `matchUrlPattern()` 정확 동작 |
| R1-4 | 자동 적용(autoApply): 페이지 진입 시 매칭 프리셋 자동 채움 | `tabs.onUpdated` → `APPLY_PRESET` |
| R1-5 | 하위 호환: 레거시(필드 단위 민감 암호화) 저장 데이터 시작 시 자동 마이그레이션 | migrateLegacyStorage 1회 이전 (M1~M2 검증) |

### R2. 캡처 모드 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R2-1 | 캡처 시작 시 페이지 입력 요소에 하이라이트(파란 점선) 표시 | input/select/textarea 전부 |
| R2-2 | 요소 클릭 → 부동 패널(표시 이름/값 입력) 표시 | popup 닫힘 상태에서도 동작 |
| R2-3 | 셀렉터 생성 fallback: `id` > `name` > `aria-label/placeholder` > `data-*` > 고유 CSS 경로 | `generateSelector()` |
| R2-4 | 값 저장: text/textarea/select/checkbox/radio 타입별 처리 | 타입별 저장 규칙 준수 |
| R2-5 | **Enter 키 입력 흐름**: 표시 이름 입력 → Enter → 값 입력창 표시 → 값 입력 → Enter → 저장 | R2-2 패널에서 동작 (Round 3) |
| R2-6 | 패널 내부 클릭 시 pick 모드 재트리거 금지 | 패널 클릭 → 저장/취소만 |
| R2-7 | 캡처 모드 탭별 상태 관리 (background Set) | CAPTURE_START/STOP/STATUS |

### R3. 적용 모드 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R3-1 | 저장된 프리셋을 버튼 한 번으로 폼에 채움 | popup "적용" 버튼 |
| R3-2 | React/Vue 등 SPA 이벤트 호환: 네이티브 value setter + `input`/`change` 이벤트 dispatch | `Object.getOwnPropertyDescriptor` |
| R3-3 | 타입별 값 세팅 (select option 없으면 추가, checkbox/radio checked) | 타입별 규칙 준수 |
| R3-4 | SPA 지연 렌더링 대응: MutationObserver 재시도 (최대 N회) | 지연 요소에도 적용 |
| R3-5 | 적용 전 사이트 패턴 검증 (대상 사이트가 아니면 오류) | APPLY_PRESET에서 검증 |

### R4. 그룹 실행 (여러 페이지 복합 세팅) — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R4-1 | 그룹 = 순서 있는 프리셋 목록 (presetId 참조, 기존 프리셋 재사용) | groups 데이터 모델(§4) |
| R4-2 | 그룹 실행: A페이지 채움 → B페이지 채움 → ... 순차 진행 | 새 탭으로 각 urlPattern 열기 |
| R4-3 | 스텝 제출 방식 선택: `auto`(값 채움 + 제출 버튼 자동 클릭) / `manual`(값만 채움, 사용자 직접 제출) | step.submitMode |
| R4-4 | popup이 닫혀도 실행 지속 (background 상태 머신 + badge `N/M`) | runState (§4) |
| R4-5 | 실행 중 중지/실패 처리, 중복 실행 차단 | RUN_ABORT/RUN_STATUS |
| R4-6 | manual 스텝: "다음 단계"로 진행 | RUN_NEXT |

### R5. 내보내기/가져오기 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R5-1 | 프리셋+그룹을 JSON 파일로 내보내기 (민감 필드는 복호화된 값 포함 — 사용자 소유 백업) | EXPORT_DATA |
| R5-2 | JSON 파일 가져오기: 스키마 검증(버전/형식), 새 ID 부여, 민감 필드는 새 ID 기준 재암호화 | IMPORT_DATA |
| R5-3 | 가져오기 시 기존 항목 유지 + 새 항목 추가 (덮어쓰기 없음) | concat 방식 |
| R5-4 | 제한: 프리셋 500개 / 그룹 100개 / 파일 5MB | 상수 + popup 검증 |

### R6. 프리셋 전체 암호화 저장 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R6-1 | 프리셋 전체(모든 필드 값)를 프리셋별 blob `sec:preset:<id>`로 AES-256-GCM 암호화 | savePreset/getPresetById |
| R6-2 | `presets` 키는 평문 인덱스 `[{id,name,urlPattern,autoApply,updatedAt}]` — 필드 값 미포함, 자동 적용 매칭은 인덱스로 복호화 없이 수행 | getPresetIndex/AUTO_APPLY_CHECK |
| R6-3 | AES-256-GCM, 키 자동 생성 (`vault_key_v1`), 매 저장 새 IV | secure-store.js |
| R6-4 | 보호가 감지 품질과 분리: 감지가 불완전해도 저장소 평문 0 (필드별 암호화 폐기) | 모든 값이 blob 안 |
| R6-5 | 복호화 지점: PRESET_LIST(편집용), APPLY_PRESET/AUTO_APPLY_CHECK/그룹 실행(적용용), EXPORT_DATA(백업용) | getPresetById |
| R6-6 | 가져오기 시 새 ID 기준 재암호화 + 인덱스 병합 | IMPORT_DATA |
| R6-7 | 프리셋 삭제 시 blob + 인덱스 정리 | deletePreset |
| R6-8 | 레거시(필드 단위) 저장 데이터는 시작 시 1회 자동 마이그레이션 | migrateLegacyStorage |
| R6-9 | 보호 수준: 로컬 열람/백업 유출/문자열 검색 방어 (정적 분석 수준. OS 키체인 수준은 확장만으로 불가 — 한계 명시) | secure-store.js 주석 |

### R7. 프리셋 값 클릭복사 UX — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R7-1 | 프리셋 목록 카드에 필드 값 행 표시 + 복사 버튼 | 📋 클릭 → 클립보드 복사 |
| R7-2 | 민감 필드는 `••••••` 마스킹 표시, 복사 시 실제 값 | password manager 패턴 |
| R7-3 | boolean 필드는 `체크됨/체크 안 됨` 표시, 복사 값은 `true/false` | 필드 타입 처리 |
| R7-4 | 빈 값은 `(값 없음)` + 복사 버튼 비활성 | value === '' |
| R7-5 | 필드 5개 초과 시 `+N개 더보기` 토글 | 목록 접기/펼치기 |
| R7-6 | 편집 뷰 필드 행에도 복사 버튼 (편집 중 최신 값 복사) | renderFields |
| R7-7 | 복사는 clipboard API + `execCommand('copy')` 폴백, 성공/실패 토스트 | copyToClipboard |

### R8. 회귀 테스트 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R8-1 | `test/encryption-verify.mjs`: mock chrome으로 실제 background.js 구동, 프리셋 blob 암호화 S1~S10 + 레거시 마이그레이션 M1~M2 검증 | `npm run test:encrypt` 전부 PASS |
| R8-2 | `test/record-replay-verify.mjs`: mock DOM+chrome으로 녹화→저장→재생 통합 검증 (전체 암호화 + sensitive 마스킹 신호 보존) | `npm run test:replay` 전부 PASS |
| R8-3 | `test/browser-e2e-verify.mjs`: **실제 Chromium에 dist 확장 로드(headful)** + localhost 서버(test-form.html) + SW `chrome.storage.local` 직접 검증. A 기본 흐름(생성→녹화→저장→재생), B 녹화 엣지케이스(머지/flush/radio/checkbox 해제/빈 값/change-flush), C PII(저장소 평문 0 + popup 마스킹 + vault 키), D 재생(delay 순차 실측/urlPattern 불일치/autoApply 재진입), E 레거시 마이그레이션(시드→재시작→자동 이전) | `node --experimental-default-type=module test/browser-e2e-verify.mjs` 40/40 PASS |

### R9. 녹화/재생 방식 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R9-1 | 프리셋 카드 버튼 `[재생][녹화]` (캡처 모드는 유지) | popup 카드 버튼 |
| R9-2 | 녹화: 시작 → 평소대로 세팅 → 종료(부동 칩) → 자동 저장, 표시 이름 직접 지정 불필요 | RECORD_START/STOP/SAVE |
| R9-3 | 녹화 이벤트: text/textarea는 input 400ms 디바운스 + 필드 이동 시 flush, select/checkbox/radio는 change 즉시, 같은 필드 연속 수정은 값만 갱신 | recordEvent/flushPendingRecord |
| R9-4 | delay 캡처: 직전 행동 후 경과 ms (0~5000 상한) | RECORD_MAX_DELAY |
| R9-5 | 재생: delay 있는 프리셋은 순차 재생(지연 + 5초 폴링), 없으면 기존 병렬 적용 유지 | replaySequential |
| R9-6 | 기존 프리셋/그룹/민감/내보내기 로직 하위 호환 | fields[] 재사용 + `delay`만 추가 |

### R10. 개인정보 자동 감지 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R10-1 | `pii-detect.js`(content.js보다 먼저 로드): type=password → autocomplete → 메타데이터 키워드 → 값 정규식 순 감지 | window.PiiDetect.isSensitive |
| R10-2 | 한국 PII 값 정규식: 휴대폰(+82)/유선/주민번호(날짜+체크섬)/카드(Luhn+BIN)/사업자(체크섬)/운전면허(지역 11~28)/여권/이메일 | 소스: toss/slash, ko-pii, kordoc, Bitwarden, validator.js, Braintree |
| R10-3 | 이름/주소/계좌번호는 메타데이터 키워드로만 판정 (값 정규식 단독 금지) | 오탐 방지 |
| R10-4 | 우편번호는 레거시 3-3 전체 일치 또는 키워드 앵커만 (부분 매치 오탐 방지) | "555-123-4567" FP 케이스 |
| R10-5 | 녹화/캡처 저장 시 자동 감지 필드 → `sensitive: true` = **마스킹 표시 신호** (저장 보호는 프리셋 전체 암호화 R6가 담당) | recordEvent/saveFromPanel |
| R10-6 | RECORD_SAVE 필드 재구성 시 `sensitive` 플래그 보존 (복사 누락 금지) | 마스킹 UX 유지 |
| R10-7 | `test/pii-detect-verify.mjs` 30/30 PASS | `npm run test:pii` |

---

## 3. 비기능 요구사항

| ID | 요구사항 | 비고 |
|----|----------|------|
| NFR-1 | Manifest V3 준수 (service_worker, content_scripts `<all_urls>`, permissions: storage/tabs/scripting) | manifest.json |
| NFR-2 | 네이티브 JS만 사용, 번들러/의존성 추가 금지 | devDependencies: playwright만 |
| NFR-3 | 모든 UI 문자열 한국어 | popup/content 패널/options |
| NFR-4 | 배포 산출물: `npm run build` → `dist/` (manifest/background/content/secure-store + popup/icons) | scripts/build.js |
| NFR-5 | 문법 검사: `npm run check` (node --check 전체 + manifest JSON 파싱) | package.json |
| NFR-6 | XSS 방어: popup/content에서 동적 값 삽입 시 `escapeHtml` 필수 | popup.js/content.js |
| NFR-7 | 타입 오류 억제(`as any`/`@ts-ignore`), 빈 catch, 테스트 삭제로 "통과" 금지 | 개발 규칙 |
| NFR-8 | 작업 단위: 워크트리 분리 → 병렬 실행 → master 머지 → 워크트리/브랜치 정리 | PARALLEL-WORK 메타프롬프트 |

## 4. 데이터 모델 (chrome.storage.local)

```js
// key: "presets" — 평문 인덱스 (필드 값 없음. 자동 적용 매칭/목록 fallback용)
{
  presets: [
    { id: "uuid", name: "프리셋 이름", urlPattern: "example.com", autoApply: false, updatedAt: 0 }
  ]
}

// key: "sec:preset:<id>" — 프리셋 전체 암호화 blob (AES-256-GCM)
// 복호화 후 형태:
{
  id: "uuid",
  name: "프리셋 이름",
  urlPattern: "example.com",            // wildcard: *.example.com, example.com/*
  fields: [
    {
      id: "uuid",
      label: "표시 이름",
      selector: "#user-name",           // CSS selector
      value: "실제 값",                  // 모든 필드 값이 blob 안에 암호화 저장됨
      type: "text" | "select" | "checkbox" | "radio" | "textarea",
      sensitive: false,                 // 마스킹 표시 신호 (저장 보호와 무관 — 전체가 암호화됨)
      delay: 0,                         // 녹화 전용. 직전 행동 후 경과 ms (0~5000), 기존 필드엔 없음
    }
  ],
  autoApply: false,
  createdAt: 0,
  updatedAt: 0,
}

// key: "groups" — 배열
{
  groups: [
    {
      id: "uuid",
      name: "제휴사 세팅",
      steps: [
        { presetId: "uuid", submitMode: "auto" | "manual", submitSelector: "button[type=submit]" },
        { presetId: "uuid", submitMode: "manual" },
      ],
      createdAt: 0,
      updatedAt: 0,
    }
  ]
}

// key: "runState" — chrome.storage.session (실행 상태 머신)
{ runId, groupId, groupName, stepIdx, totalSteps, status: "running"|"waiting"|"done"|"failed"|"aborted",
  stepResults, currentTabId, currentStep, error }

// key: "sec:preset:<id>" — 암호문 (AES-256-GCM, 프리셋 전체 JSON)
{ ct: "base64", iv: "base64" }

// key: "vault_key_v1" — AES 키 (자동 생성, base64 raw)
```

## 5. 메시지 프로토콜 (content ↔ background ↔ popup)

| 메시지 | 방향 | 설명 |
|--------|------|------|
| PRESET_LIST / CREATE / UPDATE / DELETE | popup↔background | 프리셋 CRUD (LIST는 복호화된 값 반환) |
| GROUP_LIST / CREATE / UPDATE / DELETE | popup↔background | 그룹 CRUD |
| RUN_GROUP / RUN_NEXT / RUN_ABORT / RUN_STATUS | popup→background | 그룹 실행 제어/조회 |
| CAPTURE_START / STOP / STATUS | popup→background→content | 캡처 모드 토글/조회 |
| CAPTURE_SAVE_FIELD | content→background | 캡처된 필드 저장 (프리셋 blob 갱신) |
| RECORD_START / STOP / SAVE | popup/content↔background | 녹화 모드 토글 + 녹화 저장 (전체 프리셋 암호화, sensitive 신호 보존) |
| APPLY_PRESET | popup/background→content | 프리셋 적용 (background가 blob 복호화 후 전달) |
| AUTO_APPLY_CHECK | content→background | 자동 적용 매칭 조회 |
| GET_CURRENT_URL | popup→background | 현재 탭 URL |
| EXPORT_DATA / IMPORT_DATA | popup→background | 백업/복원 (민감 복호화/재암호화) |
| SUBMIT_FORM | background→content | 그룹 auto 제출 |

## 6. 검증 체크리스트 (병렬 처리 진행 확인용)

병렬 작업 시 **각 작업이 이 체크리스트를 충족하는지**로 처리 여부를 판정한다. 요구사항 추가/변경 시 이 목록도 갱신한다.

### 통합 (모든 라운드 공통)
- [ ] `npm run check` exit 0 (node --check + manifest 파싱)
- [ ] `npm run build` exit 0, dist가 저장소와 일치 (빌드 후 git status 깨끗)
- [ ] `npm run test:encrypt` 12/12 PASS (blob 암호화 S1~S10 + 마이그레이션 M1~M2)
- [ ] `npm run test:pii` 30/30 PASS (PII 감지 판정)
- [ ] `npm run test:replay` PASS (녹화→저장→재생 통합)
- [ ] 변경 파일이 요구사항 ID(R1~R10)에 대응 — 어느 요구사항도 건드리지 않는 변경은 의심

### 기능별
- [ ] R1: 프리셋 CRUD + 패턴 매칭 + autoApply 동작
- [ ] R2: 캡처 하이라이트/패널/Enter 흐름/타입별 저장
- [ ] R3: 적용 모드 SPA 호환 + 타입별 세팅 + 패턴 검증
- [ ] R4: 그룹 순차 실행/auto·manual 제출/badge/중지
- [ ] R5: 내보내기(민감 복호화)/가져오기(검증+재암호화)/제한
- [ ] R6: 프리셋 전체 암호화 (인덱스/blob/복호화/재암호화/정리/마이그레이션)
- [ ] R7: 목록·편집 복사/마스킹/빈 값/더보기 토글
- [ ] R8: 암호화·녹화재생 통합 검증 스크립트 유지
- [ ] R9: 녹화 → 세팅 → 종료 → 재생 순서/타이밍 재생 + 기존 프리셋 하위 호환
- [ ] R10: PII 자동 감지 (메타데이터/값 정규식/오탐 방지) + 마스킹 신호 보존

## 7. 확정 결정 사항 요약 (decisions.md 상세)

| 결정 | 내용 |
|------|------|
| D1 | MV3 + 네이티브 JS (번들러 없음) |
| D2 | content script `<all_urls>` 선언적 주입 |
| D3 | 값 세팅 = 네이티브 value setter + dispatchEvent (SPA 호환) |
| D4 | 셀렉터 fallback: id > name > aria-label/placeholder > data-* > CSS 경로 |
| D5 | 프리셋 매칭 = 호스트 wildcard + 경로 패턴 |
| D6 | 캡처 모드 = 탭별 상태 (background Set) |
| D7 | 캡처 패널 Enter 키 입력 UX 머지 (`87145df`) |
| D8 | `프리셋-정보-관리` 브랜치 머지 보류 (별도 구현체, 통합 리스크) |
| D9 | 필드 단위 sensitive 플래그 암호화 머지 (`633325b`) |
| D10 | options_page 포팅 보류 (popup 관리와 중복) |
| D11 | 암호화 통합 검증 완료 (`826880c`, S1~S9) |
| D12 | `프리셋-정보-관리` 완전 흡수 판정, 추가 포팅 불필요 |
| D13 | 값 클릭복사 UX 머지 (`15e3aad`) |
| D14 | options_page 최종 보류 확정 |
| D15 | 녹화/재생 방식 채택 (기존 fields[] + delay, 캡처 모드 유지) |
| D16 | PII 자동 감지 채택 (pii-detect.js, 값 정규식+체크섬, 오탐 방지 규칙) |
| D17 | 프리셋별 전체 암호화 전환 (`sec:preset:<id>` blob + 평문 인덱스, 감지는 마스킹 전용 — D16 역할 변경) |
| D18 | 브라우저 E2E 채택 (Playwright headful 실제 확장 로드) — E2E로 발견된 버그 1건 수정: urlPattern에 포트 포함 시 `matchUrlPattern`이 `url.hostname`(포트 없음)과 비교해 **절대 매칭 실패** → 재생/자동적용 무력화. 포트 추출 후 별도 비교(패턴에 포트 있으면 포트도 일치해야 매칭). popup `hostMatchesPattern`도 동일 수정 |

## 8. 보류/미구현 항목

| 항목 | 상태 | 이유 |
|------|------|------|
| options_page (전용 설정 페이지) | 보류 확정 | popup 프리셋 관리와 기능 중복 (D10/D14) |
| `프리셋-정보-관리` 브랜치 병합 | 보류 | 별도 구현체, 가치 기능 전부 흡수 완료 (D8/D12), 참조용 보관 |
| 브라우저 E2E 테스트 (Playwright) | ✅ 해소 (R8-3) | `npm install playwright` 후 `test/browser-e2e-verify.mjs` 40/40 PASS (2026-08-16, R7) |

## 9. 변경 이력

| 날짜 | 라운드 | 변경 내용 | 관련 커밋 |
|------|--------|-----------|-----------|
| 2026-08-16 | R4 | 문서 최초 작성 (R1~R8 전체 기능 명세화) | — |
| 2026-08-16 | R5 | 녹화/재생(R9) + PII 자동 감지(R10) 추가, 필드 `delay`, RECORD_* 메시지, test:pii | — |
| 2026-08-16 | R6 | 프리셋별 전체 암호화 전환(D17): 평문 인덱스 + `sec:preset:<id>` blob, 레거시 마이그레이션, 감지=마스킹 전용, test:encrypt 12/12 + test:replay | — |
| 2026-08-16 | R7 | 브라우저 E2E(R8-3, D18): `npm install playwright`, `test/browser-e2e-verify.mjs` 40/40 (A 기본/B 녹화/C PII/D 재생/E 마이그레이션). E2E로 실제 버그 발견·수정: urlPattern 포트 미처리로 재생/자동적용 무력화 (matchUrlPattern·hostMatchesPattern). §8 보류 해소. | — |