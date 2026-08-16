# 메타프롬프트 — iframe 안 폼 녹화/재생

## 목표

사용자 요구 원문: **「사내 어드민이 iframe 로 구현되어있는데 iframe은 안되?」**

지금은 content script가 **최상위 프레임만**이라 iframe 안 입력은 녹화·재생이 안 된다. `all_frames` + 모든 프레임에 메시지 전달로 사내 어드민 iframe을 지원한다.

## 변경 범위

| 파일 | 내용 |
|------|------|
| `manifest.json` | `all_frames: true`, `webNavigation`(프레임 목록) |
| `background.js` | `sendToAllFrames`, APPLY/RECORD/CAPTURE/SUBMIT는 전 프레임 |
| `content.js` | iframe에서도 리스너. 칩은 top 또는 충분히 큰 iframe만 |
| `test/iframe-host.html` `test/iframe-form.html` | E2E용 |
| `test/record-replay-verify.mjs` / e2e | 회귀 + iframe 시나리오 가능하면 |
| `REQUIREMENTS.md` `decisions.md` `README.md` | R18, D32 |

## 구현 상세

1. APPLY_ACTION: 프레임을 돌며 성공한 첫 응답을 쓴다.
2. APPLY_PRESET: 프레임별 결과를 합친다(어느 프레임이든 성공한 필드는 성공).
3. RECORD_START/STOP/CAPTURE는 모든 프레임. 교차 origin iframe은 각 프레임의 content script가 처리.
4. 사이트 하드코딩 금지.

## MUST NOT

- 상위 페이지에서 cross-origin iframe DOM을 직접 읽으려 하지 않는다.
- 기존 테스트 삭제 금지.

## 검증

- `npm run check` / `test:encrypt` / `test:pii` / `test:replay`
- 가능하면 e2e iframe 시나리오
