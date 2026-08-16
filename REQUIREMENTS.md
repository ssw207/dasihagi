# 요구사항 정의서 — 폼 프리셋 Chrome Extension (Manifest V3)

> **이 문서의 역할**: 이 확장 프로그램이 **무엇을 해야 하는지**에 대한 단일 기준점(Source of Truth). 기능 추가/수정 시 반드시 이 문서를 기준으로 계획을 세우고, 병렬 처리 시 각 작업이 이 문서의 요구사항을 충족하는지로 진행 여부를 검증한다.
>
> **최신화 규칙**: 기능이 추가되거나 변경되면 반드시 이 문서를 갱신한다 (기능 요약, 데이터 모델, 메시지, 결정 사항). 갱신 주체는 해당 기능을 머지한 라운드.
>
> **관련 문서**: `.sisyphus/notepads/form-preset-extension/decisions.md`(결정 D1~), `.sisyphus/plans/*.md`(라운드 계획), `README.md`(사용자 매뉴얼)
>
> **최종 갱신**: 2026-08-16 (Round 4)

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
| R1-5 | 하위 호환: 기존 프리셋 데이터(평문 필드) 무마이그레이션 동작 | 필드에 `sensitive` 없는 경우 기존대로 동작 |

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

### R6. 민감값 암호화 저장 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R6-1 | 필드 단위 `sensitive` 플래그: 체크된 필드만 암호화 저장 | 캡처 패널/popup 편집에 민감 체크박스 |
| R6-2 | AES-256-GCM 암호화, 키는 자동 생성 (`vault_key_v1`), 매 저장 새 IV | secure-store.js |
| R6-3 | 저장 시 평문 미노출: `presets` 배열에는 `value:''` + 민감 필드 값은 `sec:<presetId>:<fieldId>` 키에 암호문 | 통합 검증 S1~S9 |
| R6-4 | 복호화 지점: PRESET_LIST(편집용), APPLY_PRESET/AUTO_APPLY_CHECK/그룹 실행(적용용), EXPORT_DATA(백업용) | background resolvePreset |
| R6-5 | 가져오기 시 새 ID 기준 재암호화 | IMPORT_DATA |
| R6-6 | 민감 해제/프리셋 삭제 시 암호문 정리 | deleteSecret |
| R6-7 | 보호 수준: 로컬 열람/백업 유출/문자열 검색 방어 (정적 분석 수준. OS 키체인 수준은 확장만으로 불가 — 한계 명시) | secure-store.js 주석 |

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
| R8-1 | `test/encryption-verify.mjs`: mock chrome으로 실제 background.js 구동, 암호화 S1~S9 검증 | `npm run test:encrypt` 전부 PASS |

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
// key: "presets" — 배열
{
  presets: [
    {
      id: "uuid",
      name: "프리셋 이름",
      urlPattern: "example.com",            // wildcard: *.example.com, example.com/*
      fields: [
        {
          id: "uuid",
          label: "표시 이름",
          selector: "#user-name",           // CSS selector
          value: "",                        // 민감 필드는 '' 저장 (실값은 sec:<presetId>:<fieldId>)
          type: "text" | "select" | "checkbox" | "radio" | "textarea",
          sensitive: false,                 // 선택. true면 값 암호화 저장
        }
      ],
      autoApply: false,
      createdAt: 0,
      updatedAt: 0,
    }
  ]
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

// key: "sec:<presetId>:<fieldId>" — 암호문 (AES-256-GCM)
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
| CAPTURE_SAVE_FIELD | content→background | 캡처된 필드 저장 (민감 필드 암호화) |
| APPLY_PRESET | popup/background→content | 프리셋 적용 (background가 복호화 후 전달) |
| AUTO_APPLY_CHECK | content→background | 자동 적용 매칭 조회 |
| GET_CURRENT_URL | popup→background | 현재 탭 URL |
| EXPORT_DATA / IMPORT_DATA | popup→background | 백업/복원 (민감 복호화/재암호화) |
| SUBMIT_FORM | background→content | 그룹 auto 제출 |

## 6. 검증 체크리스트 (병렬 처리 진행 확인용)

병렬 작업 시 **각 작업이 이 체크리스트를 충족하는지**로 처리 여부를 판정한다. 요구사항 추가/변경 시 이 목록도 갱신한다.

### 통합 (모든 라운드 공통)
- [ ] `npm run check` exit 0 (node --check + manifest 파싱)
- [ ] `npm run build` exit 0, dist가 저장소와 일치 (빌드 후 git status 깨끗)
- [ ] `npm run test:encrypt` 9/9 PASS (기존 기능 회귀 없음)
- [ ] 변경 파일이 요구사항 ID(R1~R8)에 대응 — 어느 요구사항도 건드리지 않는 변경은 의심

### 기능별
- [ ] R1: 프리셋 CRUD + 패턴 매칭 + autoApply 동작
- [ ] R2: 캡처 하이라이트/패널/Enter 흐름/타입별 저장
- [ ] R3: 적용 모드 SPA 호환 + 타입별 세팅 + 패턴 검증
- [ ] R4: 그룹 순차 실행/auto·manual 제출/badge/중지
- [ ] R5: 내보내기(민감 복호화)/가져오기(검증+재암호화)/제한
- [ ] R6: 민감 저장 평문 미노출/복호화 전달/정리/재암호화
- [ ] R7: 목록·편집 복사/마스킹/빈 값/더보기 토글
- [ ] R8: 암호화 통합 검증 스크립트 유지

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

## 8. 보류/미구현 항목

| 항목 | 상태 | 이유 |
|------|------|------|
| options_page (전용 설정 페이지) | 보류 확정 | popup 프리셋 관리와 기능 중복 (D10/D14) |
| `프리셋-정보-관리` 브랜치 병합 | 보류 | 별도 구현체, 가치 기능 전부 흡수 완료 (D8/D12), 참조용 보관 |
| 브라우저 E2E 테스트 (Playwright) | 미착수 | playwright 미설치. 확장 로드 수준의 E2E가 필요해지면 `npm install` 후 진행 |

## 9. 변경 이력

| 날짜 | 라운드 | 변경 내용 | 관련 커밋 |
|------|--------|-----------|-----------|
| 2026-08-16 | R4 | 문서 최초 작성 (R1~R8 전체 기능 명세화) | — |