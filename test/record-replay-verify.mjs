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
  removeEventListener(type, fn) {
    const list = this.eventListeners[type];
    if (!list) return;
    const idx = list.indexOf(fn);
    if (idx !== -1) list.splice(idx, 1);
  }
  dispatchEvent(ev) {
    const fns = this.eventListeners[ev.type] || [];
    fns.forEach((fn) => fn.call(this, ev));
    return true;
  }

  closest(sel) {
    const parts = String(sel)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let node = this;
    while (node) {
      if (parts.some((p) => matchesSelector(node, p))) return node;
      node = node.parentElement;
    }
    return null;
  }

  click() {
    const ev = { type: 'click', target: this, bubbles: true };
    const fns = this.eventListeners.click || [];
    fns.forEach((fn) => fn.call(this, ev));
    if (typeof document.dispatchSyntheticEvent === 'function') {
      document.dispatchSyntheticEvent('click', this);
    }
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
Object.defineProperty(MockElement.prototype, 'innerText', {
  configurable: true,
  get() {
    return this.textContent;
  },
  set(v) {
    this.textContent = v;
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
  const tagAttr = simple.match(/^([a-zA-Z][\w-]*)(\[[^\]]+\])$/);
  if (tagAttr) {
    if (el.tagName.toLowerCase() !== tagAttr[1].toLowerCase()) return false;
    return matchesSimple(el, tagAttr[2]);
  }
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
    this.cancelable = !!(opts && opts.cancelable);
  }
};
globalThis.KeyboardEvent = class KeyboardEvent extends Event {
  constructor(type, opts = {}) {
    super(type, opts);
    this.key = opts.key || '';
    this.code = opts.code || '';
    this.keyCode = opts.keyCode || 0;
    this.which = opts.which || 0;
    this.isComposing = !!opts.isComposing;
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
  dispatchSyntheticEvent(type, target, extra) {
    const ev = Object.assign({ type, target, isComposing: false, keyCode: 0, key: '' }, extra || {});
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

let mockTabUrl = 'https://example.com/form';
const tabUpdatedListeners = [];
const tabCreatedListeners = [];
const tabRemovedListeners = [];

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
      if (typeof backgroundListener !== 'function') {
        const err = { message: 'background not ready' };
        chrome.runtime.lastError = err;
        if (cb) cb();
        chrome.runtime.lastError = undefined;
        return;
      }
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
      return { id: tabId, url: mockTabUrl, status: 'complete' };
    },
    async sendMessage(tabId, msg) {
      return callContent(msg);
    },
    async update(tabId, opts) {
      if (opts && opts.url) {
        mockTabUrl = opts.url;
        globalThis.location.href = opts.url;
        tabUpdatedListeners.forEach((fn) => fn(tabId, { url: opts.url }, { id: tabId, url: opts.url }));
        tabUpdatedListeners.forEach((fn) =>
          fn(tabId, { status: 'complete' }, { id: tabId, url: mockTabUrl, status: 'complete' })
        );
      }
      return { id: tabId, url: mockTabUrl, status: 'complete' };
    },
    async create(opts) {
      return { id: 999, url: opts.url };
    },
    async remove() {},
    async query() {
      return [{ id: 1, url: mockTabUrl }];
    },
    onUpdated: {
      addListener(fn) {
        tabUpdatedListeners.push(fn);
      },
      removeListener(fn) {
        const idx = tabUpdatedListeners.indexOf(fn);
        if (idx !== -1) tabUpdatedListeners.splice(idx, 1);
      }
    },
    onCreated: {
      addListener(fn) {
        tabCreatedListeners.push(fn);
      }
    },
    onRemoved: {
      addListener(fn) {
        tabRemovedListeners.push(fn);
      }
    }
  },
  action: {
    setBadgeText() {},
    setBadgeBackgroundColor() {}
  },
  webNavigation: {
    async getAllFrames() {
      return [{ frameId: 0 }];
    },
    onCompleted: {
      addListener() {}
    }
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
const bizInput = document.createElement('input');
bizInput.setAttribute('id', 'biz-no');
bizInput.setAttribute('name', 'biz_no');
bizInput.setAttribute('placeholder', '사업자번호');
bizInput.type = 'text';
bizInput._value = '';

const searchBtn = document.createElement('button');
searchBtn.setAttribute('id', 'search-btn');
searchBtn.setAttribute('type', 'button');
searchBtn.textContent = '검색';
const moreLink = document.createElement('a');
moreLink.setAttribute('id', 'price-more');
moreLink.setAttribute('href', '#price');
moreLink.textContent = '가격비교 더보기';

form.appendChild(nameInput);
form.appendChild(emailInput);
form.appendChild(deptSelect);
form.appendChild(agreeCheck);
form.appendChild(bizInput);
const payBtn = document.createElement('button');
payBtn.setAttribute('id', 'pay-btn');
payBtn.setAttribute('type', 'button');
payBtn.textContent = '결제하기';
payBtn.clickCount = 0;
payBtn.addEventListener('click', () => {
  payBtn.clickCount += 1;
});
const fileInput = document.createElement('input');
fileInput.setAttribute('id', 'attach');
fileInput.setAttribute('name', 'attach');
fileInput.type = 'file';
fileInput._value = '';
form.appendChild(searchBtn);
form.appendChild(moreLink);
form.appendChild(payBtn);
form.appendChild(fileInput);
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
const recIdle = await callBackground({ type: 'RECORD_STATUS', tabId: 1 });
check('녹화 전 RECORD_STATUS inactive', !!(recIdle.ok && recIdle.data && recIdle.data.active === false), true);

const recStart = await callBackground({ type: 'RECORD_START', presetId, tabId: 1 });
check('RECORD_START ok', !!recStart.ok, true);
const recOn = await callBackground({ type: 'RECORD_STATUS', tabId: 1 });
check('녹화 중 RECORD_STATUS active', !!(recOn.ok && recOn.data && recOn.data.active), true);
check('녹화 중 presetId 일치', recOn.data && recOn.data.presetId, presetId);
const recOnNoTab = await callBackground({ type: 'RECORD_STATUS' });
check('RECORD_STATUS tabId 생략 시 sender.tab 사용', !!(recOnNoTab.ok && recOnNoTab.data && recOnNoTab.data.active), true);

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
const recOff = await callBackground({ type: 'RECORD_STATUS', tabId: 1 });
check('종료 후 RECORD_STATUS inactive', !!(recOff.ok && recOff.data && recOff.data.active === false), true);
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
check('단일 사이트 urlPatterns 1개', Array.isArray(resolved.urlPatterns) && resolved.urlPatterns.length, 1);
check('단일 사이트 urlPattern=호스트', resolved.urlPattern, 'example.com');
check('인덱스 urlPatterns 포함', Array.isArray(indexEntry.urlPatterns) && indexEntry.urlPatterns[0], 'example.com');
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

const renamed = {
  ...resolved,
  fields: resolved.fields.map((f, i) => (i === 0 ? { ...f, label: '신청자 이름' } : f))
};
const renameResp = await callBackground({ type: 'PRESET_UPDATE', preset: renamed });
check('필드명 PRESET_UPDATE ok', !!renameResp.ok, true);
const listRenamed = await callBackground({ type: 'PRESET_LIST' });
const afterRename = (listRenamed.data || []).find((p) => p.id === presetId);
check('필드명 수정 반영', afterRename && afterRename.fields[0] && afterRename.fields[0].label, '신청자 이름');
resolved.fields[0].label = '신청자 이름';

// ============================================================
// 6. 여정 녹화: 클릭 / Enter / 페이지 이동 후 재개
// ============================================================
console.log('\n[여정 녹화]');
const created2 = await callBackground({ type: 'PRESET_CREATE', name: '여정', urlPattern: 'example.com' });
assert.ok(created2.ok, '여정 PRESET_CREATE 실패');
const journeyId = created2.data.id;
const recStart2 = await callBackground({ type: 'RECORD_START', presetId: journeyId, tabId: 1 });
check('여정 RECORD_START ok', !!recStart2.ok, true);

nameInput._value = '수저세트';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(450);
document.dispatchSyntheticEvent('keydown', nameInput, { key: 'Enter', keyCode: 13 });
searchBtn.click();
moreLink.click();
await sleep(50);

mockTabUrl = 'https://example.com/price';
globalThis.location.href = mockTabUrl;
tabUpdatedListeners.forEach((fn) => fn(1, { url: mockTabUrl }, { id: 1, url: mockTabUrl }));
tabUpdatedListeners.forEach((fn) => fn(1, { status: 'complete' }, { id: 1, url: mockTabUrl, status: 'complete' }));
await sleep(30);

emailInput._value = '인기 수저세트';
document.dispatchSyntheticEvent('input', emailInput);
await sleep(450);

const recStop2 = await callBackground({ type: 'RECORD_STOP', presetId: journeyId, tabId: 1 });
check('여정 RECORD_STOP ok', !!recStop2.ok, true);
check('여정 저장 개수 > 4', (recStop2.data && recStop2.data.saved) > 4, true);

const list2 = await callBackground({ type: 'PRESET_LIST' });
const journey = list2.data.find((p) => p.id === journeyId);
assert.ok(journey, '여정 프리셋 없음');
const types = journey.fields.map((f) => f.type);
check('여정에 text 포함', types.includes('text'), true);
check('여정에 keydown 포함', types.includes('keydown'), true);
check('여정에 click 포함', types.includes('click'), true);
check('여정에 navigate 포함', types.includes('navigate'), true);
check('여정 startUrl 저장', typeof journey.startUrl === 'string' && journey.startUrl.length > 0, true);
check('같은 호스트 이동은 사이트 1개', Array.isArray(journey.urlPatterns) && journey.urlPatterns.length, 1);
check('여정 허용 사이트 example.com', journey.urlPatterns[0], 'example.com');
const clickField = journey.fields.find((f) => f.type === 'click' && f.value.includes('가격비교'));
check('가격비교 더보기 클릭 기록', !!(clickField && clickField.label), true);
const navField = journey.fields.find((f) => f.type === 'navigate');
check('navigate URL 기록', !!(navField && String(navField.value).includes('/price')), true);

console.log('\n[여정 재생]');
mockTabUrl = 'https://example.com/other';
globalThis.location.href = mockTabUrl;
nameInput._value = '';
emailInput._value = '';
let searchClicked = 0;
let moreClicked = 0;
searchBtn.addEventListener('click', () => {
  searchClicked += 1;
});
moreLink.addEventListener('click', () => {
  moreClicked += 1;
});
const replay2 = await callBackground({ type: 'APPLY_PRESET', presetId: journeyId, tabId: 1 });
assert.ok(replay2.ok, '여정 APPLY_PRESET 실패: ' + (replay2.error || ''));
const jr = replay2.data || {};
check('여정 재생 실패 0건', (jr.failures || []).length, 0);
check('여정 재생 성공 > 0', (jr.applied || []).length > 0, true);
check('검색 버튼 클릭 재생', searchClicked > 0, true);
check('가격비교 더보기 클릭 재생', moreClicked > 0, true);
check('여정 재생 후 검색어', nameInput._value, '수저세트');

// 자동 적용은 여정 프리셋을 건너뛴다
const autoSet = { ...journey, autoApply: true };
const autoUp = await callBackground({ type: 'PRESET_UPDATE', preset: autoSet });
check('여정 autoApply 저장', !!autoUp.ok, true);
const autoCheck = await callBackground({ type: 'AUTO_APPLY_CHECK', url: 'https://example.com/form' });
const autoIds = (autoCheck.data || []).map((p) => p.id);
check('여정은 자동 적용 목록에서 제외', autoIds.includes(journeyId), false);

// ============================================================
// 6.5 녹화 중 다른 사이트 이동 → 허용 사이트 N개
// ============================================================
console.log('\n[다중 사이트 허용]');
const created3 = await callBackground({ type: 'PRESET_CREATE', name: '멀티사이트', urlPattern: 'example.com' });
assert.ok(created3.ok, '멀티사이트 PRESET_CREATE 실패');
const multiId = created3.data.id;
mockTabUrl = 'https://example.com/form';
globalThis.location.href = mockTabUrl;
const recStart3 = await callBackground({ type: 'RECORD_START', presetId: multiId, tabId: 1 });
check('멀티 RECORD_START ok', !!recStart3.ok, true);

nameInput._value = '이동테스트';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(450);

mockTabUrl = 'https://shop.other.com/cart';
globalThis.location.href = mockTabUrl;
tabUpdatedListeners.forEach((fn) => fn(1, { url: mockTabUrl }, { id: 1, url: mockTabUrl }));
tabUpdatedListeners.forEach((fn) => fn(1, { status: 'complete' }, { id: 1, url: mockTabUrl, status: 'complete' }));
await sleep(30);

const recStop3 = await callBackground({ type: 'RECORD_STOP', presetId: multiId, tabId: 1 });
check('멀티 RECORD_STOP ok', !!recStop3.ok, true);

const list3 = await callBackground({ type: 'PRESET_LIST' });
const multi = list3.data.find((p) => p.id === multiId);
assert.ok(multi, '멀티사이트 프리셋 없음');
check('urlPatterns 길이 2', Array.isArray(multi.urlPatterns) && multi.urlPatterns.length, 2);
check('첫 사이트 example.com', multi.urlPatterns[0], 'example.com');
check('둘째 사이트 shop.other.com', multi.urlPatterns[1], 'shop.other.com');
check('대표 urlPattern은 시작 사이트', multi.urlPattern, 'example.com');

mockTabUrl = 'https://shop.other.com/cart';
const replayOnB = await callBackground({ type: 'APPLY_PRESET', presetId: multiId, tabId: 1 });
check('둘째 사이트에서 재생 허용', !!replayOnB.ok, true);

const formBUp = await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: presetId,
    name: resolved.name,
    urlPattern: 'example.com',
    urlPatterns: ['example.com', 'form-b.test'],
    fields: resolved.fields,
    autoApply: true
  }
});
check('폼 전용 다중 사이트 저장', !!formBUp.ok, true);
mockTabUrl = 'https://form-b.test/page';
const formBApply = await callBackground({ type: 'APPLY_PRESET', presetId, tabId: 1 });
check('폼 전용 둘째 사이트에서 적용', !!formBApply.ok, true);
const autoB = await callBackground({ type: 'AUTO_APPLY_CHECK', url: 'https://form-b.test/page' });
const autoBIds = (autoB.data || []).map((p) => p.id);
check('자동 적용이 둘째 사이트도 매칭', autoBIds.includes(presetId), true);
mockTabUrl = 'https://blocked.example.net/';
const replayBlocked = await callBackground({ type: 'APPLY_PRESET', presetId, tabId: 1 });
check('미허용 사이트는 거절', !!replayBlocked.ok, false);

