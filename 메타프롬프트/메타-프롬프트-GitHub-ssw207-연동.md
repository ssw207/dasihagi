# 메타프롬프트 — GitHub ssw207 연동·프로젝트 등록

## 목표

사용자 요구 원문: **「https://github.com/ssw207 git에 연동하고 프로젝트 등록해줘」**

로컬 프로젝트를 GitHub 사용자 `ssw207` 아래 공개 저장소로 만들고, remote를 연결한 뒤 코드를 push한다. README의 clone 주소를 실제 URL로 고친다.

## 변경 범위

- `git remote` + GitHub 저장소 생성 + push
- `README.md` clone 예시를 실제 주소로
- 필요 시 `.gitignore` (node_modules 등)

## 구현 상세

1. `git status` / remote / `gh auth status` 확인
2. 저장소 이름은 package.json 기준 `form-preset-extension` (폴더명 my-chrome-extension보다 제품명에 맞음)
3. `gh repo create ssw207/form-preset-extension --public --source=. --remote=origin` 후 push. 실패 시 원인 보고
4. README `git clone https://github.com/ssw207/form-preset-extension.git`
5. node_modules는 올리지 않음

## MUST NOT

- 다른 사람 계정에 올리기 금지
- 비밀키/토큰을 README에 적지 않음
- force push는 원격이 비어 있지 않으면 하지 않음

## 검증

- `git remote -v`가 github.com/ssw207/... 를 가리킴
- 브라우저에서 저장소가 열리는지 (gh repo view)
