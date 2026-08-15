# 폼 프리셋

사이트의 폼에 들어가는 값을 한 번 저장해 두고, 버튼 한 번으로 자동으로 채워주는 크롬 확장 프로그램입니다.

사이트마다 다른 값을 저장할 수 있고, 사이트 개수 제한이 없습니다.

## 시작하기 전에

필요한 것: **Chrome** 브라우저, **Node.js**

Node.js가 설치되어 있는지 확인합니다.

```bash
node --version
```

버전 번호(예: `v22.16.0`)가 출력되면 OK입니다.

## 1단계: 빌드

확장 프로그램을 빌드합니다.

```bash
npm run build
```

실행이 끝나면 화면에 **복사할 경로**가 출력됩니다.

```
빌드 완료 → C:\...\my-chrome-extension\dist
```

이 경로를 복사해 두세요.

## 2단계: 크롬에 확장 프로그램 로드

1. 주소창에 `chrome://extensions` 입력 후 이동합니다.
2. 우측 상단의 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다** 버튼을 클릭합니다.
4. 파일 선택 창의 **경로 입력란에 1단계에서 복사한 빌드 경로를 붙여넣고** Enter를 누릅니다.

> **성공 표시**: 툴바에 "폼 프리셋" 아이콘이 나타나면 완료입니다.

## 3단계: 테스트 페이지에서 확인 (선택)

실제 사이트 없이 동작을 확인할 수 있습니다. 아래 명령으로 테스트 페이지를 만듭니다.

```bash
mkdir -p test
cat > test/test-form.html << 'EOF'
<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><title>폼 프리셋 테스트</title></head>
<body>
  <h1>폼 프리셋 테스트 페이지</h1>
  <form>
    <p><label>이름 <input type="text" name="name" placeholder="이름"></label></p>
    <p><label>이메일 <input type="email" name="email" placeholder="이메일"></label></p>
    <p><label>부서
      <select name="dept">
        <option value="">선택하세요</option>
        <option value="eng">엔지니어링</option>
        <option value="sales">영업</option>
        <option value="mkt">마케팅</option>
      </select>
    </label></p>
    <p><label><input type="checkbox" name="agree"> 약관 동의</label></p>
    <p><textarea name="memo" placeholder="메모"></textarea></p>
  </form>
</body>
</html>
EOF
```

로컬 서버로 실행합니다.

```bash
# Python이 있으면
python3 -m http.server 8000
# Node만 있으면 (다른 창에서)
npx serve
```

브라우저에서 접속합니다.

```bash
start http://localhost:8000/test/test-form.html   # Windows
open http://localhost:8000/test/test-form.html    # macOS
xdg-open http://localhost:8000/test/test-form.html # Linux
```

> 파일을 직접 열어도 되지만, 그 경우 확장 프로그램 설정에서 **"파일 URL에 대한 액세스 허용"**을 켜야 합니다.

## 4단계: 프리셋 만들기

1. 테스트 페이지(또는 실제 사이트)에 접속합니다.
2. 툴바의 **폼 프리셋** 아이콘을 클릭합니다.
3. **+ 새 프리셋** 버튼을 클릭합니다.
4. 프리셋 이름을 입력합니다.
5. 사이트 주소가 **사이트 패턴**에 자동 입력된 것을 확인합니다.
6. **저장** 버튼을 클릭합니다.

> **성공 표시**: 화면 하단에 "저장되었습니다" 메시지가 나타납니다.

## 5단계: 캡처 모드로 값 저장하기

1. 프리셋 목록에서 **캡처** 버튼을 클릭합니다.
2. 페이지의 입력란들이 파란 점선 테두리로 표시됩니다.
3. 값을 저장할 입력란을 **클릭**합니다.
4. 화면 상단 패널에서 **표시 이름**과 **저장할 값**을 입력하고 **저장**합니다.
5. 필요한 만큼 다른 입력란도 반복합니다.

테스트 페이지 기준 예시:

| 입력란 | 표시 이름 | 저장할 값 |
|---|---|---|
| 이름 | 이름 | 홍길동 |
| 이메일 | 이메일 | hong@test.com |
| 부서 | 부서 | 엔지니어링 |

> **성공 표시**: 저장한 입력란의 점선 테두리가 사라집니다.

## 6단계: 프리셋 적용하기

1. 확장 아이콘을 클릭합니다.
2. 프리셋의 **적용** 버튼을 클릭합니다.

> **성공 표시**: 모든 입력란이 저장한 값으로 채워집니다. 부서는 "엔지니어링"으로 선택됩니다.

## 7단계: 자동 적용 (선택)

1. 프리셋 **편집** 버튼을 클릭합니다.
2. **"페이지 진입 시 자동 적용"**을 체크합니다.
3. **저장**합니다.

다음부터 해당 사이트에 접속하면 값이 자동으로 채워집니다.

## 도움이 되는 팁

### 사이트 패턴 규칙

| 패턴 | 의미 |
|---|---|
| `example.com` | example.com 모든 페이지 |
| `*.example.com` | example.com 및 모든 하위 도메인 |
| `example.com/admin/*` | admin 경로 이하 전체 |

### 문제가 생기면

| 증상 | 해결 |
|---|---|
| 값이 안 채워질 때 | 확장 프로그램 새로고침(`chrome://extensions`) + 페이지 새로고침 |
| 아이콘이 안 보일 때 | 툴바에서 확장 프로그램 고정(핀) |
| chrome:// 같은 크롬 내장 페이지 | 지원되지 않음 |
| 사이트 개편 후 값이 안 들어갈 때 | 해당 입력란을 캡처 모드로 다시 저장 |