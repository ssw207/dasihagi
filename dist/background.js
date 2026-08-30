import { setSecret, getSecret, deleteSecret, getVaultKeyStatus } from './secure-store.js';

const STORAGE_KEY = 'presets';
const GROUPS_KEY = 'groups';
const RUN_KEY = 'runState';
const EXPORT_SCHEMA_VERSION = 1;
const MAX_IMPORT_PRESETS = 500;
const MAX_IMPORT_GROUPS = 100;
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // IMPORT_DATA 총 크기 상한 (5MB)
const MAX_FIELDS_PER_PRESET = 500; // 프리셋당 필드 수 상한
const MAX_FIELD_VALUE_LENGTH = 64 * 1024; // 필드 값 크기 상한 (64KB)
const MAX_URL_PATTERNS = 20; // 프리셋당 허용 사이트 상한
const captureTabs = new Set();
const RECORD_SESSIONS_KEY = 'recordSessions';
const RECORD_MAX_DELAY = 5000;
const REPLAY_PACE_KEY = 'ui:replayPace';

function normalizeReplayPace(v) {
  return v === 'fast' || v === 'slow' ? v : 'normal';
}

async function getReplayPace() {
  try {
    const data = await chrome.storage.local.get(REPLAY_PACE_KEY);
    return normalizeReplayPace(data[REPLAY_PACE_KEY]);
  } catch (e) {
    return 'normal';
  }
}

function paceDelayMs(raw, pace) {
  const d = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), RECORD_MAX_DELAY) : 150;
  if (pace === 'fast') return Math.min(d, 40);
  if (pace === 'slow') return Math.min(Math.round(d * 1.5) + 200, RECORD_MAX_DELAY);
  return d;
}

function paceAfterNavigateMs(pace) {
  if (pace === 'fast') return 0;
  if (pace === 'slow') return 1000;
  return 200;
}

function paceTabWaitMs(pace) {
  if (pace === 'fast') return 8000;
  if (pace === 'slow') return 20000;
  return 15000;
}

function paceWaitElementMs(pace) {
  if (pace === 'fast') return 2500;
  if (pace === 'slow') return 8000;
  return 5000;
}

let recordSessions = {}; // tabId → session (같은 sessionId는 객체 공유: 팝업 탭 이어 녹화)
let journeyReplayTabId = null;
const tabCompleteWaiters = [];

let runState = null;
let groupRunInFlight = false; // RUN_GROUP 이중 진입 방지 (첫 await 전 동기 선점)

async function persistRunState() {
  try {
    await chrome.storage.session.set({ [RUN_KEY]: runState });
  } catch (e) {
    // storage.session 접근 불가 시 메모리 상태만 유지
  }
}

async function restoreRunState() {
  try {
    const data = await chrome.storage.session.get(RUN_KEY);
    runState = data[RUN_KEY] || null;
  } catch (e) {
    runState = null;
  }
}

async function clearRunState() {
  runState = null;
  try {
    await chrome.storage.session.remove(RUN_KEY);
  } catch (e) {}
}

async function getPresetIndex() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function savePresetIndex(index) {
  await chrome.storage.local.set({ [STORAGE_KEY]: index });
}

// 프리셋 전체를 복호화된 형태로 반환 (sec:preset:<id> blob)
async function getPresetById(id) {
  const raw = await getSecret('preset:' + id);
  if (!raw) return null;
  try {
    const preset = JSON.parse(raw);
    // 구조 무결성 검증 — 저장소 변조 시 popup 크래시 방지 (C8)
    if (!preset || typeof preset !== 'object' || !Array.isArray(preset.fields)) return null;
    const fields = [];
    for (const f of preset.fields) {
      if (!f || typeof f !== 'object') return null;
      fields.push({
        ...f,
        label: typeof f.label === 'string' ? f.label : String(f.label == null ? '필드' : f.label),
        selector: typeof f.selector === 'string' ? f.selector : String(f.selector || ''),
        value: f.value == null ? '' : String(f.value)
      });
    }
    preset.fields = fields;
    return preset;
  } catch (e) {
    return null;
  }
}

async function getAllPresets() {
  const index = await getPresetIndex();
  const result = [];
  for (const entry of index) {
    const preset = await getPresetById(entry.id);
    if (preset) result.push(preset);
  }
  return result;
}

// 프리셋 전체를 통째로 암호화 저장 + 평문 인덱스 갱신
async function savePreset(preset) {
  await setSecret('preset:' + preset.id, JSON.stringify(preset));
  try {
    const index = await getPresetIndex();
    const idx = index.findIndex((p) => p.id === preset.id);
    normalizePresetPatterns(preset);
    const entry = {
      id: preset.id,
      name: preset.name,
      urlPattern: preset.urlPattern,
      urlPatterns: getPresetPatterns(preset),
      autoApply: !!preset.autoApply,
      updatedAt: preset.updatedAt || Date.now()
    };
    if (idx === -1) index.push(entry);
    else index[idx] = entry;
    await savePresetIndex(index);
  } catch (e) {
    // 인덱스 쓰기 실패 시 방금 쓴 blob을 롤백해 고아 blob/불일치 방지 (Q2)
    try {
      await deleteSecret('preset:' + preset.id);
    } catch (rollbackErr) {
      // 롤백 실패는 원래 오류를 우선 전파
    }
    throw e;
  }
}

async function deletePreset(id) {
  await deleteSecret('preset:' + id);
  const index = await getPresetIndex();
  await savePresetIndex(index.filter((p) => p.id !== id));
}

function normalizeDeleteIds(ids) {
  const seen = new Set();
  const out = [];
  const raw = Array.isArray(ids) ? ids : [];
  for (const id of raw) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IMPORT_PRESETS) break;
  }
  return out;
}

async function removePresetIdsFromGroups(idSet) {
  if (!idSet || idSet.size === 0) return;
  const groups = await getGroups();
  let changed = false;
  for (const g of groups) {
    if (!Array.isArray(g.steps)) continue;
    const before = g.steps.length;
    g.steps = g.steps.filter((s) => !idSet.has(s.presetId));
    if (g.steps.length !== before) changed = true;
  }
  if (changed) await saveGroups(groups);
}

async function deletePresets(ids) {
  const unique = normalizeDeleteIds(ids);
  if (unique.length === 0) throw new Error('삭제할 프리셋을 선택해주세요.');
  for (const id of unique) {
    await deletePreset(id);
  }
  await removePresetIdsFromGroups(new Set(unique));
  return { deleted: unique.length };
}

async function getGroups() {
  const data = await chrome.storage.local.get(GROUPS_KEY);
  return Array.isArray(data[GROUPS_KEY]) ? data[GROUPS_KEY] : [];
}

