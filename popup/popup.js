(() => {
  const $ = (sel) => document.querySelector(sel);
  let currentTabId = null;
  let currentUrl = '';
  let currentHost = '';
  let presets = [];
  let editingPreset = null;

  const listView = $('#list-view');
  const editorView = $('#editor-view');
  const presetList = $('#preset-list');
  const emptyState = $('#empty-state');
  const fieldsList = $('#fields-list');
  const fieldsEmpty = $('#fields-empty');
  const toastEl = $('#toast');
  let toastTimer = null;

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2500);
  }

  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp);
      });
    });
  }

  async function loadContext() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    currentTabId = tab.id;
    currentUrl = tab.url || '';
    try {
      currentHost = new URL(currentUrl).hostname;
    } catch (e) {
      currentHost = currentUrl;
    }
    $('#site-chip').textContent = currentHost || '알 수 없는 사이트';
  }

  async function loadPresets() {
    const resp = await sendMessage({ type: 'PRESET_LIST' });
    presets = resp.ok ? resp.data : [];
    renderList();
  }

  function hostMatchesPattern(pattern) {
    if (!pattern) return false;
    const p = String(pattern).trim().toLowerCase().replace(/^[a-z]+:\/\//, '');
    const hostPart = p.split('/')[0];
    if (hostPart.startsWith('*.')) {
      const base = hostPart.slice(2);
      return currentHost === base || currentHost.endsWith('.' + base);
    }
    return currentHost === hostPart;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderList() {
    presetList.innerHTML = '';
    emptyState.classList.toggle('hidden', presets.length > 0);
    if (presets.length === 0) return;

    for (const preset of presets) {
      const card = document.createElement('div');
      card.className = 'preset-card' + (hostMatchesPattern(preset.urlPattern) ? ' is-matching' : '');

      const badges = [];
      if (hostMatchesPattern(preset.urlPattern)) badges.push('<span class="badge badge-match">현재 사이트</span>');
      if (preset.autoApply) badges.push('<span class="badge badge-auto">자동 적용</span>');

      card.innerHTML =
        '<div class="preset-card-head">' +
        '<span class="preset-name">' + escapeHtml(preset.name) + '</span>' +
        '<div class="preset-badges">' + badges.join('') + '</div>' +
        '</div>' +
        '<div class="preset-meta">' + escapeHtml(preset.urlPattern || '(패턴 없음)') + ' · 필드 ' + preset.fields.length + '개</div>' +
        '<div class="preset-actions">' +
        '<button class="btn btn-primary" data-act="apply" data-id="' + preset.id + '">적용</button>' +
        '<button class="btn" data-act="capture" data-id="' + preset.id + '">캡처</button>' +
        '<button class="btn" data-act="edit" data-id="' + preset.id + '">편집</button>' +
        '<button class="btn" data-act="delete" data-id="' + preset.id + '">삭제</button>' +
        '</div>';

      card.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => handlePresetAction(btn.dataset.act, preset));
      });
      presetList.appendChild(card);
    }
  }

  async function handlePresetAction(act, preset) {
    if (act === 'apply') {
      const resp = await sendMessage({ type: 'APPLY_PRESET', presetId: preset.id, tabId: currentTabId });
      if (!resp.ok) {
        showToast('적용 실패: ' + resp.error);
        return;
      }
      const result = resp.data || {};
      const failed = (result.failures || []).length;
      const applied = (result.applied || []).length;
      showToast('적용 완료: ' + applied + '개, 실패: ' + failed + '개');
    } else if (act === 'capture') {
      const resp = await sendMessage({ type: 'CAPTURE_START', tabId: currentTabId, presetId: preset.id });
      if (!resp.ok) {
        showToast('캡처 실패: ' + resp.error);
        return;
      }
      showToast('캡처 모드 시작! 페이지에서 입력란을 클릭하세요.');
      window.close();
    } else if (act === 'edit') {
      openEditor(preset);
    } else if (act === 'delete') {
      if (!confirm('프리셋 "' + preset.name + '"을(를) 삭제할까요?')) return;
      const resp = await sendMessage({ type: 'PRESET_DELETE', id: preset.id });
      if (!resp.ok) {
        showToast('삭제 실패: ' + resp.error);
        return;
      }
      showToast('삭제되었습니다.');
      await loadPresets();
    }
  }

  function openEditor(preset) {
    editingPreset = preset
      ? JSON.parse(JSON.stringify(preset))
      : {
          id: null,
          name: '',
          urlPattern: currentHost,
          fields: [],
          autoApply: false
        };
    listView.classList.add('hidden');
    editorView.classList.remove('hidden');
    $('#editor-title').textContent = preset ? '프리셋 편집' : '새 프리셋';
    $('#ed-name').value = editingPreset.name;
    $('#ed-pattern').value = editingPreset.urlPattern;
    $('#ed-autoapply').checked = !!editingPreset.autoApply;
    $('#btn-delete-preset').style.display = preset ? '' : 'none';
    $('#btn-capture').disabled = !preset;
    renderFields();
  }

  function renderFields() {
    const fields = editingPreset.fields;
    fieldsList.innerHTML = '';
    fieldsEmpty.classList.toggle('hidden', fields.length > 0);
    $('#field-count').textContent = fields.length;
    fields.forEach((field, idx) => {
      const item = document.createElement('div');
      item.className = 'field-item';
      const isBoolean = field.type === 'checkbox' || field.type === 'radio';
      item.innerHTML =
        '<div class="field-item-top">' +
        '<span class="field-label">' + escapeHtml(field.label) + '</span>' +
        '<span class="field-type">' + field.type + '</span>' +
        '</div>' +
        '<div class="field-selector">' + escapeHtml(field.selector) + '</div>' +
        '<div class="field-value-row">' +
        (isBoolean
          ? '<input type="text" value="' + (field.value === 'true' ? '체크됨' : '체크 안 됨') + '" disabled>'
          : '<input type="text" data-idx="' + idx + '" value="' + escapeHtml(field.value) + '" data-value-edit>') +
        '<button class="field-del" data-del="' + idx + '" title="삭제">✕</button>' +
        '</div>';
      item.querySelector('[data-del]').addEventListener('click', () => {
        editingPreset.fields.splice(idx, 1);
        renderFields();
      });
      fieldsList.appendChild(item);
    });
  }

  fieldsList.addEventListener('input', (e) => {
    if (!e.target.dataset.valueEdit) return;
    const idx = Number(e.target.dataset.idx);
    if (Number.isInteger(idx) && editingPreset.fields[idx]) {
      editingPreset.fields[idx].value = e.target.value;
    }
  });

  $('#btn-new-preset').addEventListener('click', () => openEditor(null));
  $('#btn-refresh').addEventListener('click', loadPresets);

  function backToList() {
    editorView.classList.add('hidden');
    listView.classList.remove('hidden');
    loadPresets();
  }

  $('#btn-back').addEventListener('click', backToList);
  $('#btn-cancel-editor').addEventListener('click', backToList);

  $('#btn-save-preset').addEventListener('click', async () => {
    const name = $('#ed-name').value.trim();
    const pattern = $('#ed-pattern').value.trim();
    if (!name) {
      showToast('프리셋 이름을 입력해주세요.');
      return;
    }
    if (!pattern) {
      showToast('사이트 패턴을 입력해주세요.');
      return;
    }
    editingPreset.name = name;
    editingPreset.urlPattern = pattern;
    editingPreset.autoApply = $('#ed-autoapply').checked;

    let resp;
    if (editingPreset.id) {
      resp = await sendMessage({ type: 'PRESET_UPDATE', preset: editingPreset });
    } else {
      resp = await sendMessage({
        type: 'PRESET_CREATE',
        name,
        urlPattern: pattern,
        autoApply: editingPreset.autoApply
      });
      if (resp.ok) {
        editingPreset = resp.data;
        editingPreset.fields = editingPreset.fields || [];
      }
    }
    if (!resp.ok) {
      showToast('저장 실패: ' + resp.error);
      return;
    }
    showToast('저장되었습니다.');
    renderFields();
    $('#btn-capture').disabled = false;
  });

  $('#btn-delete-preset').addEventListener('click', async () => {
    if (!editingPreset || !editingPreset.id) return;
    if (!confirm('이 프리셋을 삭제할까요?')) return;
    const resp = await sendMessage({ type: 'PRESET_DELETE', id: editingPreset.id });
    if (!resp.ok) {
      showToast('삭제 실패: ' + resp.error);
      return;
    }
    showToast('삭제되었습니다.');
    backToList();
  });

  $('#btn-capture').addEventListener('click', async () => {
    if (!editingPreset || !editingPreset.id) return;
    const resp = await sendMessage({ type: 'CAPTURE_START', tabId: currentTabId, presetId: editingPreset.id });
    if (!resp.ok) {
      showToast('캡처 실패: ' + resp.error);
      return;
    }
    showToast('캡처 모드 시작! 페이지에서 입력란을 클릭하세요.');
    window.close();
  });

  async function init() {
    await loadContext();
    await loadPresets();
  }

  init();
})();