const created4 = await callBackground({ type: 'PRESET_CREATE', name: '와일드카드', urlPattern: '*.example.com' });
assert.ok(created4.ok, '와일드카드 PRESET_CREATE 실패');
const wildId = created4.data.id;
mockTabUrl = 'https://www.example.com/';
const recStart4 = await callBackground({ type: 'RECORD_START', presetId: wildId, tabId: 1 });
check('와일드카드 RECORD_START ok', !!recStart4.ok, true);
nameInput._value = '와일드';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(450);
mockTabUrl = 'https://shop.example.com/item';
tabUpdatedListeners.forEach((fn) => fn(1, { url: mockTabUrl }, { id: 1, url: mockTabUrl }));
tabUpdatedListeners.forEach((fn) => fn(1, { status: 'complete' }, { id: 1, url: mockTabUrl, status: 'complete' }));
await sleep(30);
const recStop4 = await callBackground({ type: 'RECORD_STOP', presetId: wildId, tabId: 1 });
check('와일드카드 RECORD_STOP ok', !!recStop4.ok, true);
const list4 = await callBackground({ type: 'PRESET_LIST' });
const wild = list4.data.find((p) => p.id === wildId);
check('와일드카드는 커버 호스트를 추가하지 않음', Array.isArray(wild.urlPatterns) && wild.urlPatterns.length, 1);
check('와일드카드 패턴 유지', wild.urlPatterns[0], '*.example.com');

