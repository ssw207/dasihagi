import { setSecret, getSecret, deleteSecret } from './secure-store.js';

const STORAGE_KEY = 'presets';
const GROUPS_KEY = 'groups';
const RUN_KEY = 'runState';
const EXPORT_SCHEMA_VERSION = 1;
const MAX_IMPORT_PRESETS = 500;
const MAX_IMPORT_GROUPS = 100;
const captureTabs = new Set();
const recordTabs = new Set();

let runState = null;

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
    return JSON.parse(raw);
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
  const index = await getPresetIndex();
  const idx = index.findIndex((p) => p.id === preset.id);
  const entry = {
    id: preset.id,
    name: preset.name,
    urlPattern: preset.urlPattern,
    autoApply: !!preset.autoApply,
    updatedAt: preset.updatedAt || Date.now()
  };
  if (idx === -1) index.push(entry);
  else index[idx] = entry;
  await savePresetIndex(index);
}

async function deletePreset(id) {
  await deleteSecret('preset:' + id);
  const index = await getPresetIndex();
  await savePresetIndex(index.filter((p) => p.id !== id));
}

async function getGroups() {
  const data = await chrome.storage.local.get(GROUPS_KEY);
  return Array.isArray(data[GROUPS_KEY]) ? data[GROUPS_KEY] : [];
}

async function saveGroups(groups) {
  await chrome.storage.local.set({ [GROUPS_KEY]: groups });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  // 패턴에 포트(:port)가 포함되면 url.hostname(포트 없음)과 비교가 무력화됨 — 브라우저 E2E에서 발견.
  // 포트를 추출해 별도 비교 (패턴에 포트가 있으면 포트도 일치해야 매칭, 없으면 모든 포트 허용)
  let patPort = '';
  const portMatch = hostPat.match(/:(\d+)$/);
  if (portMatch) {
    patPort = portMatch[1];
    hostPat = hostPat.slice(0, portMatch.index);
  }
  hostPat = hostPat.replace(/\[([^\]]+)\].*/, '$1');
  const portOk = patPort === '' || patPort === url.port;
  let hostMatched;
  if (hostPat.startsWith('*.')) {
    const base = hostPat.slice(2);
    hostMatched = (host === base || host.endsWith('.' + base)) && portOk;
  } else {
    hostMatched = host === hostPat && portOk;
  }
  if (!hostMatched) return false;

  if (pathPat === '' || pathPat === '/' || pathPat === '/*') return true;
  if (pathPat.includes('*')) {
    const re = new RegExp('^' + pathPat.split('*').map(escapeRegExp).join('.*') + '$');
    return re.test(path);
  }
  return path === pathPat;
}

function patternToUrl(pattern) {
  let p = String(pattern || '').trim();
  if (!p) return null;
  if (!/^[a-z]+:\/\//i.test(p)) p = 'https://' + p;
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
    preset: preset,
    submitMode: step.submitMode || 'manual',
    submitSelector: step.submitSelector || ''
  };
  runState.status = 'running';
  updateRunBadge();
  await persistRunState();
}

