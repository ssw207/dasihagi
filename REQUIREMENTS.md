# 요구사항 정의서 — 다시하기 (dasihagi) Chrome Extension (Manifest V3)

> **이 문서의 역할**: 이 확장 프로그램이 **무엇을 해야 하는지**에 대한 단일 기준점(Source of Truth). 기능 추가/수정 시 반드시 이 문서를 기준으로 계획을 세우고, 병렬 처리 시 각 작업이 이 문서의 요구사항을 충족하는지로 진행 여부를 검증한다.
>
> **최신화 규칙**: 기능이 추가되거나 변경되면 반드시 이 문서를 갱신한다 (기능 요약, 데이터 모델, 메시지, 결정 사항). 갱신 주체는 해당 기능을 머지한 라운드.
>
> **관련 문서**: [`기획서.md`](기획서.md)(제품 범위·비목표, 역생성), [`docs/기안-사내테스트-다시하기.md`](docs/기안-사내테스트-다시하기.md)(사내 테스트 한정 기안, D37 작성 · D38 승인), `.sisyphus/notepads/form-preset-extension/decisions.md`(결정 D1~), `.sisyphus/plans/*.md`(라운드 계획), `README.md`(사용자 매뉴얼), `유즈케이스-실사용자.md`, `메타프롬프트/`(작업 메타프롬프트)
>
> **최종 갱신**: 2026-09-05 (D43~D48 채움 초안 CAP-1~7 전체, R19~R24)

---

## 1. 프로젝트 개요

| 항목 | 내용 |
|------|------|
| 이름 | 다시하기 (저장소: dasihagi) |
| 종류 | Chrome 확장 프로그램 (Manifest V3, 네이티브 JS — 번들러 없음) |
| 하는 일 | 특정 사이트의 폼에 들어가는 값을 프리셋으로 저장해 두고, 버튼 한 번으로 자동 채움 |
| 사용자 | 반복적으로 폼을 채워야 하는 일반 사용자 (개발자 아님, 한국어 사용자) |
| UI 언어 | 한국어 (모든 UI 문자열) |
| 저장소 | `chrome.storage.local` (프리셋/그룹/암호문), `chrome.storage.session` (실행 상태) |

## 2. 핵심 요구사항 (기능)

### R1. 프리셋 관리 (기본 CRUD) — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R1-1 | 사이트별 프리셋 생성/조회/수정/삭제 (여러 개 선택 삭제 포함) | popup에서 전 기능 동작, 하드코딩 사이트 없음 |
| R1-2 | 프리셋 = 이름 + 사이트 패턴(`urlPattern` 대표 + `urlPatterns` N개) + 필드 목록 | 데이터 모델(§4) 준수 |
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
| R3-4 | SPA 지연 렌더링 대응: MutationObserver + 300ms 디바운스, 최대 15초 | `content.js` applyPreset 재시도 |
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
| R5-2 | JSON 파일 가져오기: 스키마 검증(정수 schemaVersion, appId `dasihagi` 또는 레거시 `form-preset-extension`), 새 ID 부여, 민감 필드는 새 ID 기준 재암호화 | IMPORT_DATA |
| R5-3 | 가져오기 시 기존 항목 유지 + 새 항목 추가 (덮어쓰기 없음) | concat 방식 |
| R5-4 | 제한: 프리셋 500개 / 그룹 100개 / 파일 5MB. 프리셋당 필드 500개 초과 또는 필드 값 64KB 초과는 해당 프리셋만 제외 | `MAX_IMPORT_*` / `MAX_FIELDS_PER_PRESET` / `MAX_FIELD_VALUE_LENGTH` |

### R6. 프리셋 전체 암호화 저장 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R6-1 | 프리셋 전체(모든 필드 값)를 프리셋별 blob `sec:preset:<id>`로 AES-256-GCM 암호화 | savePreset/getPresetById |
| R6-2 | `presets` 키는 평문 인덱스 `[{id,name,urlPattern,urlPatterns,autoApply,updatedAt}]` — 필드 값 미포함, 자동 적용 매칭은 인덱스로 복호화 없이 수행 | getPresetIndex/AUTO_APPLY_CHECK |
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
| R7-4 | 빈 값은 `(값 없음)` + 복사 버튼 비활성. 손댈 칸은 `나중에 입력` (빈 값이면 복사 비활성 유지) | value === '' / handEdit |
| R7-5 | 필드 5개 초과 시 `+N개 더보기` 토글 | 목록 접기/펼치기 |
| R7-6 | 편집 뷰 필드 행에도 복사 버튼 (편집 중 최신 값 복사) | renderFields |
| R7-7 | 복사는 clipboard API + `execCommand('copy')` 폴백, 성공/실패 토스트 | copyToClipboard |

### R8. 회귀 테스트 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R8-1 | `test/encryption-verify.mjs`: mock chrome으로 실제 background.js 구동, 프리셋 blob 암호화 S1~S11 + 레거시 마이그레이션 M1~M2 검증 | `npm run test:encrypt` 전부 PASS |
| R8-2 | `test/record-replay-verify.mjs`: mock DOM+chrome으로 녹화→저장→재생 통합 검증 (전체 암호화 + sensitive 마스킹 신호 보존, 여정/다중사이트/팝업이어짐/모달/재생속도/손댈 칸) | `npm run test:replay` **141/141 PASS** |
| R8-3 | `test/browser-e2e-verify.mjs`: **실제 Chromium에 dist 확장 로드(headful)** + localhost 서버(test-form.html + journey-*.html) + SW `chrome.storage.local` 직접 검증. A~H + **I 중첩 iframe / J src 교체 / K 작은 iframe / L 유니코드** | `npm run test:e2e` **71/71 PASS** |
| R8-4 | `test/qa-edge-verify.mjs`: 메시지 sender, import 거부, chrome:// 녹화, 패턴(포트/IPv6/`*`), 그룹 빈 실행, 손상 blob | `npm run test:qa` **22/22 PASS** |

