# Decisions

## [2026-08-16] 제품명 다시하기
- **D33**: 사용자("form-preset이 안 맞음… 브라우저 자동화에 가깝지 않나?" → 추천대로 진행). 표시 이름 **다시하기**, 패키지/저장소 **dasihagi**. 매크로·자동화라는 말은 쓰지 않음. 내보내기 `appId`는 `dasihagi`, 가져오기는 예전 `form-preset-extension`도 허용. 메타프롬프트: `메타-프롬프트-제품명-다시하기.md`.

## [2026-08-16] iframe 안 폼
- **D32**: 사용자 질문("사내 어드민이 iframe… iframe은 안되?"). 이전에는 content script가 top만이라 iframe 입력이 안 붙었다. `all_frames` + `webNavigation.getAllFrames`로 모든 프레임에 녹화/적용. 교차 origin은 각 프레임의 content script가 처리(부모에서 iframe DOM 접근 없음). 칩은 top 또는 큰 iframe만. 메타프롬프트: `메타-프롬프트-iframe-지원.md`.

## [2026-08-16] 재생 속도 (페이지 이동 후 대기)
- **D31**: 사용자 요청("페이지이동후 쉬는동작이 있는데 설정으로 제어… 사내사이트는 봇 제한이 없어서 빠른속도로"). 전역 `ui:replayPace` = fast/normal/slow. 빠름은 녹화 delay를 40ms로 자르고 이동 후 추가 대기를 없앤다. 보통은 녹화 타이밍 + 이동 후 200ms. 느림은 delay 배율 + 이동 후 1초. 사내 도메인을 코드에 넣지 않고 popup에서 고른다. 메타프롬프트: `메타-프롬프트-재생-이동후대기-설정.md`.

## [2026-08-16] 녹화 중 팝업/새 탭 이어짐
- **D30**: 사용자 보고("A사이트에서 B사이트로 팝업이 뜬 경우는 녹화가 안되는거 같은데"). 녹화는 탭 ID에만 묶여 `window.open`/`_blank`로 열린 B에는 세션이 없었다. `openerTabId`가 녹화 중인 탭이면 같은 `sessionId` 세션을 공유하고, B complete에서 칩을 띄운다. B를 닫아도 A는 유지. 종료는 묶인 탭을 함께 멈춘 뒤 한 번 저장. 페이지 안 iframe(all_frames 없음)은 이번 범위 밖. 메타프롬프트: `메타-프롬프트-녹화-팝업창-이어짐.md`.

## [2026-08-16] UI P0 + Quick Win
- **D29**: 사용자 요청("제안 대로 진행하는 메타프롬프트를 만들고 실행"). P0: 이 사이트 녹화(생성+RECORD_START), `RECORD_STATUS` 배너+종료, 카드는 재생+⋯, 현재 사이트만 필터(기본 켜짐, `ui:filterCurrentSite`). Quick Win: 셀렉터 접기, 암호화 문구 순화, 그룹/여정 안내, 여정 자동적용 이유, 내보내기/가져오기 더보기, 새로고침 제거. P1/P2는 구현하지 않음. 메타프롬프트: `메타-프롬프트-UI-P0-개선.md`.

## [2026-08-16] 완성도 패스 (미커밋 워킹트리 품질)
- **D28**: 사용자 요청("물어보지 말고 스스로 진행하고 수정하며 완성도를 높일것"). 신규 기능 없이 기존 구현을 다듬음. 같은 탭·같은 프리셋 `RECORD_START`는 버퍼를 지우지 않음. 여정 카드에 `여정` 배지, 여정은 자동 적용 UI 비활성. 키 손상 시 `PRESET_LIST`가 오류를 돌려 popup 토스트로 안내. 필드 값 타입은 읽기 시 문자열로 정규화. fill-form 워크트리의 다른 여정 스키마(`action`/`RECORD_ACTION`)는 D20과 충돌하므로 흡수하지 않음. 메타프롬프트: `메타-프롬프트-완성도-향상.md`.