async function saveGroups(groups) {
  await chrome.storage.local.set({ [GROUPS_KEY]: groups });
}

async function listFrameIds(tabId) {
  try {
    if (chrome.webNavigation && typeof chrome.webNavigation.getAllFrames === 'function') {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      if (Array.isArray(frames) && frames.length) {
        return frames.map((f) => f.frameId);
      }
    }
  } catch (e) {
    // webNavigation 없거나 탭이 없으면 메인 프레임만
  }
  return [0];
}

async function sendToAllFrames(tabId, msg) {
  const ids = await listFrameIds(tabId);
  const results = [];
  for (const frameId of ids) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, msg, { frameId });
      results.push({ frameId, ok: true, resp });
    } catch (e) {
      results.push({ frameId, ok: false, error: e });
    }
  }
  return results;
}

function mergeApplyPresetResults(results) {
  const applied = [];
  const appliedLabels = new Set();
  const failMap = new Map();
  for (const r of results) {
    if (!r.ok || !r.resp) continue;
    const data = r.resp.result || r.resp;
    for (const a of data.applied || []) {
      applied.push(a);
      if (a && a.label) appliedLabels.add(a.label);
    }
    for (const f of data.failures || []) {
      const key = (f && f.label) || '';
      if (key) failMap.set(key, f);
    }
  }
  const failures = [...failMap.values()].filter((f) => !appliedLabels.has(f.label));
  return { applied, failures };
}

async function sendApplyToFrames(tabId, msg) {
  const results = await sendToAllFrames(tabId, msg);
  if (msg.type === 'APPLY_ACTION') {
    for (const r of results) {
      const res = r.resp && r.resp.result;
      if (r.ok && res && res.ok) return r.resp;
    }
    const last = [...results].reverse().find((r) => r.ok && r.resp);
    return last ? last.resp : { result: { ok: false, reason: '적용 실패' } };
  }
  if (msg.type === 'APPLY_PRESET') {
    return { result: mergeApplyPresetResults(results) };
  }
  if (msg.type === 'SUBMIT_FORM') {
    const hit = results.find((r) => r.ok && r.resp && r.resp.ok);
    return hit ? hit.resp : { ok: false, reason: '제출 버튼을 찾을 수 없습니다.' };
  }
  return results.some((r) => r.ok);
}

function sessionKey(tabId) {
  return String(tabId);
}

function getRecordSession(tabId) {
  return recordSessions[sessionKey(tabId)] || null;
}

function setRecordSession(tabId, session) {
  recordSessions[sessionKey(tabId)] = session;
}

function deleteRecordSession(tabId) {
  delete recordSessions[sessionKey(tabId)];
}

async function persistRecordSessions() {
  const tabs = {};
  const sessions = {};
  for (const [tabId, s] of Object.entries(recordSessions)) {
    if (!s || typeof s !== 'object') continue;
    if (!s.sessionId) s.sessionId = crypto.randomUUID();
    tabs[tabId] = s.sessionId;
    sessions[s.sessionId] = s;
  }
  try {
    await chrome.storage.session.set({ [RECORD_SESSIONS_KEY]: { v: 2, tabs, sessions } });
  } catch (e) {
    // session 저장 실패 시 메모리 세션만 유지
  }
}

async function restoreRecordSessions() {
  try {
    const data = await chrome.storage.session.get(RECORD_SESSIONS_KEY);
    const raw = data[RECORD_SESSIONS_KEY];
    recordSessions = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    if (raw.v === 2 && raw.tabs && raw.sessions) {
      for (const [tabId, sid] of Object.entries(raw.tabs)) {
        const s = raw.sessions[sid];
        if (s) recordSessions[tabId] = s;
      }
      return;
    }
    recordSessions = raw;
  } catch (e) {
    recordSessions = {};
  }
}

function tabIdsForSession(session) {
  if (!session) return [];
  return Object.keys(recordSessions)
    .filter((k) => {
      const s = recordSessions[k];
      return s === session || (session.sessionId && s && s.sessionId === session.sessionId);
    })
    .map((k) => Number(k));
}

function attachRecordingFromOpener(tab) {
  if (!tab || tab.id == null) return false;
  if (getRecordSession(tab.id)) return true;
  const openerId = tab.openerTabId;
  if (openerId == null) return false;
  const source = getRecordSession(openerId);
  if (!source) return false;
  if (tab.url && isRestrictedRecordUrl(tab.url)) return false;
  if (!source.sessionId) source.sessionId = crypto.randomUUID();
  setRecordSession(tab.id, source);
  if (tab.url) rememberSessionSite(source, tab.url);
  return true;
}

function isJourneyPreset(preset) {
  return !!(
    preset &&
    Array.isArray(preset.fields) &&
    preset.fields.some((f) => f && (f.type === 'click' || f.type === 'keydown' || f.type === 'navigate'))
  );
}

function normalizeNavUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    let href = u.href;
    if (href.endsWith('/')) href = href.slice(0, -1);
    return href;
  } catch (e) {
    return String(url || '');
  }
}

function normalizeRecordEvent(e) {
  return {
    id: e.id || crypto.randomUUID(),
    label: e.label || '필드',
    selector: typeof e.selector === 'string' ? e.selector : '',
    value: e.value == null ? '' : String(e.value),
    type: e.type || 'text',
    delay: e.delay,
    sensitive: !!e.sensitive
  };
}

function appendSessionEvent(session, raw) {
  const field = normalizeRecordEvent(raw);
  if (field.type === 'navigate') {
    const lastNav = session.events[session.events.length - 1];
    if (lastNav && lastNav.type === 'navigate' && lastNav.value === field.value) {
      return session.events.length;
    }
  }
  const now = Date.now();
  const delay = session.lastRecordAt ? Math.min(now - session.lastRecordAt, RECORD_MAX_DELAY) : 0;
  session.lastRecordAt = now;
  const last = session.events[session.events.length - 1];
  const mergeable = field.type !== 'click' && field.type !== 'keydown' && field.type !== 'navigate';
  if (mergeable && last && last.selector === field.selector && last.type === field.type) {
    last.value = field.value;
    last.sensitive = !!(last.sensitive || field.sensitive);
    return session.events.length;
  }
  if (session.events.length >= MAX_FIELDS_PER_PRESET) {
    return session.events.length;
  }
  field.delay = delay;
  session.events.push(field);
  return session.events.length;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const entry = {
      tabId,
      resolve,
      timer: setTimeout(() => {
        const idx = tabCompleteWaiters.indexOf(entry);
        if (idx !== -1) tabCompleteWaiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs)
    };
    tabCompleteWaiters.push(entry);
  });
}