const created5 = await callBackground({ type: 'PRESET_CREATE', name: '제한URL', urlPattern: 'example.com' });
const restrictId = created5.data.id;
mockTabUrl = 'https://example.com/form';
await callBackground({ type: 'RECORD_START', presetId: restrictId, tabId: 1 });
nameInput._value = '제한';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(450);
mockTabUrl = 'chrome://extensions';
tabUpdatedListeners.forEach((fn) => fn(1, { url: mockTabUrl }, { id: 1, url: mockTabUrl }));
mockTabUrl = 'https://allowed-b.com/page';
tabUpdatedListeners.forEach((fn) => fn(1, { url: mockTabUrl }, { id: 1, url: mockTabUrl }));
tabUpdatedListeners.forEach((fn) => fn(1, { status: 'complete' }, { id: 1, url: mockTabUrl, status: 'complete' }));
await sleep(30);
await callBackground({ type: 'RECORD_STOP', presetId: restrictId, tabId: 1 });
const list5 = await callBackground({ type: 'PRESET_LIST' });
const restrict = list5.data.find((p) => p.id === restrictId);
const restrictJoined = (restrict.urlPatterns || []).join(',');
check('chrome URL은 허용 목록 제외', restrictJoined.includes('chrome'), false);
check('허용 사이트에 allowed-b.com 포함', restrictJoined.includes('allowed-b.com'), true);

const legacyPreset = await callBackground({
  type: 'PRESET_UPDATE',
  preset: { ...resolved, urlPatterns: [], urlPattern: 'example.com' }
});
check('레거시 urlPatterns 빈 배열 저장', !!legacyPreset.ok, true);
mockTabUrl = 'https://example.com/form';
const legacyApply = await callBackground({ type: 'APPLY_PRESET', presetId, tabId: 1 });
check('레거시 urlPattern만으로 매칭', !!legacyApply.ok, true);

console.log('\n[녹화 재시작 가드]');
const created6 = await callBackground({ type: 'PRESET_CREATE', name: '이중시작', urlPattern: 'example.com' });
const idempId = created6.data.id;
mockTabUrl = 'https://example.com/form';
globalThis.location.href = mockTabUrl;
await callBackground({ type: 'RECORD_START', presetId: idempId, tabId: 1 });
nameInput._value = '이중시작값';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(450);
const recStartAgain = await callBackground({ type: 'RECORD_START', presetId: idempId, tabId: 1 });
check('같은 프리셋 재 RECORD_START ok', !!recStartAgain.ok, true);
await callBackground({ type: 'RECORD_STOP', presetId: idempId, tabId: 1 });
const list6 = await callBackground({ type: 'PRESET_LIST' });
const idemp = list6.data.find((p) => p.id === idempId);
const idempName = (idemp.fields || []).find((f) => f && String(f.value) === '이중시작값');
check('이중 RECORD_START 후에도 값 유지', !!idempName, true);