## [2026-08-16] 프리셋 여러 개 한 번에 삭제
- **D27**: 사용자 요청("프리셋 한번에 여러개 삭제"). 목록 체크박스 + 전체 선택 + 선택 삭제. `PRESET_DELETE_MANY { ids }`가 `deletePreset`를 돌리고 그룹 스텝은 한 번에 정리. 확인 없이 삭제하지 않음. 1개 삭제는 유지. 메타프롬프트: `메타-프롬프트-프리셋-여러개-삭제.md`.

## [2026-08-16] 녹화 이후 필드 표시 이름 수정
- **D26**: 사용자 요청("녹화후 해당필드의 이름을 수정할수 없다"). 편집 `renderFields`에서 이름 span을 input으로 바꿔 `fields[].label`을 저장한다. 녹화 흐름(이름 없이 자동 생성)은 유지. 공백 저장은 `필드`. 메타프롬프트: `메타-프롬프트-녹화-필드명-수정.md`.

## [2026-08-16] 녹화 중 방문 사이트 N개 자동 허용
- **D25**: 사용자 요청("최초 사이트 1개만 저장… 이동시 해당 사이트도 허용될수있게 자동 N 개로 저장"). 프리셋에 `urlPatterns: string[]`(최대 20)를 두고 `urlPattern`은 대표(첫) 사이트로 유지. 녹화 세션이 시작 URL과 `tabs.onUpdated` 이동 URL을 모아 `RECORD_STOP` 때 기존 패턴과 병합(이미 와일드카드가 커버하면 추가하지 않음, `chrome://` 제외). 재생·자동 적용·팝업 배지는 N개 중 하나라도 맞으면 허용. 그룹 실행은 대표 사이트만 연다. 메타프롬프트: `메타-프롬프트-녹화-다중사이트-허용.md`.

## [2026-08-16] README 사용법 GIF
- **D24**: 사용자 요청("README에 사용하는방법 움짤"). 실제 `dist` 확장을 Playwright로 로드해 스크린샷을 이어 붙임. `docs/gif/01-preset.gif`, `02-record-replay.gif`, `03-journey.gif`. 재생성: `npm run gif`. 가짜 목업 없음.

## [2026-08-16] 다른 프로젝트용 시작 메타프롬프트
- **D23**: 여정 작업 회고를 바탕으로, 질문/구현 서류 분리·3층 판정·제품/도구 분리·같은 턴 E2E·잔여 리스크 보고를 압축한 이식용 시작본을 둠. 생성기: `메타-프롬프트-시작용-메타프롬프트-생성.md`. 다른 레포에 넣을 파일: `프로젝트-시작-메타프롬프트.md`.

## [2026-08-16] 여정 녹화 Playwright E2E
- **D22**: 사용자 요청("E2E 테스트 까지 진행"). 기존 A~E 하니스에 **시나리오 F**(로컬 4페이지: 홈 검색 → 가격비교 더보기 → 비교 검색 → 상품)를 추가. 네이버 실접속 없음. Playwright는 검증 도구만(D21). `test/browser-e2e-verify.mjs` **49/49 PASS** (기존 40 + F 9). 메타프롬프트: `메타-프롬프트-여정-E2E.md`.

## [2026-08-16] 제품 런타임을 Playwright로 둘지
- **D21**: 사용자 질문("Playwright 베이스로 만드는게 그럼 나았나?"). **아니오 — 이 제품에는 확장 런타임이 맞고, Playwright는 E2E 도구로 두는 편이 낫다.** Playwright는 Node에서 CDP로 브라우저를 바깥에서 조종한다. MV3 확장 안에 넣을 수 없고, 크롬 웹스토어로 배포할 수 없으며, 사용자가 이미 로그인해 둔 Chrome(네이버 쿠키/세션)을 그대로 쓰지 못한다. Playwright로 만들면 사실상 **로컬 Node/데스크톱 RPA**가 되어 설치·프로파일·배포가 다른 제품이 된다. 확장 안 `chrome.debugger`로 Playwright처럼 붙는 방법은 주소창에 “디버깅 중” 경고가 떠 UX가 나쁘다. Playwright에서 배울 점은 로케이터(role/텍스트)·자동 대기이지 베이스 교체가 아니다. 메타프롬프트: `메타-프롬프트-Playwright-베이스-여부.md`.

