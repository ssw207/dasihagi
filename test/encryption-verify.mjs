/**
 * 프리셋 전체 암호화(AES-256-GCM) 통합 검증 스크립트
 *
 * 브라우저 없이 mock chrome API로 실제 background.js(+secure-store.js)를 구동해
 * 프리셋별 전체 암호화(sec:preset:<id> blob) 저장/복호화/재암호화/정리/마이그레이션을 검증한다.
 *
 * 저장 모델: presets = 평문 인덱스 [{id,name,urlPattern,urlPatterns,autoApply,updatedAt}]
 *           sec:preset:<id> = 프리셋 전체(모든 필드 값) AES-256-GCM 암호화 blob
 *           field.sensitive = 마스킹 표시 신호 (저장 보호와 무관)
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
    onCreated: { addListener() {} },
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
// 2. 레거시(필드 단위 민감 암호화) 데이터 시드 — 마이그레이션 검증용
//    (background.js import 시점에 migrateLegacyStorage가 실행됨)
// ============================================================

function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromB64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function seedLegacyData() {
  // vault 키를 직접 생성해 시드 — secure-store가 이 키로 복호화하도록 함
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = await crypto.subtle.exportKey('raw', key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode('비밀값123')
  );
  const now = Date.now();
  await storageLocal.set({
    vault_key_v1: toB64(raw),
    'sec:legacy-1:f1': { ct: toB64(ct), iv: toB64(iv) }, // 레거시 필드별 암호문
    presets: [
      {
        id: 'legacy-1',
        name: '레거시 프리셋',
        urlPattern: 'example.com',
        autoApply: false,
        createdAt: now,
        updatedAt: now,
        fields: [
          { id: 'f1', label: '비밀번호', selector: '#pwd', value: '', type: 'text', sensitive: true },
          { id: 'f2', label: '이름', selector: '#name', value: '홍길동', type: 'text' },
        ],
      },
    ],
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

await seedLegacyData();
await import('../background.js');

if (!messageListener) {
  throw new Error('background.js가 chrome.runtime.onMessage listener를 등록하지 않았습니다.');
}

// ============================================================
// 3. 메시지 전송 헬퍼
// ============================================================

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

async function createPreset(name, urlPattern, extra = {}) {
  return call('PRESET_CREATE', { name, urlPattern, ...extra });
}

async function saveSensitiveField(presetId, field) {
  return call('CAPTURE_SAVE_FIELD', { presetId, field });
}

// ---- M1: 레거시 저장 데이터가 프리셋 blob으로 이전 ----
await scenario('M1: 레거시 저장 데이터가 프리셋 blob으로 이전', async () => {
  const migrated = await waitFor(() => {
    const p = storageLocal.dump().presets;
    return Array.isArray(p) && p.length > 0 && !Array.isArray(p[0].fields);
  });
  assert(migrated, '마이그레이션이 인덱스 형식으로 완료되어야 함');

  const dump = storageLocal.dump();
  const idx = dump.presets.find((p) => p.id === 'legacy-1');
  assert(idx, '인덱스에 레거시 프리셋이 있어야 함');
  assert.strictEqual(idx.name, '레거시 프리셋', '인덱스에 name 유지');
  assert(!Array.isArray(idx.fields), '인덱스에 fields가 없어야 함 (평문 미노출)');

  const blob = dump['sec:preset:legacy-1'];
  assert(blob && typeof blob.ct === 'string' && typeof blob.iv === 'string', 'sec:preset:legacy-1 blob 생성');
  assert(!dump['sec:legacy-1:f1'], '레거시 필드별 sec 키 정리');
  assert(!jsonHas(dump, '비밀값123'), '저장소에 평문 비밀값123이 없어야 함');
});

// ---- M2: 이전 후 PRESET_LIST가 복호화 값 반환 ----
await scenario('M2: 이전 후 PRESET_LIST가 복호화 값 반환', async () => {
  const list = await call('PRESET_LIST', {});
  const found = list.find((p) => p.id === 'legacy-1');
  assert(found, '이전된 프리셋이 목록에 있어야 함');
  const f1 = found.fields.find((f) => f.id === 'f1');
  assert.strictEqual(f1.value, '비밀값123', '레거시 민감 값이 복호화되어야 함');
  assert.strictEqual(f1.sensitive, true, 'sensitive(마스킹 신호) 유지');
  assert.strictEqual(found.fields.find((f) => f.id === 'f2').value, '홍길동', '비민감 값 유지');
});

// ---- S1: 민감 필드 저장 시 평문 미노출 (프리셋 blob) ----
await scenario('S1: 민감 필드 저장 시 평문 미노출 (프리셋 blob)', async () => {
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
  const idx = dump.presets.find((p) => p.id === preset.id);
  assert(idx, '인덱스에 프리셋이 있어야 함');
  assert(!Array.isArray(idx.fields), '인덱스에 fields가 없어야 함 (평문 미노출)');
  assert(!jsonHas(dump, 'secret123'), 'storage 전체에 평문 secret123이 없어야 함');

  const blob = dump['sec:preset:' + preset.id];
  assert(blob && typeof blob.ct === 'string' && typeof blob.iv === 'string', 'sec:preset:<id> blob {ct, iv} 구조');
});

// ---- S2: 비민감 필드도 전체 암호화로 보호 ----
await scenario('S2: 비민감 필드도 전체 암호화로 보호', async () => {
  const preset = await createPreset('S2 프리셋', 'example.com');
  await saveSensitiveField(preset.id, {
    id: 'f2',
    label: '이름',
    selector: '#name',
    value: 'plain123',
    type: 'text',
  });

  const dump = storageDump();
  assert(!jsonHas(dump, 'plain123'), '비민감 필드도 프리셋 전체 암호화로 평문 미노출');
  assert(dump['sec:preset:' + preset.id], 'blob 존재');
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
  const oldBlob = storageDump()['sec:preset:' + preset.id];

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
  const newBlob = dump['sec:preset:' + preset.id];
  assert(newBlob && typeof newBlob.ct === 'string', 'blob에 새 암호문이 존재해야 함');
  assert.notStrictEqual(newBlob.ct, oldBlob.ct, '암호문이 새 값으로 재암호화되어야 함');
  const idx = dump.presets.find((p) => p.id === preset.id);
  assert(!Array.isArray(idx.fields), '인덱스에 fields가 없어야 함');

  const list = await call('PRESET_LIST', {});
  const found = list.find((p) => p.id === preset.id);
  assert.strictEqual(found.fields.find((f) => f.id === 'f1').value, 'newsecret456', 'PRESET_LIST로 새 값 복호화 확인');
});

// ---- S6: sensitive는 마스킹 신호로 보존 (저장 구조 불변) ----
await scenario('S6: sensitive는 마스킹 신호로 보존 (저장 구조 불변)', async () => {
  const preset = await createPreset('S6 프리셋', 'example.com');
  await saveSensitiveField(preset.id, {
    id: 'f1',
    label: '비밀번호',
    selector: '#pwd',
    value: 'secret123',
    type: 'text',
    sensitive: true,
  });

  // 민감 해제(마스킹 해제)해도 저장 구조는 불변 — 값은 blob 안에 유지
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
  assert(dump['sec:preset:' + preset.id], '민감 해제와 무관하게 blob 유지');
  assert(!jsonHas(dump, 'nowplain'), '평문 미노출 유지 (비민감 값도 blob 안)');

  const list = await call('PRESET_LIST', {});
  const found = list.find((p) => p.id === preset.id);
  const f1 = found.fields.find((f) => f.id === 'f1');
  assert.strictEqual(f1.sensitive, false, 'sensitive=false 보존 (마스킹 해제 신호)');
  assert.strictEqual(f1.value, 'nowplain', '값 반환');
});

// ---- S7: PRESET_DELETE 시 blob + 인덱스 정리 ----
await scenario('S7: PRESET_DELETE 시 blob + 인덱스 정리', async () => {
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
  assert(storageDump()['sec:preset:' + preset.id], '삭제 전 blob 존재');

  await call('PRESET_DELETE', { id: preset.id });
  const dump = storageDump();
  assert(!dump['sec:preset:' + preset.id], '삭제 후 blob 제거되어야 함');
  assert(!dump.presets.find((p) => p.id === preset.id), '삭제 후 인덱스 항목 제거되어야 함');
});

// ---- S8: IMPORT_DATA 전체 암호화 ----
await scenario('S8: IMPORT_DATA 전체 암호화', async () => {
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
  const idx = dump.presets.find((p) => p.name === 'S8 임포트 프리셋');
  assert(idx, '인덱스에 임포트 프리셋이 있어야 함');
  assert.notStrictEqual(idx.id, 'old-id-1', '새 id가 부여되어야 함');
  assert(!Array.isArray(idx.fields), '인덱스에 fields가 없어야 함');
  assert(dump['sec:preset:' + idx.id], '새 id 기준 blob이 존재해야 함');

  const list = await call('PRESET_LIST', {});
  const found = list.find((p) => p.id === idx.id);
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

// ---- S10: AUTO_APPLY_CHECK 인덱스 매칭 + 복호화 ----
await scenario('S10: AUTO_APPLY_CHECK 인덱스 매칭 + 복호화', async () => {
  const preset = await createPreset('S10 자동적용', 'example.com', { autoApply: true });
  await saveSensitiveField(preset.id, {
    id: 'f1',
    label: '비밀번호',
    selector: '#pwd',
    value: 'secret123',
    type: 'text',
    sensitive: true,
  });

  const matched = await call('AUTO_APPLY_CHECK', { url: 'https://example.com/form' });
  const found = matched.find((p) => p.id === preset.id);
  assert(found, '자동 적용 매칭 프리셋이 포함되어야 함');
  assert.strictEqual(found.fields.find((f) => f.id === 'f1').value, 'secret123', '복호화된 값 반환');

  const none = await call('AUTO_APPLY_CHECK', { url: 'https://other.com/form' });
  assert.strictEqual(none.length, 0, '비매칭 URL이면 빈 배열');
});

// ---- S11: PRESET_DELETE_MANY + 그룹 스텝 정리 ----
await scenario('S11: PRESET_DELETE_MANY 여러 개 삭제 + 그룹 스텝 정리', async () => {
  const a = await createPreset('S11-A', 'example.com');
  const b = await createPreset('S11-B', 'example.com');
  const keep = await createPreset('S11-KEEP', 'example.com');
  await saveSensitiveField(a.id, {
    id: 'fa',
    label: '비밀번호',
    selector: '#pwd',
    value: 'secret-a',
    type: 'text',
    sensitive: true
  });
  const group = await call('GROUP_CREATE', {
    name: 'S11 그룹',
    steps: [
      { presetId: a.id, submitMode: 'manual' },
      { presetId: b.id, submitMode: 'manual' },
      { presetId: keep.id, submitMode: 'manual' }
    ]
  });
  assert(group && group.id, '그룹 생성');

  let emptyFailed = false;
  try {
    await call('PRESET_DELETE_MANY', { ids: [] });
  } catch (e) {
    emptyFailed = String(e.message || '').includes('선택');
  }
  assert(emptyFailed, '빈 선택은 오류여야 함');

  const result = await call('PRESET_DELETE_MANY', { ids: [a.id, b.id, a.id] });
  assert.strictEqual(result.deleted, 2, '중복 id는 한 번만 삭제');

  const dump = storageDump();
  assert(!dump['sec:preset:' + a.id], 'A blob 제거');
  assert(!dump['sec:preset:' + b.id], 'B blob 제거');
  assert(dump['sec:preset:' + keep.id], 'KEEP blob 유지');
  assert(!dump.presets.find((p) => p.id === a.id), 'A 인덱스 제거');
  assert(!dump.presets.find((p) => p.id === b.id), 'B 인덱스 제거');
  assert(dump.presets.find((p) => p.id === keep.id), 'KEEP 인덱스 유지');

  const groups = await call('GROUP_LIST', {});
  const g = groups.find((x) => x.id === group.id);
  assert(g, '그룹 유지');
  assert.strictEqual(g.steps.length, 1, '삭제된 프리셋 스텝만 제거');
  assert.strictEqual(g.steps[0].presetId, keep.id, '남은 스텝은 KEEP');
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