function notifyTabComplete(tabId) {
  for (let i = tabCompleteWaiters.length - 1; i >= 0; i--) {
    const waiter = tabCompleteWaiters[i];
    if (waiter.tabId === tabId) {
      clearTimeout(waiter.timer);
      tabCompleteWaiters.splice(i, 1);
      waiter.resolve(true);
    }
  }
}

async function navigateTab(tabId, url, timeoutMs) {
  const tab = await chrome.tabs.get(tabId);
  if (normalizeNavUrl(tab.url) === normalizeNavUrl(url)) return true;
  const waited = waitForTabComplete(tabId, timeoutMs || 15000);
  await chrome.tabs.update(tabId, { url });
  return waited;
}

async function appendNavigateIfRecording(tabId, url) {
  const session = getRecordSession(tabId);
  if (!session || !url) return;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('about:')) return;
  if (session.lastUrl && normalizeNavUrl(session.lastUrl) === normalizeNavUrl(url)) return;
  session.lastUrl = url;
  rememberSessionSite(session, url);
  appendSessionEvent(session, {
    id: crypto.randomUUID(),
    label: '페이지 이동',
    selector: '',
    value: url,
    type: 'navigate'
  });
  await persistRecordSessions();
}

async function resumeRecordingIfNeeded(tabId) {
  const session = getRecordSession(tabId);
  if (!session) return;
  try {
    await sendToAllFrames(tabId, {
      type: 'RECORD_START',
      presetId: session.presetId,
      resume: true,
      eventCount: session.events.length
    });
  } catch (e) {
    // content script가 아직 없으면 다음 complete에서 재시도
  }
}

async function resumeAllRecordChips() {
  const ids = Object.keys(recordSessions);
  for (const id of ids) {
    const tabId = Number(id);
    if (!Number.isFinite(tabId)) continue;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.status === 'complete') await resumeRecordingIfNeeded(tabId);
    } catch (e) {
      deleteRecordSession(tabId);
    }
  }
  await persistRecordSessions();
}

async function replayJourney(tabId, preset) {
  const fields = Array.isArray(preset.fields) ? preset.fields : [];
  const applied = [];
  const failures = [];
  const pace = await getReplayPace();
  const tabWait = paceTabWaitMs(pace);
  const afterNav = paceAfterNavigateMs(pace);
  const waitEl = paceWaitElementMs(pace);
  journeyReplayTabId = tabId;
  try {
    if (preset.startUrl) {
      const moved = await navigateTab(tabId, preset.startUrl, tabWait);
      if (!moved) {
        failures.push({ ok: false, label: '시작 페이지', reason: '시작 페이지로 이동하지 못했습니다.' });
        return { applied, failures };
      }
      if (afterNav) await new Promise((r) => setTimeout(r, afterNav));
    }
    for (const field of fields) {
      await new Promise((r) => setTimeout(r, paceDelayMs(field.delay, pace)));
      if (field.type === 'navigate') {
        try {
          const moved = await navigateTab(tabId, field.value, tabWait);
          if (!moved) {
            failures.push({ ok: false, label: field.label, reason: '페이지 이동 시간 초과' });
            continue;
          }
          if (afterNav) await new Promise((r) => setTimeout(r, afterNav));
          applied.push({ ok: true, label: field.label });
        } catch (e) {
          failures.push({
            ok: false,
            label: field.label,
            reason: e && e.message ? e.message : '페이지 이동 실패'
          });
        }
        continue;
      }
      try {
        const resp = await sendApplyToFrames(tabId, {
          type: 'APPLY_ACTION',
          field,
          waitMs: waitEl
        });
        const res = resp && resp.result;
        if (res && res.ok) {
          applied.push(res);
        } else {
          failures.push(res || { ok: false, label: field.label, reason: '적용 실패' });
        }
      } catch (e) {
        const moved = await waitForTabComplete(tabId, Math.min(tabWait, 8000));
        if (moved) {
          applied.push({ ok: true, label: field.label });
        } else {
          failures.push({ ok: false, label: field.label, reason: '페이지와 통신할 수 없습니다.' });
        }
      }
    }
    return { applied, failures };
  } finally {
    journeyReplayTabId = null;
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// IDN/유니코드 도메인을 punycode(url.hostname 형식)로 정규화 (Edge-1 ④)
function normalizeHost(host) {
  if (!/[^\x00-\x7F]/.test(host)) return host;
  try {
    return new URL('http://' + host).hostname;
  } catch (e) {
    return host;
  }
}

function matchUrlPattern(pattern, urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch (e) {
    return false;
  }
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  let p = String(pattern).trim().toLowerCase().replace(/^[a-z]+:\/\//, '');
  p = p.split('?')[0].split('#')[0];
  if (p.endsWith('/') && p.length > 1) p = p.slice(0, -1);

  const slashIdx = p.indexOf('/');
  let hostPat;
  let pathPat;
  if (slashIdx === -1) {
    hostPat = p;
    pathPat = '';
  } else {
    hostPat = p.slice(0, slashIdx);
    pathPat = p.slice(slashIdx);
  }

  // ① IPv6 [::1]:8080 — 괄호 IPv6를 먼저 처리해 포트 제거 정규식이 IPv6를 망가뜨리지 않게 함
  let patPort = '';
  if (hostPat.startsWith('[')) {
    const closeIdx = hostPat.indexOf(']');
    if (closeIdx !== -1) {
      const rest = hostPat.slice(closeIdx + 1);
      const portMatch = rest.match(/^:(\d+)$/);
      if (portMatch) {
        patPort = portMatch[1];
        hostPat = hostPat.slice(0, closeIdx + 1);
      }
    }
  } else {
    const portMatch = hostPat.match(/:(\d+)$/);
    if (portMatch) {
      patPort = portMatch[1];
      hostPat = hostPat.slice(0, portMatch.index);
    }
  }

  // ③ * 단독 패턴은 모든 URL 매칭
  if (hostPat === '*') return true;

  // ④ IDN/유니코드 도메인 정규화 (url.hostname은 punycode)
  let hostPatNorm = hostPat;
  if (hostPatNorm.startsWith('*.')) {
    hostPatNorm = '*.' + normalizeHost(hostPatNorm.slice(2));
  } else {
    hostPatNorm = normalizeHost(hostPatNorm);
  }

  // ⑤ 포트 처리 — URL 기본 포트(80/443)는 명시적 포트와 동일 취급
  const urlPort = url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
  const portOk = patPort === '' || patPort === urlPort;

  let hostMatched;
  if (hostPatNorm.startsWith('*.')) {
    const base = hostPatNorm.slice(2);
    hostMatched = (host === base || host.endsWith('.' + base)) && portOk;
  } else {
    hostMatched = host === hostPatNorm && portOk;
  }
  if (!hostMatched) return false;

  if (pathPat === '' || pathPat === '/' || pathPat === '/*') return true;
  if (pathPat.includes('*')) {
    const re = new RegExp('^' + pathPat.split('*').map(escapeRegExp).join('.*') + '$');
    return re.test(path);
  }
  // ② trailing slash: example.com/admin 패턴이 example.com/admin/ URL과도 매칭
  return path === pathPat || path.replace(/\/+$/, '') === pathPat;
}

function isRestrictedRecordUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return true;
  return /^(chrome|chrome-extension|edge|about|devtools|moz-extension):/i.test(urlStr);
}

function urlToSitePattern(urlStr) {
  if (isRestrictedRecordUrl(urlStr)) return '';
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const host = u.hostname.toLowerCase();
    if (!host) return '';
    return u.port ? host + ':' + u.port : host;
  } catch (e) {
    return '';
  }
}

function normalizePatternList(patterns) {
  const out = [];
  const seen = new Set();
  const raw = Array.isArray(patterns) ? patterns : [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const p = item.trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= MAX_URL_PATTERNS) break;
  }
  return out;
}