### R9. 녹화/재생 방식 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R9-1 | 프리셋 카드 버튼 `[재생][녹화]` (캡처 모드는 유지) | popup 카드 버튼 |
| R9-2 | 녹화: 시작 → 평소대로 세팅 → 종료(부동 칩) → 자동 저장, 표시 이름 직접 지정 불필요 | RECORD_START/STOP/SAVE |
| R9-3 | 녹화 이벤트: text/textarea는 input 400ms 디바운스 + 필드 이동 시 flush, select/checkbox/radio는 change 즉시, 같은 필드 연속 수정은 값만 갱신 | recordEvent/flushPendingRecord |
| R9-4 | delay 캡처: 직전 행동 후 경과 ms (0~5000 상한) | RECORD_MAX_DELAY |
| R9-5 | 재생: delay 있는 프리셋은 순차 재생(지연 + 5초 폴링), 없으면 기존 병렬 적용 유지 | replaySequential |
| R9-6 | 기존 프리셋/그룹/민감/내보내기 로직 하위 호환 | fields[] 재사용 + `delay`만 추가 |

### R11. 멀티페이지 사용자 여정 녹화/재생 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R11-1 | 녹화 버퍼는 background + `chrome.storage.session` (`recordSessions`). content 메모리만 믿지 않음 | RECORD_APPEND, 페이지 이동 후 이벤트 유지 |
| R11-2 | 페이지 이동 후에도 같은 탭 녹화 재개 (칩 `녹화 중 · N개` + 종료) | `tabs.onUpdated` complete → RECORD_START resume |
| R11-3 | 기록 타입: 기존 폼 + `click` + `keydown`(Enter) + `navigate`(URL) | fields[].type |
| R11-4 | 녹화 중 클릭을 가로채지 않음 (preventDefault 금지) | onRecordClick 관찰만 |
| R11-5 | 재생: 여정 프리셋은 같은 탭 background 순차 재생. `startUrl`로 시작 페이지 정렬 | replayJourney / APPLY_ACTION |
| R11-6 | 클릭 재생 시 셀렉터 실패하면 보이는 글자 폴백 | findByVisibleText |
| R11-7 | 여정 프리셋은 자동 적용하지 않음 | applyAutoPreset / AUTO_APPLY_CHECK 스킵 |
| R11-8 | 기존 폼 전용 녹화/재생·캡처·그룹·암호화 하위 호환 | isJourneyPreset가 아니면 기존 경로 |
| R11-9 | 사이트 전용 셀렉터/URL 하드코딩 금지 | 일반 셀렉터 + 텍스트 폴백 |
| R11-10 | 같은 페이지 입력 레이어: 열기 클릭 → 입력 → 확인 클릭(레이어 닫힘)을 시간 순으로 기록·재생 | e2e G, `test:replay` 모달 |

### R12. 녹화 중 방문 사이트 N개 자동 허용 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R12-1 | 녹화 시작 사이트 + 이동한 http(s) 사이트를 `urlPatterns`에 중복 없이 저장 (최대 20) | RECORD_START/STOP, session.allowedSites |
| R12-2 | `chrome://` 등 제한 URL은 허용 목록에 넣지 않음 | urlToSitePattern |
| R12-3 | 같은 호스트의 경로만 바뀌면 사이트가 늘지 않음. 기존 와일드카드가 커버하면 추가하지 않음 | mergeUrlPatterns |
| R12-4 | 재생·자동 적용·팝업 배지는 N개 중 하나라도 맞으면 허용 | matchPresetUrl |
| R12-5 | `urlPattern` 문자열은 대표(첫) 사이트로 유지. `urlPatterns` 없으면 `[urlPattern]` | 하위 호환 |
| R12-6 | 편집 UI는 한 줄에 하나(textarea). 목록은 `example.com 외 N개` | popup |
| R12-7 | 그룹 실행은 대표 `urlPattern`으로 탭을 연다 (여정으로 바꾸지 않음) | patternToUrl |

### R13. 녹화 이후 필드 표시 이름 수정 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R13-1 | 프리셋 편집에서 각 필드의 표시 이름(`fields[].label`)을 수정할 수 있다 | popup `data-label-edit` |
| R13-2 | 저장 후 목록 카드·재편집에 새 이름이 반영된다 | PRESET_UPDATE |
| R13-3 | 공백 이름은 저장 시 `필드`로 되돌린다 | normalizeFieldLabels |
| R13-4 | 값/민감/삭제/셀렉터 편집은 유지 | renderFields |

### R14. 프리셋 여러 개 한 번에 삭제 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R14-1 | 목록에서 프리셋을 여러 개 선택해 한 번에 삭제 | 체크박스 + 선택 삭제 |
| R14-2 | 전체 선택/해제, 0개면 삭제 버튼 비활성 | 선택 툴바 |
| R14-3 | 확인 창에 삭제 개수 표시. 확인 없이 삭제 금지 | confirm |
| R14-4 | blob + 인덱스 정리, 그룹 스텝에서 해당 presetId 제거 | PRESET_DELETE_MANY |
| R14-5 | 카드/편집의 1개 삭제는 유지 | PRESET_DELETE |

