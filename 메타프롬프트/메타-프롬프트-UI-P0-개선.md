# 메타프롬프트 — UI P0 개선 + Quick Win

## 목표

사용자 요구 원문: **「제안 대로 진행하는 메타프롬프트를 만들고 실행」**

직전 제안의 **P0 4건**과 **Quick Win**을 구현한다. P1(검색, 여정 카드 요약, 녹화 한 단계 취소, chrome:// 전용 비활성 UI 고도화)과 P2(다크모드 등)는 이번 범위 밖.

## 변경 범위

| 파일 | 내용 |
|------|------|
| `background.js` | `RECORD_STATUS` — 탭별 녹화 세션 조회 |
| `popup/popup.html` | 녹화 배너, 현재 사이트만 토글, 이 사이트 녹화, 툴바 정리, 안내 문구 |
| `popup/popup.css` | 배너·필터·카드 메뉴 |
| `popup/popup.js` | P0/Quick Win 동작 |
| `dist/` | `npm run build` |
| `test/record-replay-verify.mjs` | RECORD_STATUS + 기존 회귀 |
| `REQUIREMENTS.md` | R15 + D29 |
| `.sisyphus/notepads/form-preset-extension/decisions.md` | D29 |
| `README.md` | 녹화 시작·필터·메뉴 설명 |

## 구현 상세

### P0-1 이 사이트 녹화
- 빈 상태·목록 툴바에 **이 사이트 녹화**.
- 현재 호스트로 프리셋 생성(`이름=호스트`, `urlPatterns=[호스트]`) 후 즉시 `RECORD_START`.
- `chrome://` 등 제한 URL이면 토스트로 거절.

### P0-2 녹화 중 popup 배너
- `RECORD_STATUS { tabId }` → `{ active, presetId, eventCount }`.
- 활성 시 상단 배너 `녹화 중 · N개` + **종료**.
- 종료 후 목록 갱신.

### P0-3 카드 액션
- 주 버튼 **재생**만. **⋯** 메뉴에 녹화/편집/삭제.
- 바깥 클릭 시 메뉴 닫힘.

### P0-4 현재 사이트만
- 토글, 기본 켜짐. 끄면 전체. 선택은 `chrome.storage.local` `ui:filterCurrentSite`에 저장.
- 필터 결과 0개면 안내 + 이 사이트 녹화.

### Quick Win
- 편집: 셀렉터 기본 접기, 클릭 시 펼침.
- 암호화 문구: 「저장값은 암호화됩니다. 민감 체크는 목록에서 값을 가립니다.」
- 그룹 안내: 「폼만 여러 사이트면 그룹, 클릭·이동이면 여정 녹화.」
- 여정 자동 적용 옆에 비활성 이유 문구.
- 내보내기/가져오기는 더보기로. 새로고침 버튼 제거.

## MUST NOT

- P1/P2 기능, options_page, 스키마 파괴 변경 금지.
- `fields[]` / 암호화 / 여정 재생 로직 변경 금지 (조회 메시지 추가만).
- 사이트 하드코딩 금지.
- 기존 테스트 삭제 금지.

## 검증 방법

- `npm run check` / `test:encrypt` / `test:pii` / `test:replay` 통과
- `npm run build`
- RECORD_STATUS: 비녹화 false, 녹화 중 true+count