function getPresetPatterns(preset) {
  if (!preset) return [];
  const fromArr = normalizePatternList(preset.urlPatterns);
  if (fromArr.length) return fromArr;
  if (typeof preset.urlPattern === 'string' && preset.urlPattern.trim()) {
    return normalizePatternList([preset.urlPattern]);
  }
  return [];
}

function normalizePresetPatterns(preset) {
  if (!preset || typeof preset !== 'object') return preset;
  const list = getPresetPatterns(preset);
  preset.urlPatterns = list;
  preset.urlPattern = list[0] || (typeof preset.urlPattern === 'string' ? preset.urlPattern : '');
  return preset;
}

function syntheticUrlsForPattern(pattern) {
  const p = String(pattern || '').trim();
  if (!p) return [];
  if (/^[a-z]+:\/\//i.test(p)) return [p];
  return ['https://' + p, 'http://' + p];
}

function patternCoversPattern(existing, incoming) {
  if (!existing || !incoming) return false;
  if (existing.trim().toLowerCase() === incoming.trim().toLowerCase()) return true;
  return syntheticUrlsForPattern(incoming).some((u) => matchUrlPattern(existing, u));
}

function mergeUrlPatterns(existingPatterns, incomingPatterns) {
  const next = normalizePatternList(existingPatterns);
  for (const incoming of normalizePatternList(incomingPatterns)) {
    if (next.some((e) => patternCoversPattern(e, incoming))) continue;
    next.push(incoming);
    if (next.length >= MAX_URL_PATTERNS) break;
  }
  return next;
}

function matchAnyUrlPattern(patterns, urlStr) {
  return normalizePatternList(patterns).some((p) => matchUrlPattern(p, urlStr));
}

function matchPresetUrl(preset, urlStr) {
  return matchAnyUrlPattern(getPresetPatterns(preset), urlStr);
}

function rememberSessionSite(session, urlStr) {
  if (!session) return;
  const pat = urlToSitePattern(urlStr);
  if (!pat) return;
  if (!Array.isArray(session.allowedSites)) session.allowedSites = [];
  session.allowedSites = mergeUrlPatterns(session.allowedSites, [pat]);
}

function patternToUrl(pattern) {
  let p = String(pattern || '').trim();
  if (!p) return null;
  if (/^[a-z]+:\/\//i.test(p)) return p;
  // 스킴 없음: 호스트에 포트가 있으면 http:// (로컬 개발/인트라넷), 없으면 https:// (UX-3)
  const hostPart = p.split('/')[0];
  p = (/:\d+$/.test(hostPart) ? 'http://' : 'https://') + p;
  return p;
}

function updateRunBadge() {
  if (!runState) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const total = runState.group.steps.length;
  if (runState.status === 'running' || runState.status === 'waiting') {
    chrome.action.setBadgeText({ text: (runState.stepIdx + 1) + '/' + total });
    chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function sanitizeRunState() {
  if (!runState) return null;
  return {
    runId: runState.runId,
    groupId: runState.groupId,
    groupName: runState.group.name,
    stepIdx: runState.stepIdx,
    totalSteps: runState.group.steps.length,
    status: runState.status,
    stepResults: runState.stepResults,
    currentTabId: runState.currentTabId,
    currentStep: runState.currentStep
      ? {
          presetName: runState.currentStep.presetName,
          presetId: runState.currentStep.presetId,
          submitMode: runState.currentStep.submitMode,
          submitSelector: runState.currentStep.submitSelector
        }
      : null,
    error: runState.error || null
  };
}

function closeRunTab() {
  if (runState && runState.currentTabId) {
    try {
      chrome.tabs.remove(runState.currentTabId);
    } catch (e) {
      // 이미 닫힌 탭이면 무시
    }
    runState.currentTabId = null;
  }
}

async function failRun(message) {
  if (!runState) return;
  runState.status = 'failed';
  runState.error = message;
  updateRunBadge();
  await persistRunState();
}

async function abortRun() {
  if (!runState) return null;
  closeRunTab();
  runState.status = 'aborted';
  updateRunBadge();
  const snapshot = sanitizeRunState();
  await clearRunState();
  return snapshot;
}

async function startCurrentStep() {
  if (!runState) return;
  const total = runState.group.steps.length;
  if (runState.stepIdx >= total) {
    runState.status = 'done';
    runState.currentTabId = null;
    updateRunBadge();
    await persistRunState();
    return;
  }

  const step = runState.group.steps[runState.stepIdx];
  const preset = await getPresetById(step.presetId);
  if (!preset) {
    await failRun('스텝 ' + (runState.stepIdx + 1) + '의 프리셋을 찾을 수 없습니다.');
    return;
  }
  const url = patternToUrl(preset.urlPattern);
  if (!url) {
    await failRun('스텝 ' + (runState.stepIdx + 1) + '의 사이트 패턴이 비어 있습니다.');
    return;
  }

  const tab = await chrome.tabs.create({ url, active: true });
  runState.currentTabId = tab.id;
  runState.currentStep = {
    presetId: preset.id,
    presetName: preset.name,
    submitMode: step.submitMode || 'manual',
    submitSelector: step.submitSelector || '',
    applied: false // 같은 스텝의 complete 이벤트 중복 처리 방지 (Flow-13)
  };
  runState.status = 'running';
  updateRunBadge();
  await persistRunState();
}

async function handleStepTabLoaded(tabId) {
  if (!runState || runState.status !== 'running') return;
  if (runState.currentTabId !== tabId || !runState.currentStep) return;
  if (runState.currentStep.applied) return; // 같은 스텝의 complete 이벤트 중복 처리 방지 (Flow-13)
  runState.currentStep.applied = true;

  const stepInfo = runState.currentStep;
  // 평문 PII를 runState에 보관하지 않고 사용 시점에 재조회 (F9)
  const preset = await getPresetById(stepInfo.presetId);
  if (!preset) {
    await failRun('스텝 "' + stepInfo.presetName + '"의 프리셋을 찾을 수 없습니다.');
    return;
  }

  let applyResult = { applied: [], failures: [] };
  try {
    const replayPace = await getReplayPace();
    const resp = await sendApplyToFrames(tabId, { type: 'APPLY_PRESET', preset, replayPace });
    applyResult = (resp && resp.result) || applyResult;
  } catch (e) {
    await failRun('스텝 "' + stepInfo.presetName + '" 적용 실패: 페이지와 통신할 수 없습니다.');
    return;
  }

  const appliedCount = (applyResult.applied || []).length;
  const failedCount = (applyResult.failures || []).length;
  runState.stepResults.push({ stepIdx: runState.stepIdx, applied: appliedCount, failed: failedCount });
  await persistRunState();

  if (stepInfo.submitMode === 'auto') {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const submitResp = await sendApplyToFrames(tabId, {
        type: 'SUBMIT_FORM',
        selector: stepInfo.submitSelector
      });
      if (!submitResp || !submitResp.ok) {
        const reason = submitResp && submitResp.reason ? submitResp.reason : '제출 실패';
        await failRun('스텝 "' + stepInfo.presetName + '" 제출 실패: ' + reason);
        return;
      }
    } catch (e) {
      await failRun('스텝 "' + stepInfo.presetName + '" 제출 중 오류가 발생했습니다.');
      return;
    }
    closeRunTab();
    runState.stepIdx++;
    await startCurrentStep();
    return;
  }

  runState.status = 'waiting';
  updateRunBadge();
  await persistRunState();
}

async function startGroupRun(groupId) {
  if (groupRunInFlight || (runState && (runState.status === 'running' || runState.status === 'waiting'))) {
    throw new Error('이미 실행 중인 그룹이 있습니다. 먼저 중지해주세요.');
  }
  // 첫 await 전에 동기 선점해 이중 진입 차단 (Flow-1)
  groupRunInFlight = true;
  try {
    const groups = await getGroups();
    const group = groups.find((g) => g.id === groupId);
    if (!group) throw new Error('그룹을 찾을 수 없습니다.');
    if (!group.steps || group.steps.length === 0) {
      throw new Error('그룹에 실행할 스텝이 없습니다.');
    }

    runState = {
      runId: crypto.randomUUID(),
      groupId: group.id,
      group: JSON.parse(JSON.stringify(group)),
      stepIdx: 0,
      status: 'running',
      stepResults: [],
      currentTabId: null,
      currentStep: null,
      error: null
    };
    await startCurrentStep();
    await persistRunState();
    return sanitizeRunState();
  } finally {
    groupRunInFlight = false;
  }
}

async function nextStep() {
  if (!runState || runState.status !== 'waiting') {
    throw new Error('대기 중인 스텝이 없습니다.');
  }
  // 동기 전이: 두 번째 호출의 status==='waiting' 검사가 실패하게 해 스텝 스킵 방지 (Flow-2)
  runState.status = 'running';
  runState.stepIdx++;
  await startCurrentStep();
  await persistRunState();
  return sanitizeRunState();
}

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'PRESET_LIST': {
      const keyStatus = await getVaultKeyStatus();
      if (keyStatus && keyStatus.ok === false) {
        throw new Error(keyStatus.message);
      }
      return getAllPresets();
    }
    case 'PRESET_CREATE': {
      const now = Date.now();
      const preset = {
        id: crypto.randomUUID(),
        name: msg.name || '새 프리셋',
        urlPattern: msg.urlPattern || '',
        urlPatterns: normalizePatternList(msg.urlPatterns && msg.urlPatterns.length ? msg.urlPatterns : [msg.urlPattern || '']),
        fields: [],
        autoApply: !!msg.autoApply,
        createdAt: now,
        updatedAt: now,
      };
      await savePreset(preset);
      return preset;
    }
    case 'PRESET_UPDATE': {
      const prev = await getPresetById(msg.preset.id);
      if (!prev) throw new Error('프리셋을 찾을 수 없습니다.');
      const updated = {
        ...prev,
        ...msg.preset,
        fields: Array.isArray(msg.preset.fields) ? msg.preset.fields : (prev.fields || []),
        updatedAt: Date.now()
      };
      await savePreset(updated);
      return updated;
    }
    case 'PRESET_DELETE': {
      if (typeof msg.id !== 'string' || !msg.id) throw new Error('삭제할 프리셋을 선택해주세요.');
      await deletePresets([msg.id]);
      return true;
    }
    case 'PRESET_DELETE_MANY': {
      return deletePresets(msg.ids);
    }
    case 'GROUP_LIST': {
      return getGroups();
    }
    case 'GROUP_CREATE': {
      const groups = await getGroups();
      const now = Date.now();
      const group = {
        id: crypto.randomUUID(),
        name: msg.name || '새 그룹',
        steps: Array.isArray(msg.steps) ? msg.steps : [],
        createdAt: now,
        updatedAt: now,
      };
      groups.push(group);
      await saveGroups(groups);
      return group;
    }
    case 'GROUP_UPDATE': {
      const groups = await getGroups();
      const idx = groups.findIndex((g) => g.id === msg.group.id);
      if (idx === -1) throw new Error('그룹을 찾을 수 없습니다.');
      const updated = { ...msg.group, updatedAt: Date.now() };
      groups[idx] = updated;
      await saveGroups(groups);
      return updated;
    }
    case 'GROUP_DELETE': {
      const groups = await getGroups();
      const next = groups.filter((g) => g.id !== msg.id);
      await saveGroups(next);
      return true;
    }
    case 'RUN_GROUP': {
      return startGroupRun(msg.groupId);
    }
    case 'RUN_NEXT': {
      return nextStep();
    }
    case 'RUN_ABORT': {
      return abortRun();
    }
    case 'RUN_STATUS': {
      return sanitizeRunState();
    }
    case 'CAPTURE_START': {
      captureTabs.add(msg.tabId);
      const cap = await sendToAllFrames(msg.tabId, { type: 'CAPTURE_START', presetId: msg.presetId });
      if (!cap.some((r) => r.ok)) {
        throw new Error('페이지에서 캡처 모드를 시작할 수 없습니다. 지원되지 않는 페이지(예: chrome://)입니다.');
      }
      return true;
    }
    case 'CAPTURE_STOP': {
      captureTabs.delete(msg.tabId);
      await sendToAllFrames(msg.tabId, { type: 'CAPTURE_STOP' });
      return true;
    }
    case 'CAPTURE_STATUS': {
      return captureTabs.has(msg.tabId);
    }
    case 'CAPTURE_SAVE_FIELD': {
      const preset = await getPresetById(msg.presetId);
      if (!preset) throw new Error('프리셋을 찾을 수 없습니다.');
      const field = { ...msg.field };
      const fieldIdx = preset.fields.findIndex((f) => f.selector === field.selector);
      if (fieldIdx === -1) {
        preset.fields.push(field);
      } else {
        preset.fields[fieldIdx] = field;
      }
      preset.updatedAt = Date.now();
      await savePreset(preset);
      return preset;
    }
    case 'RECORD_START': {
      const tabId = msg.tabId;
      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch (e) {
        throw new Error('탭 정보를 확인할 수 없습니다.');
      }
      const existing = getRecordSession(tabId);
      if (existing && existing.presetId === msg.presetId) {
        rememberSessionSite(existing, tab.url);
        await persistRecordSessions();
        const resumed = await sendToAllFrames(tabId, {
          type: 'RECORD_START',
          presetId: msg.presetId,
          resume: true,
          eventCount: existing.events.length
        });
        if (!resumed.some((r) => r.ok)) {
          throw new Error('페이지에서 녹화를 시작할 수 없습니다. 지원되지 않는 페이지(예: chrome://)입니다.');
        }
        return true;
      }
      setRecordSession(tabId, {
        sessionId: crypto.randomUUID(),
        presetId: msg.presetId,
        events: [],
        lastRecordAt: 0,
        startUrl: tab.url || '',
        lastUrl: tab.url || '',
        allowedSites: []
      });
      rememberSessionSite(getRecordSession(tabId), tab.url);
      await persistRecordSessions();
      const started = await sendToAllFrames(tabId, {
        type: 'RECORD_START',
        presetId: msg.presetId,
        resume: false,
        eventCount: 0
      });
      if (!started.some((r) => r.ok)) {
        deleteRecordSession(tabId);
        await persistRecordSessions();
        throw new Error('페이지에서 녹화를 시작할 수 없습니다. 지원되지 않는 페이지(예: chrome://)입니다.');
      }
      return true;
    }
    case 'RECORD_STATUS': {
      const tabId = msg.tabId != null ? msg.tabId : sender.tab && sender.tab.id;
      const session = getRecordSession(tabId);
      if (!session) return { active: false, presetId: null, eventCount: 0 };
      return {
        active: true,
        presetId: session.presetId,
        eventCount: Array.isArray(session.events) ? session.events.length : 0
      };
    }
    case 'RECORD_APPEND': {
      const tabId = msg.tabId || (sender.tab && sender.tab.id);
      const session = getRecordSession(tabId);
      if (!session) throw new Error('녹화 중이 아닙니다.');
      if (!msg.event || typeof msg.event !== 'object') throw new Error('잘못된 녹화 이벤트입니다.');
      const count = appendSessionEvent(session, msg.event);
      await persistRecordSessions();
      return { count };
    }
    case 'RECORD_STOP': {
      const tabId = msg.tabId || (sender.tab && sender.tab.id);
      const session = getRecordSession(tabId);
      const linked = tabIdsForSession(session);
      const stopIds = linked.length ? linked : tabId != null ? [tabId] : [];
      for (const id of stopIds) {
        try {
          await sendToAllFrames(id, { type: 'RECORD_STOP' });
        } catch (e) {
          // 페이지가 닫혔거나 스크립트가 없으면 세션에 남은 이벤트로 저장
        }
        deleteRecordSession(id);
      }
      await persistRecordSessions();
      if (!session || !Array.isArray(session.events) || session.events.length === 0) {
        return { saved: 0 };
      }
      const preset = await getPresetById(session.presetId);
      if (!preset) throw new Error('프리셋을 찾을 수 없습니다.');
      preset.fields = session.events.map((e) => normalizeRecordEvent(e));
      preset.updatedAt = Date.now();
      if (session.startUrl) preset.startUrl = session.startUrl;
      const visited = Array.isArray(session.allowedSites) ? session.allowedSites : [];
      const fromEvents = (session.events || [])
        .filter((e) => e && e.type === 'navigate')
        .map((e) => urlToSitePattern(e.value));
      const merged = mergeUrlPatterns(getPresetPatterns(preset), [urlToSitePattern(session.startUrl)].concat(visited, fromEvents));
      preset.urlPatterns = merged;
      preset.urlPattern = merged[0] || preset.urlPattern;
      await savePreset(preset);
      return { saved: preset.fields.length, preset };
    }
    case 'RECORD_SAVE': {
      const preset = await getPresetById(msg.presetId);
      if (!preset) throw new Error('프리셋을 찾을 수 없습니다.');
      const events = Array.isArray(msg.events) ? msg.events : [];
      const fields = [];
      for (const e of events) {
        const field = {
          id: e.id || crypto.randomUUID(),
          label: e.label || '필드',
          selector: e.selector,
          value: e.value ?? '',
          type: e.type || 'text',
          delay: e.delay,
          // 자동 감지된 민감 여부는 마스킹 신호로 보존 (저장 보호는 프리셋 전체 암호화가 담당)
          sensitive: !!e.sensitive
        };
        fields.push(field);
      }
      preset.fields = fields;
      preset.updatedAt = Date.now();
      await savePreset(preset);
      return preset;
    }
    case 'APPLY_PRESET': {
      const preset = await getPresetById(msg.presetId);
      if (!preset) throw new Error('프리셋을 찾을 수 없습니다.');
      const tab = await chrome.tabs.get(msg.tabId);
      if (!tab.url) throw new Error('탭 정보를 확인할 수 없습니다.');
      if (isJourneyPreset(preset)) {
        const startOk = preset.startUrl && matchPresetUrl(preset, preset.startUrl);
        const tabOk = matchPresetUrl(preset, tab.url);
        if (!startOk && !tabOk) {
          throw new Error('현재 페이지가 프리셋 대상 사이트가 아닙니다.');
        }
        return replayJourney(msg.tabId, preset);
      }
      if (!matchPresetUrl(preset, tab.url)) {
        throw new Error('현재 페이지가 프리셋 대상 사이트가 아닙니다.');
      }
      const replayPace = await getReplayPace();
      const resp = await sendApplyToFrames(msg.tabId, { type: 'APPLY_PRESET', preset, replayPace });
      return resp && resp.result;
    }
    case 'SETTINGS_GET': {
      return { replayPace: await getReplayPace() };
    }
    case 'SETTINGS_SET': {
      const pace = normalizeReplayPace(msg.replayPace);
      await chrome.storage.local.set({ [REPLAY_PACE_KEY]: pace });
      return { replayPace: pace };
    }
    case 'AUTO_APPLY_CHECK': {
      const index = await getPresetIndex();
      const matching = index.filter((p) => p.autoApply && matchPresetUrl(p, msg.url));
      const result = [];
      for (const entry of matching) {
        const preset = await getPresetById(entry.id);
        if (preset && !isJourneyPreset(preset)) result.push(preset);
      }
      return result;
    }
    case 'GET_CURRENT_URL': {
      const tab = await chrome.tabs.get(msg.tabId);
      return tab.url || '';
    }
    case 'EXPORT_DATA': {
      return {
        presets: await getAllPresets(),
        groups: await getGroups()
      };
    }
    case 'IMPORT_DATA': {
      // background 단 총 메시지 크기 제한 (I9)
      const rawSize = JSON.stringify(msg.data || {}).length;
      if (rawSize > MAX_IMPORT_BYTES) {
        throw new Error('가져오기 데이터가 너무 큽니다. (최대 ' + (MAX_IMPORT_BYTES / 1024 / 1024) + 'MB)');
      }
      const imported = validateImportData(msg.data);
      const existingGroups = await getGroups();

      const idMap = new Map();
      const now = Date.now();
      for (const preset of imported.presets) {
        const oldId = preset.id;
        preset.id = crypto.randomUUID();
        if (oldId) idMap.set(oldId, preset.id);
        preset.createdAt = preset.createdAt || now;
        preset.updatedAt = now;
        normalizePresetPatterns(preset);
        // 프리셋 전체를 통째로 암호화 저장 (민감 여부 무관)
        await setSecret('preset:' + preset.id, JSON.stringify(preset));
      }

      const groups = [];
      for (const group of imported.groups) {
        const steps = (group.steps || []).filter((s) => idMap.has(s.presetId));
        if (steps.length === 0) continue;
        group.steps = steps.map((s) => ({ ...s, presetId: idMap.get(s.presetId) }));
        group.id = crypto.randomUUID();
        group.updatedAt = now;
        groups.push(group);
      }

      // 가져온 프리셋의 인덱스 병합 (기존 항목 보존)
      const index = await getPresetIndex();
      const indexById = new Map(index.map((p) => [p.id, p]));
      for (const preset of imported.presets) {
        indexById.set(preset.id, {
          id: preset.id,
          name: preset.name,
          urlPattern: preset.urlPattern,
          urlPatterns: getPresetPatterns(preset),
          autoApply: !!preset.autoApply,
          updatedAt: preset.updatedAt
        });
      }
      await savePresetIndex([...indexById.values()]);
      await saveGroups(existingGroups.concat(groups));
      return { importedPresets: imported.presets.length, importedGroups: groups.length };
    }
    default:
      throw new Error('알 수 없는 메시지 타입: ' + msg.type);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 자체 확장(popup/content script)의 메시지만 처리 — 타 확장의 PII 유출/주입 차단 (F1)
  if (!sender || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: '허용되지 않은 발신자입니다.' });
    return;
  }
  handleMessage(msg, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true;
});

