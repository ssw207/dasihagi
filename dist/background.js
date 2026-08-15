const STORAGE_KEY = 'presets';
const captureTabs = new Set();

async function getPresets() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
}

async function savePresets(presets) {
  await chrome.storage.local.set({ [STORAGE_KEY]: presets });
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
      return true;
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
});