/**
 * 실제 브라우저 E2E 검증 — 메타-프롬프트-브라우저-E2E.md
 *
 * 실제 Chromium에 dist 확장을 로드하고, localhost 서버로 test-form.html을 서빙한 뒤
 * 녹화 → 저장(프리셋 전체 암호화) → 재생과 엣지케이스(A~E)를 검증한다.
 * storage 검증은 확장 service worker 컨텍스트에서 chrome.storage.local을 직접 조회한다.
 *
 * 실행: node --experimental-default-type=module test/browser-e2e-verify.mjs
 */
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { webcrypto, randomBytes } from 'node:crypto';

const subtle = webcrypto.subtle;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = 8765;
const FORM_URL = `http://127.0.0.1:${PORT}/`;
const JOURNEY_HOME = `http://127.0.0.1:${PORT}/j/home`;
const PATTERN = `127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('   PASS ' + name);
  } else {
    failed++;
    failures.push(name);
    console.log('   FAIL ' + name + (extra ? ' — ' + extra : ''));
  }
}

let context = null;
let sw = null;
let extId = null;
let formPage = null;
let userDataDir = null;
const swEvents = [];
let scenarioErrors = [];

const BENIGN_ERROR = /context invalidated|message port closed|receiving end does not exist/i;

function trackErrors(page) {
  page.on('pageerror', (e) => {
    if (!BENIGN_ERROR.test(e.message)) scenarioErrors.push('pageerror: ' + e.message);
  });
}

async function getStorage() {
  return sw.evaluate(() => chrome.storage.local.get(null));
}

// SW 컨텍스트는 import()가 금지되므로(ServiceWorker 사양), 테스트 프로세스에서
// vault_key_v1(AES-256-GCM 키)으로 직접 복호화 — 실제 암호화 형식 검증도 겸함.
async function encryptSecret(keyB64, plaintext) {
  const key = await subtle.importKey('raw', Buffer.from(keyB64, 'base64'), 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, Buffer.from(String(plaintext), 'utf8'));
  return { ct: Buffer.from(ct).toString('base64'), iv: iv.toString('base64') };
}

async function decryptSecret(dump, id) {
  const entry = dump['sec:' + id];
  if (!entry || !dump.vault_key_v1) return null;
  const key = await subtle.importKey('raw', Buffer.from(dump.vault_key_v1, 'base64'), 'AES-GCM', false, ['decrypt']);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(entry.iv, 'base64') }, key, Buffer.from(entry.ct, 'base64'));
  return Buffer.from(pt).toString('utf8');
}

async function decryptPreset(id) {
  const dump = await getStorage();
  const raw = await decryptSecret(dump, 'preset:' + id);
  return raw ? JSON.parse(raw) : null;
}

async function latestPresetId() {
  const dump = await getStorage();
  const arr = [...(dump.presets || [])].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return arr[0] ? arr[0].id : null;
}

async function openPopup() {
  const popup = await context.newPage();
  trackErrors(popup);
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await formPage.bringToFront(); // popup 초기화 시 active tab = 폼 탭이 되도록
  await popup.reload();
  await popup.waitForLoadState('load');
  return popup;
}

async function createPreset(popup, name, pattern = PATTERN, autoApply = false) {
  await popup.click('#btn-new-preset');
  await popup.fill('#ed-name', name);
  await popup.fill('#ed-pattern', pattern);
  if (autoApply) await popup.check('#ed-autoapply');
  await popup.click('#btn-save-preset');
  await popup.waitForSelector('#toast.show');
}

async function showAllPresets(popup) {
  const chk = popup.locator('#chk-filter-site');
  if (await chk.count()) {
    if (await chk.isChecked()) await chk.uncheck();
  }
}

async function clickCardAct(popup, name, act) {
  const card = popup.locator('.preset-card:has-text("' + name + '")');
  await card.waitFor({ state: 'visible' });
  if (act !== 'replay') {
    await card.locator('[data-menu-toggle]').click();
    await card.locator('.menu:not(.hidden) [data-act="' + act + '"]').waitFor({ state: 'visible' });
  }
  await card.locator('[data-act="' + act + '"]').click();
}

async function clickRecord(popup) {
  await popup.click('#btn-record');
  await sleep(300);
}

async function beginRecord(popup) {
  await formPage.evaluate(() => {
    document.querySelector('.fp-record-chip')?.remove();
    document.querySelector('form')?.reset();
  });
  await clickRecord(popup);
  await formPage.waitForSelector('.fp-record-chip');
}

async function clickStopRecord() {
  await formPage.click('#fp-record-stop');
}

async function waitRecordChip(timeout = 15000) {
  await formPage.waitForSelector('.fp-record-chip', { timeout });
}

async function waitBlob(id, minFields = 1) {
  for (let i = 0; i < 20; i++) {
    const p = await decryptPreset(id);
    if (p && p.fields.length >= minFields) return p;
    await sleep(250);
  }
  return decryptPreset(id);
}

async function instrumentOrder() {
  await formPage.evaluate(() => {
    window.__fpOrder = [];
    const push = (el, ev) => {
      if (!el || !el.form) return;
      const id = el.name || el.id || el.placeholder || el.type;
      window.__fpOrder.push({ ev, id, t: performance.now() });
    };
    document.addEventListener('input', (e) => push(e.target, 'input'), true);
    document.addEventListener('change', (e) => push(e.target, 'change'), true);
  });
}

async function firstOrder(ids) {
  return formPage.evaluate((ns) => {
    const seen = {};
    const out = [];
    for (const item of window.__fpOrder || []) {
      if (!(item.id in seen)) {
        seen[item.id] = true;
        out.push(item);
      }
    }
    return out.filter((x) => ns.includes(x.id)).map((x) => x.id);
  }, ids);
}

async function runScenario(name, fn) {
  console.log('\n=== ' + name + ' ===');
  scenarioErrors = [];
  try {
    await Promise.race([fn(), sleep(150000).then(() => Promise.reject(new Error('시나리오 타임아웃 150s')))]);
  } catch (e) {
    failed++;
    failures.push(name + ': 예외 — ' + e.message);
    console.log('   EXCEPTION: ' + e.message);
  }
  if (scenarioErrors.length) {
    for (const m of scenarioErrors) {
      failed++;
      failures.push(name + ': ' + m);
      console.log('   PAGE ERROR: ' + m);
    }
  }
}

// ---------- 시나리오 A: 기본 흐름 ----------
async function scenarioA() {
  const popup = await openPopup();
  await createPreset(popup, '기본');
  await beginRecord(popup);
  await formPage.fill('input[name="name"]', '홍길동');
  await formPage.fill('input[name="email"]', 'hong@example.com');
  await formPage.selectOption('select[name="dept"]', 'eng');
  await formPage.check('input[name="agree"]');
  await clickStopRecord();

  const id = await latestPresetId();
  const blob = await waitBlob(id, 4);
  const dump = await getStorage();
  const text = JSON.stringify(dump);
  const idxEntry = (dump.presets || []).find((p) => p.id === id);

  ok('A1 인덱스만 저장 (fields 없음)', !!idxEntry && !('fields' in idxEntry) && !('value' in idxEntry));
  ok('A2 blob 존재 (sec:preset:<id>)', !!dump['sec:preset:' + id]);
  ok('A3 저장소 평문 0 (이름/이메일)', !text.includes('홍길동') && !text.includes('hong@example.com'));
  ok('A4 필드 4개 저장', blob && blob.fields.length === 4, 'n=' + (blob && blob.fields.length));
  ok('A5 이메일 sensitive=true', blob && blob.fields.find((f) => f.selector === '[name="email"]')?.sensitive === true);
  ok('A6 부서/약관 비민감', blob && blob.fields.find((f) => f.type === 'select')?.sensitive !== true && blob.fields.find((f) => f.type === 'checkbox')?.sensitive !== true);

  await instrumentOrder();
  await formPage.evaluate(() => document.querySelector('form').reset()); // 재생이 실제로 채우는지 검증
  const popup2 = await openPopup();
  await popup2.click('.preset-card:has-text("기본") [data-act="replay"]');
  await formPage.waitForFunction(
    () =>
      document.querySelector('input[name="name"]').value === '홍길동' &&
      document.querySelector('input[name="email"]').value === 'hong@example.com' &&
      document.querySelector('select[name="dept"]').value === 'eng' &&
      document.querySelector('input[name="agree"]').checked,
    { timeout: 20000 }
  );
  const order = await firstOrder(['name', 'email', 'dept', 'agree']);
  ok('A7 재생 순서 (이름→이메일→부서→약관)', JSON.stringify(order) === JSON.stringify(['name', 'email', 'dept', 'agree']), order.join(','));
  await popup2.close().catch(() => {});
}

// ---------- 시나리오 B: 녹화 엣지케이스 ----------
async function scenarioB1Merge() {
  const popup = await openPopup();
  await createPreset(popup, 'B1');
  await beginRecord(popup);
  await formPage.fill('input[name="name"]', '홍');
  await sleep(600); // debounce(400ms) flush
  await formPage.fill('input[name="name"]', '홍길동');
  await sleep(600);
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 1);
  const nameFields = (blob?.fields || []).filter((f) => f.selector === '[name="name"]');
  ok('B1 같은 필드 연속 입력 머지 (이벤트 1개)', nameFields.length === 1, 'n=' + nameFields.length);
  ok('B1 최종값만 저장', nameFields[0] && nameFields[0].value === '홍길동', JSON.stringify(nameFields.map((f) => f.value)));
}

async function scenarioB2Flush() {
  const popup = await openPopup();
  await createPreset(popup, 'B2');
  await beginRecord(popup);
  await formPage.fill('input[name="name"]', '홍길동');
  await formPage.fill('input[name="email"]', 'hong@example.com'); // 대기 없이 전환 → flush
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const order = (blob?.fields || []).map((f) => f.selector);
  ok('B2 필드 전환 flush (이름 먼저 기록)', order.length >= 2 && order[0] === '[name="name"]' && order[1] === '[name="email"]', order.join(' | '));
}

async function scenarioB3Radio() {
  const popup = await openPopup();
  await createPreset(popup, 'B3');
  await beginRecord(popup);
  await formPage.check('input[name="payment"][value="card"]');
  await formPage.check('input[name="payment"][value="bank"]');
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const radios = (blob?.fields || []).filter((f) => f.type === 'radio');
  ok('B3 radio 별도 셀렉터로 2개 이벤트', radios.length === 2, 'n=' + radios.length);
  ok('B3 radio 값은 checked 상태(true)', radios.every((f) => f.value === 'true'), JSON.stringify(radios.map((f) => f.value)));

  await instrumentOrder();
  await formPage.evaluate(() => document.querySelector('form').reset()); // 재생 실검증
  const popup2 = await openPopup();
  await popup2.click('.preset-card:has-text("B3") [data-act="replay"]');
  await formPage.waitForFunction(() => document.querySelector('input[name="payment"][value="bank"]').checked, { timeout: 15000 });
  const finalState = await formPage.evaluate(
    () =>
      document.querySelector('input[name="payment"][value="bank"]').checked &&
      !document.querySelector('input[name="payment"][value="card"]').checked
  );
  ok('B3 재생 → 마지막 선택(bank) 체크, 카드 해제', finalState);
  await popup2.close().catch(() => {});
}

async function scenarioB4CheckboxUncheck() {
  const popup = await openPopup();
  await createPreset(popup, 'B4');
  await beginRecord(popup);
  await formPage.check('input[name="agree"]');
  await formPage.uncheck('input[name="agree"]');
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 1);
  const agree = (blob?.fields || []).find((f) => f.type === 'checkbox');
  ok('B4 체크 해제 상태 저장 (value=false)', agree && agree.value === 'false', 'value=' + (agree && agree.value));

  await formPage.check('input[name="agree"]'); // 재생 시 해제되는지 실검증
  const popup2 = await openPopup();
  await popup2.click('.preset-card:has-text("B4") [data-act="replay"]');
  await formPage.waitForFunction(() => document.querySelector('input[name="agree"]').checked === false, { timeout: 15000 });
  ok('B4 재생 → 약관 해제 상태 유지', await formPage.evaluate(() => document.querySelector('input[name="agree"]').checked === false));
  await popup2.close().catch(() => {});
}

async function scenarioB5ChangeFlush() {
  const popup = await openPopup();
  await createPreset(popup, 'B5');
  await beginRecord(popup);
  await formPage.fill('textarea[name="memo"]', '메모내용');
  await formPage.selectOption('select[name="dept"]', 'sales'); // 입력 직후 change → pending flush
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const order = (blob?.fields || []).map((f) => f.selector);
  ok('B5 입력 후 change → 대기 입력 먼저 flush', order.length >= 2 && order[0] === '[name="memo"]' && order[1] === '[name="dept"]', order.join(' | '));
}

async function scenarioB6EmptyValue() {
  const popup = await openPopup();
  await createPreset(popup, 'B6');
  await beginRecord(popup);
  await formPage.fill('textarea[name="memo"]', '메모내용');
  await sleep(600);
  await formPage.fill('textarea[name="memo"]', ''); // 전체 삭제
  await formPage.click('input[name="name"]'); // 다른 필드로 이동
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 1);
  const memo = (blob?.fields || []).find((f) => f.selector === '[name="memo"]');
  ok('B6 빈 값 이벤트 저장', !!memo && memo.value === '', 'value=' + JSON.stringify(memo && memo.value));
  ok('B6 빈 필드 1개만 기록', (blob?.fields || []).length === 1, 'n=' + (blob?.fields || []).length);
}

// ---------- 시나리오 C: PII/암호화 ----------
async function scenarioC() {
  const popup = await openPopup();
  await createPreset(popup, 'PII');
  await beginRecord(popup);
  await formPage.fill('input[name="email"]', 'hong@example.com');
  await formPage.fill('textarea[name="memo"]', '메모내용');
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const dump = await getStorage();
  const text = JSON.stringify(dump);

  ok('C1 이메일 sensitive=true (마스킹 신호)', blob && blob.fields.find((f) => f.selector === '[name="email"]')?.sensitive === true);
  ok('C1-2 메모 sensitive=false', blob && blob.fields.find((f) => f.selector === '[name="memo"]')?.sensitive === false);
  ok('C2 저장소 평문 0 (이메일/메모)', !text.includes('hong@example.com') && !text.includes('메모내용'));
  ok('C3 vault_key_v1 존재', !!dump.vault_key_v1);
  ok('C3-2 인덱스에 필드 값 없음', !('fields' in (dump.presets || []).find((p) => p.id === id)));

  const popup2 = await openPopup();
  await popup2.waitForSelector('.preset-card:has-text("PII")');
  const masked = await popup2.$$eval('.preset-card:has-text("PII") .field-copy-value.is-sensitive', (els) => els.map((e) => e.textContent));
  ok('C4 popup 민감 필드 •••••• 마스킹', masked.length === 1 && masked[0] === '••••••', JSON.stringify(masked));
  const memoShown = await popup2.$eval('.preset-card:has-text("PII") .field-copy-row:has-text("메모") .field-copy-value', (e) => e.textContent);
  ok('C4-2 popup 비민감 값 평문 표시', memoShown === '메모내용', String(memoShown));
  await popup2.close().catch(() => {});
}

// ---------- 시나리오 D: 재생/적용 엣지케이스 ----------
async function scenarioD1Delay() {
  const popup = await openPopup();
  await createPreset(popup, 'D1');
  await beginRecord(popup);
  await formPage.fill('input[name="name"]', '홍길동');
  await sleep(700);
  await formPage.fill('input[name="email"]', 'hong@example.com');
  await sleep(1200); // email debounce(400ms) 자동 flush 후에도 700ms+ 간격 확보
  await formPage.selectOption('select[name="dept"]', 'sales');
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 3);
  const emailF = (blob?.fields || []).find((f) => f.selector === '[name="email"]');
  const deptF = (blob?.fields || []).find((f) => f.selector === '[name="dept"]');
  ok('D1 delay 기록', (emailF?.delay || 0) >= 500 && (deptF?.delay || 0) >= 700, 'email=' + emailF?.delay + ', dept=' + deptF?.delay);

  await instrumentOrder();
  await formPage.evaluate(() => document.querySelector('form').reset()); // 재생 실검증
  const popup2 = await openPopup();
  await popup2.click('.preset-card:has-text("D1") [data-act="replay"]');
  await formPage.waitForFunction(() => document.querySelector('select[name="dept"]').value === 'sales', { timeout: 25000 });
  const order = await firstOrder(['name', 'email', 'dept']);
  ok('D1 순차 재생 순서', JSON.stringify(order) === JSON.stringify(['name', 'email', 'dept']), order.join(','));
  const gaps = await formPage.evaluate(() => {
    const o = window.__fpOrder || [];
    const t = (id) => o.find((x) => x.id === id);
    const name = t('name');
    const email = t('email');
    const dept = t('dept');
    return { e: name && email ? email.t - name.t : -1, d: email && dept ? dept.t - email.t : -1 };
  });
  ok('D1 delay 재생 반영 (이름→이메일 ≥500ms)', gaps.e >= 500, 'gap=' + Math.round(gaps.e));
  ok('D1 delay 재생 반영 (이메일→부서 ≥700ms)', gaps.d >= 700, 'gap=' + Math.round(gaps.d));
  await popup2.close().catch(() => {});
}

async function scenarioD2Mismatch() {
  const popup = await openPopup();
  await createPreset(popup, '대상아님', 'example.com');
  await formPage.evaluate(() => document.querySelector('form').reset());
  await popup.click('#btn-back');
  await showAllPresets(popup);
  await popup.waitForSelector('.preset-card:has-text("대상아님")');
  await clickCardAct(popup, '대상아님', 'replay');
  await popup.waitForSelector('#toast.show');
  const toast = await popup.textContent('#toast');
  ok('D2 urlPattern 불일치 → 오류 메시지', toast.includes('재생 실패') && toast.includes('대상 사이트'), toast);
  ok('D2 폼 미변경', await formPage.evaluate(() => document.querySelector('input[name="name"]').value === ''));
  await popup.close().catch(() => {});
}

async function scenarioD3AutoApply() {
  const popup = await openPopup();
  await createPreset(popup, '자동', PATTERN, true);
  await beginRecord(popup);
  await formPage.fill('input[name="name"]', '김철수');
  await sleep(300);
  await formPage.fill('input[name="email"]', 'kim@example.com');
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  ok('D3 autoApply 저장', blob && blob.autoApply === true);

  // 페이지 재진입(reload) → tabs.onUpdated → 자동 채움
  await formPage.reload();
  let autoFilled = false;
  try {
    await formPage.waitForFunction(() => document.querySelector('input[name="name"]').value === '김철수', { timeout: 8000 });
    autoFilled = true;
  } catch (e) {
    autoFilled = false;
  }
  ok('D3 페이지 재진입 자동 채움', autoFilled, autoFilled ? '' : 'reload 후 8초 내 미채움 (race)');

  // 재진입(pushState) → AUTO_APPLY_CHECK → 연속 적용 (재진입 안전성)
  await formPage.evaluate(() => history.pushState({}, '', '/?r=1'));
  await formPage.waitForFunction(() => document.querySelector('input[name="email"]').value === 'kim@example.com', { timeout: 10000 });
  await formPage.evaluate(() => history.pushState({}, '', '/?r=2'));
  await sleep(2500); // 두 번째 적용 실행 중
  const consistent = await formPage.evaluate(
    () =>
      document.querySelector('input[name="name"]').value === '김철수' &&
      document.querySelector('input[name="email"]').value === 'kim@example.com'
  );
  ok('D3 재진입 연속 적용 후 값 일관', consistent);
  await popup.close().catch(() => {});
}

// ---------- 시나리오 F: 멀티페이지 여정 녹화/재생 ----------
async function scenarioF() {
  await formPage.goto(JOURNEY_HOME);
  await formPage.bringToFront();
  const popup = await openPopup();
  await createPreset(popup, '여정E2E');
  await formPage.evaluate(() => document.querySelector('.fp-record-chip')?.remove());
  await clickRecord(popup);
  await waitRecordChip();

  await formPage.fill('#q', '수저세트');
  await sleep(500);
  await Promise.all([formPage.waitForURL(/\/j\/results/), formPage.click('#search-btn')]);
  await waitRecordChip();
  const chipAfterNav = await formPage.isVisible('.fp-record-chip');
  ok('F2 페이지 이동 후 녹화 칩 복원', chipAfterNav);

  await Promise.all([formPage.waitForURL(/\/j\/compare/), formPage.click('#price-more')]);
  await waitRecordChip();

  await formPage.fill('#q2', '인기 수저세트');
  await sleep(500);
  await formPage.click('#confirm-btn');
  await formPage.waitForSelector('#confirmed:not([hidden])');
  await Promise.all([formPage.waitForURL(/\/j\/product/), formPage.click('#product-1')]);
  await waitRecordChip();
  await formPage.click('#fp-record-stop');

  const id = await latestPresetId();
  const blob = await waitBlob(id, 4);
  const types = (blob?.fields || []).map((f) => f.type);
  ok('F1 필드 4개 이상', blob && blob.fields.length >= 4, 'n=' + (blob && blob.fields.length));
  ok('F1 text 기록', types.includes('text'), types.join(','));
  ok('F1 click 기록', types.includes('click'), types.join(','));
  ok('F1 navigate 기록', types.includes('navigate'), types.join(','));
  ok('F1 startUrl이 홈', !!(blob && blob.startUrl && blob.startUrl.includes('/j/home')), String(blob && blob.startUrl));
  const hasQuery = (blob?.fields || []).some((f) => String(f.value || '').includes('수저세트'));
  ok('F1 검색어 값 보존', hasQuery);

  await formPage.goto(FORM_URL);
  await formPage.bringToFront();
  const popup2 = await openPopup();
  await showAllPresets(popup2);
  await clickCardAct(popup2, '여정E2E', 'replay');
  await formPage.waitForURL(/\/j\/product/, { timeout: 60000 });
  const productId = await formPage.textContent('#product-id');
  ok('F3 재생 후 상품 페이지', productId && productId.trim() === '1', 'id=' + productId);
  await popup2.close().catch(() => {});

  const popup3 = await openPopup();
  await showAllPresets(popup3);
  await clickCardAct(popup3, '여정E2E', 'edit');
  const autoDisabled = await popup3.locator('#ed-autoapply').isDisabled();
  const hintVisible = await popup3.locator('#ed-autoapply-hint').isVisible();
  ok('F4 여정 자동적용 UI 비활성', autoDisabled && hintVisible);
  await popup3.close().catch(() => {});

  const dumpF = await getStorage();
  const rawF = await decryptSecret(dumpF, 'preset:' + id);
  const parsedF = rawF ? JSON.parse(rawF) : null;
  if (parsedF) {
    parsedF.autoApply = true;
    const blobF = await encryptSecret(dumpF.vault_key_v1, JSON.stringify(parsedF));
    await sw.evaluate(async ({ presetId, blob }) => {
      const data = await chrome.storage.local.get('presets');
      const index = Array.isArray(data.presets) ? data.presets : [];
      const entry = index.find((p) => p.id === presetId);
      if (entry) entry.autoApply = true;
      await chrome.storage.local.set({ presets: index, ['sec:preset:' + presetId]: blob });
    }, { presetId: id, blob: blobF });
  }

  await formPage.goto(JOURNEY_HOME);
  await sleep(4000);
  const stayedHome = /\/j\/home/.test(formPage.url());
  ok('F4 여정은 자동 적용되지 않음', stayedHome, formPage.url());
}

async function scenarioGModalPopup() {
  await formPage.goto(FORM_URL);
  await formPage.bringToFront();
  const popup = await openPopup();
  await createPreset(popup, '모달입력');
  await beginRecord(popup);
  await formPage.click('#open-modal');
  await formPage.waitForSelector('#input-modal:not([hidden])');
  await formPage.fill('#modal-note', '팝업메모');
  await sleep(450);
  await formPage.click('#modal-confirm');
  await formPage.waitForFunction(() => document.getElementById('input-modal')?.hidden === true);
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const types = (blob?.fields || []).map((f) => f.type);
  const values = (blob?.fields || []).map((f) => String(f.value || ''));
  ok('G1 모달 열기 클릭 기록', (blob?.fields || []).some((f) => f.type === 'click' && String(f.value || '').includes('상세 입력')));
  ok('G1 모달 입력값 기록', values.includes('팝업메모'), values.join(','));
  ok('G1 확인 클릭 기록', (blob?.fields || []).some((f) => f.type === 'click' && String(f.value || '').includes('확인')));

  await formPage.evaluate(() => {
    const modal = document.getElementById('input-modal');
    const input = document.getElementById('modal-note');
    if (modal) modal.hidden = true;
    if (input) input.value = '';
  });
  const popup2 = await openPopup();
  await showAllPresets(popup2);
  await clickCardAct(popup2, '모달입력', 'replay');
  await formPage.waitForFunction(() => document.querySelector('#modal-note')?.value === '팝업메모', { timeout: 15000 });
  const note = await formPage.inputValue('#modal-note');
  ok('G2 재생 후 모달 입력값', note === '팝업메모', note);
  await popup2.close().catch(() => {});
}

async function scenarioHIframe() {
  const hostUrl = `http://127.0.0.1:${PORT}/iframe-host`;
  await formPage.goto(hostUrl);
  await formPage.bringToFront();
  const popup = await openPopup();
  await createPreset(popup, 'iframe어드민');
  await beginRecord(popup);
  const frame = formPage.frameLocator('#admin');
  await frame.locator('#partner').fill('테스트제휴');
  await sleep(450);
  await frame.locator('#fee').fill('3.3');
  await sleep(450);
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const values = (blob?.fields || []).map((f) => String(f.value || ''));
  ok('H1 iframe 제휴사 값 기록', values.includes('테스트제휴'), values.join(','));
  ok('H1 iframe 수수료 값 기록', values.includes('3.3'), values.join(','));

  await formPage.evaluate(() => {
    const f = document.querySelector('#admin');
    const doc = f && f.contentDocument;
    if (!doc) return;
    const p = doc.querySelector('#partner');
    const fee = doc.querySelector('#fee');
    if (p) p.value = '';
    if (fee) fee.value = '';
  });
  const popup2 = await openPopup();
  await showAllPresets(popup2);
  await clickCardAct(popup2, 'iframe어드민', 'replay');
  await formPage.waitForFunction(() => {
    const f = document.querySelector('#admin');
    const doc = f && f.contentDocument;
    if (!doc) return false;
    const p = doc.querySelector('#partner');
    const feeEl = doc.querySelector('#fee');
    return !!(p && feeEl && p.value === '테스트제휴' && feeEl.value === '3.3');
  }, { timeout: 15000 });
  const partner = await frame.locator('#partner').inputValue();
  const fee = await frame.locator('#fee').inputValue();
  ok('H2 iframe 재생 후 제휴사', partner === '테스트제휴', partner);
  ok('H2 iframe 재생 후 수수료', fee === '3.3', fee);
  await popup2.close().catch(() => {});
}

