# QA 엣지케이스 — 다시하기

기준: 2026-08-30 · v0.1.0 · R1~R18 · D35 지연 iframe 합류  
팀: 보안 / 엣지 / 흐름 / 데이터 / UX (교차 검증)

판정: **PASS** 실행 확인 · **커버** 기존 스위트 · **한계** 제품이 의도적으로 안 함 · **미실행** 실사이트/권한 부족

실행 명령:

```
npm run check
npm run test:encrypt
npm run test:pii
npm run test:replay
npm run test:qa
npm run test:e2e
```

---

## 1. 보안 (Security)

| # | 케이스 | 시나리오 | 예상 | 실행 | 심각도 | 판정 |
|---|--------|----------|------|------|--------|------|
| S1 | 타 확장 sender | EXPORT_DATA를 다른 확장 id로 | 차단 | `test:qa` | 치명 | PASS |
| S2 | 자체 sender | PRESET_LIST | 허용 | `test:qa` | 치명 | PASS |
| S3 | content sender 검증 | 타 확장이 APPLY_PRESET | 무시 | 코드 `content.js` sender.id | 치명 | 커버(F2) |
| S4 | XSS 이름 저장 | `<img onerror>` 프리셋 이름 | 문자열로만 저장, 렌더는 escapeHtml | `test:qa` + popup escapeHtml | 높음 | PASS |
| S5 | 내보내기 평문 | EXPORT_DATA | 파일에 실값. 사용자 백업 | encrypt S9 | 중간 | 커버 · 의도 |
| S6 | 잘못된 appId 가져오기 | appId=other-app | 거부 | `test:qa` | 높음 | PASS |
| S7 | 레거시 appId | form-preset-extension | 허용 | `test:qa` | 중간 | PASS |
| S8 | 64KB 초과 값 import | 필드 65537자 | 해당 프리셋 제외 | `test:qa` | 높음 | PASS |
| S9 | schemaVersion 문자열 | `"1"` | 거부 | `test:qa` | 높음 | PASS |
| S10 | 페이지↔content 경계 | 악성 페이지가 확장 API 직접 호출 | isolated world | 정적 | 치명 | 커버(MV3) |

---

## 2. 엣지 (Edge)

| # | 케이스 | 시나리오 | 예상 | 실행 | 심각도 | 판정 |
|---|--------|----------|------|------|--------|------|
| E1 | chrome:// 녹화 | RECORD_START | 거절 | `test:qa` | 높음 | PASS |
| E2 | 0개 종료 | 녹화 후 입력 없이 종료 | saved=0, 크래시 없음 | `test:qa` | 중간 | PASS |
| E3 | 세션 없는 APPEND | 녹화 전 RECORD_APPEND | 실패 | `test:qa` | 중간 | PASS |
| E4 | 사이트 불일치 재생 | other.com 프리셋을 example.com에 | 오류 | `test:qa` + e2e D2 | 높음 | PASS |
| E5 | 이상한 재생 속도 | warp | normal | `test:qa` | 낮음 | PASS |
| E6 | 포트 패턴 | 127.0.0.1:3000 | 매칭 | `test:qa` + e2e D18 이력 | 높음 | PASS |
| E7 | IPv6 | `[::1]:8080` | 매칭 | `test:qa` | 중간 | PASS |
| E8 | `*` 패턴 | 모든 URL 적용 | 매칭 (사용자 실수 가능) | `test:qa` | 중간 | PASS |
| E9 | 유니코드 값 | 한👍가, メモ✨ | 기록·재생 | e2e L | 중간 | PASS |
| E10 | 빈 값 녹화 | 칸을 비움 | 이벤트 1개 | e2e B6 | 중간 | 커버 |
| E11 | radio / checkbox 해제 | 선택 변경 | 마지막 상태 | e2e B3 B4 | 중간 | 커버 |
| E12 | delay 상한 | 5초 | 0~5000 | replay | 낮음 | 커버 |
| E13 | hidden input | type=hidden | 녹화 안 함 | `isFormField` | 낮음 | 정적 PASS |
| E14 | file input | type=file | 폼 필드로 잡혀 빈 값 기록 가능. 파일은 채우지 않음 | 정적 | 중간 | **한계** (README 첨부 불가) |

---

## 3. 흐름 (Flow)

