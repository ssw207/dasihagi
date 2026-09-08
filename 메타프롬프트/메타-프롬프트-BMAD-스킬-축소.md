# 메타프롬프트 — BMAD 스킬 축소

## 목표

사용자 요구 원문: **「bmad로 기획 간단한 구현 정도만 할건데 불필요한 bmad스킬삭제」**

BMAD를 **짧은 기획 → 구현**만 쓰도록 줄인다. 제품 런타임은 건드리지 않는다.

## 변경 범위

| 경로 | 하는 일 |
|------|---------|
| `.agents/skills/bmad-*` | **유지**: `bmad-help`, `bmad-spec`, `bmad-build`. 나머지 디렉터리 삭제 |
| `_bmad/_config/skill-manifest.csv` | 유지 3개만 |
| `_bmad/_config/bmad-help.csv` | 유지 3개 + `_meta` |
| `_bmad/bmm/module-help.csv` | spec, build만 |
| `_bmad/core/module-help.csv` | help만 |
| `_bmad/config.toml` | `[agents.bmad-agent-*]` 제거 |
| `AGENTS.md` / `README.md` / `REQUIREMENTS.md` / `decisions.md` | D41: 라이트 세트 |

## 구현 상세

유지 이유:

- `bmad-spec` — 아이디어를 SPEC.md로 줄이는 기획
- `bmad-build` — 구현 (자체 리뷰 단계 있음)
- `bmad-help` — 다음에 뭘 쓸지

삭제: 에이전트 페르소나, PRD/UX/아키텍처/에픽/스프린트, party, brainstorm, recon, forge, review, walkthrough, QA e2e, retro, correct-course, customize, project-context, build-auto, code-review.

`bmad-build`는 `bmad-code-review` 스킬 없이 자체 `step-04-review`를 쓴다.

## MUST NOT

- 확장 JS / test / manifest 변경 금지
- `AGENTS.md` 메타프롬프트 영구 규칙 삭제 금지
- `_bmad/scripts/` 삭제 금지 (spec/build가 씀)
- `npx bmad-method install` 재실행으로 29개를 되돌리지 않음

## 검증

- `.agents/skills`에 `bmad-help`, `bmad-spec`, `bmad-build`만 남음
- help CSV가 삭제된 스킬을 추천하지 않음
- `git status`에 런타임 JS 없음