async function scenarioHLateIframe() {
  const hostUrl = `http://127.0.0.1:${PORT}/iframe-host-late`;
  await formPage.goto(hostUrl);
  await formPage.bringToFront();
  const popup = await openPopup();
  await createPreset(popup, '늦은iframe');
  await beginRecord(popup);
  await formPage.waitForSelector('#admin', { timeout: 10000 });
  const frame = formPage.frameLocator('#admin');
  await frame.locator('#partner').waitFor({ state: 'visible', timeout: 10000 });
  await frame.locator('.fp-record-chip').waitFor({ state: 'visible', timeout: 10000 });
  await frame.locator('#partner').fill('지연제휴');
  await sleep(450);
  await frame.locator('#fee').fill('9.9');
  await sleep(450);
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const values = (blob?.fields || []).map((f) => String(f.value || ''));
  ok('H3 지연 iframe 제휴사 값 기록', values.includes('지연제휴'), values.join(','));
  ok('H3 지연 iframe 수수료 값 기록', values.includes('9.9'), values.join(','));
  await popup.close().catch(() => {});
}

async function scenarioINestedIframe() {
  await formPage.goto(`http://127.0.0.1:${PORT}/iframe-host-nested`);
  await formPage.bringToFront();
  const popup = await openPopup();
  await createPreset(popup, '중첩iframe');
  await beginRecord(popup);
  const inner = formPage.frameLocator('#shell').frameLocator('#admin');
  await inner.locator('#partner').waitFor({ state: 'visible', timeout: 10000 });
  await inner.locator('#partner').fill('중첩제휴');
  await sleep(450);
  await inner.locator('#fee').fill('1.1');
  await sleep(450);
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const values = (blob?.fields || []).map((f) => String(f.value || ''));
  ok('I1 중첩 iframe 제휴사 기록', values.includes('중첩제휴'), values.join(','));
  ok('I1 중첩 iframe 수수료 기록', values.includes('1.1'), values.join(','));
  await popup.close().catch(() => {});
}

