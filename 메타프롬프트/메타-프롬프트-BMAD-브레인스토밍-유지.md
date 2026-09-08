# 메타프롬프트 — BMAD brainstorm 스킬 유지

## 목표

사용자 요구 원문: **「bmad branstorm 스킬은 냅둘것.」**

D41에서 지운 `bmad-brainstorming`을 복원한다. help/spec/build와 함께 유지. 제품 런타임은 건드리지 않는다.

## 변경 범위

| 경로 | 하는 일 |
|------|---------|
| `.agents/skills/bmad-brainstorming/` | 설치 패키지에서 복원 |
| `_bmad/_config/skill-manifest.csv` | brainstorming 행 추가 |
| `_bmad/_config/bmad-help.csv` | BP 행 추가 |
| `_bmad/core/module-help.csv` | BSP 행 추가 |
| `AGENTS.md` / `README.md` / `REQUIREMENTS.md` / `decisions.md` | D42 |

## MUST NOT

- 나머지 삭제된 스킬 복원 금지
- `npx bmad-method install` 전체 재설치로 29개 되돌리기 금지
- 확장 JS 변경 금지

## 검증

- `.agents/skills`에 help, spec, build, brainstorming 4개
- help CSV가 brainstorming을 추천함