async function applyAutoPreset(tabId, url) {
  if (getRecordSession(tabId) || journeyReplayTabId === tabId) return;
  try {
    const index = await getPresetIndex();
    const matching = index.filter((p) => p.autoApply && matchPresetUrl(p, url));
    for (const entry of matching) {
      try {
        const preset = await getPresetById(entry.id);
        if (!preset || isJourneyPreset(preset)) continue;
        const replayPace = await getReplayPace();
        await sendApplyToFrames(tabId, { type: 'APPLY_PRESET', preset, replayPace });
      } catch (e) {
        // 페이지가 아직 스크립트를 로드하지 않았으면 무시
      }
    }
  } catch (e) {
    // 확장 재로드 등 일시적 오류는 무시
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (attachRecordingFromOpener(tab)) persistRecordSessions();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!getRecordSession(tabId)) attachRecordingFromOpener(tab);
  if (changeInfo.url) {
    appendNavigateIfRecording(tabId, changeInfo.url);
  }
  if (changeInfo.status !== 'complete' || !tab.url) return;
  notifyTabComplete(tabId);
  resumeRecordingIfNeeded(tabId);
  applyAutoPreset(tabId, tab.url);
  if (runState && runState.status === 'running' && runState.currentTabId === tabId) {
    handleStepTabLoaded(tabId);
  }
});

