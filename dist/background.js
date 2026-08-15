const STORAGE_KEY = 'presets';
const GROUPS_KEY = 'groups';
const RUN_KEY = 'runState';
const EXPORT_SCHEMA_VERSION = 1;
const MAX_IMPORT_PRESETS = 500;
const MAX_IMPORT_GROUPS = 100;
const captureTabs = new Set();

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

async function getPresets() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function savePresets(presets) {
  await chrome.storage.local.set({ [STORAGE_KEY]: presets });
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

  let hostMatched;
  if (hostPat.startsWith('*.')) {
    const base = hostPat.slice(2);
    hostMatched = host === base || host.endsWith('.' + base);
  } else {
    hostMatched = host === hostPat;
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
  const presets = await getPresets();
  const preset = presets.find((p) => p.id === step.presetId);
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
      return getPresets();
    }
    case 'PRESET_CREATE': {
      const presets = await getPresets();
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
      presets.push(preset);
      await savePresets(presets);
      return preset;
    }
    case 'PRESET_UPDATE': {
      const presets = await getPresets();
      const idx = presets.findIndex((p) => p.id === msg.preset.id);
      if (idx === -1) throw new Error('프리셋을 찾을 수 없습니다.');
      const updated = { ...msg.preset, updatedAt: Date.now() };
      presets[idx] = updated;
      await savePresets(presets);
      return updated;
    }
    case 'PRESET_DELETE': {
      const presets = await getPresets();
      const next = presets.filter((p) => p.id !== msg.id);
      await savePresets(next);
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
      const presets = await getPresets();
      const preset = presets.find((p) => p.id === msg.presetId);
      if (!preset) throw new Error('프리셋을 찾을 수 없습니다.');
      const fieldIdx = preset.fields.findIndex((f) => f.selector === msg.field.selector);
      if (fieldIdx === -1) {
        preset.fields.push(msg.field);
      } else {
        preset.fields[fieldIdx] = msg.field;
      }
      preset.updatedAt = Date.now();
      await savePresets(presets);
      return preset;
    }
    case 'APPLY_PRESET': {
      const presets = await getPresets();
      const preset = presets.find((p) => p.id === msg.presetId);
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
      const presets = await getPresets();
      return presets.filter((p) => p.autoApply && matchUrlPattern(p.urlPattern, msg.url));
    }
    case 'GET_CURRENT_URL': {
      const tab = await chrome.tabs.get(msg.tabId);
      return tab.url || '';
    }
    case 'EXPORT_DATA': {
      return {
        presets: await getPresets(),
        groups: await getGroups()
      };
    }
    case 'IMPORT_DATA': {
      const imported = validateImportData(msg.data);
      const existingPresets = await getPresets();
      const existingGroups = await getGroups();

      const idMap = new Map();
      const now = Date.now();
      for (const preset of imported.presets) {
        const oldId = preset.id;
        preset.id = crypto.randomUUID();
        if (oldId) idMap.set(oldId, preset.id);
        preset.createdAt = preset.createdAt || now;
        preset.updatedAt = now;
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

      await savePresets(existingPresets.concat(imported.presets));
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
    const presets = await getPresets();
    const matching = presets.filter((p) => p.autoApply && matchUrlPattern(p.urlPattern, url));
    for (const preset of matching) {
      try {
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

restoreRunState().then(resumeRunAfterRestore);

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