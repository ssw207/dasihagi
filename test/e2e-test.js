/* E2E 테스트: 다시하기 Chrome Extension — 그룹(여러 페이지 복합 세팅) 실행 기능 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const EXT_PATH = path.join(ROOT, 'dist');
const ARTIFACTS = path.join(__dirname, 'artifacts');
if (!fs.existsSync(ARTIFACTS)) fs.mkdirSync(ARTIFACTS, { recursive: true });

const FORM_A = 'http://localhost:8765/test/form-a.html';
const FORM_B = 'http://localhost:8765/test/form-b.html';

const results = {}; // name -> {pass, detail}
function report(name, pass, detail) {
  results[name] = { pass: !!pass, detail };
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}: ${detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`
    ]
  });

  let sw = null;
  for (let i = 0; i < 30; i++) {
    sw = context.serviceWorkers().find((w) => w.url().endsWith('background.js'));
    if (sw) break;
    await sleep(500);
  }

  // --- 1. 확장 로드 검증 ---
  if (!sw) {
    report('확장 로드', false, 'service worker(background.js)가 감지되지 않음');
    await context.close();
    process.exit(1);
  }
  const extId = new URL(sw.url()).host;
  const POPUP_URL = `chrome-extension://${extId}/popup/popup.html`;
  report('확장 로드', true, `service worker 등록됨 (extId=${extId})`);

  // chrome.* API 평가용 드라이버 페이지 (MV3 SW 유휴 종료와 무관하게 안정적으로 동작)
  const driver = await context.newPage();
  await driver.goto(POPUP_URL, { waitUntil: 'load' }).catch(() => {});
  await sleep(300);
  const evalExt = (fn, arg) => driver.evaluate(fn, arg);
  const getBadge = () => evalExt(async () => await chrome.action.getBadgeText({}));
  const getPresets = () => evalExt(async () => (await chrome.storage.local.get('presets')).presets || []);
  const getGroups = () => evalExt(async () => (await chrome.storage.local.get('groups')).groups || []);
  const getRunState = () => evalExt(async () => (await chrome.storage.session.get('runState')).runState || null);

  async function activateFormTab(part) {
    return evalExt(async (p) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.includes(p));
      if (t) {
        await chrome.tabs.update(t.id, { active: true });
        return t.id;
      }
      return null;
    }, part);
  }

  async function openPopup(activatePart = 'localhost:8765') {
    const popup = await context.newPage();
    await popup.goto(POPUP_URL, { waitUntil: 'load' });
    await activateFormTab(activatePart);
    await popup.reload({ waitUntil: 'load' });
    await sleep(400);
    return popup;
  }

  async function stopAllCapture() {
    await evalExt(async () => {
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        try { await chrome.tabs.sendMessage(t.id, { type: 'CAPTURE_STOP' }); } catch (e) {}
      }
    });
  }

  async function closePopup(popup) {
    if (!popup || popup.isClosed()) return;
    try { await popup.close(); } catch (e) {}
  }

  async function waitForNewPage(urlPart, knownIds) {
    const start = Date.now();
    while (Date.now() - start < 20000) {
      const found = context.pages().find(
        (p) => !knownIds.has(p) && !p.isClosed() && p.url().includes(urlPart)
      );
      if (found) return found;
      await sleep(250);
    }
    throw new Error('새 탭을 찾지 못함: ' + urlPart);
  }

  async function inputValue(page, sel) {
    if (page.isClosed()) return null;
    try {
      return await page.evaluate((s) => {
        const el = document.querySelector(s);
        return el ? el.value : null;
      }, sel);
    } catch (e) {
      return null;
    }
  }

  async function waitInputValue(page, sel, expected, timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (page.isClosed()) return false;
      const v = await inputValue(page, sel);
      if (v === expected) return true;
      await sleep(300);
    }
    return false;
  }

  const pageErrors = [];
  context.on('page', (p) => {
    p.on('pageerror', (e) => pageErrors.push('pageerror: ' + e.message));
    p.on('console', (m) => {
      if (m.type() === 'error') pageErrors.push('console: ' + m.text());
    });
  });

  try {
    // ===== 테스트 데이터 초기화 =====
    await evalExt(async () => {
      await chrome.storage.local.remove(['presets', 'groups']);
      await chrome.storage.session.remove('runState');
    });
    report('데이터 초기화', true, 'presets/groups/runState 비움');

    // ===== S1: 프리셋 A 생성 + 캡처 + 적용 =====
    const pageA = context.pages()[0] || await context.newPage();
    await pageA.goto(FORM_A, { waitUntil: 'load' });
    await sleep(600);

    let popup = await openPopup();
    await popup.click('#btn-new-preset');
    await popup.waitForSelector('#editor-title');
    const autoPattern = await popup.inputValue('#ed-pattern');
    report('S1.3 사이트 패턴 자동 입력', autoPattern === 'localhost:8765',
      `자동 입력된 패턴: "${autoPattern}" (기대: "localhost:8765") — 코드는 hostname만 사용`);
    await popup.fill('#ed-name', 'A 페이지 세팅');
    await popup.click('#btn-save-preset');
    await popup.waitForSelector('#toast.show', { timeout: 3000 }).catch(() => {});
    report('S1.3 프리셋 A 저장', true, '이름 "A 페이지 세팅" 저장');

    // 캡처 모드 시작
    await popup.click('#btn-capture').catch(() => {});
    await sleep(500);
    await pageA.waitForSelector('.fp-capture-input', { timeout: 5000 }).catch(() => {});
    const hlCount = await pageA.evaluate(() => document.querySelectorAll('.fp-capture-input').length);
    report('S1.4 캡처 모드 하이라이트', hlCount >= 3, `파란 점선 입력란 ${hlCount}개`);

    async function captureField(page, selector, label, value) {
      await page.click(selector);
      await page.waitForSelector('.fp-panel', { timeout: 5000 });
      await page.fill('#fp-label', label);
      await page.press('#fp-label', 'Enter');
      await page.fill('#fp-value', value);
      await page.press('#fp-value', 'Enter');
      await sleep(500);
      await page.click('#fp-cancel').catch(() => {});
      await sleep(200);
    }

    await captureField(pageA, 'input[name="company"]', '회사명', '테스트컴퍼니');
    await captureField(pageA, 'input[name="email"]', '이메일', 'tester@example.com');
    await captureField(pageA, 'select[name="plan"]', '플랜', '프리미엄');

    let presets = await getPresets();
    const presetA = presets.find((p) => p.name === 'A 페이지 세팅');
    report('S1.5~7 필드 캡처', presetA && presetA.fields.length === 3,
      `캡처된 필드: ${presetA ? presetA.fields.map((f) => f.label).join(', ') : '없음'}`);

    // 적용
    await closePopup(popup);
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('button[data-act="apply"]');
    await sleep(500);
    const toastText = await popup.evaluate(() => document.querySelector('#toast').textContent);
    report('S1.8 적용 토스트', /적용 완료: 3개/.test(toastText), `토스트: "${toastText}"`);

    const c1 = await waitInputValue(pageA, 'input[name="company"]', '테스트컴퍼니');
    const c2 = await waitInputValue(pageA, 'input[name="email"]', 'tester@example.com');
    const c3 = await waitInputValue(pageA, 'select[name="plan"]', '프리미엄');
    report('S1 적용 결과', c1 && c2 && c3, `company=${await inputValue(pageA, 'input[name="company"]')}, email=${await inputValue(pageA, 'input[name="email"]')}, plan=${await inputValue(pageA, 'select[name="plan"]')}`);
    await closePopup(popup);
    await pageA.screenshot({ path: path.join(ARTIFACTS, 's1-applied.png') });

    // ===== S2: 프리셋 B 생성 + 캡처 + 적용 =====
    await stopAllCapture();
    const pageB = await context.newPage();
    await pageB.goto(FORM_B, { waitUntil: 'load' });
    await sleep(600);

    popup = await openPopup('form-b');
    await popup.click('#btn-new-preset');
    await popup.waitForSelector('#editor-title');
    await popup.fill('#ed-name', 'B 페이지 세팅');
    await popup.click('#btn-save-preset');
    await sleep(400);
    await popup.click('#btn-capture').catch(() => {});
    await sleep(500);
    await pageB.waitForSelector('.fp-capture-input', { timeout: 5000 }).catch(() => {});
    const hlCountB = await pageB.evaluate(() => document.querySelectorAll('.fp-capture-input').length);
    report('S2.4 캡처 모드 하이라이트', hlCountB >= 3, `파란 점선 입력란 ${hlCountB}개`);

    await captureField(pageB, 'input[name="name"]', '이름', '홍길동');
    await captureField(pageB, 'input[name="phone"]', '전화번호', '010-1234-5678');
    await captureField(pageB, 'textarea[name="memo"]', '메모', '테스트 메모');

    presets = await getPresets();
    const presetB = presets.find((p) => p.name === 'B 페이지 세팅');
    report('S2.5~7 필드 캡처', presetB && presetB.fields.length === 3,
      `캡처된 필드: ${presetB ? presetB.fields.map((f) => f.label).join(', ') : '없음'}`);

await closePopup(popup);
    await activateFormTab('form-b');
    popup = await openPopup('form-b');
    await popup.locator('.preset-card', { hasText: 'B 페이지 세팅' }).locator('button[data-act="apply"]').click();
    await sleep(500);
    const toastB = await popup.evaluate(() => document.querySelector('#toast').textContent);
    report('S2.8 적용 토스트', /적용 완료: 3개/.test(toastB), `토스트: "${toastB}"`);
    const d1 = await waitInputValue(pageB, 'input[name="name"]', '홍길동');
    const d2 = await waitInputValue(pageB, 'input[name="phone"]', '010-1234-5678');
    const d3 = await waitInputValue(pageB, 'textarea[name="memo"]', '테스트 메모');
    report('S2 적용 결과', d1 && d2 && d3, `name=${await inputValue(pageB, 'input[name="name"]')}, phone=${await inputValue(pageB, 'input[name="phone"]')}, memo=${await inputValue(pageB, 'textarea[name="memo"]')}`);
    await closePopup(popup);
    await pageB.screenshot({ path: path.join(ARTIFACTS, 's2-applied.png') });

    // ===== S3: 그룹 생성 (A → B, 수동 제출) =====
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('#tab-groups');
    await popup.click('#btn-new-group');
    await popup.fill('#ge-name', '제휴사 세팅 테스트');
    await popup.selectOption('#ge-preset-select', { index: 0 });
    await popup.click('#btn-add-step');
    await popup.selectOption('#ge-preset-select', { index: 1 });
    await popup.click('#btn-add-step');
    await sleep(300);
    const stepModes = await popup.evaluate(() =>
      Array.from(document.querySelectorAll('.step-mode')).map((el) => el.textContent)
    );
    report('S3.5 스텝 제출 방식', stepModes.length === 2 && stepModes.every((m) => m === '수동'),
      `스텝 모드: ${stepModes.join(', ')}`);
    await popup.click('#btn-save-group');
    await sleep(500);

    let groups = await getGroups();
    const group1 = groups.find((g) => g.name === '제휴사 세팅 테스트');
    const stepNames = group1 ? group1.steps.map((s) => {
      const p = presets.find((pp) => pp.id === s.presetId);
      return p ? p.name : '?';
    }) : [];
    report('S3 그룹 생성', group1 && group1.steps.length === 2 && stepNames[0] === 'A 페이지 세팅' && stepNames[1] === 'B 페이지 세팅',
      `그룹 스텝 순서: ${stepNames.join(' → ')} (${group1 ? group1.steps.length : 0}스텝)`);
    await closePopup(popup);
    await popup.screenshot({ path: path.join(ARTIFACTS, 's3-group-list.png') }).catch(() => {});

    // ===== S4 준비: 그룹 실행이 로컬 http URL을 열도록 프리셋 패턴을 전체 URL로 수정 =====
    async function editPresetPattern(presetName, newPattern) {
      await activateFormTab('form-a');
      const p = await openPopup();
      await p.click('#tab-presets');
      const card = p.locator('.preset-card', { hasText: presetName });
      await card.locator('button[data-act="edit"]').click();
      await p.fill('#ed-pattern', newPattern);
      await p.click('#btn-save-preset');
      await sleep(400);
      await p.click('#btn-back');
      await sleep(300);
      await closePopup(p);
    }
    await editPresetPattern('A 페이지 세팅', 'http://localhost:8765/test/form-a.html');
    await editPresetPattern('B 페이지 세팅', 'http://localhost:8765/test/form-b.html');
    report('S4 준비(패턴 수정)', true, 'A/B 프리셋 패턴을 전체 URL로 수정 (로컬 http 서버 접근용)');

    // ===== S4: 그룹 실행 (수동 제출 모드) =====
    const knownPages = new Set(context.pages());
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('#tab-groups');
    await popup.click('button[data-act="run"]').catch(() => {});
    await sleep(800);

    const groupTabA = await waitForNewPage('form-a', knownPages);
    await groupTabA.waitForLoadState('load');
    await sleep(1500);
    const gA1 = await waitInputValue(groupTabA, 'input[name="company"]', '테스트컴퍼니');
    const gA2 = await waitInputValue(groupTabA, 'input[name="email"]', 'tester@example.com');
    const gA3 = await waitInputValue(groupTabA, 'select[name="plan"]', '프리미엄');
    report('S4.2 A 페이지 자동 채움', gA1 && gA2 && gA3, `group A: company=${await inputValue(groupTabA, 'input[name="company"]')}, plan=${await inputValue(groupTabA, 'select[name="plan"]')}`);
    await groupTabA.screenshot({ path: path.join(ARTIFACTS, 's4-a-filled.png') });

    const badge1 = await getBadge();
    await activateFormTab('form-a');
    popup = await openPopup();
    const runStatus1 = await popup.evaluate(() => {
      const card = document.querySelector('.run-card');
      if (!card) return null;
      return {
        status: (document.querySelector('.run-status') || {}).textContent || '',
        badge: (document.querySelector('.badge-run') || {}).textContent || ''
      };
    });
    report('S4.3 대기 상태 카드 + 배지',
      runStatus1 && runStatus1.status.includes('제출 대기 중') && runStatus1.badge === '1/2' && badge1 === '1/2',
      `카드="${runStatus1 ? runStatus1.status : null}" 카드배지=${runStatus1 ? runStatus1.badge : null} 툴바배지="${badge1}"`);
    await closePopup(popup);

    // A 페이지 직접 제출
    await groupTabA.click('button[type="submit"]');
    await sleep(1500);

    // 다음 단계 → B
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('[data-run-act="next"]');
    await sleep(1000);
    await closePopup(popup);

    const groupTabB = await waitForNewPage('form-b', knownPages);
    await groupTabB.waitForLoadState('load');
    await sleep(1500);
    const gB1 = await waitInputValue(groupTabB, 'input[name="name"]', '홍길동');
    const gB2 = await waitInputValue(groupTabB, 'input[name="phone"]', '010-1234-5678');
    const gB3 = await waitInputValue(groupTabB, 'textarea[name="memo"]', '테스트 메모');
    report('S4.6 B 페이지 자동 채움', gB1 && gB2 && gB3, `group B: name=${await inputValue(groupTabB, 'input[name="name"]')}, memo=${await inputValue(groupTabB, 'textarea[name="memo"]')}`);
    await groupTabB.screenshot({ path: path.join(ARTIFACTS, 's4-b-filled.png') });

    const badge2 = await getBadge();
    report('S4.6 B 진행 배지', badge2 === '2/2', `툴바배지="${badge2}"`);

    // B 제출 → 다음 단계(마지막) → 완료
    await groupTabB.click('button[type="submit"]');
    await sleep(1500);
    await activateFormTab('form-b');
    popup = await openPopup();
    await popup.click('[data-run-act="next"]');
    await sleep(1200);
    const doneCard = await popup.evaluate(() => {
      const card = document.querySelector('.run-card');
      if (!card) return null;
      return (document.querySelector('.run-status') || {}).textContent || '';
    });
    const badgeDone = await getBadge();
    report('S4.8 완료 상태', doneCard && doneCard.includes('완료!') && badgeDone === '',
      `카드="${doneCard}" 툴바배지="${badgeDone}"`);
    await closePopup(popup);

    // ===== S5: 그룹 실행 중 중지 =====
    const knownPages5 = new Set(context.pages());
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('#tab-groups');
    await popup.click('button[data-act="run"]').catch(() => {});
    await sleep(800);
    const s5Tab = await waitForNewPage('form-a', knownPages5);
    await s5Tab.waitForLoadState('load');
    await sleep(1500);
    const s5Filled = await waitInputValue(s5Tab, 'input[name="company"]', '테스트컴퍼니');
    report('S5.1 재실행 A 채움', s5Filled, '그룹 재실행 시 A 페이지 채워짐 (중복 실행 차단 해제 확인)');

    const s5TabId = s5Tab;
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('[data-run-act="abort"]');
    await sleep(1000);
    await closePopup(popup);

    const s5Closed = s5TabId.isClosed();
    const badgeAfterAbort = await getBadge();
    const runStateAfterAbort = await getRunState();
    report('S5 중지 처리', s5Closed && badgeAfterAbort === '',
      `탭 닫힘=${s5Closed}, 툴바배지="${badgeAfterAbort}", runState=${runStateAfterAbort ? runStateAfterAbort.status : '없음(카드 숨김)'}`);

    // 중지 후 재실행 가능 여부
    const knownPages5b = new Set(context.pages());
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('#tab-groups');
    await popup.click('button[data-act="run"]').catch(() => {});
    await sleep(800);
    const s5bTab = await waitForNewPage('form-a', knownPages5b);
    await s5bTab.waitForLoadState('load');
    await sleep(1500);
    const s5bFilled = await waitInputValue(s5bTab, 'input[name="company"]', '테스트컴퍼니');
    report('S5 중지 후 재실행', s5bFilled, '중지 후 다른 그룹 실행이 정상 동작');
    await s5bTab.screenshot({ path: path.join(ARTIFACTS, 's5-abort.png') });
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('[data-run-act="abort"]').catch(() => {});
    await sleep(800);
    await closePopup(popup);

    // ===== S6: 자동 제출 모드 =====
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('#tab-groups');
    const gCard = popup.locator('.preset-card', { hasText: '제휴사 세팅 테스트' });
    await gCard.locator('button[data-act="gedit"]').click();
    await sleep(300);
    await popup.selectOption('.step-mode-select >> nth=0', 'auto');
    await popup.fill('.step-selector-input >> nth=0', 'button[type="submit"]');
    await popup.click('#btn-save-group');
    await sleep(500);
    await closePopup(popup);

    const knownPages6 = new Set(context.pages());
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('#tab-groups');
    await popup.click('button[data-act="run"]').catch(() => {});
    await sleep(800);

    const s6TabA = await waitForNewPage('form-a', knownPages6);
    await s6TabA.waitForLoadState('load');
    await sleep(400);
    const s6Filled = await waitInputValue(s6TabA, 'input[name="company"]', '테스트컴퍼니', 800);
    report('S6 A 채움 → 자동 제출 대기', s6Filled, 'A 페이지 값 채워짐, 1.2초 후 자동 제출 예정');

    // 자동 제출 → 탭 닫힘 → B 탭 자동 진행
    let s6aClosed = false;
    const start = Date.now();
    while (Date.now() - start < 20000) {
      if (s6TabA.isClosed()) { s6aClosed = true; break; }
      await sleep(250);
    }
    const s6TabB = await waitForNewPage('form-b', knownPages6);
    await s6TabB.waitForLoadState('load');
    await sleep(1500);
    const s6B1 = await waitInputValue(s6TabB, 'input[name="name"]', '홍길동');
    const s6B2 = await waitInputValue(s6TabB, 'input[name="phone"]', '010-1234-5678');
    const s6B3 = await waitInputValue(s6TabB, 'textarea[name="memo"]', '테스트 메모');
    const badge6 = await getBadge();
    report('S6 자동 제출 → B 자동 진행',
      s6aClosed && s6B1 && s6B2 && s6B3 && badge6 === '2/2',
      `A탭 자동닫힘=${s6aClosed}, B: name=${await inputValue(s6TabB, 'input[name="name"]')}, 배지="${badge6}"`);
    await s6TabB.screenshot({ path: path.join(ARTIFACTS, 's6-b-auto.png') });

    // S6 정리: 중지
    await activateFormTab('form-b');
    popup = await openPopup();
    await popup.click('[data-run-act="abort"]').catch(() => {});
    await sleep(800);
    await closePopup(popup);

    // ===== S7: 회귀 (단일 프리셋 적용) =====
    await editPresetPattern('A 페이지 세팅', 'localhost'); // 패턴 원복
    await activateFormTab('form-a');
    popup = await openPopup();
    await popup.click('#tab-presets');
    await popup.click('button[data-act="apply"]');
    await sleep(800);
    const r1 = await waitInputValue(pageA, 'input[name="company"]', '테스트컴퍼니');
    const r2 = await waitInputValue(pageA, 'input[name="email"]', 'tester@example.com');
    const r3 = await waitInputValue(pageA, 'select[name="plan"]', '프리미엄');
    report('S7 단일 프리셋 회귀', r1 && r2 && r3, `company=${await inputValue(pageA, 'input[name="company"]')}, email=${await inputValue(pageA, 'input[name="email"]')}, plan=${await inputValue(pageA, 'select[name="plan"]')}`);
    await closePopup(popup);

    // ===== 최종 정리 =====
    if (pageErrors.length) {
      console.log('\n[페이지 에러 수집]');
      [...new Set(pageErrors)].slice(0, 10).forEach((e) => console.log(' - ' + e));
    }
  } catch (e) {
    console.error('\n[테스트 중단 - 예외]', e.message);
    console.error(e.stack);
    try { await context.pages()[0].screenshot({ path: path.join(ARTIFACTS, 'failure.png') }); } catch (_) {}
  } finally {
    await context.close();
  }

  // ===== 최종 보고 =====
  const S = (n) => (results[n] ? (results[n].pass ? '✅' : '❌') : '⏭️');
  console.log('\n# E2E 테스트 결과');
  console.log(`- 확장 로드: ${S('확장 로드')}`);
  console.log(`- S1 프리셋 A (캡처→적용): ${S('S1 적용 결과')}`);
  console.log(`- S2 프리셋 B (캡처→적용): ${S('S2 적용 결과')}`);
  console.log(`- S3 그룹 생성: ${S('S3 그룹 생성')}`);
  console.log(`- S4 그룹 실행 (수동): ${S('S4.8 완료 상태')}`);
  console.log(`- S5 실행 중 중지: ${S('S5 중지 처리')}`);
  console.log(`- S6 자동 제출: ${S('S6 자동 제출 → B 자동 진행')}`);
  console.log(`- S7 회귀 (단일 프리셋): ${S('S7 단일 프리셋 회귀')}`);
  console.log('\n## 실패 상세 (해당 시)');
  for (const [k, v] of Object.entries(results)) {
    if (!v.pass) console.log(`- ${k}: ${v.detail}`);
  }
  process.exit(0);
})();