// 탭 URL이 안 바뀌고 iframe만 로드/교체되는 사내 어드민: tabs.onUpdated가 안 뜸
if (chrome.webNavigation && chrome.webNavigation.onCompleted && typeof chrome.webNavigation.onCompleted.addListener === 'function') {
  chrome.webNavigation.onCompleted.addListener((details) => {
    if (!details || details.tabId == null) return;
    const session = getRecordSession(details.tabId);
    if (!session) return;
    if (isRestrictedRecordUrl(details.url)) return;
    if (details.frameId !== 0) {
      rememberSessionSite(session, details.url);
      persistRecordSessions();
    }
    resumeRecordingIfNeeded(details.tabId);
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  // 닫힌 탭을 캡처/녹화 추적에서 제거 (좀비 방지, Flow-9)
  captureTabs.delete(tabId);
  deleteRecordSession(tabId);
  persistRecordSessions();
  // 실행 중(running)뿐 아니라 대기(waiting) 중에도 탭이 닫히면 run 실패 처리 (Flow-12)
  if (runState && runState.currentTabId === tabId && (runState.status === 'running' || runState.status === 'waiting')) {
    failRun('실행 중인 탭이 닫혀 그룹 실행이 중단되었습니다.');
  }
});

async function resumeRunAfterRestore() {
  if (!runState || runState.status !== 'running' || !runState.currentTabId) return;
  try {
    const tab = await chrome.tabs.get(runState.currentTabId);
    if (tab.status === 'complete') {
      // 복원 시 이전 세션의 중복 처리 가드를 해제해 재개 가능하게 함 (Flow-13/F9)
      if (runState.currentStep) runState.currentStep.applied = false;
      await handleStepTabLoaded(tab.id);
    }
  } catch (e) {
    failRun('실행 중이던 탭을 찾을 수 없어 그룹 실행이 중단되었습니다.');
  }
}

// 레거시(필드 단위 민감 암호화) 저장 데이터를 프리셋별 전체 암호화로 1회 이전
async function migrateLegacyStorage() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const presets = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
    if (presets.length === 0) return;
    // 이미 인덱스 형식(첫 항목에 fields 없음)이면 스킵
    if (!presets[0] || !Array.isArray(presets[0].fields)) return;

    const index = [];
    const legacySecretsToDelete = [];
    for (const p of presets) {
      if (!p || typeof p.id !== 'string') continue;
      const fields = [];
      for (const f of (Array.isArray(p.fields) ? p.fields : [])) {
        if (f.sensitive) {
          // 레거시 필드별 암호문(sec:<presetId>:<fieldId>) 복호화
          const secret = await getSecret(p.id + ':' + f.id);
          fields.push({ ...f, value: secret ?? '' });
          legacySecretsToDelete.push(p.id + ':' + f.id);
        } else {
          fields.push({ ...f });
        }
      }
      const full = { ...p, fields };
      normalizePresetPatterns(full);
      await setSecret('preset:' + full.id, JSON.stringify(full));
      index.push({
        id: full.id,
        name: full.name,
        urlPattern: full.urlPattern,
        urlPatterns: getPresetPatterns(full),
        autoApply: !!full.autoApply,
        updatedAt: full.updatedAt
      });
    }
    await savePresetIndex(index);

    // 마이그레이션 성공 후에만 레거시 필드별 암호문 정리 (실패 시 레거시 원본 보존, L3)
    if (legacySecretsToDelete.length) {
      await chrome.storage.local.remove(legacySecretsToDelete);
    }

    // 남은 레거시 필드별 암호문(sec:preset: 제외, 두 세그먼트 키) 정리
    const all = await chrome.storage.local.get(null);
    const legacyKeys = Object.keys(all).filter((k) => /^sec:(?!preset:)[^:]+:[^:]+$/.test(k));
    if (legacyKeys.length) await chrome.storage.local.remove(legacyKeys);
  } catch (e) {
    // 실패 시 unhandledRejection 없이 로깅 후 마이그레이션 중단 (레거시 원본 보존, L3)
    console.error('레거시 데이터 마이그레이션 실패:', e);
  }
}

