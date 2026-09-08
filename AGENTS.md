# 다시하기 (dasihagi) — 프로젝트 에이전트 규칙

## 영구 규칙 (사용자 지시, 2026-08-16)

**사용자의 모든 요청은 반드시 메타프롬프트 파일로 만들어서 실행한다.**

- 기능 추가/변경/설계 결정 등 어떤 요청이든, 구현에 앞서 `메타프롬프트/메타-프롬프트-<주제>.md` 파일을 먼저 작성한다.
- 메타프롬프트에는 다음을 포함한다: 목표(사용자 요구 원문 포함), 변경 범위(파일별), 구현 상세, MUST NOT(금지 사항), 검증 방법.
- 메타프롬프트 작성 후 그 내용을 기준으로 실제 구현을 실행한다. 구현 완료 후에는 요구사항 정의서(REQUIREMENTS.md)·결정 문서(decisions.md)·README를 갱신한다.
- 메타프롬프트는 `메타프롬프트/` 폴더에만 둔다. 파일명 형식: `메타-프롬프트-녹화방식-개선.md`.

## 프로젝트 기본 규칙

- Chrome Extension Manifest V3, 네이티브 JS (번들러 없음, `dist/`는 `npm run build`로 생성)
- 모든 UI 문자열 한국어
- 저장소: `chrome.storage.local` — 프리셋은 프리셋별 암호화 blob(`sec:preset:<id>`) + 평문 인덱스(`presets`), 그룹은 평문(`groups`)
- 민감값/프리셋 암호화: `secure-store.js` (AES-256-GCM, 키 `vault_key_v1`)
- 검증: `npm run check` / `npm run build` / `npm run test:encrypt` / `npm run test:pii` / `npm run test:replay` / `npm run test:qa` / `npm run test:e2e`
- 프로젝트 루트 `C:\Users\hoo kim\orca\dasihagi`

## BMAD (개발 워크플로, D40)

- `_bmad/` + Grok 스킬 4개: `bmad-help`, `bmad-brainstorming`, `bmad-spec`(기획), `bmad-build`(구현). 제품 런타임과 무관.
- 산출물은 `_bmad-output/` (gitignore). 영구 규칙(메타프롬프트)이 BMAD보다 우선. `npx bmad-method install`을 다시 돌리면 스킬이 복원되므로 돌리지 말 것.