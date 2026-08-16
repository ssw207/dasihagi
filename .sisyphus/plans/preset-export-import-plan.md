# 계획: 프리셋 내보내기/가져오기 기능

## 1. 배경 및 목표

"폼 프리셋" Chrome 확장 프로그램(MV3)에 **저장된 프리셋과 그룹을 파일로 내보내기/가져오기** 하는 기능을 추가한다.

- **내보내기**: 사용자가 저장한 프리셋(+그룹)을 JSON 파일로 다운로드
- **가져오기**: JSON 파일을 선택 → 검증 → 확인 → 저장소에 반영

**목표**: 코드베이스의 기존 패턴(메시지 기반 아키텍처, toast 알림, escapeHtml)을 그대로 따르며, 외부 라이브러리 없이 구현한다.

## 2. 현재 코드베이스 분석 (탐색 결과)

| 항목 | 내용 |
|---|---|
| 저장소 | `chrome.storage.local` — 키 `presets`, `groups` |
| 프리셋 구조 | `{ id, name, urlPattern, fields: [{label, type, selector, value}], autoApply, createdAt, updatedAt }` |
| 그룹 구조 | `{ id, name, steps: [{presetId, submitMode, submitSelector}], createdAt, updatedAt }` |
| 백그라운드 | `background.js` — `handleMessage` switch 문으로 메시지 타입별 처리, `sendResponse({ok, data/error})` |
| 팝업 | `popup/popup.html` + `popup/popup.js` — 프리셋 탭/그룹 탭, `sendMessage()` 래퍼, `showToast()`, `escapeHtml()` |
| 메시지 타입 | `PRESET_LIST/CREATE/UPDATE/DELETE`, `GROUP_LIST/CREATE/UPDATE/DELETE`, `RUN_*`, `CAPTURE_*`, `APPLY_PRESET` 등 |
| 빌드 | `scripts/build.js` — dist로 복사, `npm run check`로 문법 검사 |
| 작업 위치 | 실제 확장 코드는 형제 워크트리 `여러-페이지-복합-세팅-기능-추가`에 있음 (현재 워크트리는 빈 상태) |

### 데이터 흐름
```
popup.js ── chrome.runtime.sendMessage({type, ...}) ──▶ background.js handleMessage()
                                                     ──▶ chrome.storage.local
```

### 핵심 제약
- `fields[].selector`는 CSS 셀렉터, `value`는 문자열(boolean은 `"true"/"false"`)
- 그룹 `steps[].presetId`는 프리셋 `id`를 참조 — **가져오기 시 ID 매핑이 필수**
- 프리셋 ID는 `crypto.randomUUID()` 생성

## 3. 설계 결정 사항

### 3-1. 내보내기 파일 스키마 (JSON, `schemaVersion: 1`)

```json
{
  "schemaVersion": 1,
  "appId": "form-preset-extension",
  "exportedAt": "2026-08-15T22:30:00.000Z",
  "presets": [ { "id": "...", "name": "...", "urlPattern": "...", "fields": [...], "autoApply": false, "createdAt": 0, "updatedAt": 0 } ],
  "groups":   [ { "id": "...", "name": "...", "steps": [{ "presetId": "...", "submitMode": "manual", "submitSelector": "" }], "createdAt": 0, "updatedAt": 0 } ]
}
```

- `schemaVersion`으로 하위 호환 보장. 이후 스키마 변경 시 `schemaVersion` 증가 + 마이그레이션 함수 추가.
- 프리셋/그룹 원본 객체를 그대로 포함(필드 누락 방지). `appId`로 다른 확장 파일과 구분.

### 3-2. 내보내기 플로우

1. 프리셋 탭 툴바에 **"내보내기"** 버튼 추가
2. 클릭 → `EXPORT_DATA` 메시지 → background가 `presets`+`groups` 반환
3. popup에서 JSON 직렬화 → `Blob` + `URL.createObjectURL` → `<a download>` 클릭 → `revokeObjectURL`
4. 파일명: `presets-YYYY-MM-DD.json` (현지 날짜)
5. 데이터가 0개면 버튼 비활성화 대신 toast로 "내보낼 데이터가 없습니다" 안내 (버튼은 항상 활성, 가벼운 피드백)