async function scenarioJIframeSrcSwap() {
  await formPage.goto(`http://127.0.0.1:${PORT}/iframe-host-swap`);
  await formPage.bringToFront();
  const popup = await openPopup();
  await createPreset(popup, 'src교체');
  await beginRecord(popup);
  const frame = formPage.frameLocator('#admin');
  await frame.locator('#partner').waitFor({ state: 'visible', timeout: 10000 });
  await frame.locator('.fp-record-chip').waitFor({ state: 'visible', timeout: 10000 });
  await frame.locator('#partner').fill('교체제휴');
  await sleep(450);
  await frame.locator('#fee').fill('2.2');
  await sleep(450);
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const values = (blob?.fields || []).map((f) => String(f.value || ''));
  ok('J1 src 교체 후 제휴사 기록', values.includes('교체제휴'), values.join(','));
  ok('J1 src 교체 후 수수료 기록', values.includes('2.2'), values.join(','));
  await popup.close().catch(() => {});
}

async function scenarioKTinyIframe() {
  await formPage.goto(`http://127.0.0.1:${PORT}/iframe-host-tiny`);
  await formPage.bringToFront();
  const popup = await openPopup();
  await createPreset(popup, '작은iframe');
  await beginRecord(popup);
  const inIframe = await formPage.frameLocator('#admin').locator('.fp-record-chip').count();
  ok('K1 작은 iframe에는 칩 없음', inIframe === 0, String(inIframe));
  const onHost = await formPage.locator('.fp-record-chip').count();
  ok('K1 바깥 페이지에 칩 있음', onHost >= 1, String(onHost));
  const frame = formPage.frameLocator('#admin');
  await frame.locator('#partner').fill('작은제휴');
  await sleep(450);
  await frame.locator('#fee').fill('0.5');
  await sleep(450);
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const values = (blob?.fields || []).map((f) => String(f.value || ''));
  ok('K2 작은 iframe 값도 기록', values.includes('작은제휴') && values.includes('0.5'), values.join(','));
  await popup.close().catch(() => {});
}