// 키 무결성이 확인된 경우에만 인덱스에만 있고 blob이 없는 항목 정리 (X1)
async function cleanupOrphanIndexEntries() {
  try {
    const keyStatus = await getVaultKeyStatus();
    if (!keyStatus || keyStatus.ok !== true) return; // 키 손상/누락 의심 시 인덱스 보존
    const index = await getPresetIndex();
    if (index.length === 0) return;
    const data = await chrome.storage.local.get(index.map((e) => 'sec:preset:' + e.id));
    const cleaned = index.filter((e) => data['sec:preset:' + e.id] !== undefined);
    if (cleaned.length !== index.length) {
      await savePresetIndex(cleaned);
    }
  } catch (e) {
    console.error('고아 인덱스 정리 실패:', e);
  }
}

// vault 키 손상/누락 감지 — 사용자 경고 (K1/K2/F6)
async function checkVaultKey() {
  try {
    const status = await getVaultKeyStatus();
    if (status && status.ok === false) {
      console.error('[secure-store] ' + status.message);
      try {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '암호화 키 오류',
          message: status.message
        });
      } catch (e) {
        // 알림 권한 미설정 등이면 로그만 남김
      }
    }
  } catch (e) {
    console.error('[secure-store] 키 상태 확인 실패:', e);
  }
}