### 3-3. 가져오기 플로우

1. 프리셋 탭 툴바에 **"가져오기"** 버튼 추가 → 숨겨진 `<input type="file" accept=".json">` 트리거
2. 파일 선택 → `FileReader`로 읽기 → `JSON.parse`
3. **검증** (아래 3-4) 통과 시 확인 다이얼로그(`confirm`) 표시:
   - "프리셋 N개, 그룹 M개를 가져옵니다. 기존 항목은 유지되고, 이름이 같으면 추가됩니다. 계속할까요?"
4. 확인 → `IMPORT_DATA` 메시지 → background가 **새 ID 부여 + 저장** → popup이 목록 새로고침 + toast "가져오기 완료"
5. 취소 시 아무것도 저장하지 않음

### 3-4. 검증 규칙 (가져오기)

| 단계 | 검사 | 실패 시 |
|---|---|---|
| 1 | `JSON.parse` 성공 | "파일을 읽을 수 없습니다. 올바른 JSON 파일인지 확인하세요." |
| 2 | 최상위가 객체, `schemaVersion` 존재 | "지원되지 않는 파일 형식입니다." |
| 3 | `schemaVersion` ≤ 현재 버전 | "새 버전의 파일입니다. 확장 프로그램을 업데이트하세요." |
| 4 | `presets`/`groups`가 배열(없으면 빈 배열로 간주) | 해당 키 무시 |
| 5 | 개별 프리셋: `name`(문자열), `urlPattern`(문자열), `fields`(배열), 각 field에 `label`/`selector`/`value` | 해당 프리셋만 건너뛰고 유효한 것만 가져옴 |
| 6 | 개별 그룹: `name`(문자열), `steps`(배열), 각 step의 `presetId`가 **가져온 프리셋에 존재** | 없는 step은 제거, step이 0개면 그룹 건너뜀 |
| 7 | 개수 제한: 프리셋 ≤ 500, 그룹 ≤ 100 | 초과분은 건너뜀 (toast로 안내) |
| 8 | 파일 크기 ≤ 5MB | "파일이 너무 큽니다." |

**ID 정책**: 가져온 프리셋/그룹은 **새 `crypto.randomUUID()` ID를 부여**하고 기존 항목과 무관하게 추가한다. (사용자 결정 완료)
- 기존 데이터 보존 보장 (덮어쓰기 없음)
- 그룹 `steps[].presetId`는 가져온 프리셋의 새 ID로 **재매핑** (이것이 핵심 처리)

**보안**: 가져온 데이터를 `eval`하지 않음, `innerHTML` 삽입 시 `escapeHtml()` 사용(popup.js 기존 함수), 셀렉터 문자열은 저장만 하고 실행하지 않음.

### 3-5. 엣지 케이스 체크리스트

- [x] 파일이 비어 있거나 0바이트
- [x] 확장자가 `.json`이 아닌 파일 (accept 속성으로 대부분 차단, 그래도 검증은 동작)
- [x] 손상된 JSON (파싱 실패)
- [x] `schemaVersion` 누락/문자열/미래 버전
- [x] `presets`/`groups`가 배열이 아님 (객체/문자열)
- [x] 프리셋에 `name` 없는 경우 / 필드에 `selector` 없는 경우
- [x] 그룹이 참조하는 프리셋이 가져온 파일에 없음 → step 제거 후 가져오기
- [x] 동일 이름 프리셋이 이미 존재 → 중복 허용(새 ID) — 사용자에게 안내 문구
- [x] 가져오기 중 `chrome.storage` 오류 (`runtime.lastError`)
- [x] 5MB 초과 파일
- [x] 유니코드/한글/이모지 이름 (JSON 직렬화에서 안전)
- [x] 같은 파일 연속 가져오기 → 중복이 계속 늘어남 (안내 문구로 인지 가능하게)
- [x] 프리셋이 0개인 상태에서 내보내기 → "내보낼 데이터가 없습니다"

## 4. 구현 단계