async function scenarioLUnicode() {
  await formPage.goto(FORM_URL);
  await formPage.bringToFront();
  const popup = await openPopup();
  await createPreset(popup, '유니코드');
  await beginRecord(popup);
  await formPage.fill('[placeholder="이름"]', '한👍가');
  await sleep(450);
  await formPage.fill('[placeholder="메모"]', 'メモ✨');
  await sleep(450);
  await clickStopRecord();
  const id = await latestPresetId();
  const blob = await waitBlob(id, 2);
  const values = (blob?.fields || []).map((f) => String(f.value || ''));
  ok('L1 이모지 이름 기록', values.includes('한👍가'), values.join(','));
  ok('L1 일본어 메모 기록', values.includes('メモ✨'), values.join(','));
  await formPage.evaluate(() => document.querySelector('form')?.reset());
  const popup2 = await openPopup();
  await showAllPresets(popup2);
  await clickCardAct(popup2, '유니코드', 'replay');
  await formPage.waitForFunction(
    () =>
      document.querySelector('[placeholder="이름"]')?.value === '한👍가' &&
      document.querySelector('[placeholder="메모"]')?.value === 'メモ✨',
    { timeout: 15000 }
  );
  const name = await formPage.inputValue('[placeholder="이름"]');
  const memo = await formPage.inputValue('[placeholder="메모"]');
  ok('L2 재생 후 이모지', name === '한👍가', name);
  ok('L2 재생 후 일본어', memo === 'メモ✨', memo);
  await popup2.close().catch(() => {});
}