## [2026-08-16] 멀티페이지 사용자 여정 녹화 구현
- **D20**: D19 판정 후 사용자 지시("구현 진행"). 녹화 버퍼를 content 메모리가 아니라 **background + `chrome.storage.session` (`recordSessions`)** 에 둔다. content는 확정 행동만 `RECORD_APPEND`. 페이지 이동 시 `tabs.onUpdated`가 `navigate`를 남기고 complete에서 `RECORD_START { resume }`로 칩/리스너를 복원한다. `fields[]`에 `type: click | keydown | navigate` 추가(기존 폼 타입 유지). 클릭은 가로채지 않음. 셀렉터 실패 시 보이는 글자로 `a/button` 폴백. `isJourneyPreset`이면 같은 탭 background 재생 + `startUrl`로 시작 페이지 정렬. 여정은 **자동 적용 제외**. 그룹(R4)은 새 탭 폼 채움 그대로. 네이버 하드코딩 없음. 메타프롬프트: `메타-프롬프트-멀티페이지-여정-녹화-구현.md`.

## [2026-08-16] 멀티페이지 사용자 여정 녹화 — 가능 여부 판정
- **D19**: 사용자 요청("네이버 메인 → 수저세트 검색 → 가격비교 더보기 → 재검색 → 상품 선택"을 **한 프리셋**으로 녹화·재생). **현재 제품으로는 불가.** 녹화는 한 문서의 폼 `input`/`change`만(`content.js` `isFormField`, `startRecordingMode`). 전체 페이지 이동 시 content script·버퍼 소멸. `recordTabs`는 탭 complete에서 녹화를 재개하지 않음. 재생(`replaySequential`/`applyField`)은 값 채움만 — 클릭·Enter·URL 이동 없음. 그룹(R4)은 페이지별 프리셋을 **새 탭**으로 열어 폼을 채우는 별 기능이며 한 프리셋 여정과 같지 않음. **MV3로 구현은 조건부 가능**(버퍼를 session/background로 이전, 탭 이동 후 녹화 재개, `click`/`keydown`/`navigate` 액션, 같은 탭 재생 상태 머신). **네이버 같은 동적 사이트는 셀렉터·검색 순위가 바뀌어 재생이 깨지기 쉬움.** 이번 라운드는 판정만, 구현 없음. 메타프롬프트: `메타-프롬프트-멀티페이지-사용자여정-녹화.md`.

## [2026-08-16] Round 7: 브라우저 E2E + 엣지케이스 검증
- **D18**: **실제 브라우저 E2E 채택** — 사용자 요청("실제 E2E. 테스트도 진행했어?" → "엣지케이스도 도출해서 테스트하도록해. 메타프롬프트로 변환해서 요청"). Playwright headful로 실제 Chromium에 `dist` 확장 로드(`--load-extension`), Node http 서버로 `test/test-form.html` 서빙, SW attach 후 `chrome.storage.local` 직접 검증, popup은 실제 확장 페이지를 열어 버튼 클릭. **SW 컨텍스트는 `import()` 금지**(ServiceWorker 사양) → 복호화 검증은 테스트 프로세스에서 `vault_key_v1`로 AES-256-GCM 직접 복호화(암호화 형식 검증 겸함). `chrome.runtime.reload()`는 확장 페이지 탐색이 `ERR_BLOCKED_BY_CLIENT`로 차단되어, E(마이그레이션)는 동일 profile 디렉토리로 context 재시작(실제 브라우저 재시작과 동일 조건)으로 검증. **E2E로 실제 버그 1건 발견·수정**: urlPattern에 포트 포함 시(`127.0.0.1:8765`) `matchUrlPattern`이 `url.hostname`(포트 없음)과 비교해 **절대 매칭 실패** → 재생/자동적용이 조용히 무력화되던 문제. 포트를 추출해 별도 비교(패턴에 포트 있으면 포트도 일치해야 매칭, 없으면 모든 포트 허용)로 수정, popup `hostMatchesPattern`(현재 사이트 배지)도 동일 수정. 검증: `test/browser-e2e-verify.mjs` **40/40 PASS**(A 기본 7 + B 녹화 10 + C PII 8 + D 재생 9 + E 마이그레이션 6), 회귀 유지(check/encrypt 12/pii 30/replay 28). test-form.html에 radio 그룹(결제수단) 추가. 메타프롬프트: `메타-프롬프트-브라우저-E2E.md`.

