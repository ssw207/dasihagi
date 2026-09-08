# 메타프롬프트 — BMAD 설치

## 목표

사용자 요구 원문: **「bmad 설치」**

이 저장소에 [BMAD Method](https://docs.bmad-method.org/start/install-bmad/)를 설치한다. 제품 런타임(확장 JS)은 바꾸지 않는다. 에이전트 워크플로 도구로만 추가한다.

## 변경 범위

| 파일/경로 | 하는 일 |
|-----------|---------|
| `_bmad/` | 설치기가 생성. 공유 설정·스크립트 |
| `.agents/skills/` | Grok 도구 연동 스킬 (`--tools grok`) |
| `_bmad-output/` | 산출물 폴더. `.gitignore`에 추가 |
| `.gitignore` | `_bmad-output/` 무시 |
| `README.md` | 개발자만 절에 BMAD 한 줄 |
| `REQUIREMENTS.md` / `decisions.md` | D40: 개발 도구, 제품 요구 아님 |
| 이 메타프롬프트 | 작업 지시 |

## 구현 상세

```
npx --yes bmad-method install --yes --directory . --modules bmm --tools grok --communication-language Korean --document-output-language Korean --output-folder _bmad-output --set core.project_name=다시하기
```

- 모듈: **BMM** (소프트웨어 개발 모듈). BMB/TEA/게임은 요청 없음 → 넣지 않음.
- 도구: **grok** (`.agents/skills`). 이 세션의 Grok Build TUI와 맞음.
- 대화/문서 언어: Korean (제품 UI와 동일).
- 전제: Node 20.12+, uv 있음 (확인됨).

## MUST NOT

- `background.js` / `content.js` / `popup/` / `manifest.json` / `secure-store.js` / `pii-detect.js` / `test/` / `dist/` 변경 금지
- 기존 `AGENTS.md` 영구 규칙(메타프롬프트 필수)을 BMAD로 덮어쓰지 않음. 설치기가 건드리면 원문 복구.
- 제품 요구사항 R1~R18에 BMAD를 기능으로 넣지 않음.
- README 사용자 설치 절차에 BMAD를 넣지 않음.

## 검증

- 설치기 종료 메시지에 **BMAD is ready to use!** 또는 동등 성공.
- `_bmad/` 존재, Grok 스킬이 `.agents/skills`에 생김.
- `git status`에 런타임 JS 없음.
