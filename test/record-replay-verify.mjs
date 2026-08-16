/**
 * 녹화 → 저장 → 재생 통합 검증 스크립트
 *
 * 브라우저 없이 mock DOM + mock chrome API로 실제 코드를 함께 구동해
 * "녹화 시작 → 평소대로 입력 → 종료 → RECORD_SAVE → 재생" 흐름을 검증한다.
 *   - content.js   (녹화 이벤트/디바운스/머지/delay, 순차 재생)
 *   - pii-detect.js (개인정보 자동 감지 → 민감 플래그)
 *   - background.js (RECORD_SAVE 프리셋 전체 암호화 저장, PRESET_LIST 복호화, APPLY_PRESET 라우팅)
 *   - secure-store.js (AES-256-GCM)
 *
 * 실행: node --experimental-default-type=module test/record-replay-verify.mjs
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ============================================================
// 1. mock DOM (content.js가 요구하는 최소 DOM)
// ============================================================

class MockClassList {
  constructor() {
    this._set = new Set();
  }
  add(...names) {
    names.forEach((n) => this._set.add(n));
  }
  remove(...names) {
    names.forEach((n) => this._set.delete(n));
  }
  toggle(name, force) {
    const on = force === undefined ? !this._set.has(name) : !!force;
    on ? this._set.add(name) : this._set.delete(name);
    return on;
  }
  contains(name) {
    return this._set.has(name);
  }
  get length() {
    return this._set.size;
  }
  [Symbol.iterator]() {
    return this._set[Symbol.iterator]();
  }
}

const domRegistry = { all: [] };

class MockElement {
  constructor(tagName, attrs = {}) {
    this.nodeType = 1; // Node.ELEMENT_NODE
    this.tagName = String(tagName).toUpperCase();
    this.attrs = { ...attrs };
    this.classList = new MockClassList();
    this.children = [];
    this.parentElement = null;
    this.isConnected = false;
    this.eventListeners = {};
    this.labels = [];
    this._innerHtml = '';
    this.textContent = attrs.textContent ?? '';
    this.id = attrs.id || '';
    this.name = attrs.name || '';
    this.type = attrs.type || '';
    this.placeholder = attrs.placeholder || '';
    this.checked = !!attrs.checked;
    this.options = attrs.options || [];
    if (attrs.class) {
      String(attrs.class).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    }
    if (this.id) {
      // id는 attr로도 노출
      this.attrs.id = this.id;
    }
    domRegistry.all.push(this);
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'name') this.name = String(value);
    if (name === 'placeholder') this.placeholder = String(value);
    if (name === 'type') this.type = String(value);
    if (name === 'class') {
      this.classList = new MockClassList();
      String(value).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
    }
  }

  appendChild(child) {
    if (child.parentElement) child.parentElement.removeChild(child);
    child.parentElement = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
    child.parentElement = null;
    child.isConnected = false;
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
    this.isConnected = false;
  }

  addEventListener(type, fn) {
    (this.eventListeners[type] = this.eventListeners[type] || []).push(fn);
  }
  dispatchEvent(ev) {
    const fns = this.eventListeners[ev.type] || [];
    fns.forEach((fn) => fn.call(this, ev));
    return true;
  }

  closest(sel) {
    let node = this;
    while (node) {
      if (matchesSelector(node, sel)) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelector(sel) {
    return document._queryAll(sel).find((el) => el !== this && isDescendant(el, this)) || null;
  }

  focus() {}
  select() {}
}

// value/checked는 setNativeValue(Object.getOwnPropertyDescriptor(proto,'value'))를 위해 프로토타입에 정의
Object.defineProperty(MockElement.prototype, 'value', {
  configurable: true,
  enumerable: true,
  get() {
    return this._value;
  },
  set(v) {
    this._value = v;
  }
});
Object.defineProperty(MockElement.prototype, 'checked', {
  configurable: true,
  enumerable: true,
  get() {
    return this._checked;
  },
  set(v) {
    this._checked = !!v;
  }
});

class MockInputElement extends MockElement {}
class MockSelectElement extends MockElement {}
class MockTextAreaElement extends MockElement {}

// setNativeValue(Object.getOwnPropertyDescriptor(proto,'value'))가 각 프로토타입의
// 자체 accessor를 찾도록 서브클래스 프로토타입에 개별 정의 (실제 브라우저 인터페이스 구조와 동일)
for (const cls of [MockInputElement, MockSelectElement, MockTextAreaElement]) {
  Object.defineProperty(cls.prototype, 'value', {
    configurable: true,
    enumerable: true,
    get() {
      return this._value;
    },
    set(v) {
      this._value = v;
    }
  });
}
Object.defineProperty(MockInputElement.prototype, 'checked', {
  configurable: true,
  enumerable: true,
  get() {
    return this._checked;
  },
  set(v) {
    this._checked = !!v;
  }
});

// innerHTML 최소 파서 (녹화 칩/토스트의 단순 태그용)
function setInnerHTML(el, html) {
  for (const c of [...el.children]) {
    c.isConnected = false;
    c.parentElement = null;
  }
  el.children.length = 0;
  const tagRe = /<(\w+)([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const [, tag, attrsStr, inner] = m;
    const attrs = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(attrsStr))) attrs[am[1]] = am[2];
    const child = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
    child.textContent = inner.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, '');
    el.appendChild(child);
  }
}
Object.defineProperty(MockElement.prototype, 'innerHTML', {
  configurable: true,
  get() {
    return this._innerHtml;
  },
  set(v) {
    this._innerHtml = v;
    setInnerHTML(this, v);
  }
});

function matchesSimple(el, simple) {
  let nth = null;
  const nthMatch = simple.match(/:nth-of-type\((\d+)\)$/);
  if (nthMatch) {
    nth = Number(nthMatch[1]);
    simple = simple.replace(/:nth-of-type\(\d+\)$/, '');
  }
  if (nth !== null) {
    const parent = el.parentElement;
    if (!parent) return false;
    const sameTag = parent.children.filter((c) => c.tagName === el.tagName);
    if (sameTag.indexOf(el) + 1 !== nth) return false;
  }
  if (simple.startsWith('#')) return el.id === simple.slice(1);
  if (simple.startsWith('.')) return el.classList.contains(simple.slice(1));
  const attrMatch = simple.match(/^\[([\w-]+)="([^"]*)"\]$/);
  if (attrMatch) return el.getAttribute(attrMatch[1]) === attrMatch[2];
  return el.tagName.toLowerCase() === simple.toLowerCase();
}

function matchesSelector(el, sel) {
  if (!el || !el.isConnected) return false;
  sel = sel.trim();
  if (sel.includes(' > ')) {
    const parts = sel.split('>').map((s) => s.trim());
    let cur = el;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!cur || !matchesSimple(cur, parts[i])) return false;
      if (i > 0) cur = cur.parentElement;
    }
    return true;
  }
  return matchesSimple(el, sel);
}

function isDescendant(el, ancestor) {
  let node = el;
  while (node) {
    if (node === ancestor) return true;
    node = node.parentElement;
  }
  return false;
}

const domElement = new MockElement('html');
const domBody = new MockElement('body');
const domHead = new MockElement('head');
domBody.parentElement = domElement;
domHead.parentElement = domElement;
domElement.children.push(domBody, domHead);
domBody.isConnected = true;
domHead.isConnected = true;
domElement.isConnected = true;

globalThis.Element = MockElement;
globalThis.HTMLInputElement = MockInputElement;
globalThis.HTMLSelectElement = MockSelectElement;
globalThis.HTMLTextAreaElement = MockTextAreaElement;
globalThis.Node = { ELEMENT_NODE: 1 };
globalThis.Event = class Event {
  constructor(type, opts) {
    this.type = type;
    this.bubbles = !!(opts && opts.bubbles);
  }
};
globalThis.MutationObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.CSS = { escape: (s) => String(s) };
globalThis.history = { pushState() {}, replaceState() {} };
globalThis.location = { href: 'https://example.com/form' };

const docListeners = {};
globalThis.document = {
  body: domBody,
  head: domHead,
  documentElement: domElement,
  createElement(tag) {
    const cls =
      tag === 'input' ? MockInputElement : tag === 'select' ? MockSelectElement : tag === 'textarea' ? MockTextAreaElement : MockElement;
    return new cls(tag);
  },
  querySelector(sel) {
    return this._queryAll(sel)[0] || null;
  },
  querySelectorAll(sel) {
    return this._queryAll(sel);
  },
  _queryAll(sel) {
    const out = [];
    const groups = sel.split(',').map((s) => s.trim()).filter(Boolean);
    for (const g of groups) {
      for (const el of domRegistry.all) {
        if (matchesSelector(el, g) && !out.includes(el)) out.push(el);
      }
    }
    return out;
  },
  addEventListener(type, fn) {
    (docListeners[type] = docListeners[type] || []).push(fn);
  },
  removeEventListener(type, fn) {
    const list = docListeners[type] || [];
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
  },
  // 테스트 전용: document 레벨 캡처 리스너로 합성 이벤트 전달
  dispatchSyntheticEvent(type, target) {
    const ev = { type, target, isComposing: false, keyCode: 0 };
    (docListeners[type] || []).forEach((fn) => fn.call(document, ev));
  }
};

globalThis.window = globalThis;
globalThis.addEventListener = function () {};
globalThis.removeEventListener = function () {};

// ============================================================
// 2. mock chrome API — content.js + background.js 라우팅
// ============================================================

function createStorage() {
  const store = new Map();
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return Object.fromEntries(store);
      if (typeof keys === 'string') return store.has(keys) ? { [keys]: store.get(keys) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (store.has(k)) out[k] = store.get(k);
        return out;
      }
      if (typeof keys === 'object') {
        const out = {};
        for (const [k, def] of Object.entries(keys)) out[k] = store.has(k) ? store.get(k) : def;
        return out;
      }
      return {};
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) store.set(k, v);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) store.delete(k);
    },
    dump() {
      return Object.fromEntries(store);
    }
  };
}

const storageLocal = createStorage();
const storageSession = createStorage();

let contentListener = null;
let backgroundListener = null;

function callContent(msg) {
  return new Promise((resolve) => {
    const done = (resp) => resolve(resp);
    const ret = contentListener(msg, { tab: { id: 1 } }, done);
    if (ret !== true) done({ ok: true }); // 동기 응답이 없는 경우 기본 성공
  });
}

function callBackground(msg) {
  return new Promise((resolve) => {
    backgroundListener(msg, { tab: { id: 1 } }, (resp) => resolve(resp));
  });
}

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(fn) {
        // content.js가 먼저 등록되면 content, background.js가 나중에 등록
        if (!contentListener) contentListener = fn;
        else backgroundListener = fn;
      }
    },
    sendMessage(msg, cb) {
      callBackground(msg).then((resp) => cb && cb(resp));
    },
    lastError: undefined
  },
  storage: {
    local: storageLocal,
    session: storageSession
  },
  tabs: {
    async get(tabId) {
      return { id: tabId, url: 'https://example.com/form' };
    },
    async sendMessage(tabId, msg) {
      return callContent(msg);
    },
    async create(opts) {
      return { id: 999, url: opts.url };
    },
    async remove() {},
    async query() {
      return [{ id: 1, url: 'https://example.com/form' }];
    },
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} }
  },
  action: {
    setBadgeText() {},
    setBadgeBackgroundColor() {}
  }
};

// ============================================================
// 3. 실제 코드 로드
// ============================================================

// pii-detect.js (IIFE)
eval(fs.readFileSync(path.join(ROOT, 'pii-detect.js'), 'utf8'));
assert.ok(window.PiiDetect && typeof window.PiiDetect.isSensitive === 'function', 'PiiDetect 로드 실패');

// PiiDetect 호출 계측 (recordEvent가 실제로 호출하는지 확인)
const piiCalls = [];
const origIsSensitive = window.PiiDetect.isSensitive;
window.PiiDetect.isSensitive = function (el, value) {
  const result = origIsSensitive(el, value);
  piiCalls.push({ tag: el && el.tagName, name: el && el.getAttribute('name'), value: String(value), result });
  return result;
};

// content.js (IIFE)
eval(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'));
assert.ok(contentListener, 'content.js 메시지 리스너 등록 실패');

// background.js + secure-store.js (ESM)
await import(pathToFileURL(path.join(ROOT, 'background.js')).href);
assert.ok(backgroundListener, 'background.js 메시지 리스너 등록 실패');

// ============================================================
// 4. 테스트 폼 구성
// ============================================================

const form = document.createElement('form');
const nameInput = document.createElement('input');
nameInput.setAttribute('id', 'user-name');
nameInput.setAttribute('name', 'user_name');
nameInput.setAttribute('placeholder', '이름');
nameInput.type = 'text';
const emailInput = document.createElement('input');
emailInput.setAttribute('id', 'user-email');
emailInput.setAttribute('name', 'user_email');
emailInput.setAttribute('placeholder', '이메일');
emailInput.type = 'text';
const deptSelect = document.createElement('select');
deptSelect.setAttribute('id', 'dept');
deptSelect.setAttribute('name', 'dept');
deptSelect.setAttribute('aria-label', '부서');
deptSelect.options = [
  { value: '', text: '선택하세요' },
  { value: 'eng', text: '엔지니어링' },
  { value: 'sales', text: '영업' }
];
deptSelect._value = 'eng';
const agreeCheck = document.createElement('input');
agreeCheck.setAttribute('id', 'agree');
agreeCheck.setAttribute('name', 'agree');
agreeCheck.setAttribute('aria-label', '약관 동의');
agreeCheck.type = 'checkbox';

form.appendChild(nameInput);
form.appendChild(emailInput);
form.appendChild(deptSelect);
form.appendChild(agreeCheck);
document.body.appendChild(form);

// ============================================================
// 5. 테스트: 녹화 → 저장 → 재생
// ============================================================

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    console.log('  ❌ ' + name + ' — 기대: ' + JSON.stringify(expected) + ', 실제: ' + JSON.stringify(actual));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonHas = (obj, needle) => JSON.stringify(obj).includes(needle);

// 5-1. 프리셋 생성
const created = await callBackground({ type: 'PRESET_CREATE', name: '테스트', urlPattern: 'example.com' });
assert.ok(created.ok, 'PRESET_CREATE 실패: ' + (created.error || ''));
const presetId = created.data.id;
// recordEvent 경로만 계측하도록 초기화 (직접 호출 제거)
piiCalls.length = 0;
console.log('\n[녹화]');

// 5-2. 녹화 시작
const recStart = await callBackground({ type: 'RECORD_START', presetId, tabId: 1 });
check('RECORD_START ok', !!recStart.ok, true);

// 5-3. 이름 입력 (첫 이벤트, delay 0)
nameInput._value = '홍길동';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(30);
// 5-4. 같은 필드 연속 수정 → 머지 (새 행동 없이 값만 갱신)
nameInput._value = '홍길동님';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(30);
// 5-5. 이메일 입력 (필드 전환 → 이름 pending flush) — 개인정보 자동 감지 대상
emailInput._value = 'hong@test.com';
document.dispatchSyntheticEvent('input', emailInput);
await sleep(30);
// 5-6. 셀렉트 변경 (change 즉시)
deptSelect._value = 'sales';
document.dispatchSyntheticEvent('change', deptSelect);
// 5-7. 체크박스 체크 (change 즉시)
agreeCheck._checked = true;
document.dispatchSyntheticEvent('change', agreeCheck);
// 이메일 pending flush 대기
await sleep(450);

// 5-8. 녹화 종료 → RECORD_SAVE
const recStop = await callBackground({ type: 'RECORD_STOP', presetId, tabId: 1 });
check('RECORD_STOP ok', !!recStop.ok, true);
await sleep(100); // RECORD_SAVE 메시지 처리 대기

// 5-9. 저장 검증 — 프리셋별 전체 암호화 (평문 인덱스 + 암호화 blob)
const stored = storageLocal.dump();
const indexEntry = stored.presets.find((p) => p.id === presetId);
assert.ok(indexEntry, '인덱스에 프리셋 없음');
check('인덱스에 fields 없음 (전체 암호화)', !Array.isArray(indexEntry.fields), true);
const blob = stored['sec:preset:' + presetId];
check('프리셋 blob 존재', !!(blob && blob.ct && blob.iv), true);
check('저장소 평문 미노출 (이메일)', jsonHas(stored, 'hong@test.com'), false);
check('저장소 평문 미노출 (이름)', jsonHas(stored, '홍길동님'), false);
check('저장소 평문 미노출 (부서)', jsonHas(stored, 'sales'), false);
assert.ok(
  piiCalls.some((c) => c.name === 'user_email' && c.result === true),
  'recordEvent가 isSensitive를 호출해 이메일을 감지해야 함'
);

// 5-10. PRESET_LIST 복호화 → 필드/민감 신호 검증
const list = await callBackground({ type: 'PRESET_LIST' });
const resolved = list.data.find((p) => p.id === presetId);
assert.ok(resolved, 'PRESET_LIST에 프리셋 없음');
const fields = resolved.fields;
const byName = {};
for (const f of fields) byName[f.selector] = f;
check('필드 수 (머지 반영)', fields.length, 4);
check('필드 순서: 이름', fields[0].label, '이름');
check('필드 순서: 이메일', fields[1].label, '이메일');
check('필드 순서: 부서', fields[2].label, '부서');
check('필드 순서: 약관', fields[3].label, '약관 동의');
check('이름 값 (연속 수정 머지)', byName['#user-name'].value, '홍길동님');
check('이메일 값 (복호화)', byName['#user-email'].value, 'hong@test.com');
check('부서 값', byName['#dept'].value, 'sales');
check('약관 값', byName['#agree'].value, 'true');
check('첫 이벤트 delay 0', fields[0].delay, 0);
check('이메일 delay 존재(숫자)', typeof byName['#user-email'].delay === 'number' && byName['#user-email'].delay > 0, true);
check('이메일 자동 민감 감지 (마스킹 신호)', !!byName['#user-email'].sensitive, true);
check('이름 자동 민감 감지 (이름 규칙)', !!byName['#user-name'].sensitive, true);

// 5-12. 재생 (순차, delay 타이밍)
console.log('\n[재생]');
const replayResp = await callBackground({ type: 'APPLY_PRESET', presetId, tabId: 1 });
assert.ok(replayResp.ok, 'APPLY_PRESET 실패: ' + (replayResp.error || ''));
const result = replayResp.data || {};
check('재생 성공 필드 수', (result.applied || []).length, 4);
check('재생 실패 0건', (result.failures || []).length, 0);
check('재생 순서 유지', (result.applied || []).map((r) => r.label).join(','), '이름,이메일,부서,약관 동의');
check('재생 후 이름 값', nameInput._value, '홍길동님');
check('재생 후 이메일 값 (복호화 적용)', emailInput._value, 'hong@test.com');
check('재생 후 부서 값', deptSelect._value, 'sales');
check('재생 후 약관 체크', agreeCheck._checked, true);

// 5-13. 순차 재생 확인 (delay 있는 필드가 순서대로 — 첫 필드 이후 delay > 0 인지)
check('재생에 delay 사용됨 (순차 경로)', result.applied.length > 0 && fields.some((f) => f.delay > 0), true);

// ============================================================
// 6. 결과
// ============================================================

console.log('\n' + '='.repeat(50));
console.log('결과: ' + pass + ' PASS / ' + fail + ' FAIL');
if (fail > 0) process.exit(1);
console.log('녹화 → 저장 → 재생 통합 검증 통과');