## [2026-08-16] Round 6: 프리셋별 전체 암호화 전환
- **D17**: **프리셋별 전체 암호화**로 전환 — 사용자 요청("그냥 통으로 암호화해서 저장 하는식으로 하는게 어때?") + 설계 확인(범위=프리셋별 덩어리, pii-detect=마스킹 UX용 유지). `presets` 키는 평문 인덱스 `[{id,name,urlPattern,autoApply,updatedAt}]`로 축소(필드 값 없음, 자동 적용 매칭은 인덱스로 복호화 없이 수행)하고, 프리셋 전체를 `sec:preset:<id>` blob 하나로 AES-256-GCM 암호화. **보호가 감지 품질과 분리** — 감지가 불완전해도 저장소 평문 0. 필드 단위 `sensitive`는 **마스킹 표시 신호**로 역할 변경(D16과 함께 명시적 폐기: D9의 필드 단위 암호화 대체). secure-store.js API는 재사용(setSecret/getSecret/deleteSecret에 'preset:' id). background: getPresetById/getAllPresets/savePreset/deletePreset 추가, resolvePreset* 제거, 모든 저장 핸들러 "복호화→수정→재암호화"로 단순화. **RECORD_SAVE 버그 수정**: field 재구성 시 `sensitive: !!e.sensitive` 복사 누락으로 민감 신호가 유실되던 문제 수정(원인 확정 후 수정). 레거시(필드 단위) 저장 데이터는 시작 시 `migrateLegacyStorage()` 1회 자동 이전(필드별 sec 키 복호화 → blob → 인덱스 → 정리). 검증: `test/encryption-verify.mjs` 재작성(blob S1~S10 + 마이그레이션 M1~M2 = 12/12 PASS), `test/record-replay-verify.mjs` 갱신(전체 암호화 + sensitive 보존 28/28 PASS), `test:pii` 30/30 유지. 메타프롬프트: `메타-프롬프트-프리셋-전체암호화.md`.

## [2026-08-16] Round 5: 녹화/재생 + 개인정보 자동 감지 암호화
- **D15**: 프리셋 등록 방식을 **녹화 방식**으로 개선 — 사용자는 녹화 시작 → 평소대로 폼 세팅 → 종료만 하면 되고, 표시 이름을 직접 지을 필요 없음. 카드 버튼이 `[재생][녹화]`로 교체 (캡처 모드는 유지). 녹화는 기존 `fields[]` 구조 재사용 + `delay`(직전 행동 후 경과 ms, 0~5000) 속성만 추가(하위 호환). text/textarea는 400ms 디바운스 + 다른 필드 이동 시 flush, select/checkbox/radio는 change 즉시, 같은 필드 연속 수정은 값만 갱신. 재생은 `replaySequential()`(delay 대기 + 5초 폴링) — delay 없는 기존 프리셋은 기존 병렬 적용 유지. 메시지: RECORD_START/RECORD_STOP/RECORD_SAVE.
- **D16**: **개인정보 자동 감지** 채택 — 신규 `pii-detect.js`(window.PiiDetect.isSensitive, content.js보다 먼저 로드)로 녹화/캡처 시 민감 필드를 자동 판정해 `sensitive: true`로 자동 암호화. 감지 순서: autocomplete 속성 → type=password → 메타데이터 키워드 → 값 정규식+체크섬. 소스: toss/slash, ko-pii, kordoc, Bitwarden, validator.js, Braintree. 이름/주소/계좌는 메타데이터 키워드로만 판정, 우편번호는 레거시 3-3 전체 일치 또는 키워드 앵커만 (부분 매치 오탐 방지: `555-123-4567` FP 케이스로 수정). RECORD_SAVE에 민감 필드 암호화 누락 보완(setSecret + value:''). 검증: `test/pii-detect-verify.mjs` 30/30 PASS, `npm run test:encrypt` 9/9 PASS.