### R15. 팝업 UX (P0) — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R15-1 | 목록/빈 화면에서 **이 사이트 녹화**: 현재 호스트 프리셋 생성 후 즉시 녹화 | 제한 URL은 거절 |
| R15-2 | 녹화 중 popup 상단 배너(`녹화 중 · N개`) + 종료 | `RECORD_STATUS` |
| R15-3 | 카드 주 버튼은 재생, 녹화/편집/삭제는 `⋯` 메뉴 | 바깥 클릭 시 닫힘 |
| R15-4 | **현재 사이트만** 필터 (기본 켜짐, `ui:filterCurrentSite` 저장) | 0개면 안내 + 녹화 버튼 |
| R15-5 | 셀렉터 기본 접기, 암호화 문구 순화, 그룹/여정 안내, 여정 자동적용 이유, 내보내기·가져오기 더보기 | Quick Win |

### R16. 녹화 중 팝업/새 탭 이어짐 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R16-1 | A에서 녹화 중 `openerTabId`가 A인 B 탭/창이 열리면 같은 세션으로 녹화 재개 | onCreated / onUpdated + 칩 |
| R16-2 | B의 입력·클릭·이동이 같은 프리셋 `fields[]`에 시간 순으로 붙는다 | 공유 session.events |
| R16-3 | B URL은 허용 사이트에 추가. `chrome://` 팝업은 무시 | allowedSites |
| R16-4 | B를 닫아도 A 녹화는 유지. 종료는 연결된 탭 모두 칩 종료 후 한 번 저장 | RECORD_STOP |

### R17. 재생 속도 (페이지 이동 후 대기) — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R17-1 | 전역 설정 `ui:replayPace`: `fast` / `normal`(기본) / `slow`. 그 외 값은 `normal` | SETTINGS_GET/SET |
| R17-2 | 빠름: delay ≤40ms, 이동 후 추가 대기 0, 탭 complete 8초, 요소 대기 2.5초 | `paceDelayMs` / `paceAfterNavigateMs` / `paceTabWaitMs` / `paceWaitElementMs` |
| R17-3 | 보통: 녹화 delay 그대로 + 이동 후 200ms, 탭 15초, 요소 5초 | 기본값 |
| R17-4 | 느림: delay×1.5+200(상한 5000) + 이동 후 1초, 탭 20초, 요소 8초 | 외부 사이트 |
| R17-5 | popup에 **재생 속도** 세그먼트. 사이트 목록 하드코딩 없음 | 사용자가 고름 |

### R18. iframe 안 폼 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R18-1 | content script `all_frames: true` | iframe 안 input도 리스너 |
| R18-2 | 녹화/캡처/적용/제출 메시지를 탭의 모든 프레임에 전달 | webNavigation.getAllFrames |
| R18-3 | APPLY_ACTION은 성공한 첫 프레임, APPLY_PRESET은 프레임 결과 병합 | sendApplyToFrames |
| R18-4 | 녹화 칩은 top 또는 iframe `innerWidth≥240 && innerHeight≥160`만 | 작은 광고 iframe에 칩 난립 방지 |
| R18-5 | 늦게 생긴 iframe / src가 바뀐 프레임도 활성 녹화 세션에 합류 | content `RECORD_STATUS` 합류 + `webNavigation.onCompleted` 재개. iframe URL은 탭 navigate로 기록하지 않음 |

### R19. 손댈 칸 / 나중에 입력 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R19-1 | 채움 타입(`text` `textarea` `select` `checkbox` `radio`)의 저장 값이 비면 손댈 칸. 재생은 값을 넣지 않고 노란 `fp-hand-edit`를 input/change까지 유지 | 녹화 중 별도 버튼 없음. 칸을 비워 두면 손댈 칸 |
| R19-2 | 편집에서 손댈 칸을 켜고 끌 수 있다. 값이 있는 칸을 켜면 재생이 덮지 않고 노란 표시만 | popup `data-hand-edit` |
| R19-3 | `click` `keydown` `navigate`는 손댈 칸이 아니다 | isFillFieldType |
| R19-4 | 누락은 손댈 칸이 아닌 필드가 없거나 적용 실패한 경우, 또는 손댈 칸 요소를 못 찾은 경우. 손댈 칸 성공은 실패 개수에 넣지 않음 | 토스트: 채움 / 손댈 칸 / 누락 |
| R19-5 | 플래그 `handEdit`는 암호화 blob 안에만. 평문 인덱스에 필드 값·플래그 없음 | R6 |
| R19-6 | 레거시: `handEdit` 키 없음 + 채움 타입 + 값 `''` → 읽기 때 손댈 칸. 저장 전까지 blob 일괄 재기록 없음 | getPresetById |
| R19-7 | 목록 카드 손댈 칸 빈 값: `나중에 입력` (`값 없음` 아님). 복사 버튼은 빈 값이면 비활성 | buildFieldCopyRows |
| R19-8 | 화면 밖 손댈 칸은 자동 스크롤하지 않고 토스트 라벨로 존재를 알린다 | formatReplayToast |

