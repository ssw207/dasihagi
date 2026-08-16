/**
 * 민감값 AES-256-GCM 암호화 통합 검증 스크립트
 *
 * 브라우저 없이 mock chrome API로 실제 background.js(+secure-store.js)를 구동해
 * 민감 필드의 암호화 저장/복호화/재암호화/정리 동작을 검증한다.
 *
 * 실행: node --experimental-default-type=module test/encryption-verify.mjs
 *  (package.json에 "type":"module"이 없어 background.js가 CJS로 해석되는 문제를
 *   --experimental-default-type=module 플래그로 회피)
 */

import assert from 'node:assert';

// ============================================================
// 1. mock chrome API (in-memory)
// ============================================================

let messageListener = null;
const sentMessages = []; // chrome.tabs.sendMessage 기록
let currentTabUrl = 'https://example.com/form'; // chrome.tabs.get이 반환할 URL

function createStorage() {
  const store = new Map();
  return {
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store);
      }
      if (typeof keys === 'string') {
        return store.has(keys) ? { [keys]: store.get(keys) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (store.has(k)) out[k] = store.get(k);
        return out;
      }
      if (typeof keys === 'object') {
        const out = {};
        for (const [k, def] of Object.entries(keys)) {
          out[k] = store.has(k) ? store.get(k) : def;
        }
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
    },
  };
}

const storageLocal = createStorage();
const storageSession = createStorage();

globalThis.chrome = {
  runtime: {
    onMessage: {
      addListener(fn) {
        messageListener = fn;
      },
    },
  },
  storage: {
    local: storageLocal,
    session: storageSession,
  },
  tabs: {
    async get(tabId) {
      return { id: tabId, url: currentTabUrl };
    },
    async sendMessage(tabId, msg) {
      sentMessages.push({ tabId, msg });
      return { result: { applied: [], failures: [] } };
    },
    onUpdated: { addListener() {} },
    onRemoved: { addListener() {} },
    async create() {
      return { id: 9999 };
    },
    async remove() {},
  },
  action: {
    setBadgeText() {},
    setBadgeBackgroundColor() {},
  },
};

// ============================================================
// 2. background.js 로드 (mock chrome을 전역에 설정한 뒤 import)
// ============================================================

await import('../background.js');

if (!messageListener) {
  throw new Error('background.js가 chrome.runtime.onMessage listener를 등록하지 않았습니다.');
}

// ============================================================
// 3. 메시지 전송 헬퍼
// ============================================================

/**
 * background.js의 listener는 sendResponse({ok, data}) 패턴이므로,
 * sendResponse가 호출될 때까지 기다렸다가 {ok, data} 형태로 반환한다.
 */
function send(type, msg) {
  return new Promise((resolve, reject) => {
    let done = false;
    const sendResponse = (resp) => {
      if (done) return;
      done = true;
      resolve(resp);
    };
    let ret;
    try {
      ret = messageListener({ type, ...msg }, {}, sendResponse);
    } catch (e) {
      reject(e);
      return;
    }
    // listener가 Promise를 반환하는 경우에도 처리
    if (ret && typeof ret.then === 'function') {
      ret
        .then((v) => {
          if (!done) {
            done = true;
            resolve(v);
          }
        })
        .catch((e) => {
          if (!done) {
            done = true;
            reject(e);
          }
        });
    }
  });
}

/** send 후 {ok:true, data}를 풀어 data만 반환. 실패 시 throw. */
async function call(type, msg) {
  const resp = await send(type, msg);
  if (!resp || resp.ok !== true) {
    throw new Error(
      `[${type}] 실패: ${resp && resp.error ? resp.error : JSON.stringify(resp)}`
    );
  }
  return resp.data;
}

function storageDump() {
  return { ...storageLocal.dump(), ...storageSession.dump() };
}

function jsonHas(storage, needle) {
  return JSON.stringify(storage).includes(needle);
}

function secKeysFor(presetId) {
  return Object.keys(storageLocal.dump()).filter((k) => k.startsWith(`sec:${presetId}:`));
}

// ============================================================
// 4. 검증 시나리오 (각각 독립 프리셋)
// ============================================================

const results = [];