console.log('\n[팝업 탭 이어 녹화]');
const created7 = await callBackground({ type: 'PRESET_CREATE', name: '팝업이어짐', urlPattern: 'example.com' });
const popupRecId = created7.data.id;
mockTabUrl = 'https://example.com/form';
globalThis.location.href = mockTabUrl;
await callBackground({ type: 'RECORD_START', presetId: popupRecId, tabId: 1 });
nameInput._value = 'A사이트값';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(450);
const popupTab = { id: 2, openerTabId: 1, url: 'https://shop.other.com/popup', status: 'loading' };
tabCreatedListeners.forEach((fn) => fn(popupTab));
mockTabUrl = popupTab.url;
tabUpdatedListeners.forEach((fn) =>
  fn(2, { url: popupTab.url }, { id: 2, url: popupTab.url, openerTabId: 1 })
);
tabUpdatedListeners.forEach((fn) =>
  fn(2, { status: 'complete' }, { id: 2, url: popupTab.url, status: 'complete', openerTabId: 1 })
);
await sleep(30);
const popupStatus = await callBackground({ type: 'RECORD_STATUS', tabId: 2 });
check('팝업 탭 RECORD_STATUS active', !!(popupStatus.ok && popupStatus.data && popupStatus.data.active), true);
await callBackground({
  type: 'RECORD_APPEND',
  tabId: 2,
  event: { label: '팝업입력', selector: '#popup-q', value: 'B사이트값', type: 'text' }
});
const popupStop = await callBackground({ type: 'RECORD_STOP', presetId: popupRecId, tabId: 2 });
check('팝업 탭 RECORD_STOP ok', !!popupStop.ok, true);
const list7 = await callBackground({ type: 'PRESET_LIST' });
const popupPreset = list7.data.find((p) => p.id === popupRecId);
const popupTypes = (popupPreset.fields || []).map((f) => f.type);
const popupValues = (popupPreset.fields || []).map((f) => f.value);
const popupSites = (popupPreset.urlPatterns || []).join(',');
check('팝업 이어 녹화에 A 입력 유지', popupValues.includes('A사이트값'), true);
check('팝업 이어 녹화에 B 입력 포함', popupValues.includes('B사이트값'), true);
check('팝업 URL navigate 기록', popupTypes.includes('navigate'), true);
check('허용 사이트에 shop.other.com', popupSites.includes('shop.other.com'), true);

console.log('\n[입력 팝업 확인 후 닫힘]');
const openModalBtn = document.createElement('button');
openModalBtn.setAttribute('id', 'open-modal');
openModalBtn.setAttribute('type', 'button');
openModalBtn.textContent = '상세 입력';
const modalBox = document.createElement('div');
modalBox.setAttribute('id', 'input-modal');
modalBox.hidden = true;
const modalInput = document.createElement('input');
modalInput.setAttribute('id', 'modal-note');
modalInput.setAttribute('name', 'modal_note');
modalInput.setAttribute('placeholder', '추가 메모');
modalInput.type = 'text';
const modalConfirm = document.createElement('button');
modalConfirm.setAttribute('id', 'modal-confirm');
modalConfirm.setAttribute('type', 'button');
modalConfirm.textContent = '확인';
modalBox.appendChild(modalInput);
modalBox.appendChild(modalConfirm);
domBody.appendChild(openModalBtn);
domBody.appendChild(modalBox);
openModalBtn.addEventListener('click', () => {
  modalBox.hidden = false;
});
modalConfirm.addEventListener('click', () => {
  modalBox.hidden = true;
});

const created8 = await callBackground({ type: 'PRESET_CREATE', name: '모달입력', urlPattern: 'example.com' });
const modalId = created8.data.id;
mockTabUrl = 'https://example.com/form';
globalThis.location.href = mockTabUrl;
await callBackground({ type: 'RECORD_START', presetId: modalId, tabId: 1 });
document.dispatchSyntheticEvent('click', openModalBtn);
modalBox.hidden = false;
modalInput._value = '팝업메모';
document.dispatchSyntheticEvent('input', modalInput);
await sleep(450);
document.dispatchSyntheticEvent('click', modalConfirm);
modalBox.hidden = true;
await sleep(30);
const modalStop = await callBackground({ type: 'RECORD_STOP', presetId: modalId, tabId: 1 });
check('모달 RECORD_STOP ok', !!modalStop.ok, true);
const list8 = await callBackground({ type: 'PRESET_LIST' });
const modalPreset = list8.data.find((p) => p.id === modalId);
const modalFields = modalPreset.fields || [];
check('모달 열기 클릭 기록', modalFields.some((f) => f.type === 'click' && String(f.value || '').includes('상세 입력')), true);
check('모달 입력값 기록', modalFields.some((f) => f.value === '팝업메모'), true);
check('모달 확인 클릭 기록', modalFields.some((f) => f.type === 'click' && String(f.value || '').includes('확인')), true);
modalInput._value = '';
modalBox.hidden = true;
const modalReplay = await callBackground({ type: 'APPLY_PRESET', presetId: modalId, tabId: 1 });
check('모달 재생 ok', !!modalReplay.ok, true);
check('모달 재생 후 입력값', modalInput._value, '팝업메모');

const created9 = await callBackground({ type: 'PRESET_CREATE', name: '팝업닫힘', urlPattern: 'example.com' });
const closeId = created9.data.id;
mockTabUrl = 'https://example.com/form';
await callBackground({ type: 'RECORD_START', presetId: closeId, tabId: 1 });
nameInput._value = '닫힘전A';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(450);
const closeTab = { id: 3, openerTabId: 1, url: 'https://shop.other.com/dialog', status: 'loading' };
tabCreatedListeners.forEach((fn) => fn(closeTab));
tabUpdatedListeners.forEach((fn) =>
  fn(3, { url: closeTab.url }, { id: 3, url: closeTab.url, openerTabId: 1 })
);
tabUpdatedListeners.forEach((fn) =>
  fn(3, { status: 'complete' }, { id: 3, url: closeTab.url, status: 'complete', openerTabId: 1 })
);
await callBackground({
  type: 'RECORD_APPEND',
  tabId: 3,
  event: { label: '팝업확인값', selector: '#dlg', value: '닫힘전B', type: 'text' }
});
tabRemovedListeners.forEach((fn) => fn(3));
const afterClose = await callBackground({ type: 'RECORD_STATUS', tabId: 1 });
check('팝업 닫힌 뒤 A 녹화 유지', !!(afterClose.ok && afterClose.data && afterClose.data.active), true);
nameInput._value = '닫힌뒤A';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(450);
await callBackground({ type: 'RECORD_STOP', presetId: closeId, tabId: 1 });
const list9 = await callBackground({ type: 'PRESET_LIST' });
const closePreset = list9.data.find((p) => p.id === closeId);
const closeVals = (closePreset.fields || []).map((f) => f.value);
check('팝업 닫힘 후 A 입력 유지', closeVals.includes('닫힘전A'), true);
check('닫힌 팝업의 입력 보존', closeVals.includes('닫힘전B'), true);
check('팝업 닫힌 뒤 A 추가 입력', closeVals.includes('닫힌뒤A'), true);

