# 메타프롬프트 — GitHub dasihagi 등록

## 목표

사용자 요구 원문: **「gh 로그인 완료」** (직전: ssw207에 연동, 제품명 다시하기/dasihagi)

`gh`가 ssw207으로 로그인됐는지 확인하고, 공개 저장소 `ssw207/dasihagi`를 만든 뒤 `master`를 push한다.

## 변경 범위

- git remote `origin`
- GitHub repo create + push
- README URL이 이미 dasihagi면 코드 추가 변경 없음

## 구현 상세

1. `gh auth status` — 계정이 ssw207인지 확인
2. 저장소가 없으면 `gh repo create ssw207/dasihagi --public --source=. --remote=origin --push`
3. 이미 있으면 origin 설정 후 `git push -u origin master`
4. force push 금지 (원격이 비어 있거나 우리가 만든 빈 저장소일 때만 push)

## MUST NOT

- 다른 계정/다른 이름(form-preset-extension)으로 만들지 않음
- 기존 원격 커밋을 덮어쓰는 force push 금지

## 검증

- `git remote -v` → github.com/ssw207/dasihagi
- `gh repo view ssw207/dasihagi --web` 가능
