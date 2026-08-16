// 개인정보(PII) 자동 감지 모듈 — 다시하기 Chrome Extension
//
// 감지 순서 (Bitwarden 자동완성 파이프라인 참고):
//   1. autocomplete 속성 (autocomplete / x-autocompletetype / autocompletetype)
//   2. type="password"
//   3. 필드 메타데이터 키워드 (name/id/placeholder/aria-label/label/title/class)
//   4. 값 정규식 + 체크섬 (이메일/휴대폰/주민번호/카드/사업자등록번호/운전면허/여권/우편번호)
//
// 검증된 소스: toss/slash, ko-pii (Marker-Inc-Korea), kordoc, Bitwarden,
// validator.js, Braintree credit-card-type, SecureAgentics Adrian, LangChain.js
//
// 모든 패턴은 형식/체크섬 검증이며 실존 여부 검증이 아니다.

(() => {
  // ---------- 체크섬 검증 ----------

  function luhnValid(digits) {
    const d = String(digits).replace(/\D/g, '');
    if (d.length < 13 || d.length > 19) return false;
    let sum = 0;
    let double = false;
    for (let i = d.length - 1; i >= 0; i--) {
      let n = Number(d[i]);
      if (double) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      double = !double;
    }
    return sum % 10 === 0;
  }

  const RRN_WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  // 주민등록번호/외국인등록번호 체크섬 (13자리)
  function rrnChecksumValid(digits13) {
    if (!/^\d{13}$/.test(digits13)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(digits13[i]) * RRN_WEIGHTS[i];
    return (11 - (sum % 11)) % 10 === Number(digits13[12]);
  }

  // 앞 6자리가 실제 달력 날짜인지 (월 1-12, 일 1-31)
  function rrnDateValid(digits13) {
    const month = Number(digits13.slice(2, 4));
    const day = Number(digits13.slice(4, 6));
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
  }

  const BRN_KEYS = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  // 사업자등록번호 체크섬 (10자리, 국세청 규칙)
  function brnChecksumValid(digits10) {
    if (!/^\d{10}$/.test(digits10)) return false;
    if (digits10 === '0000000000') return false;
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += Number(digits10[i]) * BRN_KEYS[i];
    sum += Math.floor((Number(digits10[8]) * 5) / 10);
    return Number(digits10[9]) === (10 - (sum % 10)) % 10;
  }

  // ---------- 값 정규식 (test() 전용 — /g 없이 lastIndex 안전) ----------

  const EMAIL_RE = /(?<![A-Za-z0-9._%+\-])[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)+(?![A-Za-z0-9])/;
  const MOBILE_RE = /(?<![0-9+])(01[01679])[-.\s]{0,3}(\d{3,4})[-.\s]{0,3}(\d{4})(?![0-9])/;
  const MOBILE_INTL_RE = /(?<![0-9])(?:\+82|0082)[-.\s]?(?:\(0\)[-.\s]?)?(1[01679])[-.\s]{0,3}(\d{3,4})[-.\s]{0,3}(\d{4})(?![0-9])/;
  const HOME_RE = /(?<![0-9+])(02|03[1-3]|04[1-4]|05[1-5]|06[1-4]|070)[-.\s)]{0,3}(\d{3,4})[-.\s]{0,3}(\d{4})(?![0-9])/;
  const RRN_RE = /(?<!\d)(\d{6})([-‐‑–—.\s])([1-8]\d{6})(?!\d)/;
  const RRN_COMPACT_RE = /(?<!\d)(\d{6})([1-8]\d{6})(?!\d)/;
  const CARD_RE = /(?:3[47]\d{2}[-.\s]?\d{6}[-.\s]?\d{5})|(?:\d{4}[-.\s]?\d{4}[-.\s]?\d{4}[-.\s]?\d{4})/;
  const BRN_RE = /(?<![0-9])(\d{3})-?(\d{2})-?(\d{5})(?![0-9])/;
  const DRIVER_RE = /(?<![0-9])(\d{2})-(\d{2})-(\d{6})-(\d{2})(?![0-9])/;
  const PASSPORT_RE = /(?<![A-Za-z0-9])(PP|PM|PS|PO|PD|PR|PT|M|S|G|O|D|R|T)(\d{8})(?![A-Za-z0-9])/;
  // 우편번호 레거시 6자리 — 전체 값이 3-3 형식일 때만 판정
  // (부분 매치 금지: "555-123-4567"의 "555-123" 같은 오탐 방지)
  const POSTAL_LEGACY_RE = /^\d{3}-\d{3}$/;

  const CARD_BIN_FIRST = new Set(['2', '3', '4', '5', '6', '9']);

  // ---------- 메타데이터 키워드 ----------

  const METADATA_KEYWORD_RULES = [
    { name: 'password', re: /(비밀번호|password|passwd|pw|pwd|secret|token)/i },
    { name: 'rrn', re: /(주민등록번호|주민번호|외국인등록번호|rrn|ssn|resident)/i },
    { name: 'phone', re: /(전화|휴대폰|핸드폰|연락처|phone|mobile|tel|cell|handy)/i },
    { name: 'email', re: /(이메일|전자우편|email|e-?mail)/i },
    { name: 'address', re: /(주소|address|addr|zip|postal|우편)/i },
    { name: 'name', re: /(이름|성명|fullname|username|cardholder|firstname|lastname|givenname|familyname|surname|realname)/i },
    { name: 'account', re: /(계좌|account|acct|bank|은행)/i },
    { name: 'card', re: /(카드|신용카드|체크카드|card|cvv|cvc|cc-?num)/i },
    { name: 'business', re: /(사업자|business|biz|법인)/i },
    { name: 'birth', re: /(생년월일|birth|생일)/i },
    { name: 'passport', re: /(여권|passport)/i },
    { name: 'driver', re: /(운전면허|면허|driver|license)/i }
  ];

  const SENSITIVE_AUTOCOMPLETE = new Set([
    'current-password', 'new-password', 'one-time-code',
    'cc-number', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-type', 'cc-name',
    'ssn', 'tax-id',
    'tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-extension',
    'email', 'username',
    'name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name',
    'honorific-suffix', 'nickname', 'organization',
    'street-address', 'address-line1', 'address-line2', 'address-line3',
    'address-level1', 'address-level2', 'address-level3', 'address-level4',
    'country', 'country-name', 'postal-code', 'shipping', 'billing'
  ]);

  // ---------- 필드 메타데이터 수집 ----------

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function getAutocompleteValue(el) {
    const raw =
      el.getAttribute('autocomplete') ||
      el.getAttribute('x-autocompletetype') ||
      el.getAttribute('autocompletetype') ||
      '';
    const v = String(raw).toLowerCase().trim();
    if (!v || v === 'off' || v === 'on') return null;
    const tokens = v.split(/\s+/);
    return tokens[tokens.length - 1];
  }

  // 소문자 + 구분자 제거 후 키워드 매칭 (Bitwarden 토크나이즈 방식)
  function getFieldMetadata(el) {
    const parts = [];
    for (const attr of ['name', 'id', 'placeholder', 'aria-label', 'title', 'class']) {
      const v = el.getAttribute(attr);
      if (v) parts.push(v);
    }
    if (el.labels) {
      for (const l of el.labels) {
        if (l.textContent) parts.push(l.textContent);
      }
    }
    if (el.id) {
      try {
        const labelFor = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
        if (labelFor && labelFor.textContent) parts.push(labelFor.textContent);
      } catch (e) {
        // 잘못된 셀렉터 무시
      }
    }
    const parentLabel = el.closest('label');
    if (parentLabel && parentLabel.textContent) parts.push(parentLabel.textContent);
    return parts.join(' ').toLowerCase().replace(/[-_\s]+/g, '');
  }

  // ---------- 값 정규식 판정 ----------

  function detectValuePII(value) {
    const v = String(value);
    if (!v.trim()) return false;

    // 주민등록번호 (날짜 유효성 + 체크섬 보조)
    let m = v.match(RRN_RE) || v.match(RRN_COMPACT_RE);
    if (m) {
      const digits13 = m[1] + (m[3] || m[2]);
      if (rrnDateValid(digits13) && rrnChecksumValid(digits13)) return true;
      if (rrnDateValid(digits13)) return true; // 2020 이후 발급분은 체크섬 불일치 가능
    }

    // 이메일
    if (EMAIL_RE.test(v)) return true;

    // 카드번호 (Luhn + BIN 첫 자리)
    if (CARD_RE.test(v)) {
      const digits = v.replace(/\D/g, '');
      if (luhnValid(digits) && CARD_BIN_FIRST.has(digits[0])) return true;
    }

    // 휴대폰/유선전화
    if (MOBILE_RE.test(v) || MOBILE_INTL_RE.test(v) || HOME_RE.test(v)) return true;

    // 사업자등록번호 (체크섬)
    m = v.match(BRN_RE);
    if (m && brnChecksumValid(m[1] + m[2] + m[3])) return true;

    // 운전면허번호 (지역코드 11~28)
    m = v.match(DRIVER_RE);
    if (m) {
      const region = Number(m[1]);
      if (region >= 11 && region <= 28) return true;
    }

    // 여권번호
    m = v.match(PASSPORT_RE);
    if (m && m[2] !== '00000000') return true;

    // 우편번호 (레거시 3-3 전체 일치만 — 5자리 신형·부분 매치는 키워드 앵커 없이 판정 금지)
    if (POSTAL_LEGACY_RE.test(v.trim())) return true;

    return false;
  }

  // ---------- 메인 판정 ----------

  function isSensitive(el, value) {
    if (!(el instanceof Element)) return false;

    // 1. type="password"
    if (el instanceof HTMLInputElement && el.type === 'password') return true;

    // 2. autocomplete 속성
    const ac = getAutocompleteValue(el);
    if (ac && SENSITIVE_AUTOCOMPLETE.has(ac)) return true;

    // 3. 메타데이터 키워드
    const meta = getFieldMetadata(el);
    if (meta) {
      for (const rule of METADATA_KEYWORD_RULES) {
        if (rule.re.test(meta)) return true;
      }
    }

    // 4. 값 정규식
    if (value != null && detectValuePII(value)) return true;

    return false;
  }

  window.PiiDetect = { isSensitive };
})();