### R20. 위험 클릭 재생 금지 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R20-1 | 기본 위험 글자는 `marking-rules.md` 목록과 같거나 그 단어로 끝날 때(대소문자 무시). 목록: `상신` `결재` `결제` `결제하기` `구매하기` `전송` `송금` `이체` `Pay` `Purchase` | `matchesDangerText` |
| R20-2 | `제출` `확인` `저장` `다음` `검색`은 기본 금지 아님 | 검색·임시저장 오차단 방지 |
| R20-3 | 판정은 `replayBlocked:boolean`(클릭 타입만). 저장·읽기 시 `replayBlocked`가 boolean이면 그 값, 없으면 보이는 글자로 기본값 | `resolveReplayBlocked` / `getPresetById` / `normalizeRecordEvent` / `CAPTURE_SAVE_FIELD` |
| R20-4 | 재생은 위험 클릭을 누르지 않고 `blocked:true`로 중단. 이후 필드는 멈춤. 토스트 `직접 누르기 N개` | `content.js applyField` `fp-blocked-click`, `replaySequential` `replayJourney` break, `formatReplayToast` |
| R20-5 | 편집에서 클릭 필드 `재생 금지`를 켜고 끌 수 있다. 켜면 재생이 누르지 않음, 끄면 누름 | `popup data-replay-blocked` |
| R20-6 | 그룹 `auto` 제출 버튼이 위험 글자면 자동 클릭하지 않고 `waiting`으로 사람 대기 | `handleStepTabLoaded` `SUBMIT_FORM blocked` |
| R20-7 | `replayBlocked`는 blob 안만. 평문 인덱스에 없음. 레거시는 키 없음 → 기본값, 저장 전까지 blob 일괄 재기록 없음 | R6 |

### R21. 파일 첨부 칸에서 멈춤 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R21-1 | `input[type=file]` 값은 확장이 채우지 못한다. 도달하면 값을 넣지 않고 `직접 첨부` 안내 | `content.js applyField` `fp-file-stop` `fileStop:true` |
| R21-2 | 파일 칸은 실패가 아니라 `applied fileStop`으로 집계. 이후 필드는 이어서 진행 가능 | `replaySequential` / `formatReplayToast` |
| R21-3 | 여정·그룹 모두 동일 | - |
| R21-4 | 토스트 `직접 첨부 N개`, 스타일 `.fp-file-stop` | `popup/popup.js` |

### R22. 프리셋별 재생 속도 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R22-1 | 프리셋에 `replayPace: 'fast'|'normal'|'slow'|''` (빈 값·키 없음이면 전역 따름) | `popup #ed-pace-row` `전역 따름` 버튼 |
| R22-2 | 프리셋 값이 있으면 전역 `ui:replayPace`를 덮는다. 없으면 전역을 따름 | `resolvePresetPace(preset, globalPace)` |
| R22-3 | 전역 `ui:replayPace`는 유지. 사이트 도메인 하드코딩 없음 | `SETTINGS_GET/SET` + 기획서 7.2 P0 |
| R22-4 | 재생 타이밍은 preset pace 기준으로 delay/이동 후 대기/요소 대기 | `paceDelayMs` / `paceAfterNavigateMs` / `paceWaitElementMs` + `paceTabWaitMs` |

### R23. 깨진 칸만 다시 찍기 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R23-1 | 편집에서 필드 `다시 찍기` → 페이지에서 칸을 가리키면 그 필드만 갱신 (전체 재녹화 없음) | `CAPTURE_START {replaceFieldId}` → `CAPTURE_SAVE_FIELD` → `findIndex(f.id===replaceId)` |
| R23-2 | 캡처와 같은 종류의 동작으로 필드 지정. 별 엔진 없음 | `content startCaptureMode` `replaceFieldId` |
| R23-3 | 갱신은 `id` 유지, `selector`·`value`만 갱신. 인덱스 작성부는 건드리지 않음 | `background CAPTURE_SAVE_FIELD` 머지 |
| R23-4 | 여정 중간 실패 후 그 칸만 리픽하면 재녹화 없이 재생 | `fieldId` 누락 → 리픽 → `failures 0` |

### R24. 값 없는 스크럽 내보내기 — ✅ 구현
| ID | 요구사항 | 수용 기준 |
|----|----------|-----------|
| R24-1 | `EXPORT_DATA {scrub:true}`는 `fields[].value=''`인 사본. 손댈 칸·금지 클릭·속도 표시는 남김 | `scrubPresetForExport` |
| R24-2 | 프리셋과 그룹을 함께 내보냄. 그룹엔 필드 값이 없음 | `EXPORT_DATA` |
| R24-3 | 기존 실값 내보내기 경로는 유지. 스크럽은 별 동작·별 파일명(`presets-scrub-*.json`) | `popup downloadExport(scrub)` |
| R24-4 | 스크럽 JSON 가져오기는 새 ID, 기존 항목 유지. 스키마·상한 R5 유지. 실값과 혼합 가져오기 충돌 없음 | `IMPORT_DATA` |

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
| NFR-1 | Manifest V3 준수 (service_worker, content_scripts `<all_urls>` `all_frames`, permissions: storage/tabs/scripting/webNavigation) | manifest.json |
| NFR-2 | 네이티브 JS만 사용, 번들러/런타임 의존성 추가 금지 | 개발: playwright(E2E), ffmpeg-static(README GIF) |
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
    { id: "uuid", name: "프리셋 이름", urlPattern: "example.com", urlPatterns: ["example.com"], autoApply: false, updatedAt: 0 }
  ]
}

