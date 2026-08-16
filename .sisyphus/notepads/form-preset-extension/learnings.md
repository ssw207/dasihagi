# Learnings

## [2026-08-15] 프로젝트 시작
- 그린필드 프로젝트 (빈 git 저장소)
- Chrome Extension Manifest V3, 네이티브 JS 사용 (빌드 도구 없음)
- 모든 UI 문자열 한국어
- 저장소: chrome.storage.local, key "presets"
- 사이트 매칭 하드코딩 금지 — urlPattern 기반 (예: `*.example.com`, `example.com/*`)
- SPA 대응 필수: React/Vue 값 세팅 시 네이티브 setter + input/change 이벤트 dispatch
- 파일 구조: manifest.json / background.js / content.js / popup/(html,css,js) / icons/ / README.md

## [2026-08-15] 구현 완료
- 서브에이전트(task)가 이 환경에서 멈추는 문제 → 메인 세션에서 직접 구현
- select 값 세팅: option value와 텍스트 둘 다 매칭 시도, 없으면 option 동적 추가 (targetValue 버그 수정)
- select 유형 버그 발견: textMatched 후 setNativeValue에 원본 field.value를 다시 넣는 문제 → targetValue 변수로 분리
- 패널 HTML 삽입 시 escapeHtml() 사용 (label, selector 모두 이스케이프)
- URL 매칭 테스트 10건 통과
- node --check + manifest JSON 검증 통과

## [2026-08-16] 영구 규칙 + 프리셋별 전체 암호화 전환
- 사용자 지시: **모든 요청은 메타프롬프트 파일로 만들어 실행** — AGENTS.md에 영구 기록
- 설계 전환: 필드 단위 민감 암호화 → **프리셋별 전체 암호화** (`sec:preset:<id>` blob + 평문 인덱스 `presets`)
  - 보호가 감지 품질과 분리됨: 감지가 불완전해도 저장소 평문 0
  - pii-detect.js는 보안 역할 종료, **UI 마스킹 전용**으로 유지 (field.sensitive = 마스킹 신호)
- RECORD_SAVE 버그 원인 확정: field 재구성 시 `sensitive: !!e.sensitive` 복사 누락 → 전환 구현에서 반드시 보존

## [2026-08-15] 빌드 + 문서 재작성
- 사용자 요청: 빌드 명령어 + 복붙 가능한 빌드 경로 필요
- `scripts/build.js` 추가: `npm run build` → dist/ 폴더 생성 + 절대 경로 출력 (복사해서 chrome://extensions 로드 창에 붙여넣기)
- 빌드 출력 예: `빌드 완료 → C:\Users\...\my-chrome-extension\dist`
- README 관점 변경: 사용자 입장(어떻게 쓰는지) 중심, 기술 정보(파일 구조/스토리지/백업) 전부 제거
- README 7단계 흐름: 빌드 → 크롬 로드(경로 붙여넣기) → 테스트 페이지 → 프리셋 → 캡처 → 적용 → 자동 적용 → 도움말
- 테스트 페이지 생성 명령 + 로컬 서버(python3 -m http.server / npx serve) 포함
- README의 모든 명령어 실제 실행 검증 완료 (test-form.html 생성, build 동작)