migrateLegacyStorage()
  .catch((e) => console.error('레거시 데이터 마이그레이션 실패:', e))
  .then(restoreRunState)
  .then(restoreRecordSessions)
  .then(resumeAllRecordChips)
  .then(resumeRunAfterRestore)
  .then(cleanupOrphanIndexEntries);
checkVaultKey();

function validateImportData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('지원되지 않는 파일 형식입니다.');
  }
  if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) {
    throw new Error('지원되지 않는 파일 형식입니다.');
  }
  if (data.schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new Error('새 버전의 파일입니다. 확장 프로그램을 업데이트하세요.');
  }
  if (data.appId != null && data.appId !== 'dasihagi' && data.appId !== 'form-preset-extension') {
    throw new Error('이 확장 프로그램의 백업 파일이 아닙니다.');
  }

  const rawPresets = Array.isArray(data.presets) ? data.presets : [];
  const rawGroups = Array.isArray(data.groups) ? data.groups : [];

  const presets = [];
  for (const p of rawPresets.slice(0, MAX_IMPORT_PRESETS)) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.name !== 'string') continue;
    const hasPattern =
      typeof p.urlPattern === 'string' ||
      (Array.isArray(p.urlPatterns) && p.urlPatterns.some((x) => typeof x === 'string' && x.trim()));
    if (!hasPattern) continue;
    normalizePresetPatterns(p);
    if (!Array.isArray(p.fields)) continue;
    // 프리셋당 필드 수 상한 — 초과 시 해당 프리셋만 드롭 (명시적 처리, F7)
    if (p.fields.length > MAX_FIELDS_PER_PRESET) {
      console.warn('프리셋 "' + p.name + '"의 필드 수가 상한(' + MAX_FIELDS_PER_PRESET + '개)을 초과해 가져오기에서 제외합니다.');
      continue;
    }
    const fieldsValid = p.fields.every(
      (f) => f && typeof f === 'object' && typeof f.label === 'string' && typeof f.selector === 'string' && typeof f.value === 'string' && f.value.length <= MAX_FIELD_VALUE_LENGTH
    );
    if (!fieldsValid) {
      console.warn('프리셋 "' + p.name + '"에 크기 상한(' + MAX_FIELD_VALUE_LENGTH + '자)을 초과하는 필드 값이 있어 가져오기에서 제외합니다.');
      continue;
    }
    presets.push({ ...p });
  }

  const presetIds = new Set(presets.map((p) => p.id).filter(Boolean));

  const groups = [];
  for (const g of rawGroups.slice(0, MAX_IMPORT_GROUPS)) {
    if (!g || typeof g !== 'object') continue;
    if (typeof g.name !== 'string' || !Array.isArray(g.steps)) continue;
    const steps = g.steps.filter(
      (s) => s && typeof s === 'object' && typeof s.presetId === 'string' && presetIds.has(s.presetId)
    );
    if (steps.length === 0) continue;
    groups.push({ ...g, steps: steps.map((s) => ({ ...s })) });
  }

  return { presets, groups };
}