async function scenario(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`[PASS] ${name}`);
  } catch (e) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name}`);
    console.log(`       ${e.message}`);
  }
}

async function createPreset(name, urlPattern) {
  return call('PRESET_CREATE', { name, urlPattern });
}

async function saveSensitiveField(presetId, field) {
  return call('CAPTURE_SAVE_FIELD', { presetId, field });
}

// ---- S1: 민감 필드 저장 시 평문 미노출 ----
await scenario('S1: 민감 필드 저장 시 평문 미노출', async () => {
  const preset = await createPreset('S1 프리셋', 'example.com');
  await saveSensitiveField(preset.id, {
    id: 'f1',
    label: '비밀번호',
    selector: '#pwd',
    value: 'secret123',
    type: 'text',
    sensitive: true,
  });

  const dump = storageDump();
  const saved = dump.presets.find((p) => p.id === preset.id);
  assert(saved, '프리셋이 저장되어 있어야 함');
  const field = saved.fields.find((f) => f.id === 'f1');
  assert(field, '필드 f1이 저장되어 있어야 함');
  assert.strictEqual(field.value, '', '민감 필드 value는 빈 문자열이어야 함');
  assert.strictEqual(field.sensitive, true, '민감 필드 sensitive=true 유지');
  assert(!jsonHas(dump, 'secret123'), 'storage 전체에 평문 secret123이 없어야 함');

  const sec = dump[`sec:${preset.id}:f1`];
  assert(sec && typeof sec.ct === 'string' && typeof sec.iv === 'string', 'sec: 키에 {ct, iv} 구조가 있어야 함');
});

// ---- S2: 비민감 필드는 평문 유지 ----
await scenario('S2: 비민감 필드는 평문 유지', async () => {
  const preset = await createPreset('S2 프리셋', 'example.com');
  await saveSensitiveField(preset.id, {
    id: 'f2',
    label: '이름',
    selector: '#name',
    value: 'plain123',
    type: 'text',
  });

  const dump = storageDump();
  const saved = dump.presets.find((p) => p.id === preset.id);
  const field = saved.fields.find((f) => f.id === 'f2');
  assert.strictEqual(field.value, 'plain123', '비민감 필드는 평문 그대로 저장');
  assert(jsonHas(dump, 'plain123'), 'storage JSON에 plain123이 존재해야 함');
});

// ---- S3: PRESET_LIST 복호화 ----
await scenario('S3: PRESET_LIST 복호화', async () => {
  const preset = await createPreset('S3 프리셋', 'example.com');
  await saveSensitiveField(preset.id, {
    id: 'f1',
    label: '비밀번호',
    selector: '#pwd',
    value: 'secret123',
    type: 'text',
    sensitive: true,
  });

  const list = await call('PRESET_LIST', {});
  const found = list.find((p) => p.id === preset.id);
  assert(found, 'PRESET_LIST에 프리셋이 있어야 함');
  const field = found.fields.find((f) => f.id === 'f1');
  assert.strictEqual(field.value, 'secret123', '민감 필드가 복호화되어 반환되어야 함');
});

// ---- S4: APPLY_PRESET 복호화 전달 ----
await scenario('S4: APPLY_PRESET 복호화 전달', async () => {
  const preset = await createPreset('S4 프리셋', 'example.com');
  await saveSensitiveField(preset.id, {
    id: 'f1',
    label: '비밀번호',
    selector: '#pwd',
    value: 'secret123',
    type: 'text',
    sensitive: true,
  });

  currentTabUrl = 'https://example.com/form'; // urlPattern 'example.com'과 매칭
  const before = sentMessages.length;
  const result = await call('APPLY_PRESET', { presetId: preset.id, tabId: 42 });
  assert(result && Array.isArray(result.applied) && Array.isArray(result.failures), 'APPLY_PRESET 결과가 {applied, failures} 구조여야 함');

  const sent = sentMessages.slice(before);
  assert.strictEqual(sent.length, 1, 'tabs.sendMessage가 1회 호출되어야 함');
  const applied = sent[0].msg;
  assert.strictEqual(applied.type, 'APPLY_PRESET', '전달 메시지 타입이 APPLY_PRESET이어야 함');
  const field = applied.preset.fields.find((f) => f.id === 'f1');
  assert.strictEqual(field.value, 'secret123', '적용 메시지에 복호화된 값이 전달되어야 함');
});

// ---- S5: PRESET_UPDATE 재암호화 ----
await scenario('S5: PRESET_UPDATE 재암호화', async () => {
  const preset = await createPreset('S5 프리셋', 'example.com');
  await saveSensitiveField(preset.id, {
    id: 'f1',
    label: '비밀번호',
    selector: '#pwd',
    value: 'secret123',
    type: 'text',
    sensitive: true,
  });
  const oldSec = storageDump()[`sec:${preset.id}:f1`];

  await call('PRESET_UPDATE', {
    preset: {
      id: preset.id,
      name: 'S5 프리셋',
      urlPattern: 'example.com',
      fields: [
        { id: 'f1', label: '비밀번호', selector: '#pwd', value: 'newsecret456', type: 'text', sensitive: true },
      ],
    },
  });

  const dump = storageDump();
  assert(!jsonHas(dump, 'newsecret456'), 'storage 전체에 평문 newsecret456이 없어야 함');
  const newSec = dump[`sec:${preset.id}:f1`];
  assert(newSec && typeof newSec.ct === 'string', 'sec: 키에 새 암호문이 존재해야 함');
  assert.notStrictEqual(newSec.ct, oldSec.ct, '암호문이 새 값으로 재암호화되어야 함');
  const saved = dump.presets.find((p) => p.id === preset.id);
  assert.strictEqual(saved.fields.find((f) => f.id === 'f1').value, '', '필드 value는 빈 문자열 유지');

  const list = await call('PRESET_LIST', {});
  const found = list.find((p) => p.id === preset.id);
  assert.strictEqual(found.fields.find((f) => f.id === 'f1').value, 'newsecret456', 'PRESET_LIST로 새 값 복호화 확인');
});

// ---- S6: 민감 해제 시 암호문 정리 ----
await scenario('S6: 민감 해제 시 암호문 정리', async () => {
  const preset = await createPreset('S6 프리셋', 'example.com');
  await saveSensitiveField(preset.id, {
    id: 'f1',
    label: '비밀번호',
    selector: '#pwd',
    value: 'secret123',
    type: 'text',
    sensitive: true,
  });

  await call('PRESET_UPDATE', {
    preset: {
      id: preset.id,
      name: 'S6 프리셋',
      urlPattern: 'example.com',
      fields: [
        { id: 'f1', label: '비밀번호', selector: '#pwd', value: 'nowplain', type: 'text', sensitive: false },
      ],
    },
  });

  const dump = storageDump();
  assert(!dump[`sec:${preset.id}:f1`], '민감 해제 시 sec: 키가 삭제되어야 함');
  const saved = dump.presets.find((p) => p.id === preset.id);
  assert.strictEqual(saved.fields.find((f) => f.id === 'f1').value, 'nowplain', '평문으로 저장되어야 함');
});

// ---- S7: PRESET_DELETE 암호문 정리 ----
await scenario('S7: PRESET_DELETE 암호문 정리', async () => {
  const preset = await createPreset('S7 프리셋', 'example.com');
  await saveSensitiveField(preset.id, {
    id: 'f1',
    label: '비밀번호',
    selector: '#pwd',
    value: 'secret123',
    type: 'text',
    sensitive: true,
  });
  await saveSensitiveField(preset.id, {
    id: 'f2',
    label: '카드번호',
    selector: '#card',
    value: 'card456',
    type: 'text',
    sensitive: true,
  });
  assert.strictEqual(secKeysFor(preset.id).length, 2, '삭제 전 sec: 키 2개 존재');

  await call('PRESET_DELETE', { id: preset.id });
  assert.strictEqual(secKeysFor(preset.id).length, 0, '삭제 후 해당 프리셋의 sec: 키가 전부 제거되어야 함');
});

// ---- S8: IMPORT_DATA 재암호화 ----
await scenario('S8: IMPORT_DATA 재암호화', async () => {
  const importData = {
    schemaVersion: 1,
    presets: [
      {
        id: 'old-id-1',
        name: 'S8 임포트 프리셋',
        urlPattern: 'example.com',
        fields: [
          { id: 'f1', label: '비밀번호', selector: '#pwd', value: 'imported123', type: 'text', sensitive: true },
        ],
      },
    ],
    groups: [],
  };
  const result = await call('IMPORT_DATA', { data: importData });
  assert.strictEqual(result.importedPresets, 1, '프리셋 1개 임포트');

  const dump = storageDump();
  assert(!jsonHas(dump, 'imported123'), 'storage 전체에 평문 imported123이 없어야 함');
  const imported = dump.presets.find((p) => p.name === 'S8 임포트 프리셋');
  assert(imported, '임포트된 프리셋이 저장되어야 함');
  assert.notStrictEqual(imported.id, 'old-id-1', '새 id가 부여되어야 함');
  const sec = dump[`sec:${imported.id}:f1`];
  assert(sec && typeof sec.ct === 'string', '새 id 기준 sec: 키가 존재해야 함');

  const list = await call('PRESET_LIST', {});
  const found = list.find((p) => p.id === imported.id);
  assert.strictEqual(found.fields.find((f) => f.id === 'f1').value, 'imported123', 'PRESET_LIST로 복호화 확인');
});

// ---- S9: EXPORT_DATA 복호화 ----
await scenario('S9: EXPORT_DATA 복호화', async () => {
  const preset = await createPreset('S9 프리셋', 'example.com');
  await saveSensitiveField(preset.id, {
    id: 'f1',
    label: '비밀번호',
    selector: '#pwd',
    value: 'secret123',
    type: 'text',
    sensitive: true,
  });

  const exported = await call('EXPORT_DATA', {});
  const found = exported.presets.find((p) => p.id === preset.id);
  assert(found, 'EXPORT_DATA에 프리셋이 있어야 함');
  assert.strictEqual(found.fields.find((f) => f.id === 'f1').value, 'secret123', '백업 데이터에 복호화된 평문 값 포함');
});

// ============================================================
// 5. 요약 및 exit code
// ============================================================

const failed = results.filter((r) => !r.pass);
console.log('\n===== 요약 =====');
for (const r of results) {
  console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}`);
}
console.log(`총 ${results.length}개 중 ${results.length - failed.length}개 통과, ${failed.length}개 실패`);
process.exit(failed.length === 0 ? 0 : 1);