console.log('\n[재생 속도 설정]');
const paceGet0 = await callBackground({ type: 'SETTINGS_GET' });
check('기본 재생 속도 normal', paceGet0.data && paceGet0.data.replayPace, 'normal');
const paceSet = await callBackground({ type: 'SETTINGS_SET', replayPace: 'fast' });
check('SETTINGS_SET fast', paceSet.data && paceSet.data.replayPace, 'fast');
const paceGet1 = await callBackground({ type: 'SETTINGS_GET' });
check('SETTINGS_GET fast 유지', paceGet1.data && paceGet1.data.replayPace, 'fast');
const created10 = await callBackground({ type: 'PRESET_CREATE', name: '속도테스트', urlPattern: 'example.com' });
const paceId = created10.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: paceId,
    name: '속도테스트',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    startUrl: 'https://example.com/form',
    fields: [
      { id: 'n1', label: '이동', selector: '', value: 'https://example.com/form', type: 'navigate', delay: 3000 },
      { id: 't1', label: '이름', selector: '#user-name', value: '빠른재생', type: 'text', delay: 2500 }
    ]
  }
});
nameInput._value = '';
const tFast = Date.now();
const paceReplay = await callBackground({ type: 'APPLY_PRESET', presetId: paceId, tabId: 1 });
const fastMs = Date.now() - tFast;
check('빠름 재생 ok', !!paceReplay.ok, true);
check('빠름이면 이동 후 대기가 짧음', fastMs < 1200, true);
await callBackground({ type: 'SETTINGS_SET', replayPace: 'normal' });

console.log('\n[손댈 칸 / 나중에 입력]');
const createdHand = await callBackground({ type: 'PRESET_CREATE', name: '손댈칸', urlPattern: 'example.com' });
const handId = createdHand.data.id;
mockTabUrl = 'https://example.com/form';
globalThis.location.href = mockTabUrl;
await callBackground({ type: 'RECORD_START', presetId: handId, tabId: 1 });
nameInput._value = '고정이름';
document.dispatchSyntheticEvent('input', nameInput);
await sleep(450);
bizInput._value = '';
document.dispatchSyntheticEvent('input', bizInput);
await sleep(450);
await callBackground({ type: 'RECORD_STOP', presetId: handId, tabId: 1 });
const listHand = await callBackground({ type: 'PRESET_LIST' });
const handPreset = listHand.data.find((p) => p.id === handId);
const handBySel = {};
for (const f of handPreset.fields || []) handBySel[f.selector] = f;
check('빈 값 녹화 handEdit', !!(handBySel['#biz-no'] && handBySel['#biz-no'].handEdit), true);
check('값 있는 칸은 handEdit 아님', !handBySel['#user-name'].handEdit, true);
const indexHand = storageLocal.dump().presets.find((p) => p.id === handId);
check('인덱스에 fields 없음', !Array.isArray(indexHand.fields), true);
check('인덱스에 handEdit 없음', jsonHas(indexHand, 'handEdit'), false);
nameInput._value = '';
bizInput._value = '페이지사업자';
bizInput.classList.remove('fp-hand-edit');
const handReplay = await callBackground({ type: 'APPLY_PRESET', presetId: handId, tabId: 1 });
const handRes = handReplay.data || {};
const handApplied = handRes.applied || [];
check('손댈 칸 재생 실패 0', (handRes.failures || []).length, 0);
check('손댈 칸 applied 플래그', handApplied.some((a) => a.handEdit && a.label === handBySel['#biz-no'].label), true);
check('고정 칸은 채움', nameInput._value, '고정이름');
check('손댈 칸 값 유지', bizInput._value, '페이지사업자');
check('손댈 칸 노란 표시', bizInput.classList.contains('fp-hand-edit'), true);
check('채움 칸은 노란 표시 아님', nameInput.classList.contains('fp-hand-edit'), false);

const createdLegacy = await callBackground({ type: 'PRESET_CREATE', name: '레거시빈값', urlPattern: 'example.com' });
const legacyId = createdLegacy.data.id;
const blobBeforeUpdate = storageLocal.dump()['sec:preset:' + legacyId];
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: legacyId,
    name: '레거시빈값',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    fields: [{ id: 'leg1', label: '사업자', selector: '#biz-no', value: '', type: 'text' }]
  }
});
const storedLegacy = storageLocal.dump();
const legacyIndex = storedLegacy.presets.find((p) => p.id === legacyId);
check('레거시 인덱스 필드 없음', !Array.isArray(legacyIndex.fields), true);
const listLegacy = await callBackground({ type: 'PRESET_LIST' });
const emptyLegacy = listLegacy.data.find((p) => p.id === legacyId);
check('레거시 빈 값 읽기 handEdit', !!(emptyLegacy.fields[0] && emptyLegacy.fields[0].handEdit), true);
const blobAfterList = storageLocal.dump()['sec:preset:' + legacyId];
check('읽기 후 blob 재기록 없음', JSON.stringify(blobAfterList), JSON.stringify(storedLegacy['sec:preset:' + legacyId]));
void blobBeforeUpdate;

bizInput._value = '레거시유지';
bizInput.classList.remove('fp-hand-edit');
const legacyReplay = await callBackground({ type: 'APPLY_PRESET', presetId: legacyId, tabId: 1 });
check('레거시 재생 실패 0', (legacyReplay.data.failures || []).length, 0);
check('레거시 재생 값 안 넣음', bizInput._value, '레거시유지');
check('레거시 노란 표시', bizInput.classList.contains('fp-hand-edit'), true);

