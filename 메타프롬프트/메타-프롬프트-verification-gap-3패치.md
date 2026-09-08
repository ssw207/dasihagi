# 메타프롬프트 — verification-gap 3 patch 추가

## 목표 (사용자 요구 원문 포함)
사용자: "바로 추가" — 직전 verification-gap 리뷰에서 도출된 3개 patch를 즉시 테스트로 추가한다.
- 여정 재생에서 위험 클릭 blocked 후 중단이 e2e로 검증되지 않음
- 스크럽 내보내기(scrub:true)가 값만 비우고 handEdit/replayBlocked/replayPace는 유지한다는 계약이 테스트로 고정되지 않음
- CAPTURE_SAVE_FIELD의 replaceFieldId 빈 값 갱신이 검증되지 않음

## 변경 범위 (파일별)
- `test/record-replay-verify.mjs` — 2개 테스트 추가 (scrub handEdit 보존, repick 빈 값 handEdit)
- `test/browser-e2e-verify.mjs` — 1개 e2e 시나리오 M 추가 (여정 blocked 중단)
- `test/journey-blocked.html` (신규, `test/journey-*.html` 패턴 따름) — e2e용 여정 페이지 (선택, 필요 시)
- 기존 `test/record-replay-verify.mjs` 내 scrub 테스트 보강은 기존 로직 유지, 추가 어서션만 삽입
- 빌드 산출물 `dist/`는 `npm run build`로 재생성 (수동 코드 변경 없음, 테스트만)

## 구현 상세
### 1) scrub flags 보존 (record-replay-verify)
- 기존 scrub 테스트 블록(around line 1411-1444) 뒤에 handEdit 보존 어서션 추가
- 프리셋에 `handEdit:true`인 text 필드와 `replayBlocked:true` click을 함께 두고 `EXPORT_DATA {scrub:true}` 후 `value===''` 이면서 `handEdit`/`replayBlocked`/`replayPace`가 원본과 동일함을 check()
- 추가로 scrub JSON을 IMPORT_DATA로 재가져와 `PRESET_LIST`에서 손댈 칸/금지 표시가 복원되는지 검증
- 기존 pass 161 → 163 예상 (2건 추가)

### 2) repick 빈 값 handEdit (record-replay-verify)
- 기존 리픽 테스트(around line 1385-1410) 뒤에 빈 값 리픽 케이스 추가
- `PRESET_CREATE` 후 `fields:[{id:'rf2', selector:'#missing-old', value:'old', type:'text'}]` → `APPLY_PRESET` 실패 확인 → `CAPTURE_SAVE_FIELD {replaceFieldId:'rf2', field:{value:'', selector:'#biz-no', type:'text'}}` → `PRESET_LIST`에서 `value==='' && handEdit===true && id==='rf2'` 확인 → `APPLY_PRESET` 시 `bizInput`이 덮이지 않고 `fp-hand-edit` 노란 표시
- 실패했던 기존 `value !== '' ? field.value : prev.value` 로직이 빈 값도 갱신하도록 수정 여부를 검증하는 회귀 방지

### 3) 여정 blocked e2e (browser-e2e-verify)
- `scenarioMBlockedJourney` 함수 추가: `journey-blocked.html` 경유 없이 기존 `test-form.html` 기반으로 mock journey preset을 `PRESET_UPDATE`로 생성( text → click:결제하기 → text )
- `APPLY_PRESET` 호출 후 `replayRes.data.applied.some(a=>a.blocked)` 및 이후 필드 미실행 검증은 record-replay 단위로 이미 있음 → e2e에서는 실제 `formPage`에서 결제 버튼 클릭이 발생하지 않았는지 `payBtn` clickCount 또는 `blocked` 스타일(`fp-blocked-click`) 확인
- `main()`의 시나리오 목록에 `runScenario('M: 여정 blocked 중단', scenarioM)` 추가, `pageFiles`에 `/j/blocked` 라우트 필요 시 추가

## MUST NOT
- 위험 단어 목록(DANGER_CLICK_WORDS) 변경 금지 — UI 메시지/기획서 하드코딩 금지 원칙 유지
- scrub 로직 자체 변경 금지 — 테스트만 추가, `background.js`의 `scrubPresetForExport` 수정은 이번 패치 범위 밖 (보존 어서션이 실패하면 그때 수정)
- e2e에서 실제 결제 API 호출 금지 — 클릭 카운트/스타일 검증만
- 기존 161/71 테스트를 깨뜨리는 변경 금지 — `npm run test:replay`/`test:e2e`는 기존 PASS 유지해야 함

## 검증 방법
- `npm run check` — exit 0
- `npm run build` — exit 0, dist 일치
- `npm run test:replay` — 163/163 PASS 예상 (기존 161 + 2)
- `npm run test:e2e` — 72/72 PASS 예상 (기존 71 + 1) — 로컬 headful이므로 CI에서는 `--` 모드로 수동 확인
- 실패 시 `background.js:658-677`의 빈 값 리픽 로직(`value !== '' ? ... : prev.value`)을 `field.value !== undefined ? field.value : prev.value` 로 수정 검토