| # | 케이스 | 시나리오 | 예상 | 실행 | 심각도 | 판정 |
|---|--------|----------|------|------|--------|------|
| F1 | 빈 그룹 실행 | steps [] | 거절 | `test:qa` | 중간 | PASS |
| F2 | 선택 삭제 0개 | ids [] | 거절 | `test:qa` | 낮음 | PASS |
| F3 | 빈 id 삭제 | id '' | 거절 | `test:qa` | 낮음 | PASS |
| F4 | import concat | 기존 유지 + 추가 | 덮지 않음 | `test:qa` | 높음 | PASS |
| F5 | 여정 자동적용 제외 | click 필드 + autoApply | AUTO_APPLY 목록에서 제외 | `test:qa` + e2e F4 | 높음 | PASS |
| F6 | 이중 RECORD_START | 같은 프리셋 | 버퍼 유지 | replay | 높음 | 커버 |
| F7 | 그룹 연타 | RUN_GROUP 중 재실행 | 거절 | 코드 groupRunInFlight | 높음 | 커버(Flow-1) |
| F8 | 팝업 이어 녹화 | opener 탭 | 같은 세션 | replay | 높음 | 커버 |
| F9 | 모달 열기→입력→확인 | 같은 페이지 레이어 | 기록·재생 | e2e G | 중간 | 커버 |
| F10 | 늦게 뜬 iframe | 녹화 시작 후 iframe | 합류·기록 | e2e H3 | 치명 | 커버 D35 |
| F11 | 중첩 iframe | 포털>껍데기>폼 | 기록 | e2e I | 높음 | PASS |
| F12 | iframe src 교체 | about:blank → 폼 | 합류·기록 | e2e J | 높음 | PASS |
| F13 | 작은 iframe | 120×80, 칩 없음 | 바깥 칩으로 종료, 값은 기록 | e2e K | 중간 | PASS |
| F14 | 같은 origin iframe | 이미 로드 | 기록·재생 | e2e H | 높음 | 커버 |
| F15 | 캡처+녹화 패널 | 패널 입력 | 녹화 이벤트 제외 | 코드 Flow-7 | 중간 | 커버 |
| F16 | sandbox iframe | sandbox 속성 | content script 없음 → 불가 | 제품 한계 | 중간 | **한계** |

---

## 4. 데이터 (Data)

| # | 케이스 | 시나리오 | 예상 | 실행 | 심각도 | 판정 |
|---|--------|----------|------|------|--------|------|
| D1 | 손상 blob | ct/iv 쓰레기 | 목록에서 건너뜀, 크래시 없음 | `test:qa` | 높음 | PASS |
| D2 | 레거시 마이그레이션 | 필드 단위 sec | blob 이전 | encrypt M1-2, e2e E | 높음 | 커버 |
| D3 | 키 없음 | vault 손상 | 새 키 자동 생성 없이 오류 | encrypt K 이력 | 치명 | 커버 |
| D4 | 평문 인덱스 | 저장소 덤프 | fields 값 없음 | e2e A1 C3-2 | 치명 | 커버 |
| D5 | PII 오탐 | 날짜, 미국번호 | 미민감 | `test:pii` | 중간 | 커버 30/30 |
| D6 | 가져오기 500/100/5MB | 상한 | 자르거나 거절 | R5-4, 코드 | 중간 | 커버(F7) |

---

## 5. UX (UX Abuser)

| # | 케이스 | 시나리오 | 예상 | 실행 | 심각도 | 판정 |
|---|--------|----------|------|------|--------|------|
| U1 | 민감 마스킹 | 이메일 카드 | •••••• | e2e C4 | 높음 | 커버 |
| U2 | 현재 사이트만 | 다른 호스트 숨김 | 필터 | popup 기본 on | 중간 | 정적 |
| U3 | 제한 페이지 버튼 | chrome:// | 이 사이트 녹화 비활성 | popup isRestrictedPage | 중간 | 정적 PASS |
| U4 | 재생 ≠ 제출 | 폼 재생 | submit 클릭 없음 (여정 클릭은 예외) | README | 높음 | 의도 |
| U5 | 빠른 연타 저장 | 더블클릭 | 1개만 생성 | UX-4 | 중간 | 커버 |
| U6 | 칩 가림 | 전체 iframe | iframe이 크면 안쪽 칩 | R18-4, e2e H | 중간 | 커버 |

---

## 교차로 버린 것

| 후보 | 이유 |
|------|------|
| 캡차·보안키패드 통과 | 비목표 |
| 파일 첨부 재생 성공 | 확장 불가 |
| 실 사내 어드민 접속 | 로그인·망 없음. 로컬 iframe으로 대체 |
| 팀 공유/클라우드 | 제품 없음 |

---

## 실행 요약

| 스위트 | 결과 |
|--------|------|
| `npm run check` | PASS (manifest OK) |
| `test:encrypt` | 13/13 |
| `test:pii` | 30/30 |
| `test:replay` | 99/99 |
| `test:qa` | **22/22 PASS** |
| `test:e2e` | **71/71 PASS** (I 중첩, J src 교체, K 작은 iframe, L 유니코드 포함) |

L2는 처음에 이름만 기다리고 메모를 바로 읽어 실패 → 테스트가 두 칸 모두 채워질 때까지 기다리도록 수정. 제품 버그 아님.

### 신규 발견 (이번 라운드)

- **파일 input**: `isFormField`가 `type=file`을 포함한다. 녹화되면 빈 문자열이 남을 수 있다. 재생으로 파일은 채워지지 않음. README 한계와 같음. 코드 변경 없음.
- **`*` 사이트 패턴**: 모든 URL에 재생·자동적용 가능. 사용자가 직접 넣은 경우만. 막지 않음.

### 아직 안 함

- 교차 origin iframe (다른 포트 두 서버) — 같은 원리(프레임별 content script)이나 E2E 미실행
- 실 폐쇄망 어드민, Shadow DOM, contenteditable 전용 에디터
- 그룹 실행 headful E2E (mock F1만)

다음에 열 수 있는 게이트: 교차 origin iframe E2E, 그룹 실행 E2E.
