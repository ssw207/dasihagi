# 크롬 익스텐션: 사이트별 폼 자동 세팅 프리셋

## 목표 (Meta Prompt)

브라우저에서 특정 사이트의 폼 값을 손으로 세팅하는 반복 작업을 자동화하는 Chrome Extension (Manifest V3) 을 만든다.

**핵심 요구사항:**
- 사이트 N개 지원 — 하드코딩 금지, 사이트별 프리셋을 저장소에 저장/관리
- **캡처 모드**: 확장 활성화 상태로 사이트 진입 → 인풋 폼 클릭 → 저장할 값 지정 → 프리셋 저장
- **적용 모드**: 저장된 프리셋을 버튼 한 번으로 폼에 세팅 (React/Vue 등 SPA 이벤트도 트리거)
- 누구나 쉽게 사용 — popup UI 에서 프리셋 생성/수정/삭제/적용

**사용자 (한국어 사용자):**
- 모든 UI 문자열은 한국어
- README 도 한국어

## 아키텍처

```
my-chrome-extension/
├── manifest.json        # MV3, content_scripts: <all_urls>, permissions: storage/tabs/scripting
├── background.js        # Service Worker - preset CRUD 메시지 라우터
├── content.js           # 캡처 모드(인풋 클릭→저장) + 적용 모드(값 세팅)
├── popup/
│   ├── popup.html       # 프리셋 관리 UI (한국어)
│   ├── popup.css
│   └── popup.js
├── icons/
│   ├── icon16.png / icon48.png / icon128.png
└── README.md            # 설치 및 사용법 (한국어)
```

### 데이터 모델 (chrome.storage.local, key: "presets")

```js
{
  presets: [
    {
      id: "uuid",
      name: "프리셋 이름",
      urlPattern: "example.com",          // 호스트명 (wildcard: *.example.com, example.com/*)
      fields: [
        {
          id: "uuid",
          label: "표시 이름",               // 사용자가 알아보는 라벨
          selector: "#user-name",          // CSS selector
          value: "저장할 값",
          type: "text" | "select" | "checkbox" | "radio" | "textarea",
        }
      ],
      autoApply: false,                   // 페이지 진입 시 자동 적용 여부
      createdAt: 0,
      updatedAt: 0,
    }
  ]
}
```

### 메시지 프로토콜 (content ↔ background ↔ popup)

- `PRESET_LIST` → 전체 프리셋 조회
- `PRESET_CREATE` / `PRESET_UPDATE` / `PRESET_DELETE` → CRUD
- `CAPTURE_START` / `CAPTURE_STOP` → 탭별 캡처 모드 토글
- `CAPTURE_SAVE_FIELD` → 캡처된 필드 저장
- `APPLY_PRESET` → 현재 탭에 프리셋 적용 (background → content)
- `GET_CURRENT_URL` → popup 에서 현재 탭 URL 확인

## 구현 원칙

1. **React/Vue/Angular 호환 값 세팅**: 네이티브 value setter + `input`/`change` 이벤트 dispatch
2. **셀렉터 생성**: 클릭된 요소에서 `id` > `name` > `data-*` > 고유한 CSS 경로 순으로 fallback 셀렉터 생성
3. **캡처 모드 UI**: 입력 요소에 하이라이트 테두리 + 클릭 시 부동 패널(라벨/값 입력)
4. **확장 UI 는 한국어**
5. **보안**: content script 은 페이지 DOM 접근만, 저장은 chrome.storage.local 만

## TODOs

### T1: 프로젝트 스캐폴드 — manifest.json + 아이콘 + 디렉토리 구조
- [x] manifest.json (MV3, `content_scripts: ["<all_urls>"]`, `permissions: ["storage","tabs","scripting"]`, action popup, background service_worker)
- [x] icons/ 폴더에 16/48/128 PNG 아이콘 생성
- [x] package.json (선택, 테스트/문법검사용, 빌드 도구 불필요 — 네이티브 JS 사용)

### T2: background.js — Service Worker (저장소 + 메시지 라우터)
- [x] chrome.storage.local 기반 preset CRUD (create/update/delete/list)
- [x] URL 패턴 매칭 함수 (`*.example.com`, `example.com/*` 형식, 호스트명 + 경로 와일드카드)
- [x] 탭별 캡처 모드 상태 관리 + content script 에 상태 전파
- [x] content script 주입 및 메시지 라우팅
- [x] autoApply: `tabs.onUpdated` 완료 시 매칭 프리셋 자동 적용

### T3: content.js — 캡처 모드 + 적용 모드
- [x] 캡처 모드 진입 시 모든 form input/select/textarea 에 하이라이트 오버레이
- [x] 요소 클릭 시 셀렉터 생성 + 부동 패널(라벨/값 입력 + 저장 버튼) 표시
- [x] 셀렉터 생성: id > name > aria-label/placeholder > data-* > CSS 경로 fallback
- [x] 적용 모드: 필드별 요소 찾기 → type 별 값 세팅
  - text/textarea: 네이티브 setter + input/change 이벤트
  - select: value 설정 + change 이벤트 (option 없으면 option 추가)
  - checkbox/radio: checked 설정 + change 이벤트
- [x] SPA 대응: MutationObserver 로 지연 렌더링 요소 재시도 (최대 N회)

### T4: popup/ — 프리셋 관리 UI (한국어)
- [x] popup.html: 현재 사이트 표시, 프리셋 목록, 새 프리셋 생성, 적용/수정/삭제 버튼
- [x] popup.css: 깔끔한 UI (다크/라이트 대응 최소화, 간결한 레이아웃)
- [x] popup.js: background 와 메시지 통신, 캡처 모드 토글 버튼, 프리셋 목록 렌더링
- [x] URL 패턴 편집 UI (기본값: 현재 호스트명 자동 입력)
- [x] autoApply 체크박스

### T5: README.md — 설치 및 사용법 (한국어)
- [x] 설치 방법 (chrome://extensions → 개발자 모드 → 압축해제된 확장 프로그램 로드)
- [x] 사용법: 캡처 모드 → 클릭 → 값 저장 → 적용
- [x] 데이터 구조 설명 + chrome.storage 백업/복원 팁

## Final Verification Wave

### F1: 코드 품질 리뷰 (Oracle)
- [x] VERDICT: 모든 파일이 MV3 규격 준수, 보안 이슈(로컬 파일 접근, 원격 코드) 없음, 하드코딩된 사이트 매칭 없음
### F2: 기능 완전성 리뷰 (Oracle)
- [x] VERDICT: T1~T5 요구사항 전부 구현, 캡처→저장→적용 플로우가 코드상 완결
### F3: 동작 QA (hands-on)
- [x] VERDICT: 문법 검사(node --check), manifest.json JSON 유효성, 스토리지 스키마 일관성 통과
### F4: 리뷰 (Momus)
- [x] VERDICT: 플랜 대비 구현 누락 없음

## Definition of Done
- [x] 모든 파일 생성 완료
- [x] node --check 로 모든 JS 문법 검증
- [x] manifest.json JSON 유효성 검증
- [x] 캡처→저장→적용 전체 플로우가 코드 레벨에서 추적 가능
