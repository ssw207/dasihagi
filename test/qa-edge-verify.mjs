/**
 * QA 엣지케이스 실행 — mock chrome으로 background.js 메시지 경계 검증
 * 실행: npm run test:qa
 */
import assert from 'node:assert';

let messageListener = null;
let currentTabUrl = 'https://example.com/form';
const EXT_ID = 'qa-ext';

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
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
    dump() {
      return Object.fromEntries(store);
    }
  };
}

const storageLocal = createStorage();
const storageSession = createStorage();

globalThis.chrome = {
  runtime: {
    id: EXT_ID,
    onMessage: {
      addListener(fn) {
        messageListener = fn;
      }
    }
  },
  storage: { local: storageLocal, session: storageSession },
  tabs: {
    async get(tabId) {
      return { id: tabId, url: currentTabUrl, status: 'complete' };
    },
    async sendMessage(tabId, msg) {
      if (/^chrome:|chrome-extension:|about:/i.test(currentTabUrl)) {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return { ok: true, result: { applied: [{ label: 'ok' }], failures: [] } };
    },
    async create() {
      return { id: 99, url: currentTabUrl };
    },
    async remove() {},
    async update() {
      return { id: 1, url: currentTabUrl };
    },
    async query() {
      return [{ id: 1, url: currentTabUrl }];
    },
    onUpdated: { addListener() {} },
    onCreated: { addListener() {} },
    onRemoved: { addListener() {} }
  },
  action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
  webNavigation: {
    async getAllFrames() {
      return [{ frameId: 0 }];
    },
    onCompleted: { addListener() {} }
  }
};

await import('../background.js');
assert.ok(messageListener, 'background listener 없음');

function send(type, extra = {}, sender = { id: EXT_ID, tab: { id: 1 } }) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sendResponse = (resp) => {
      if (done) return;
      done = true;
      resolve(resp);
    };
    try {
      const ret = messageListener({ type, ...extra }, sender, sendResponse);
      if (ret && typeof ret.then === 'function') {
        ret.then((v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        }, reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

async function call(type, extra = {}) {
  const resp = await send(type, extra);
  if (!resp || resp.ok !== true) {
    throw new Error(type + ' 실패: ' + (resp && resp.error ? resp.error : JSON.stringify(resp)));
  }
  return resp.data;
}

const results = [];
async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log('[PASS] ' + name);
  } catch (e) {
    results.push({ name, pass: false, err: e.message });
    console.log('[FAIL] ' + name);
    console.log('       ' + e.message);
  }
}

await scenario('S1 타 확장 sender EXPORT 차단', async () => {
  const resp = await send('EXPORT_DATA', {}, { id: 'evil', tab: { id: 1 } });
  assert.equal(resp.ok, false);
  assert.match(String(resp.error || ''), /허용되지 않은/);
});

await scenario('S2 자체 sender PRESET_LIST 허용', async () => {
  const list = await call('PRESET_LIST');
  assert.ok(Array.isArray(list));
});

await scenario('S3 IMPORT schemaVersion 거부', async () => {
  const resp = await send('IMPORT_DATA', { data: { schemaVersion: '1', presets: [], groups: [] } });
  assert.equal(resp.ok, false);
});

await scenario('S4 IMPORT 잘못된 appId 거부', async () => {
  const resp = await send('IMPORT_DATA', {
    data: { schemaVersion: 1, appId: 'other-app', presets: [], groups: [] }
  });
  assert.equal(resp.ok, false);
});

await scenario('S5 레거시 appId 가져오기 허용', async () => {
  const data = await call('IMPORT_DATA', {
    data: {
      schemaVersion: 1,
      appId: 'form-preset-extension',
      presets: [
        {
          name: '옛백업',
          urlPattern: 'legacy.example.com',
          fields: [{ label: '이름', selector: '#n', value: '홍', type: 'text' }]
        }
      ],
      groups: []
    }
  });
  assert.equal(data.importedPresets, 1);
});

await scenario('S6 64KB 초과 필드 가져오기 제외', async () => {
  const huge = 'x'.repeat(64 * 1024 + 1);
  const data = await call('IMPORT_DATA', {
    data: {
      schemaVersion: 1,
      appId: 'dasihagi',
      presets: [
        {
          name: '거대',
          urlPattern: 'huge.example.com',
          fields: [{ label: '메모', selector: '#m', value: huge, type: 'textarea' }]
        }
      ],
      groups: []
    }
  });
  assert.equal(data.importedPresets, 0);
});

await scenario('S7 XSS 문자열은 값으로만 저장', async () => {
  const p = await call('PRESET_CREATE', {
    name: '<img src=x onerror=alert(1)>',
    urlPattern: 'xss.example.com'
  });
  const list = await call('PRESET_LIST');
  const found = list.find((x) => x.id === p.id);
  assert.ok(found);
  assert.equal(found.name, '<img src=x onerror=alert(1)>');
});

await scenario('S8 유니코드·이모지 프리셋 이름', async () => {
  const p = await call('PRESET_CREATE', { name: '제휴-한👍', urlPattern: 'uni.example.com' });
  const list = await call('PRESET_LIST');
  assert.ok(list.some((x) => x.id === p.id && x.name === '제휴-한👍'));
});

await scenario('E1 chrome:// RECORD_START 거절', async () => {
  currentTabUrl = 'chrome://extensions';
  const resp = await send('RECORD_START', { tabId: 1, presetId: 'nope' });
  currentTabUrl = 'https://example.com/form';
  assert.equal(resp.ok, false);
});

await scenario('E2 빈 녹화 RECORD_STOP saved=0', async () => {
  const p = await call('PRESET_CREATE', { name: '빈녹화', urlPattern: 'example.com' });
  await call('RECORD_START', { tabId: 1, presetId: p.id });
  const stop = await call('RECORD_STOP', { tabId: 1 });
  assert.equal(stop.saved, 0);
});

await scenario('E3 RECORD_APPEND 세션 없으면 실패', async () => {
  const resp = await send('RECORD_APPEND', { tabId: 1, event: { type: 'text', value: 'a', selector: '#x', label: 'x' } });
  assert.equal(resp.ok, false);
});

await scenario('E4 APPLY 사이트 불일치', async () => {
  const p = await call('PRESET_CREATE', { name: '다른사이트', urlPattern: 'other.com' });
  currentTabUrl = 'https://example.com/form';
  const resp = await send('APPLY_PRESET', { tabId: 1, presetId: p.id });
  assert.equal(resp.ok, false);
  assert.match(String(resp.error || ''), /대상 사이트/);
});

await scenario('E5 SETTINGS 이상한 값은 normal', async () => {
  const set = await call('SETTINGS_SET', { replayPace: 'warp' });
  assert.equal(set.replayPace, 'normal');
  const got = await call('SETTINGS_GET');
  assert.equal(got.replayPace, 'normal');
});

await scenario('E6 포트 포함 패턴 매칭', async () => {
  const p = await call('PRESET_CREATE', { name: '로컬', urlPattern: '127.0.0.1:3000' });
  await call('CAPTURE_SAVE_FIELD', {
    presetId: p.id,
    field: { id: 'f1', label: '이름', selector: '#n', value: '가', type: 'text' }
  });
  currentTabUrl = 'http://127.0.0.1:3000/form';
  const applied = await call('APPLY_PRESET', { tabId: 1, presetId: p.id });
  assert.ok(applied);
  currentTabUrl = 'https://example.com/form';
});

await scenario('E7 IPv6 패턴 [::1]:8080', async () => {
  const p = await call('PRESET_CREATE', { name: 'v6', urlPattern: '[::1]:8080' });
  await call('CAPTURE_SAVE_FIELD', {
    presetId: p.id,
    field: { id: 'f1', label: 'n', selector: '#n', value: '1', type: 'text' }
  });
  currentTabUrl = 'http://[::1]:8080/';
  const applied = await call('APPLY_PRESET', { tabId: 1, presetId: p.id });
  assert.ok(applied);
  currentTabUrl = 'https://example.com/form';
});

await scenario('E8 * 패턴은 모든 URL', async () => {
  const p = await call('PRESET_CREATE', { name: '전체', urlPattern: '*' });
  await call('CAPTURE_SAVE_FIELD', {
    presetId: p.id,
    field: { id: 'f1', label: 'n', selector: '#n', value: '1', type: 'text' }
  });
  currentTabUrl = 'https://anywhere.test/x';
  const applied = await call('APPLY_PRESET', { tabId: 1, presetId: p.id });
  assert.ok(applied);
  currentTabUrl = 'https://example.com/form';
});

await scenario('F1 그룹 빈 스텝 실행 거절', async () => {
  const g = await call('GROUP_CREATE', { name: '빈그룹', steps: [] });
  const resp = await send('RUN_GROUP', { groupId: g.id });
  assert.equal(resp.ok, false);
});

await scenario('F2 PRESET_DELETE_MANY 빈 목록 거절', async () => {
  const resp = await send('PRESET_DELETE_MANY', { ids: [] });
  assert.equal(resp.ok, false);
});

await scenario('F3 없는 프리셋 삭제 거절', async () => {
  const resp = await send('PRESET_DELETE', { id: '' });
  assert.equal(resp.ok, false);
});

await scenario('F4 가져오기는 기존을 덮지 않음', async () => {
  const before = await call('PRESET_LIST');
  const n = before.length;
  await call('IMPORT_DATA', {
    data: {
      schemaVersion: 1,
      appId: 'dasihagi',
      presets: [
        {
          name: '추가분',
          urlPattern: 'added.example.com',
          fields: [{ label: 'a', selector: '#a', value: '1', type: 'text' }]
        }
      ],
      groups: []
    }
  });
  const after = await call('PRESET_LIST');
  assert.ok(after.length === n + 1);
  assert.ok(before.every((p) => after.some((x) => x.id === p.id)));
});

await scenario('F5 여정은 AUTO_APPLY_CHECK에서 빠짐', async () => {
  const p = await call('PRESET_CREATE', {
    name: '여정자동',
    urlPattern: 'example.com',
    autoApply: true
  });
  await call('CAPTURE_SAVE_FIELD', {
    presetId: p.id,
    field: { id: 'c1', label: '클릭', selector: 'button', value: '확인', type: 'click' }
  });
  const checked = await call('AUTO_APPLY_CHECK', { url: 'https://example.com/form' });
  assert.ok(!checked.some((x) => x.id === p.id));
});

await scenario('D1 손상 blob은 목록에서 건너뜀', async () => {
  const p = await call('PRESET_CREATE', { name: '손상예정', urlPattern: 'broken.example.com' });
  await storageLocal.set({ ['sec:preset:' + p.id]: { ct: 'not-base64!!!', iv: '??' } });
  const list = await call('PRESET_LIST');
  assert.ok(!list.some((x) => x.id === p.id && Array.isArray(x.fields) && x.fields.length));
});

const failed = results.filter((r) => !r.pass);
console.log('\n===== QA mock 결과: PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length + ' =====');
if (failed.length) {
  process.exitCode = 1;
}