async function handleStepTabLoaded(tabId) {
  if (!runState || runState.status !== 'running') return;
  if (runState.currentTabId !== tabId || !runState.currentStep) return;

  const stepInfo = runState.currentStep;
  const preset = stepInfo.preset;

  let applyResult = { applied: [], failures: [] };
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'APPLY_PRESET', preset });
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
      const submitResp = await chrome.tabs.sendMessage(tabId, {
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
  if (runState && (runState.status === 'running' || runState.status === 'waiting')) {
    throw new Error('이미 실행 중인 그룹이 있습니다. 먼저 중지해주세요.');
  }
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
}

async function nextStep() {
  if (!runState || runState.status !== 'waiting') {
    throw new Error('대기 중인 스텝이 없습니다.');
  }
  runState.stepIdx++;
  await startCurrentStep();
  await persistRunState();
  return sanitizeRunState();
}

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'PRESET_LIST': {
      return getAllPresets();
    }
    case 'PRESET_CREATE': {
      const now = Date.now();
      const preset = {
        id: crypto.randomUUID(),
        name: msg.name || '새 프리셋',
        urlPattern: msg.urlPattern || '',
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
      await deletePreset(msg.id);
      const groups = await getGroups();
      let changed = false;
      for (const g of groups) {
        const before = g.steps.length;
        g.steps = g.steps.filter((s) => s.presetId !== msg.id);
        if (g.steps.length !== before) changed = true;
      }
      if (changed) await saveGroups(groups);
      return true;
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
      try {
        await chrome.tabs.sendMessage(msg.tabId, { type: 'CAPTURE_START', presetId: msg.presetId });
      } catch (e) {
        throw new Error('페이지에서 캡처 모드를 시작할 수 없습니다. 지원되지 않는 페이지(예: chrome://)입니다.');
      }
      return true;
    }
    case 'CAPTURE_STOP': {
      captureTabs.delete(msg.tabId);
      try {
        await chrome.tabs.sendMessage(msg.tabId, { type: 'CAPTURE_STOP' });
      } catch (e) {
        // 페이지가 닫혔거나 스크립트가 없으면 무시
      }
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
      recordTabs.add(msg.tabId);
      try {
        await chrome.tabs.sendMessage(msg.tabId, { type: 'RECORD_START', presetId: msg.presetId });
      } catch (e) {
        throw new Error('페이지에서 녹화를 시작할 수 없습니다. 지원되지 않는 페이지(예: chrome://)입니다.');
      }
      return true;
    }
    case 'RECORD_STOP': {
      recordTabs.delete(msg.tabId);
      try {
        await chrome.tabs.sendMessage(msg.tabId, { type: 'RECORD_STOP' });
      } catch (e) {
        // 페이지가 닫혔거나 스크립트가 없으면 무시
      }
      return true;
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
      if (!matchUrlPattern(preset.urlPattern, tab.url)) {
        throw new Error('현재 페이지가 프리셋 대상 사이트가 아닙니다.');
      }
      const resp = await chrome.tabs.sendMessage(msg.tabId, { type: 'APPLY_PRESET', preset });
      return resp && resp.result;
    }
    case 'AUTO_APPLY_CHECK': {
      const index = await getPresetIndex();
      const matching = index.filter((p) => p.autoApply && matchUrlPattern(p.urlPattern, msg.url));
      const result = [];
      for (const entry of matching) {
        const preset = await getPresetById(entry.id);
        if (preset) result.push(preset);
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
  handleMessage(msg, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
  return true;
});

async function applyAutoPreset(tabId, url) {
  try {
    const index = await getPresetIndex();
    const matching = index.filter((p) => p.autoApply && matchUrlPattern(p.urlPattern, url));
    for (const entry of matching) {
      try {
        const preset = await getPresetById(entry.id);
        if (!preset) continue;
        await chrome.tabs.sendMessage(tabId, { type: 'APPLY_PRESET', preset });
      } catch (e) {
        // 페이지가 아직 스크립트를 로드하지 않았으면 무시
      }
    }
  } catch (e) {
    // 확장 재로드 등 일시적 오류는 무시
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  applyAutoPreset(tabId, tab.url);
  if (runState && runState.status === 'running' && runState.currentTabId === tabId) {
    handleStepTabLoaded(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (runState && runState.status === 'running' && runState.currentTabId === tabId) {
    failRun('실행 중인 탭이 닫혀 그룹 실행이 중단되었습니다.');
  }
});

async function resumeRunAfterRestore() {
  if (!runState || runState.status !== 'running' || !runState.currentTabId) return;
  try {
    const tab = await chrome.tabs.get(runState.currentTabId);
    if (tab.status === 'complete') {
      await handleStepTabLoaded(tab.id);
    }
  } catch (e) {
    failRun('실행 중이던 탭을 찾을 수 없어 그룹 실행이 중단되었습니다.');
  }
}

// 레거시(필드 단위 민감 암호화) 저장 데이터를 프리셋별 전체 암호화로 1회 이전
async function migrateLegacyStorage() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const presets = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  if (presets.length === 0) return;
  // 이미 인덱스 형식(첫 항목에 fields 없음)이면 스킵
  if (!presets[0] || !Array.isArray(presets[0].fields)) return;

  const index = [];
  for (const p of presets) {
    if (!p || typeof p.id !== 'string') continue;
    const fields = [];
    for (const f of (Array.isArray(p.fields) ? p.fields : [])) {
      if (f.sensitive) {
        // 레거시 필드별 암호문(sec:<presetId>:<fieldId>) 복호화 후 정리
        const secret = await getSecret(p.id + ':' + f.id);
        fields.push({ ...f, value: secret ?? '' });
        await deleteSecret(p.id + ':' + f.id);
      } else {
        fields.push({ ...f });
      }
    }
    const full = { ...p, fields };
    await setSecret('preset:' + full.id, JSON.stringify(full));
    index.push({
      id: full.id,
      name: full.name,
      urlPattern: full.urlPattern,
      autoApply: !!full.autoApply,
      updatedAt: full.updatedAt
    });
  }
  await savePresetIndex(index);

  // 남은 레거시 필드별 암호문(sec:preset: 제외, 두 세그먼트 키) 정리
  const all = await chrome.storage.local.get(null);
  const legacyKeys = Object.keys(all).filter((k) => /^sec:(?!preset:)[^:]+:[^:]+$/.test(k));
  if (legacyKeys.length) await chrome.storage.local.remove(legacyKeys);
}

migrateLegacyStorage()
  .then(restoreRunState)
  .then(resumeRunAfterRestore);

function validateImportData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('지원되지 않는 파일 형식입니다.');
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion < 1) {
    throw new Error('지원되지 않는 파일 형식입니다.');
  }
  if (data.schemaVersion > EXPORT_SCHEMA_VERSION) {
    throw new Error('새 버전의 파일입니다. 확장 프로그램을 업데이트하세요.');
  }

  const rawPresets = Array.isArray(data.presets) ? data.presets : [];
  const rawGroups = Array.isArray(data.groups) ? data.groups : [];

  const presets = [];
  for (const p of rawPresets.slice(0, MAX_IMPORT_PRESETS)) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.name !== 'string' || typeof p.urlPattern !== 'string') continue;
    if (!Array.isArray(p.fields)) continue;
    const fieldsValid = p.fields.every(
      (f) => f && typeof f === 'object' && typeof f.label === 'string' && typeof f.selector === 'string' && typeof f.value === 'string'
    );
    if (!fieldsValid) continue;
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