// key: "sec:preset:<id>" — 프리셋 전체 암호화 blob (AES-256-GCM)
// 복호화 후 형태:
{
  id: "uuid",
  name: "프리셋 이름",
  urlPattern: "example.com",            // 대표(첫) 사이트. wildcard: *.example.com, example.com/*
  urlPatterns: ["example.com"],         // 허용 사이트 N개 (R12). 없으면 [urlPattern]
  fields: [
    {
      id: "uuid",
      label: "표시 이름",
      selector: "#user-name",           // CSS selector
      value: "실제 값",                  // 모든 필드 값이 blob 안에 암호화 저장됨
      type: "text" | "select" | "checkbox" | "radio" | "textarea" | "click" | "keydown" | "navigate",
      sensitive: false,                 // 마스킹 표시 신호 (저장 보호와 무관 — 전체가 암호화됨)
      delay: 0,                         // 녹화 전용. 직전 행동 후 경과 ms (0~5000), 기존 필드엔 없음
      handEdit: false,                  // 손댈 칸 (R19). 채움 타입만. 키 없음+값 ''이면 읽기 때 true
      replayBlocked: false,             // 재생 금지 클릭 (R20). click 타입만. 키 없음이면 보이는 글자로 기본값
      // type 확장(R11): "click" | "keydown" | "navigate"
      // click: selector + value(보이는 글자, 재생 폴백)
      // keydown: selector + value("Enter")
      // navigate: selector "" + value(절대 URL)
    }
  ],
  startUrl: "",                         // 여정 녹화 시작 탭 URL (선택, R11)
  replayPace: "fast"|"normal"|"slow"|"", // 프리셋별 재생 속도 (R22). ''·키 없음이면 전역 따름
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

// key: "recordSessions" — chrome.storage.session (녹화 버퍼. SW 재시작 생존)
{
  v: 2,
  tabs: { [tabId]: sessionId },
  sessions: {
    [sessionId]: {
      sessionId, presetId, events: [], lastRecordAt: 0,
      startUrl: "", lastUrl: "", allowedSites: []
    }
  }
}

// key: "sec:preset:<id>" — 암호문 (AES-256-GCM, 프리셋 전체 JSON)
{ ct: "base64", iv: "base64" }

// key: "vault_key_v1" — AES 키 (자동 생성, base64 raw)

// key: "ui:replayPace" — chrome.storage.local, "fast"|"normal"|"slow" (기본 "normal")
// key: "ui:filterCurrentSite" — chrome.storage.local, boolean (기본 true)
```

상한 상수 (`background.js`): 가져오기 프리셋 500 / 그룹 100 / 5MB, 프리셋당 필드 500, 필드 값 64KB, `urlPatterns` 20, `delay` 0~5000.

## 5. 메시지 프로토콜 (content ↔ background ↔ popup)

| 메시지 | 방향 | 설명 |
|--------|------|------|
| PRESET_LIST / CREATE / UPDATE / DELETE / DELETE_MANY | popup↔background | 프리셋 CRUD (LIST는 복호화된 값 반환, DELETE_MANY는 ids[]) |
| GROUP_LIST / CREATE / UPDATE / DELETE | popup↔background | 그룹 CRUD |
| RUN_GROUP / RUN_NEXT / RUN_ABORT / RUN_STATUS | popup→background | 그룹 실행 제어/조회 |
| CAPTURE_START / STOP / STATUS | popup→background→content | 캡처 모드 토글/조회 |
| CAPTURE_SAVE_FIELD | content→background | 캡처된 필드 저장 (프리셋 blob 갱신) |
| RECORD_START / STOP / SAVE | popup/content↔background | 녹화 모드 토글 + 녹화 저장 (전체 프리셋 암호화, sensitive 신호 보존) |
| RECORD_STATUS | popup/content↔background | 현재 탭 녹화 여부·presetId·eventCount. `tabId` 없으면 `sender.tab.id` |
| RECORD_APPEND | content→background | 확정된 행동 1건을 세션 버퍼에 추가 (페이지 이동 생존) |
| APPLY_ACTION | background→content | 여정 재생 중 한 행동(값/클릭/Enter) 적용 |
| APPLY_PRESET | popup/background→content | 프리셋 적용 (여정이면 background 같은 탭 재생, 아니면 content) |
| AUTO_APPLY_CHECK | content→background | 자동 적용 매칭 조회 |
| GET_CURRENT_URL | background 핸들러 유지 | popup은 `chrome.tabs.query` 직접 사용 |
| EXPORT_DATA / IMPORT_DATA | popup→background | 백업/복원 (민감 복호화/재암호화) |
| SUBMIT_FORM | background→content | 그룹 auto 제출 |
| SETTINGS_GET / SETTINGS_SET | popup↔background | 재생 속도(`replayPace`: fast/normal/slow) |

## 6. 검증 체크리스트 (병렬 처리 진행 확인용)

병렬 작업 시 **각 작업이 이 체크리스트를 충족하는지**로 처리 여부를 판정한다. 요구사항 추가/변경 시 이 목록도 갱신한다.

### 통합 (모든 라운드 공통)
- [x] `npm run check` exit 0 (node --check + manifest 파싱)
- [x] `npm run build` exit 0, dist가 저장소와 일치 (빌드 후 git status 깨끗)
- [x] `npm run test:encrypt` 13/13 PASS (blob 암호화 S1~S11 + 마이그레이션 M1~M2)
- [x] `npm run test:pii` 30/30 PASS (PII 감지 판정)
- [x] `npm run test:replay` 161/161 PASS (녹화→저장→재생 통합 + 여정/다중사이트/팝업이어짐/모달/재생속도/손댈 칸/위험 클릭·파일·프리셋 속도·리픽·스크럽)
- [x] `npm run test:qa` 22/22 PASS
- [x] `npm run test:e2e` 71/71 PASS
- [x] 변경 파일이 요구사항 ID(R1~R19,R20~R24)에 대응 — 어느 요구사항도 건드리지 않는 변경은 의심

### 기능별
- [x] R1: 프리셋 CRUD + 패턴 매칭 + autoApply 동작
- [x] R2: 캡처 하이라이트/패널/Enter 흐름/타입별 저장
- [x] R3: 적용 모드 SPA 호환 + 타입별 세팅 + 패턴 검증
- [x] R4: 그룹 순차 실행/auto·manual 제출/badge/중지
- [x] R5: 내보내기(민감 복호화)/가져오기(검증+재암호화)/제한
- [x] R6: 프리셋 전체 암호화 (인덱스/blob/복호화/재암호화/정리/마이그레이션)
- [x] R7: 목록·편집 복사/마스킹/빈 값/더보기 토글
- [x] R8: 암호화·녹화재생 통합 검증 스크립트 유지
- [x] R9: 녹화 → 세팅 → 종료 → 재생 순서/타이밍 재생 + 기존 프리셋 하위 호환
- [x] R10: PII 자동 감지 (메타데이터/값 정규식/오탐 방지) + 마스킹 신호 보존
- [x] R11: 여정 녹화(이동 후 재개/클릭/Enter/navigate/같은 페이지 모달) + 같은 탭 재생 + 폼 전용 하위 호환
- [x] R12: 녹화 중 방문 사이트 N개 자동 허용 + 레거시 urlPattern 하위 호환
- [x] R13: 편집에서 필드 표시 이름 수정 + 공백 시 `필드`
- [x] R14: 프리셋 여러 개 선택 삭제 + 그룹 스텝 정리
- [x] R15: 이 사이트 녹화 / 녹화 배너 / 카드 ⋯ 메뉴 / 현재 사이트만 필터
- [x] R16: 녹화 중 opener 팝업/새 탭 이어 녹화
- [x] R17: 재생 속도(이동 후 대기) fast/normal/slow
- [x] R18: iframe 안 폼 녹화/재생 (지연 로드 합류 포함)
- [x] R19: 손댈 칸(나중에 입력) 녹화·편집·재생 하이라이트, 누락과 구분
- [x] R20: 위험 클릭 재생 금지(보이는 글자 매칭, 편집 금지, 그룹 auto 대기) — CAP-4
- [x] R21: 파일 첨부 칸에서 멈춤·직접 첨부 안내 — CAP-6
- [x] R22: 프리셋별 재생 속도(프리셋이 전역 덮음) — CAP-5
- [x] R23: 깨진 칸만 다시 찍기(캡처 재사용, selector 갱신) — CAP-3
- [x] R24: 값 없는 스크럽 내보내기(프리셋+그룹, 값만 비움) — CAP-7

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
| D19 | 멀티페이지 사용자 여정 한 프리셋 녹화: 당시 제품은 불가, MV3 조건부 가능으로 판정 |
| D20 | 여정 녹화 구현: recordSessions + click/keydown/navigate + 같은 탭 재생 + startUrl. 여정 자동 적용 없음. 그룹은 그대로. |
| D21 | 제품 런타임은 MV3 확장. Playwright는 E2E 전용. Playwright 베이스로 바꾸는 것은 이 제품(스토어 배포·로그인된 Chrome)에 더 낫지 않음. |
| D22 | 여정 녹화 Playwright E2E(F) 추가. localhost 4페이지, 네이버 실접속 없음. 49/49 PASS. |
| D23 | 다른 프로젝트용 시작 메타프롬프트(`메타프롬프트/프로젝트-시작-메타프롬프트.md`) + 생성기. 질문과 구현의 서류 수준을 분리. |
| D24 | README 사용법 움짤: 실제 확장 화면 GIF 3개 (`docs/gif/`). `npm run gif`로 재촬영. |
| D25 | 녹화 중 방문 사이트를 `urlPatterns` N개로 자동 저장. 매칭은 아무 패턴이나. `urlPattern`은 대표(첫) 사이트. |
| D26 | 녹화(및 캡처) 후 편집 화면에서 필드 표시 이름을 수정할 수 있다. 스키마 변경 없음. |
| D27 | 프리셋 여러 개 선택 삭제. `PRESET_DELETE_MANY`, 확인 창, 그룹 스텝 정리. |
| D28 | 완성도 패스: 같은 프리셋 `RECORD_START` 버퍼 유지, 여정 배지, 여정 자동적용 UI 차단, 키 오류를 popup에 표시, 필드 값 읽기 정규화. fill-form 대체 스키마는 흡수하지 않음. |
| D29 | UI 제안 P0+Quick Win: 이 사이트 녹화, RECORD_STATUS 배너, 카드 ⋯ 메뉴, 현재 사이트만 필터, 셀렉터 접기, 툴바 더보기. P1/P2는 보류. |
| D30 | 녹화 중 A가 연 B 팝업/새 탭은 같은 세션으로 이어 녹화. sessionId로 탭을 묶고 RECORD_STOP은 묶인 탭을 함께 종료. |
| D31 | 재생 속도 전역 설정. 사내(봇 제한 없음)는 빠름, 외부는 보통/느림. 도메인 하드코딩 없음. |
| D32 | iframe 지원: all_frames + 전 프레임 메시지. 상위 페이지에서 cross-origin DOM을 읽지 않음. |
| D35 | 늦게 로드/교체되는 iframe도 녹화 합류. RECORD_STATUS는 sender.tab, content 부트 합류, webNavigation.onCompleted. iframe URL은 탭 navigate로 안 남김. |
| D36 | QA 엣지케이스 카탈로그(`QA-엣지케이스.md`) + `npm run test:qa` + E2E I/J/K/L. |
| D33 | 제품명 다시하기 / 저장소 dasihagi. 내보내기 appId 변경, 레거시 form-preset-extension 가져오기 허용. |
| D34 | 구현된 제품 기준 기획서 역생성 (`기획서.md`). 코드 변경 없음. |
| D37 | 사내 테스트 한정 개발 기안. 기획팅 + `docs/기안-사내테스트-다시하기.md`. 제품 기획서와 역할 분리. 코드 변경 없음. |
| D38 | 기안 승인. §11 네 항목·K1~K9. 범위 확대 없음. 코드 변경 없음. |
| D39 | 소스 기준 문서 최신화. 런타임 코드 변경 없음. 테스트 수·저장 키·R11-10 모달을 코드와 맞춤. |
| D40 | BMAD Method(BMM v6.12) 개발 워크플로 설치. Grok 스킬. 제품 기능 아님. |
| D41 | BMAD 스킬을 help/spec/build 3개로 축소. 제품 기능 아님. |
| D42 | `bmad-brainstorming` 복원. 유지 4개: help / brainstorming / spec / build. |
| D43 | 손댈 칸/나중에 입력. 빈 채움 값은 재생이 덮지 않고 노란 표시. 셀렉터 실패만 누락. |
| D44 | 위험 클릭 재생 금지. 기본 단어 10개(상신·결재·결제·결제하기·구매하기·전송·송금·이체·Pay·Purchase) 보이는 글자 매칭, 편집 덮어쓰기, 그룹 auto도 대기. |
| D45 | 파일 첨부 칸에서 멈춤. fileStop은 실패 아님, 직접 첨부 안내. |
| D46 | 프리셋별 재생 속도. 전역 유지하되 프리셋이 덮음, 사이트 하드코딩 없음. |
| D47 | 깨진 칸만 다시 찍기. 캡처 재사용·replaceFieldId로 selector 갱신, 전체 재녹화 없음. |
| D48 | 값 없는 스크럽 내보내기. 필드 값만 비움, 그룹 포함, 실값 경로 유지. |

## 8. 보류/미구현 항목

| 항목 | 상태 | 이유 |
|------|------|------|
| options_page (전용 설정 페이지) | 보류 확정 | popup 프리셋 관리와 기능 중복 (D10/D14) |
| `프리셋-정보-관리` 브랜치 병합 | 보류 | 별도 구현체, 가치 기능 전부 흡수 완료 (D8/D12), 참조용 보관 |
| 브라우저 E2E 테스트 (Playwright) | ✅ 해소 (R8-3, D22, D35, D36) | `npm run test:e2e` 71/71 PASS (I 중첩·J src교체·K 작은 iframe·L 유니코드 포함) |
| 멀티페이지 사용자 여정 녹화/재생 (한 프리셋, 클릭·검색·페이지 이동) | ✅ 해소 (R11, D20) | recordSessions + 클릭/Enter/이동 녹화 + 같은 탭 재생. 동적 사이트의 셀렉터 불안정은 제품 한계로 README에 명시. |

## 9. 변경 이력

| 날짜 | 라운드 | 변경 내용 | 관련 커밋 |
|------|--------|-----------|-----------|
| 2026-08-16 | R4 | 문서 최초 작성 (R1~R8 전체 기능 명세화) | — |
| 2026-08-16 | R5 | 녹화/재생(R9) + PII 자동 감지(R10) 추가, 필드 `delay`, RECORD_* 메시지, test:pii | — |
| 2026-08-16 | R6 | 프리셋별 전체 암호화 전환(D17): 평문 인덱스 + `sec:preset:<id>` blob, 레거시 마이그레이션, 감지=마스킹 전용, test:encrypt 12/12 + test:replay | — |
| 2026-08-16 | R7 | 브라우저 E2E(R8-3, D18): `npm install playwright`, `test/browser-e2e-verify.mjs` 40/40 (A 기본/B 녹화/C PII/D 재생/E 마이그레이션). E2E로 실제 버그 발견·수정: urlPattern 포트 미처리로 재생/자동적용 무력화 (matchUrlPattern·hostMatchesPattern). §8 보류 해소. | — |
| 2026-08-16 | D19 | 멀티페이지 사용자 여정 한 프리셋 녹화: **당시 불가 / MV3 조건부 가능**. 메타프롬프트 `메타-프롬프트-멀티페이지-사용자여정-녹화.md`. | — |
| 2026-08-16 | D20 | 여정 녹화 구현(R11): session 버퍼, click/keydown/navigate, 같은 탭 재생, startUrl, 자동 적용 제외. 메타프롬프트 `메타-프롬프트-멀티페이지-여정-녹화-구현.md`. | — |
| 2026-08-16 | D21 | 제품 런타임은 확장, Playwright는 E2E 전용. Playwright 베이스 교체는 이 제품에 더 낫지 않음. | — |
| 2026-08-16 | D22 | 여정 E2E(F): journey-*.html + 시나리오 F. `npm run test:e2e` 49/49. 메타프롬프트 `메타-프롬프트-여정-E2E.md`. | — |
| 2026-08-16 | D23 | 이식용 시작 메타프롬프트 + 생성기. | — |
| 2026-08-16 | D25 | 녹화 다중 사이트 허용(R12): 이동한 사이트를 `urlPatterns`에 자동 추가. 메타프롬프트 `메타-프롬프트-녹화-다중사이트-허용.md`. | — |
| 2026-08-16 | D26 | 녹화 후 필드명 수정(R13): 편집 화면에서 `fields[].label` 직접 수정. 메타프롬프트 `메타-프롬프트-녹화-필드명-수정.md`. | — |
| 2026-08-16 | D27 | 프리셋 여러 개 삭제(R14): 체크박스 + `PRESET_DELETE_MANY`. 메타프롬프트 `메타-프롬프트-프리셋-여러개-삭제.md`. | — |
| 2026-08-16 | D28 | 완성도 패스: 녹화 재시작 가드, 여정 배지/자동적용 비활성, vault 키 오류 안내, 필드 값 정규화. 메타프롬프트 `메타-프롬프트-완성도-향상.md`. | — |
| 2026-08-16 | D29 | UI P0(R15): 이 사이트 녹화, 녹화 배너, 카드 메뉴, 현재 사이트만. 메타프롬프트 `메타-프롬프트-UI-P0-개선.md`. | — |
| 2026-08-16 | D30 | 팝업/새 탭 이어 녹화(R16). 메타프롬프트 `메타-프롬프트-녹화-팝업창-이어짐.md`. | — |
| 2026-08-16 | D31 | 재생 속도(R17): 페이지 이동 후 대기 조절. 메타프롬프트 `메타-프롬프트-재생-이동후대기-설정.md`. | — |
| 2026-08-16 | D32 | iframe 녹화/재생(R18). 메타프롬프트 `메타-프롬프트-iframe-지원.md`. | — |
| 2026-08-16 | docs | README를 공개 GitHub 기준 설치·사용 설명으로 전면 갱신. 메타프롬프트 `메타-프롬프트-README-깃허브-사용설명.md`. | — |
| 2026-08-16 | D33 | 제품명 다시하기(dasihagi). 메타프롬프트 `메타-프롬프트-제품명-다시하기.md`. | — |
| 2026-08-16 | docs | README 목차·설치·여정/그룹 표 정리. 움짤은 `npm run gif`로 다시 촬영. | — |
| 2026-08-16 | docs | 메타프롬프트를 `메타프롬프트/` 한 폴더로 모음. | — |
| 2026-08-30 | D34 | 제품 기획서 역생성 (`기획서.md`). 기능 변경 없음. 메타프롬프트 `메타-프롬프트-기획서-역생성.md`. | — |
| 2026-08-30 | D35 | 늦게 생긴 iframe이 녹화 세션에 합류 (R18-5). 메타프롬프트 `메타-프롬프트-iframe-녹화-검토.md`. | — |
| 2026-08-30 | D36 | QA 엣지케이스 도출·실행 (`QA-엣지케이스.md`, `test:qa`, e2e I~L). 메타프롬프트 `메타-프롬프트-QA-엣지케이스-진행.md`. | — |
| 2026-08-30 | D37 | 사내 테스트 한정 기안 (기획팅 + `docs/기안-사내테스트-다시하기.md`). 코드 변경 없음. 메타프롬프트 `메타-프롬프트-사내테스트-기안-기획서.md`. | — |
| 2026-08-30 | D38 | 기안 승인 (§11 네 항목). 코드 변경 없음. 메타프롬프트 `메타-프롬프트-사내테스트-기안-승인.md`. | — |
| 2026-09-05 | D39 | 소스 기준 문서 최신화 (테스트 수, 저장 키, R3-4/R5/R11-10/R17/R18-4, iframe 유즈케이스). 코드 변경 없음. 메타프롬프트 `메타-프롬프트-소스기준-문서최신화.md`. | — |
| 2026-09-05 | D40 | BMAD Method 설치 (`_bmad/`, Grok 29 스킬). 제품 코드 변경 없음. 메타프롬프트 `메타-프롬프트-BMAD-설치.md`. | — |
| 2026-09-05 | D41 | BMAD 스킬 축소: help / spec / build만. 메타프롬프트 `메타-프롬프트-BMAD-스킬-축소.md`. | — |
| 2026-09-05 | D42 | `bmad-brainstorming` 복원. 메타프롬프트 `메타-프롬프트-BMAD-브레인스토밍-유지.md`. | — |
| 2026-09-05 | D43 | 손댈 칸/나중에 입력(R19). 메타프롬프트 `메타-프롬프트-손댈칸-나중에입력.md`. | — |
| 2026-09-05 | D44~D48 | 채움 초안 CAP-4~7: 위험 클릭 금지(R20)·파일 스톱(R21)·프리셋 속도(R22)·리픽(R23)·스크럽(R24). `replayBlocked`/`replayPace`/`fileStop`/`replaceFieldId`/`scrub`. 테스트 141→161. 메타프롬프트 `메타-프롬프트-채움초안-스토리2-6.md`. | — |