### 0단계: 작업 위치 확정 (사용자 결정 완료)
현재 워크트리(`저장한-프리셋-내보내기-가져오기-기능추가`)는 빈 상태. 실제 코드는 형제 워크트리(`여러-페이지-복합-세팅-기능-추가`)에 있음.
- **결정: 현재 워크트리로 코드 복사 후 구현** (브랜치 분리 유지)
- 복사 대상: `manifest.json`, `background.js`, `content.js`, `popup/`, `icons/`, `scripts/`, `package.json`, `test/`, `README.md`

### 1단계: `background.js` — EXPORT/IMPORT 핸들러 추가
- `handleMessage` switch에 `EXPORT_DATA`, `IMPORT_DATA` 케이스 추가
- `EXPORT_DATA`: `{ presets: await getPresets(), groups: await getGroups() }` 반환
- `IMPORT_DATA`: 검증 함수(`validateImportData`) 실행 → 새 ID 부여 → `savePresets`/`saveGroups` → 가져온 개수 반환
- 검증/ID 매핑 로직은 `background.js` 하단 헬퍼 함수로 구현

### 2단계: `popup/popup.html` — 버튼 및 파일 입력 추가
- 프리셋 탭 `.toolbar`에 `내보내기`/`가져오기` 버튼 추가 (`btn-export`, `btn-import`)
- 숨겨진 `<input type="file" id="import-file" accept=".json" hidden>`

### 3단계: `popup/popup.js` — 이벤트 핸들러 추가
- `btn-export` 클릭: `EXPORT_DATA` → Blob 다운로드 (파일명 `presets-YYYY-MM-DD.json`)
- `btn-import` 클릭: `#import-file` 클릭 트리거
- `#import-file` change: `FileReader` → `JSON.parse` 시도 → 실패 시 toast → 통과 시 `confirm` → `IMPORT_DATA` 전송 → 성공 시 `loadPresets()` + `loadGroups()` + toast
- `escapeHtml` 사용 (기존 함수 재사용)

### 4단계: `popup/popup.css` — 버튼 스타일
- 기존 `.btn` 클래스만 사용, 추가 CSS 최소화

### 5단계: 검증 (빌드/테스트)
- `npm run check` (문법 검사) — 실패 시 수정
- `npm run build` → dist 생성
- 수동 테스트 시나리오 (아래 5절)

## 5. 테스트 계획

### 자동 검사
```bash
npm run check   # node --check + manifest JSON 파싱
npm run build   # dist 생성 확인
```

### 수동 테스트 (test/test-form.html 사용)
1. 프리셋 2개(한글/이모지 이름 포함) + 그룹 1개 생성
2. **내보내기** → JSON 파일 다운로드 확인 → 파일 내용에서 스키마 필수 항목 확인
3. 모든 데이터 삭제 후 **가져오기** → 프리셋/그룹 복원 확인 (그룹 실행으로 ID 매핑 검증)
4. 기존 데이터가 있는 상태에서 같은 파일 **가져오기** → 중복 추가 확인
5. 손상된 JSON 파일 가져오기 → 에러 toast 확인
6. 0개 상태에서 내보내기 → 안내 메시지 확인

## 6. 완료 기준 (Definition of Done)

- [x] `EXPORT_DATA`/`IMPORT_DATA` 메시지가 `background.js`에 구현됨
- [x] 내보내기: Blob 다운로드, 파일명 규칙, `revokeObjectURL` 정리
- [x] 가져오기: 검증 8단계, ID 재매핑, confirm 확인 단계
- [x] `npm run check` 통과
- [x] 수동 테스트 6개 시나리오 통과
- [x] 기존 기능(프리셋 CRUD, 그룹 실행, 캡처 모드) 회귀 없음

## 7. 리스크 및 열린 질문

1. ~~작업 위치~~ → **결정됨**: 현재 워크트리로 코드 복사 후 구현
2. ~~중복 정책~~ → **결정됨**: 새 ID + 추가 (기존 데이터 보존)
3. ~~그룹 포함 여부~~ → **결정됨**: 프리셋 + 그룹 모두 포함, ID 재매핑
4. **확인 UI**: `confirm()`(내장) 사용 — 팝업 크기 제약으로 커스텀 모달은 불필요 (요구 시 확장 가능)