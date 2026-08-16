/**
 * 민감값 암호화 저장 모듈 — AES-256-GCM + 자동 생성 키
 * 방어: 로컬 열람/백업 유출/문자열 검색. 한계: 능동적 역공에는 난독화 수준
 * (키가 같은 브라우저 저장소에 존재. OS 키체인 수준은 확장 설치만으로 불가).
 */

const KEY_NAME = 'vault_key_v1';
const SECRET_PREFIX = 'sec:';
const PRESETS_INDEX_KEY = 'presets';
const B64_CHUNK = 0x8000;

function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(bin);
}

function fromB64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 저장된 키 형식 검증 — 손상/오염된 키를 새 키 생성으로 덮어쓰지 않도록 사전 차단
function isValidKeyFormat(stored) {
  return (
    typeof stored === 'string' &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(stored) &&
    stored.length >= 24 &&
    stored.length <= 64
  );
}

let cachedKey = null;

async function getOrCreateKey() {
  if (cachedKey) return cachedKey;
  const { [KEY_NAME]: stored } = await chrome.storage.local.get(KEY_NAME);
  if (stored) {
    if (!isValidKeyFormat(stored)) {
      throw new Error('암호화 키가 손상되었습니다.');
    }
    cachedKey = await crypto.subtle.importKey(
      'raw', fromB64(stored), 'AES-GCM', false, ['encrypt', 'decrypt']
    );
    return cachedKey;
  }
  // 키가 없는데 저장된 프리셋이 있으면 새 키 자동 생성으로 기존 데이터를 소실시키지 않는다
  const { [PRESETS_INDEX_KEY]: presets } = await chrome.storage.local.get(PRESETS_INDEX_KEY);
  if (Array.isArray(presets) && presets.length > 0) {
    throw new Error('암호화 키가 없어 저장된 프리셋을 복호화할 수 없습니다.');
  }
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const raw = await crypto.subtle.exportKey('raw', key);
  await chrome.storage.local.set({ [KEY_NAME]: toB64(raw) });
  cachedKey = key;
  return cachedKey;
}

// vault 키 상태 신호 — background가 사용자 경고를 낼 수 있게 함 (K1/K2/F6)
export async function getVaultKeyStatus() {
  const { [KEY_NAME]: stored } = await chrome.storage.local.get(KEY_NAME);
  const { [PRESETS_INDEX_KEY]: presets } = await chrome.storage.local.get(PRESETS_INDEX_KEY);
  const hasPresets = Array.isArray(presets) && presets.length > 0;
  if (!stored) {
    return hasPresets
      ? { ok: false, reason: 'missing', message: '암호화 키가 없어 저장된 프리셋을 복호화할 수 없습니다.' }
      : { ok: true, empty: true };
  }
  if (!isValidKeyFormat(stored)) {
    return { ok: false, reason: 'corrupt', message: '암호화 키가 손상되었습니다.' };
  }
  try {
    await crypto.subtle.importKey('raw', fromB64(stored), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'corrupt', message: '암호화 키가 손상되었습니다.' };
  }
}

export async function setSecret(id, plaintext) {
  const key = await getOrCreateKey();
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 매 저장마다 새 IV (재사용 금지)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(String(plaintext))
  );
  await chrome.storage.local.set({
    [SECRET_PREFIX + id]: { ct: toB64(ct), iv: toB64(iv) },
  });
}

export async function getSecret(id) {
  const { [SECRET_PREFIX + id]: entry } = await chrome.storage.local.get(SECRET_PREFIX + id);
  if (!entry) return null;
  try {
    const key = await getOrCreateKey();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(entry.iv) },
      key,
      fromB64(entry.ct)
    );
    return new TextDecoder().decode(pt);
  } catch {
    // 키 불일치/데이터 손상 시 null 반환. 민감정보를 로그에 남기지 않음.
    return null;
  }
}

export async function deleteSecret(id) {
  await chrome.storage.local.remove(SECRET_PREFIX + id);
}

export async function clearAllSecrets() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(SECRET_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}