const createdFlag = await callBackground({ type: 'PRESET_CREATE', name: '플래그편집', urlPattern: 'example.com' });
const flagId = createdFlag.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: flagId,
    name: '플래그편집',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    fields: [{ id: 'n', label: '이름', selector: '#user-name', value: '덮이면안됨', type: 'text', handEdit: true }]
  }
});
nameInput._value = '페이지이름';
nameInput.classList.remove('fp-hand-edit');
const flagReplay = await callBackground({ type: 'APPLY_PRESET', presetId: flagId, tabId: 1 });
const flagRes = flagReplay.data || {};
check('값 있는 손댈 칸 안 덮음', nameInput._value, '페이지이름');
check('값 있는 손댈 칸 노란 표시', nameInput.classList.contains('fp-hand-edit'), true);
check('값 있는 손댈 칸 실패 0', (flagRes.failures || []).length, 0);
const missFill = await callContent({
  type: 'APPLY_ACTION',
  waitMs: 0,
  field: { id: 'm', label: '없는칸', selector: '#missing-field', value: '값있음', type: 'text', handEdit: false }
});
check('손댈 칸 아닌 깨진 셀렉터는 누락', !!(missFill.result && missFill.result.ok === false), true);
check('누락 라벨이 손댈 칸과 다름', missFill.result && missFill.result.label, '없는칸');
check('누락에 handEdit 플래그 없음', !!(missFill.result && missFill.result.handEdit), false);

const missHand = await callContent({
  type: 'APPLY_ACTION',
  waitMs: 0,
  field: { id: 'mh', label: '사업자', selector: '#missing-hand', value: '', type: 'text', handEdit: true }
});
check('손댈 칸 요소 없음은 누락', !!(missHand.result && missHand.result.ok === false), true);

const createdOff = await callBackground({ type: 'PRESET_CREATE', name: '손댈칸해제', urlPattern: 'example.com' });
const offId = createdOff.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: offId,
    name: '손댈칸해제',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    fields: [{ id: 'off1', label: '사업자', selector: '#biz-no', value: '', type: 'text', handEdit: false }]
  }
});
bizInput._value = '해제전값';
bizInput.classList.remove('fp-hand-edit');
const offReplay = await callBackground({ type: 'APPLY_PRESET', presetId: offId, tabId: 1 });
const offRes = offReplay.data || {};
check('손댈 칸 해제 후 빈 값 적용', bizInput._value, '');
check('해제 후 노란 표시 없음', bizInput.classList.contains('fp-hand-edit'), false);
check('해제 후 실패 0 (요소 있음)', (offRes.failures || []).length, 0);

const createdJourneyHand = await callBackground({ type: 'PRESET_CREATE', name: '여정손댈', urlPattern: 'example.com' });
const jhId = createdJourneyHand.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: jhId,
    name: '여정손댈',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    startUrl: 'https://example.com/form',
    fields: [
      { id: 'jt', label: '이름', selector: '#user-name', value: '여정이름', type: 'text', delay: 0 },
      { id: 'jb', label: '사업자', selector: '#biz-no', value: '', type: 'text', delay: 0, handEdit: true },
      { id: 'jc', label: '검색', selector: '#search-btn', value: '검색', type: 'click', delay: 0 }
    ]
  }
});
nameInput._value = '';
bizInput._value = '여정사업자';
bizInput.classList.remove('fp-hand-edit');
const jhReplay = await callBackground({ type: 'APPLY_PRESET', presetId: jhId, tabId: 1 });
const jhRes = jhReplay.data || {};
check('여정 손댈 칸 실패 0', (jhRes.failures || []).length, 0);
check('여정 고정 칸 채움', nameInput._value, '여정이름');
check('여정 손댈 칸 유지', bizInput._value, '여정사업자');
check('여정 손댈 칸 노란 표시', bizInput.classList.contains('fp-hand-edit'), true);
check('여정 손댈 칸 ok', (jhRes.applied || []).some((a) => a.handEdit && a.label === '사업자'), true);
check('클릭은 손댈 칸 아님', !(jhRes.applied || []).some((a) => a.label === '검색' && a.handEdit), true);

const createdMerge = await callBackground({ type: 'PRESET_CREATE', name: '머지손댈', urlPattern: 'example.com' });
const mergeId = createdMerge.data.id;
await callBackground({ type: 'RECORD_START', presetId: mergeId, tabId: 1 });
bizInput._value = '임시사업자';
document.dispatchSyntheticEvent('input', bizInput);
await sleep(450);
bizInput._value = '';
document.dispatchSyntheticEvent('input', bizInput);
await sleep(450);
await callBackground({ type: 'RECORD_STOP', presetId: mergeId, tabId: 1 });
const mergeList = await callBackground({ type: 'PRESET_LIST' });
const mergeBiz = ((mergeList.data || []).find((p) => p.id === mergeId)?.fields || []).find((f) => f.selector === '#biz-no');
check('값→빈 머지 handEdit', !!(mergeBiz && mergeBiz.handEdit), true);
check('값→빈 머지 값 비움', mergeBiz && mergeBiz.value, '');
bizInput._value = '페이지유지';
bizInput.classList.remove('fp-hand-edit');
const mergeReplay = await callBackground({ type: 'APPLY_PRESET', presetId: mergeId, tabId: 1 });
check('값→빈 머지 재생 안 덮음', bizInput._value, '페이지유지');
check('값→빈 머지 노란 표시', bizInput.classList.contains('fp-hand-edit'), true);
check('값→빈 머지 실패 0', ((mergeReplay.data || {}).failures || []).length, 0);

const createdMerge2 = await callBackground({ type: 'PRESET_CREATE', name: '머지채움', urlPattern: 'example.com' });
const merge2Id = createdMerge2.data.id;
await callBackground({ type: 'RECORD_START', presetId: merge2Id, tabId: 1 });
bizInput._value = '';
document.dispatchSyntheticEvent('input', bizInput);
await sleep(450);
bizInput._value = '최종사업자';
document.dispatchSyntheticEvent('input', bizInput);
await sleep(450);
await callBackground({ type: 'RECORD_STOP', presetId: merge2Id, tabId: 1 });
const merge2List = await callBackground({ type: 'PRESET_LIST' });
const merge2Biz = ((merge2List.data || []).find((p) => p.id === merge2Id)?.fields || []).find((f) => f.selector === '#biz-no');
check('빈→값 머지 handEdit 아님', !(merge2Biz && merge2Biz.handEdit), true);
check('빈→값 머지 최종값', merge2Biz && merge2Biz.value, '최종사업자');
bizInput._value = '';
bizInput.classList.remove('fp-hand-edit');
const merge2Replay = await callBackground({ type: 'APPLY_PRESET', presetId: merge2Id, tabId: 1 });
check('빈→값 머지 재생 채움', bizInput._value, '최종사업자');
check('빈→값 머지 노란 표시 없음', bizInput.classList.contains('fp-hand-edit'), false);