// ---------- 시나리오 E: 마이그레이션 ----------
async function scenarioE() {
  const legacyPreset = {
    id: 'legacy-1',
    name: '레거시',
    urlPattern: '127.0.0.1:9999',
    fields: [
      { id: 'f1', label: '이름', selector: '[placeholder="이름"]', value: '', type: 'text', sensitive: true, delay: 0 },
      { id: 'f2', label: '메모', selector: '[placeholder="메모"]', value: '메모내용', type: 'text', sensitive: false, delay: 0 }
    ],
    autoApply: false,
    createdAt: 1000,
    updatedAt: 1000
  };
  const dump0 = await getStorage();
  const legacyEntry = await encryptSecret(dump0.vault_key_v1, '홍길동'); // 레거시 필드 단위 암호문(sec:legacy-1:f1)과 동일 형식
  await sw.evaluate(async ({ preset, entry }) => {
    await chrome.storage.local.set({ 'sec:legacy-1:f1': entry, presets: [preset] });
  }, { preset: legacyPreset, entry: legacyEntry });

  // 브라우저 재시작 시뮬레이션 (chrome.runtime.reload는 확장 페이지 탐색이 ERR_BLOCKED_BY_CLIENT로
  // 차단되는 문제가 있어, 동일 profile 디렉토리로 context를 재시작 — 실제 재시작과 동일한 조건)
  await context.close().catch(() => {});
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`]
  });
  // popup을 열어 SW wake → migrateLegacyStorage(탑레벨)가 먼저 실행된 뒤 PRESET_LIST 응답
  const wake = await context.newPage();
  await wake.goto(`chrome-extension://${extId}/popup/popup.html`);
  await wake.close().catch(() => {});
  for (let i = 0; i < 40; i++) {
    const list = context.serviceWorkers().filter((w) => w.url().includes('background.js'));
    if (list.length) {
      sw = list[0];
      try {
        await sw.evaluate(() => true);
        break;
      } catch (e) {
        sw = null;
      }
    }
    await sleep(250);
  }
  ok('E0 SW 재시작', !!sw, '재시작 후 service worker 미발견');

  const dump = await getStorage();
  const legacyKeys = Object.keys(dump).filter((k) => /^sec:(?!preset:)[^:]+:[^:]+$/.test(k));
  ok('E1 인덱스 변환 (fields 없음)', Array.isArray(dump.presets) && dump.presets.length === 1 && dump.presets[0].id === 'legacy-1' && !('fields' in dump.presets[0]));
  ok('E2 blob 생성 (sec:preset:legacy-1)', !!dump['sec:preset:legacy-1']);
  ok('E3 레거시 키 정리', !dump['sec:legacy-1:f1'] && legacyKeys.length === 0, JSON.stringify(legacyKeys));
  const migrated = await decryptPreset('legacy-1');
  ok('E4 민감 필드 값 복호화 이전', migrated && migrated.fields[0].value === '홍길동' && migrated.fields[0].sensitive === true, JSON.stringify(migrated?.fields));
  ok('E5 비민감 필드 값 보존', migrated && migrated.fields[1].value === '메모내용' && migrated.fields[1].sensitive === false);
}

