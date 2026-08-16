/**
 * 민감값 암호화 저장 모듈 — AES-256-GCM + 자동 생성 키
 * 방어: 로컬 열람/백업 유출/문자열 검색. 한계: 능동적 역공에는 난독화 수준
 * (키가 같은 브라우저 저장소에 존재. OS 키체인 수준은 확장 설치만으로 불가).
 */

const KEY_NAME = 'vault_key_v1';
const SECRET_PREFIX = 'sec:';
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

let cachedKey = null;

async function getOrCreateKey() {
  if (cachedKey) return cachedKey;
  const { [KEY_NAME]: stored } = await chrome.storage.local.get(KEY_NAME);
  if (stored) {
    cachedKey = await crypto.subtle.importKey(
      'raw', fromB64(stored), 'AES-GCM', false, ['encrypt', 'decrypt']
    );
    return cachedKey;
  }
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
  );
  const raw = await crypto.subtle.exportKey('raw', key);
  await chrome.storage.local.set({ [KEY_NAME]: toB64(raw) });
  cachedKey = key;
  return cachedKey;
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