console.log('\n[위험 클릭 / 첨부 / 속도 / 리픽 / 스크럽]');
const createdDanger = await callBackground({ type: 'PRESET_CREATE', name: '위험클릭', urlPattern: 'example.com' });
const dangerId = createdDanger.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: dangerId,
    name: '위험클릭',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    startUrl: 'https://example.com/form',
    fields: [
      { id: 'dn', label: '이름', selector: '#user-name', value: '위험이름', type: 'text', delay: 0 },
      { id: 'dp', label: '결제', selector: '#pay-btn', value: '결제하기', type: 'click', delay: 0 },
      { id: 'db', label: '사업자', selector: '#biz-no', value: '이후값', type: 'text', delay: 0 }
    ]
  }
});
nameInput._value = '';
bizInput._value = '유지';
payBtn.clickCount = 0;
const dangerReplay = await callBackground({ type: 'APPLY_PRESET', presetId: dangerId, tabId: 1 });
const dangerRes = dangerReplay.data || {};
check('위험 클릭 전 칸 채움', nameInput._value, '위험이름');
check('위험 클릭 안 함', payBtn.clickCount, 0);
check('위험 클릭 blocked', (dangerRes.applied || []).some((a) => a.blocked && a.label === '결제'), true);
check('위험 클릭 이후 필드 중단', bizInput._value, '유지');

const createdFile = await callBackground({ type: 'PRESET_CREATE', name: '첨부', urlPattern: 'example.com' });
const fileId = createdFile.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: fileId,
    name: '첨부',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    fields: [
      { id: 'fn', label: '이름', selector: '#user-name', value: '첨부이름', type: 'text' },
      { id: 'ff', label: '파일', selector: '#attach', value: 'x.png', type: 'text' }
    ]
  }
});
nameInput._value = '';
fileInput._value = 'old';
const fileReplay = await callBackground({ type: 'APPLY_PRESET', presetId: fileId, tabId: 1 });
const fileRes = fileReplay.data || {};
check('첨부 전 칸 채움', nameInput._value, '첨부이름');
check('파일 값 안 넣음', fileInput._value, 'old');
check('파일 fileStop', (fileRes.applied || []).some((a) => a.fileStop), true);
check('파일 실패 아님', (fileRes.failures || []).length, 0);

await callBackground({ type: 'SETTINGS_SET', replayPace: 'slow' });
const createdFast = await callBackground({ type: 'PRESET_CREATE', name: '빠름프리셋', urlPattern: 'example.com' });
const fastId = createdFast.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: fastId,
    name: '빠름프리셋',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    replayPace: 'fast',
    fields: [{ id: 'pn', label: '이름', selector: '#user-name', value: '속도이름', type: 'text', delay: 1000 }]
  }
});
nameInput._value = '';
const tPace = Date.now();
const pacePresetReplay = await callBackground({ type: 'APPLY_PRESET', presetId: fastId, tabId: 1 });
const paceMs = Date.now() - tPace;
check('프리셋 빠름이 전역 느림을 덮음', nameInput._value, '속도이름');
check('프리셋 빠름이면 1초 delay가 짧아짐', paceMs < 400, true);
check('프리셋 속도 재생 ok', !!pacePresetReplay.ok, true);
await callBackground({ type: 'SETTINGS_SET', replayPace: 'normal' });

// 최고속도: delay 무시 즉시 적용
const createdMax = await callBackground({ type: 'PRESET_CREATE', name: '최고속도프리셋', urlPattern: 'example.com' });
const maxId = createdMax.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: maxId,
    name: '최고속도프리셋',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    replayPace: 'max',
    fields: [{ id: 'pm', label: '이름', selector: '#user-name', value: '최고이름', type: 'text', delay: 2000 }]
  }
});
nameInput._value = '';
const tMax = Date.now();
const maxReplay = await callBackground({ type: 'APPLY_PRESET', presetId: maxId, tabId: 1 });
const maxMs = Date.now() - tMax;
check('최고속도 프리셋 채움', nameInput._value, '최고이름');
check('최고속도는 2초 delay 무시 즉시', maxMs < 300, true);
check('최고속도 재생 ok', !!maxReplay.ok, true);
const maxPace = await callBackground({ type: 'SETTINGS_SET', replayPace: 'max' });
check('전역 최고속도 저장', maxPace.data && maxPace.data.replayPace, 'max');
await callBackground({ type: 'SETTINGS_SET', replayPace: 'normal' });

const createdRepick = await callBackground({ type: 'PRESET_CREATE', name: '리픽', urlPattern: 'example.com' });
const repickId = createdRepick.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: repickId,
    name: '리픽',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    fields: [{ id: 'rf1', label: '이름', selector: '#missing-old', value: '리픽이름', type: 'text' }]
  }
});
nameInput._value = '';
const beforeRepick = await callBackground({ type: 'APPLY_PRESET', presetId: repickId, tabId: 1 });
check('리픽 전 누락', ((beforeRepick.data || {}).failures || []).length > 0, true);
await callBackground({
  type: 'CAPTURE_SAVE_FIELD',
  presetId: repickId,
  replaceFieldId: 'rf1',
  field: { id: 'rf1', label: '이름', selector: '#user-name', value: '리픽이름', type: 'text' }
});
nameInput._value = '';
const afterRepick = await callBackground({ type: 'APPLY_PRESET', presetId: repickId, tabId: 1 });
check('리픽 후 채움', nameInput._value, '리픽이름');
check('리픽 후 실패 0', ((afterRepick.data || {}).failures || []).length, 0);

