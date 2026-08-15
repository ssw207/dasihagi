# 여러 페이지 복합 세팅 (그룹 실행) 기능

## 목표

현재 1프리셋 = 1페이지 폼 채우기만 지원한다. 제휴사 세팅처럼 **여러 페이지(A/B/C)를 순차적으로 채우고 저장**해야 하는 요구에 대응한다.

**핵심 요구사항:**
- 그룹 = 순서 있는 프리셋 목록 (기존 프리셋 재사용, 하위 호환 유지)
- 그룹 실행: A페이지 채움 → 저장 → B페이지 채움 → 저장 → C페이지 채움 → 저장
- 각 스텝의 "저장" 처리 방식 선택 가능 (하이브리드):
  - **auto**: 값 채움 + 제출 버튼 자동 클릭
  - **manual**: 값만 채움, 제출은 사용자가 직접, popup에서 "다음 단계"로 진행
- 페이지 이동: 확장이 각 스텝 프리셋의 urlPattern으로 **새 탭을 열어** 순차 실행
- popup이 닫혀도 실행 지속 (background 상태 머신)

## 확정 설계 (사용자 승인 완료)

### 데이터 모델 (chrome.storage.local, key: "groups")

```js
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
```

- `presets[]`는 무변경. 그룹은 presetId 참조만.
- auto 스텝에만 submitSelector 필수.

### 실행 상태 머신 (background.js)

```
runState = {
  runId, groupId, stepIdx, status: 'running'|'waiting'|'done'|'failed',
  stepResults: [{ stepIdx, ok, message }],
  currentTabId,   // 현재 스텝 탭
  currentPreset,  // 현재 스텝 프리셋 (적용용)
  currentStep,    // 현재 스텝 설정 (submitMode 등)
}
```

플로우:
1. popup `RUN_GROUP` → 기존 실행 있으면 거부. runState 생성, stepIdx=0
2. step[0].presetId → 프리셋 조회 → urlPattern으로 `chrome.tabs.create` 새 탭
3. `tabs.onUpdated` 로드 완료 감지(현재 탭 ID 매칭) → `APPLY_PRESET`
4. auto: 지연 후 content에 `SUBMIT_FORM` → 성공 시 탭 닫기 → 다음 스텝 새 탭
5. manual: status='waiting', popup에 "다음 단계" 버튼 노출. popup `RUN_NEXT` → 다음 스텝
6. 마지막 스텝 완료 → status='done', 배지 초기화
7. 중지 `RUN_ABORT` → 실행 중 탭 정리, 상태 초기화

### 메시지 프로토콜 추가

- `GROUP_LIST` / `GROUP_CREATE` / `GROUP_UPDATE` / `GROUP_DELETE`
- `RUN_GROUP` → 그룹 실행 시작 (현재 탭 닫기 후 새 탭으로 진행)
- `RUN_STATUS` → 현재 실행 상태 조회 (popup 오픈 시)
- `RUN_NEXT` → manual 스텝에서 다음 스텝 진행
- `RUN_ABORT` → 실행 중단
- content: `SUBMIT_FORM` → submitSelector 클릭

### content.js 변경

- 캡처 모드 확장: 버튼 요소(`button`, `input[type=submit]`)도 캡처 대상. type `'submit-button'` 저장
  - 필드 캡처: input/select/textarea (기존 유지)
  - 버튼 캡처: 캡처 모드에서 버튼 클릭 시 submit 버튼으로 저장 (새 메시지 `CAPTURE_SAVE_SUBMIT`)
- `SUBMIT_FORM` 메시지 처리: submitSelector로 요소 찾아 click() → `{ ok }` 응답
  - 실패 시 fallback: form 내부 첫 submit 버튼 → form.requestSubmit()

### popup 변경

- 상단 탭 전환: **프리셋** / **그룹**
- 그룹 목록 뷰: 그룹 카드 (이름, 스텝 N개, 실행/편집/삭제)
- 그룹 편집 뷰:
  - 이름 입력
  - 스텝 목록: 프리셋 선택(드롭다운), submitMode 선택(auto/manual), auto면 submitSelector 입력
  - 스텝 추가/삭제/순서 이동
- 실행 상태 뷰 (목록 상단): 실행 중이면 진행 상황 표시 (N/M 단계), manual 대기 시 "다음 단계" 버튼, "중지" 버튼
- 배지: 실행 중 "n/m", 완료 시 초기화

## 파일별 변경 범위

| 파일 | 변경 |
|---|---|
| background.js | groups CRUD, 실행 상태 머신, RUN_* 메시지, 배지 |
| content.js | 버튼 캡처, SUBMIT_FORM 처리 |
| popup/popup.html | 탭 전환, 그룹 목록/편집/실행 상태 뷰 |
| popup/popup.js | 그룹 CRUD UI, 실행 트리거, 상태 폴링 |
| popup/popup.css | 그룹 스타일 |

## TODOs

- [ ] T1: worktree 베이스 커밋 (완료: 65ce064)
- [ ] T2: background.js — groups CRUD + 실행 상태 머신
- [ ] T3: content.js — 버튼 캡처 + SUBMIT_FORM
- [ ] T4: popup UI — 탭 전환 + 그룹 목록/편집/실행 상태
- [ ] T5: popup.css — 그룹 스타일
- [ ] T6: 검증 — node --check, build, 수동 테스트 플로우

## Definition of Done

- [ ] 그룹 CRUD 동작
- [ ] 그룹 실행: 새 탭 열기 → 프리셋 적용 → (auto) 제출 클릭 → 다음 스텝
- [ ] manual 스텝에서 "다음 단계"로 진행
- [ ] 실행 중 popup 재오픈 시 상태 복원
- [ ] 중지 시 탭 정리
- [ ] node --check 전 파일 통과, build 성공