## [2026-08-16] Round 4: 프리셋 값 클릭복사 UX 머지
- **D13**: 프리셋 필드 값 클릭복사 UX를 master에 머지 완료 (`15e3aad`, fast-forward). 목록 카드에 필드 값 행(민감 필드 `••••••` 마스킹 + 실값 복사, boolean/빈 값 처리, 5개 초과 더보기 토글), 편집 뷰에 복사 버튼. clipboard API + execCommand 폴백. XSS 대비 escapeHtml 처리.
- **D14**: options_page 추가는 최종 보류 확정 — D10/D12 재확인, popup 관리와 중복. 추가 포팅 대상 없음.

## [2026-08-16] Round 3: 암호화 통합 검증 + 프리셋-정보-관리 흡수 판정
- **D11**: 민감값 암호화 통합 검증 완료 — `test/encryption-verify.mjs` (mock chrome API로 실제 background.js 구동, S1~S9 전부 PASS, 커밋 `826880c`). 저장 평문 미노출/복호화 전달/재암호화/민감해제 정리/삭제 정리/가져오기 재암호화/내보내기 복호화 확인.
- **D12**: `프리셋-정보-관리` 브랜치(e1efe57)는 **완전 흡수 판정**. 가치 기능(secure-store 암호화, 필드 민감 체크, 프리셋 CRUD)이 모두 master에 흡수됨. 잔여 차이는 options_page와 클릭복사 UX뿐이며 options_page는 popup 관리와 중복(D10 재확인). 브랜치는 참조용으로만 보관, 추가 포팅 불필요.
- **후보**: 프리셋 필드 값 **클릭복사 UX** (master popup에 없음) — 필요 시 Round 4 후보

## [2026-08-16] Round 2: 민감값 AES-256-GCM 암호화 머지
- **D9**: 필드 단위 `sensitive` 플래그 방식으로 민감값 암호화를 master에 머지 완료 (`633325b`, fast-forward). secure-store.js 이식(background module 전환), 민감 필드는 값 암호화 저장(`sec:<presetId>:<fieldId>`), 조회/적용/내보내기 시 복호화, 가져오기 시 새 ID 재암호화. 캡처 패널·popup 편집에 민감 체크박스 추가. 기존 필드 평문 유지(하위 호환).
- **D10**: Round 2에서 옵션 페이지 포팅은 보류 (popup 프리셋 관리와 중복). 고유 요소(민감 체크박스)는 popup 편집 UI에 흡수 완료.

## [2026-08-16] 프리셋-등록-UI-UX개선 머지 + 프리셋-정보-관리 보류
- **D7**: 캡처 패널 Enter 키 입력 UX 개선을 master에 머지 완료 (`87145df`, fast-forward). 표시 이름 Enter → 값 입력창 표시 → Enter 저장, 패널 내부 클릭 시 pick 모드 방지
- **D8**: `프리셋-정보-관리` 워크트리(4커밋, Initial commit 기반 별도 구현체)는 머지 보류. master와 manifest·구조가 완전히 달라 통합 리스크 큼. AES-256-GCM 암호화·옵션 페이지 등 가치 있는 기능은 추후 master 아키텍처에 맞게 포팅하는 별도 계획으로 검토

## [2026-08-15] 아키텍처 결정
- **D1**: MV3 + 네이티브 JS (번들러 없음) — 크롬 익스텐션은 번들링 없이도 동작, 의존성 최소화
- **D2**: content script 을 `<all_urls>` 에 선언적 주입 — 동적 주입(scripting API)보다 단순하고 안정적
- **D3**: 값 세팅은 네이티브 value setter (Object.getOwnPropertyDescriptor) + dispatchEvent — React/Vue 이벤트 시스템 연동
- **D4**: 셀렉터 fallback 순서: id > name > aria-label/placeholder > data-* > CSS 경로 (document.querySelectorAll 로 고유성 검증)
- **D5**: 프리셋 매칭은 호스트명 기준 wildcard 패턴, 경로 패턴도 지원
- **D6**: 캡처 모드는 탭별 상태 (background 에서 Set 으로 관리, content script 에 메시지 전파)