async function main() {
  const pageFiles = {
    '/': 'test-form.html',
    '/j/home': 'journey-home.html',
    '/j/results': 'journey-results.html',
    '/j/compare': 'journey-compare.html',
    '/j/product': 'journey-product.html',
    '/iframe-host': 'iframe-host.html',
    '/iframe-host-late': 'iframe-host-late.html',
    '/iframe-host-nested': 'iframe-host-nested.html',
    '/iframe-host-swap': 'iframe-host-swap.html',
    '/iframe-host-tiny': 'iframe-host-tiny.html',
    '/iframe-form': 'iframe-form.html'
  };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || '/', `http://127.0.0.1:${PORT}`).pathname;
      const file = pageFiles[pathname];
      if (file) {
        const html = await readFile(path.join(ROOT, 'test', file));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  userDataDir = await mkdtemp(path.join(os.tmpdir(), 'fp-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`]
  });
  context.on('serviceworker', (w) => swEvents.push(w));

  for (let i = 0; i < 100; i++) {
    const list = context.serviceWorkers();
    if (list.length) {
      sw = list[0];
      break;
    }
    await sleep(150);
  }
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30000 });
  extId = new URL(sw.url()).hostname;
  console.log('확장 ID:', extId);

  formPage = await context.newPage();
  trackErrors(formPage);
  await formPage.goto(FORM_URL);
  await formPage.bringToFront();
  console.log('폼 페이지:', FORM_URL);

  try {
    await runScenario('A: 기본 흐름', scenarioA);
    await runScenario('B1: 같은 필드 머지', scenarioB1Merge);
    await runScenario('B2: 필드 전환 flush', scenarioB2Flush);
    await runScenario('B3: radio 그룹', scenarioB3Radio);
    await runScenario('B4: checkbox 해제', scenarioB4CheckboxUncheck);
    await runScenario('B5: 입력 후 change flush', scenarioB5ChangeFlush);
    await runScenario('B6: 빈 값', scenarioB6EmptyValue);
    await runScenario('C: PII/암호화', scenarioC);
    await runScenario('D1: delay 순차 재생', scenarioD1Delay);
    await runScenario('D2: urlPattern 불일치', scenarioD2Mismatch);
    await runScenario('D3: autoApply 재진입', scenarioD3AutoApply);
    await runScenario('F: 멀티페이지 여정', scenarioF);
    await runScenario('G: 입력 팝업 확인 닫힘', scenarioGModalPopup);
    await runScenario('H: iframe 어드민', scenarioHIframe);
    await runScenario('H3: 지연 iframe 녹화', scenarioHLateIframe);
    await runScenario('I: 중첩 iframe', scenarioINestedIframe);
    await runScenario('J: iframe src 교체', scenarioJIframeSrcSwap);
    await runScenario('K: 작은 iframe', scenarioKTinyIframe);
    await runScenario('L: 유니코드 값', scenarioLUnicode);
    await runScenario('E: 레거시 마이그레이션', scenarioE);
  } finally {
    await context.close().catch(() => {});
    await new Promise((r) => server.close(r));
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main()
  .catch((e) => {
    console.error('E2E 러너 오류:', e && e.stack ? e.stack : e);
    failed++;
  })
  .finally(() => {
    console.log('\n===== E2E 결과: PASS ' + passed + ' / FAIL ' + failed + ' =====');
    if (failures.length) {
      console.log('실패 목록:');
      for (const f of failures) console.log('  - ' + f);
    }
    process.exit(failed === 0 ? 0 : 1);
  });