// repick 빈 값 → 손댈 칸 (verification-gap patch)
const createdRepickEmpty = await callBackground({ type: 'PRESET_CREATE', name: '리픽빈값', urlPattern: 'example.com' });
const repickEmptyId = createdRepickEmpty.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: repickEmptyId,
    name: '리픽빈값',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    fields: [{ id: 'rf2', label: '사업자', selector: '#biz-no', value: '기존값', type: 'text', handEdit: false }]
  }
});
bizInput._value = '페이지유지';
bizInput.classList.remove('fp-hand-edit');
const beforeEmpty = await callBackground({ type: 'APPLY_PRESET', presetId: repickEmptyId, tabId: 1 });
check('리픽빈값 전 채움', bizInput._value, '기존값');
await callBackground({
  type: 'CAPTURE_SAVE_FIELD',
  presetId: repickEmptyId,
  replaceFieldId: 'rf2',
  field: { id: 'rf2', label: '사업자', selector: '#biz-no', value: '', type: 'text' }
});
const listEmpty = await callBackground({ type: 'PRESET_LIST' });
const emptyField = ((listEmpty.data || []).find((p) => p.id === repickEmptyId)?.fields || []).find((f) => f.id === 'rf2');
check('리픽 빈 값 저장', emptyField && emptyField.value, '');
check('리픽 빈 값 handEdit', !!(emptyField && emptyField.handEdit), true);
check('리픽 빈 값 id 유지', emptyField && emptyField.id, 'rf2');
bizInput._value = '페이지유지2';
bizInput.classList.remove('fp-hand-edit');
const afterEmpty = await callBackground({ type: 'APPLY_PRESET', presetId: repickEmptyId, tabId: 1 });
check('리픽 빈 값 재생 안 덮음', bizInput._value, '페이지유지2');
check('리픽 빈 값 노란 표시', bizInput.classList.contains('fp-hand-edit'), true);
check('리픽 빈 값 실패 0', ((afterEmpty.data || {}).failures || []).length, 0);

const createdScrub = await callBackground({ type: 'PRESET_CREATE', name: '스크럽원본', urlPattern: 'example.com' });
const scrubId = createdScrub.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: scrubId,
    name: '스크럽원본',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    replayPace: 'fast',
    fields: [
      { id: 's1', label: '이름', selector: '#user-name', value: '비밀이름', type: 'text', handEdit: false },
      { id: 's2', label: '결제', selector: '#pay-btn', value: '결제하기', type: 'click', replayBlocked: true }
    ]
  }
});
const exp = await callBackground({ type: 'EXPORT_DATA', scrub: true });
const scrubPreset = ((exp.data || {}).presets || []).find((p) => p.id === scrubId);
check('스크럽 값 비움', !!(scrubPreset && scrubPreset.fields.every((f) => f.value === '')), true);
check('스크럽 그룹 키', Array.isArray((exp.data || {}).groups), true);
check('스크럽 속도 유지', !!(scrubPreset && scrubPreset.replayPace === 'fast'), true);
check('스크럽 금지 플래그 유지', !!(scrubPreset && scrubPreset.fields.some((f) => f.replayBlocked)), true);
const fullExp = await callBackground({ type: 'EXPORT_DATA' });
const fullPreset = ((fullExp.data || {}).presets || []).find((p) => p.id === scrubId);
check('실값 내보내기는 값 유지', !!(fullPreset && fullPreset.fields.some((f) => f.value === '비밀이름')), true);
const imp = await callBackground({
  type: 'IMPORT_DATA',
  data: { schemaVersion: 1, appId: 'dasihagi', presets: [scrubPreset], groups: [] }
});
check('스크럽 가져오기 성공', !!(imp.ok && imp.data && imp.data.importedPresets >= 1), true);
// scrub handEdit 보존 (verification-gap patch)
const createdScrubHand = await callBackground({ type: 'PRESET_CREATE', name: '스크럽손댈', urlPattern: 'example.com' });
const scrubHandId = createdScrubHand.data.id;
await callBackground({
  type: 'PRESET_UPDATE',
  preset: {
    id: scrubHandId,
    name: '스크럽손댈',
    urlPattern: 'example.com',
    urlPatterns: ['example.com'],
    replayPace: 'slow',
    fields: [
      { id: 'sh1', label: '사업자', selector: '#biz-no', value: '비밀사업자', type: 'text', handEdit: true },
      { id: 'sh2', label: '결제', selector: '#pay-btn', value: '결제하기', type: 'click', replayBlocked: true }
    ]
  }
});
const expHand = await callBackground({ type: 'EXPORT_DATA', scrub: true });
const scrubHand = ((expHand.data || {}).presets || []).find((p) => p.id === scrubHandId);
check('스크럽 손댈 칸 값 비움', scrubHand && scrubHand.fields.find((f) => f.id === 'sh1')?.value === '', true);
check('스크럽 손댈 칸 플래그 유지', !!(scrubHand && scrubHand.fields.find((f) => f.id === 'sh1')?.handEdit), true);
check('스크럽 금지 플래그 유지(손댈 프리셋)', !!(scrubHand && scrubHand.fields.find((f) => f.id === 'sh2')?.replayBlocked), true);
check('스크럽 속도 유지(slow)', scrubHand && scrubHand.replayPace, 'slow');
const impHand = await callBackground({
  type: 'IMPORT_DATA',
  data: { schemaVersion: 1, appId: 'dasihagi', presets: [scrubHand], groups: [] }
});
check('스크럽 손댈 가져오기 성공', !!(impHand.ok && impHand.data && impHand.data.importedPresets >= 1), true);
const listHandScrub = await callBackground({ type: 'PRESET_LIST' });
const importedHand = (listHandScrub.data || []).find((p) => p.name === '스크럽손댈' && p.id !== scrubHandId);
const importedFieldHand = importedHand && importedHand.fields.find((f) => f.label === '사업자');
check('가져온 손댈 칸 handEdit 복원', !!(importedFieldHand && importedFieldHand.handEdit), true);
check('가져온 손댈 칸 값 비어있음', importedFieldHand && importedFieldHand.value, '');
bizInput._value = '가져온페이지';
bizInput.classList.remove('fp-hand-edit');
if (importedHand) {
  const replayHandScrub = await callBackground({ type: 'APPLY_PRESET', presetId: importedHand.id, tabId: 1 });
  check('가져온 손댈 프리셋 재생 안 덮음', bizInput._value, '가져온페이지');
  check('가져온 손댈 노란 표시', bizInput.classList.contains('fp-hand-edit'), true);
}

const jhList = await callBackground({ type: 'PRESET_LIST' });
const jhStored = (jhList.data || []).find((p) => p.id === jhId);
const jhClick = (jhStored && jhStored.fields || []).find((f) => f.type === 'click');
check('클릭 필드에 handEdit 없음', !!(jhClick && !('handEdit' in jhClick)), true);

// ============================================================
// 7. 결과
// ============================================================

console.log('\n' + '='.repeat(50));
console.log('결과: ' + pass + ' PASS / ' + fail + ' FAIL');
if (fail > 0) process.exit(1);
console.log('녹화 → 저장 → 재생 통합 검증 통과');