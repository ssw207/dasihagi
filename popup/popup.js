(() => {
  const $ = (sel) => document.querySelector(sel);
  let currentTabId = null;
  let currentUrl = '';
  let currentHost = '';
  let presets = [];
  let groups = [];
  let editingPreset = null;
  let editingGroup = null;
  let activeTab = 'presets';

  const listView = $('#presets-view');
  const editorView = $('#preset-editor-view');
  const groupsView = $('#groups-view');
  const groupEditorView = $('#group-editor-view');
  const presetList = $('#preset-list');
  const emptyState = $('#empty-state');
  const groupList = $('#group-list');
  const groupsEmpty = $('#groups-empty');
  const fieldsList = $('#fields-list');
  const fieldsEmpty = $('#fields-empty');
  const stepsList = $('#steps-list');
  const stepsEmpty = $('#steps-empty');
  const runStatusWrap = $('#run-status-wrap');
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

  async function loadGroups() {
    const resp = await sendMessage({ type: 'GROUP_LIST' });
    groups = resp.ok ? resp.data : [];
    renderGroupList();
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

  function switchTab(tab) {
    activeTab = tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    listView.classList.toggle('hidden', tab !== 'presets');
    groupsView.classList.toggle('hidden', tab !== 'groups');
    editorView.classList.add('hidden');
    groupEditorView.classList.add('hidden');
    if (tab === 'groups') loadGroups();
    refreshRunStatus();
  }

  $('#tab-presets').addEventListener('click', () => switchTab('presets'));
  $('#tab-groups').addEventListener('click', () => switchTab('groups'));

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

  function renderGroupList() {
    groupList.innerHTML = '';
    groupsEmpty.classList.toggle('hidden', groups.length > 0);
    if (groups.length === 0) return;

    for (const group of groups) {
      const card = document.createElement('div');
      card.className = 'preset-card';

      card.innerHTML =
        '<div class="preset-card-head">' +
        '<span class="preset-name">' + escapeHtml(group.name) + '</span>' +
        '<div class="preset-badges"><span class="badge badge-group">' + group.steps.length + '스텝</span></div>' +
        '</div>' +
        '<div class="preset-meta">' +
        group.steps
          .map((s) => {
            const p = presets.find((pp) => pp.id === s.presetId);
            return escapeHtml(p ? p.name : '(삭제된 프리셋)') + (s.submitMode === 'auto' ? ' [자동 제출]' : ' [수동]');
          })
          .join(' → ') +
        '</div>' +
        '<div class="preset-actions">' +
        '<button class="btn btn-primary" data-act="run" data-id="' + group.id + '">실행</button>' +
        '<button class="btn" data-act="gedit" data-id="' + group.id + '">편집</button>' +
        '<button class="btn" data-act="gdelete" data-id="' + group.id + '">삭제</button>' +
        '</div>';

      card.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => handleGroupAction(btn.dataset.act, group));
      });
      groupList.appendChild(card);
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

  async function handleGroupAction(act, group) {
    if (act === 'run') {
      const resp = await sendMessage({ type: 'RUN_GROUP', groupId: group.id });
      if (!resp.ok) {
        showToast('실행 실패: ' + resp.error);
        return;
      }
      showToast('그룹 실행 시작!');
      window.close();
    } else if (act === 'gedit') {
      openGroupEditor(group);
    } else if (act === 'gdelete') {
      if (!confirm('그룹 "' + group.name + '"을(를) 삭제할까요?')) return;
      const resp = await sendMessage({ type: 'GROUP_DELETE', id: group.id });
      if (!resp.ok) {
        showToast('삭제 실패: ' + resp.error);
        return;
      }
      showToast('삭제되었습니다.');
      await loadGroups();
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
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'presets'));
    activeTab = 'presets';
    listView.classList.add('hidden');
    groupsView.classList.add('hidden');
    editorView.classList.remove('hidden');
    groupEditorView.classList.add('hidden');
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
      const isSensitive = !!field.sensitive;
      item.innerHTML =
        '<div class="field-item-top">' +
        '<span class="field-label">' + escapeHtml(field.label) + '</span>' +
        '<span class="field-type">' + field.type + '</span>' +
        '</div>' +
        '<div class="field-selector">' + escapeHtml(field.selector) + '</div>' +
        '<div class="field-value-row">' +
        (isBoolean
          ? '<input type="text" value="' + (field.value === 'true' ? '체크됨' : '체크 안 됨') + '" disabled>'
          : '<input type="' + (isSensitive ? 'password' : 'text') + '" data-idx="' + idx + '" value="' + escapeHtml(field.value) + '" data-value-edit>') +
        '<label class="field-sensitive"><input type="checkbox" data-sensitive="' + idx + '"' + (isSensitive ? ' checked' : '') + '>민감</label>' +
        '<button class="field-del" data-del="' + idx + '" title="삭제">✕</button>' +
        '</div>';
      item.querySelector('[data-del]').addEventListener('click', () => {
        editingPreset.fields.splice(idx, 1);
        renderFields();
      });
      const sensitiveCheck = item.querySelector('[data-sensitive]');
      if (sensitiveCheck) {
        sensitiveCheck.addEventListener('change', (e) => {
          editingPreset.fields[idx].sensitive = e.target.checked;
          const input = item.querySelector('[data-value-edit]');
          if (input) input.type = e.target.checked ? 'password' : 'text';
        });
      }
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

  function renderPresetOptions() {
    const sel = $('#ge-preset-select');
    sel.innerHTML = '';
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + ' (' + p.urlPattern + ')';
      sel.appendChild(opt);
    }
    $('#btn-add-step').disabled = presets.length === 0;
  }

  function openGroupEditor(group) {
    editingGroup = group
      ? JSON.parse(JSON.stringify(group))
      : {
          id: null,
          name: '',
          steps: []
        };
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === 'groups'));
    activeTab = 'groups';
    listView.classList.add('hidden');
    groupsView.classList.add('hidden');
    groupEditorView.classList.remove('hidden');
    editorView.classList.add('hidden');
    $('#group-editor-title').textContent = group ? '그룹 편집' : '새 그룹';
    $('#ge-name').value = editingGroup.name;
    $('#btn-delete-group').style.display = group ? '' : 'none';
    renderPresetOptions();
    renderSteps();
  }

  function renderSteps() {
    stepsList.innerHTML = '';
    stepsEmpty.classList.toggle('hidden', editingGroup.steps.length > 0);
    $('#step-count').textContent = editingGroup.steps.length;
    editingGroup.steps.forEach((step, idx) => {
      const preset = presets.find((p) => p.id === step.presetId);
      const item = document.createElement('div');
      item.className = 'step-item';
      item.innerHTML =
        '<div class="step-item-head">' +
        '<span class="step-num">' + (idx + 1) + '</span>' +
        '<span class="step-preset-name">' + escapeHtml(preset ? preset.name : '(삭제된 프리셋)') + '</span>' +
        '<span class="step-mode">' + (step.submitMode === 'auto' ? '자동 제출' : '수동') + '</span>' +
        '</div>' +
        '<div class="step-controls">' +
        '<select class="step-mode-select" data-idx="' + idx + '">' +
        '<option value="manual"' + (step.submitMode !== 'auto' ? ' selected' : '') + '>수동 (직접 제출)</option>' +
        '<option value="auto"' + (step.submitMode === 'auto' ? ' selected' : '') + '>자동 제출</option>' +
        '</select>' +
        '<input type="text" class="step-selector-input" data-idx="' + idx + '" placeholder="제출 버튼 셀렉터" value="' + escapeHtml(step.submitSelector || '') + '"' + (step.submitMode !== 'auto' ? ' disabled' : '') + '>' +
        '<button class="field-del" data-move-up="' + idx + '" title="위로">↑</button>' +
        '<button class="field-del" data-move-down="' + idx + '" title="아래로">↓</button>' +
        '<button class="field-del" data-step-del="' + idx + '" title="삭제">✕</button>' +
        '</div>';

      item.querySelector('.step-mode-select').addEventListener('change', (e) => {
        editingGroup.steps[idx].submitMode = e.target.value;
        const input = item.querySelector('.step-selector-input');
        input.disabled = e.target.value !== 'auto';
        if (e.target.value !== 'auto') editingGroup.steps[idx].submitSelector = '';
      });
      item.querySelector('.step-selector-input').addEventListener('input', (e) => {
        editingGroup.steps[idx].submitSelector = e.target.value;
      });
      item.querySelector('[data-step-del]').addEventListener('click', () => {
        editingGroup.steps.splice(idx, 1);
        renderSteps();
      });
      item.querySelector('[data-move-up]').addEventListener('click', () => {
        if (idx === 0) return;
        const [s] = editingGroup.steps.splice(idx, 1);
        editingGroup.steps.splice(idx - 1, 0, s);
        renderSteps();
      });
      item.querySelector('[data-move-down]').addEventListener('click', () => {
        if (idx >= editingGroup.steps.length - 1) return;
        const [s] = editingGroup.steps.splice(idx, 1);
        editingGroup.steps.splice(idx + 1, 0, s);
        renderSteps();
      });
      stepsList.appendChild(item);
    });
  }

  $('#btn-add-step').addEventListener('click', () => {
    const presetId = $('#ge-preset-select').value;
    if (!presetId) {
      showToast('프리셋이 없습니다. 먼저 프리셋을 만들어주세요.');
      return;
    }
    editingGroup.steps.push({ presetId, submitMode: 'manual', submitSelector: '' });
    renderSteps();
  });

  $('#btn-new-preset').addEventListener('click', () => openEditor(null));
  $('#btn-refresh').addEventListener('click', loadPresets);
  $('#btn-new-group').addEventListener('click', () => openGroupEditor(null));
  $('#btn-refresh-groups').addEventListener('click', async () => {
    await loadGroups();
    refreshRunStatus();
  });

  $('#btn-export').addEventListener('click', async () => {
    const resp = await sendMessage({ type: 'EXPORT_DATA' });
    if (!resp.ok) {
      showToast('내보내기 실패: ' + resp.error);
      return;
    }
    const data = resp.data || {};
    const presets = Array.isArray(data.presets) ? data.presets : [];
    const groups = Array.isArray(data.groups) ? data.groups : [];
    if (presets.length === 0 && groups.length === 0) {
      showToast('내보낼 데이터가 없습니다.');
      return;
    }

    const payload = {
      schemaVersion: 1,
      appId: 'form-preset-extension',
      exportedAt: new Date().toISOString(),
      presets,
      groups
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'presets-' + dateStr + '.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('내보내기 완료: 프리셋 ' + presets.length + '개, 그룹 ' + groups.length + '개');
  });

  $('#btn-import').addEventListener('click', () => {
    $('#import-file').click();
  });

  $('#import-file').addEventListener('change', async (e) => {
    const input = e.target;
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) {
        showToast('파일이 너무 큽니다.');
        return;
      }
      const text = await file.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        showToast('파일을 읽을 수 없습니다. 올바른 JSON 파일인지 확인하세요.');
        return;
      }
      const presetCount = Array.isArray(data.presets) ? data.presets.length : 0;
      const groupCount = Array.isArray(data.groups) ? data.groups.length : 0;
      const msg = '프리셋 ' + presetCount + '개, 그룹 ' + groupCount + '개를 가져옵니다. ' +
        '기존 항목은 유지되고 새 항목으로 추가됩니다. 계속할까요?';
      if (!confirm(msg)) return;

      const resp = await sendMessage({ type: 'IMPORT_DATA', data });
      if (!resp.ok) {
        showToast('가져오기 실패: ' + resp.error);
        return;
      }
      const result = resp.data || {};
      showToast(
        '가져오기 완료: 프리셋 ' + (result.importedPresets || 0) + '개, 그룹 ' + (result.importedGroups || 0) + '개'
      );
      await loadPresets();
      await loadGroups();
    } finally {
      input.value = '';
    }
  });

  function backToList() {
    editorView.classList.add('hidden');
    listView.classList.remove('hidden');
    loadPresets();
  }

  $('#btn-back').addEventListener('click', backToList);
  $('#btn-cancel-editor').addEventListener('click', backToList);

  function groupBackToList() {
    groupEditorView.classList.add('hidden');
    groupsView.classList.remove('hidden');
    loadGroups();
  }

  $('#btn-group-back').addEventListener('click', groupBackToList);
  $('#btn-group-cancel').addEventListener('click', groupBackToList);

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

  $('#btn-save-group').addEventListener('click', async () => {
    const name = $('#ge-name').value.trim();
    if (!name) {
      showToast('그룹 이름을 입력해주세요.');
      return;
    }
    editingGroup.name = name;

    let resp;
    if (editingGroup.id) {
      resp = await sendMessage({ type: 'GROUP_UPDATE', group: editingGroup });
    } else {
      resp = await sendMessage({ type: 'GROUP_CREATE', name, steps: editingGroup.steps });
      if (resp.ok) editingGroup = resp.data;
    }
    if (!resp.ok) {
      showToast('저장 실패: ' + resp.error);
      return;
    }
    showToast('저장되었습니다.');
    groupBackToList();
  });

  $('#btn-delete-group').addEventListener('click', async () => {
    if (!editingGroup || !editingGroup.id) return;
    if (!confirm('이 그룹을 삭제할까요?')) return;
    const resp = await sendMessage({ type: 'GROUP_DELETE', id: editingGroup.id });
    if (!resp.ok) {
      showToast('삭제 실패: ' + resp.error);
      return;
    }
    showToast('삭제되었습니다.');
    groupBackToList();
  });

  async function refreshRunStatus() {
    const resp = await sendMessage({ type: 'RUN_STATUS' });
    const run = resp.ok ? resp.data : null;
    if (!run) {
      runStatusWrap.classList.add('hidden');
      runStatusWrap.innerHTML = '';
      return;
    }
    runStatusWrap.classList.remove('hidden');
    runStatusWrap.innerHTML = '';

    const card = document.createElement('div');
    card.className = 'run-card run-' + run.status;
    const stepNames = (run.stepResults || [])
      .map((r) => {
        const label = '스텝 ' + (r.stepIdx + 1);
        if (r.failed > 0) return label + ' (실패 ' + r.failed + ')';
        return label + ' (완료)';
      })
      .join(', ');

    let statusText = '';
    if (run.status === 'running') statusText = '실행 중';
    else if (run.status === 'waiting') statusText = '제출 대기 중 — 페이지에서 직접 제출한 뒤 "다음 단계"를 누르세요.';
    else if (run.status === 'done') statusText = '완료!';
    else if (run.status === 'failed') statusText = '실패: ' + (run.error || '알 수 없는 오류');
    else if (run.status === 'aborted') statusText = '중지됨';

    const badgeText = run.status === 'done' ? run.totalSteps + '/' + run.totalSteps : (run.stepIdx + 1) + '/' + run.totalSteps;
    card.innerHTML =
      '<div class="run-card-head">' +
      '<span class="run-title">' + escapeHtml(run.groupName) + '</span>' +
      '<span class="badge badge-run">' + badgeText + '</span>' +
      '</div>' +
      '<div class="run-status">' + escapeHtml(statusText) + '</div>' +
      (stepNames ? '<div class="run-steps">' + escapeHtml(stepNames) + '</div>' : '') +
      '<div class="preset-actions">' +
      (run.status === 'waiting'
        ? '<button class="btn btn-primary" data-run-act="next">다음 단계</button>'
        : '') +
      (run.status === 'running' || run.status === 'waiting'
        ? '<button class="btn btn-danger" data-run-act="abort">중지</button>'
        : '<button class="btn" data-run-act="dismiss">닫기</button>') +
      '</div>';

    card.querySelectorAll('[data-run-act]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const act = e.target.dataset.runAct;
        if (act === 'next') {
          const r = await sendMessage({ type: 'RUN_NEXT' });
          if (!r.ok) showToast('진행 실패: ' + r.error);
          await refreshRunStatus();
          await loadGroups();
        } else if (act === 'abort') {
          const r = await sendMessage({ type: 'RUN_ABORT' });
          if (!r.ok) showToast('중지 실패: ' + r.error);
          await refreshRunStatus();
          await loadGroups();
        } else if (act === 'dismiss') {
          runStatusWrap.classList.add('hidden');
          runStatusWrap.innerHTML = '';
        }
      });
    });
    runStatusWrap.appendChild(card);
  }

  async function init() {
    await loadContext();
    await Promise.all([loadPresets(), loadGroups()]);
    await refreshRunStatus();
  }

  init();
})();