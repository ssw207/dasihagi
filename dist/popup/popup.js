(() => {
  const $ = (sel) => document.querySelector(sel);
  let currentTabId = null;
  let currentUrl = '';
  let currentHost = '';
  let currentPort = '';
  let presets = [];
  let groups = [];
  let editingPreset = null;
  let editingGroup = null;
  let activeTab = 'presets';
  const selectedPresetIds = new Set();
  const FILTER_KEY = 'ui:filterCurrentSite';
  let filterCurrentSite = true;

  const listView = $('#presets-view');
  const editorView = $('#preset-editor-view');
  const groupsView = $('#groups-view');
  const groupEditorView = $('#group-editor-view');
  const presetList = $('#preset-list');
  const emptyState = $('#empty-state');
  const emptyFilter = $('#empty-filter');
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

  async function copyToClipboard(text, isSensitive) {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (e) {
      ok = false;
    }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (e) {
        ok = false;
      }
    }
    if (ok) {
      showToast(isSensitive ? '민감 값이 복사되었습니다.' : '복사되었습니다.');
      if (isSensitive) {
        // 민감 값은 30초 후 클립보드에서 제거 (잔류 방지, best-effort)
        setTimeout(() => {
          try {
            if (navigator.clipboard && window.isSecureContext) {
              navigator.clipboard.writeText('').catch(() => {
                // 클립보드 클리어 실패는 무시 — 보안 강화 목적의 best-effort 동작
              });
            }
          } catch (e) {
            // 클립보드 API 미지원 등으로 실패해도 무시
          }
        }, 30000);
      }
    } else {
      showToast('복사 실패: 클립보드 접근이 차단되었습니다.');
    }
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
      const u = new URL(currentUrl);
      currentHost = u.hostname;
      currentPort = u.port;
    } catch (e) {
      currentHost = currentUrl;
      currentPort = '';
    }
    $('#site-chip').textContent = currentHost || '알 수 없는 사이트';
    const blocked = isRestrictedPage();
    ['#btn-record-site', '#btn-record-site-empty', '#btn-record-site-filter'].forEach((sel) => {
      const el = $(sel);
      if (el) el.disabled = blocked;
    });
  }

  function isRestrictedPage() {
    return /^(chrome|chrome-extension|edge|about|devtools|moz-extension):/i.test(currentUrl || '');
  }

  function visiblePresets() {
    if (!filterCurrentSite) return presets.slice();
    return presets.filter((p) => presetMatchesCurrent(p));
  }

  async function loadFilterPref() {
    try {
      const data = await chrome.storage.local.get(FILTER_KEY);
      if (typeof data[FILTER_KEY] === 'boolean') filterCurrentSite = data[FILTER_KEY];
    } catch (e) {
      filterCurrentSite = true;
    }
    const chk = $('#chk-filter-site');
    if (chk) chk.checked = filterCurrentSite;
  }

  function paintPaceButtons(pace) {
    document.querySelectorAll('.pace-btn').forEach((btn) => {
      btn.classList.toggle('is-on', btn.dataset.pace === pace);
    });
  }

  async function loadReplayPace() {
    const resp = await sendMessage({ type: 'SETTINGS_GET' });
    const pace = resp.ok && resp.data ? resp.data.replayPace : 'normal';
    paintPaceButtons(pace === 'fast' || pace === 'slow' ? pace : 'normal');
  }

  async function refreshRecordBanner() {
    const banner = $('#record-banner');
    if (!banner) return;
    const resp = await sendMessage({ type: 'RECORD_STATUS', tabId: currentTabId });
    const data = resp && resp.ok ? resp.data : null;
    const active = !!(data && data.active);
    banner.classList.toggle('hidden', !active);
    const text = $('#record-banner-text');
    if (active && text) text.textContent = '녹화 중 · ' + (data.eventCount || 0) + '개';
  }

  function closeAllMenus(except) {
    document.querySelectorAll('.menu').forEach((el) => {
      if (el !== except) el.classList.add('hidden');
    });
    const moreBtn = $('#btn-more');
    if (moreBtn && (!except || except.id !== 'more-menu')) moreBtn.setAttribute('aria-expanded', 'false');
  }

  async function startRecordThisSite() {
    if (isRestrictedPage()) {
      showToast('이 페이지에서는 녹화할 수 없습니다.');
      return;
    }
    const host = currentHost || '새 프리셋';
    const pattern = currentPort ? currentHost + ':' + currentPort : currentHost;
    const created = await sendMessage({
      type: 'PRESET_CREATE',
      name: host,
      urlPattern: pattern || '',
      urlPatterns: pattern ? [pattern] : []
    });
    if (!created.ok || !created.data) {
      showToast('프리셋 생성 실패: ' + (created.error || ''));
      return;
    }
    const resp = await sendMessage({ type: 'RECORD_START', tabId: currentTabId, presetId: created.data.id });
    if (!resp.ok) {
      showToast('녹화 실패: ' + resp.error);
      return;
    }
    showToast('녹화 시작! 페이지에서 평소대로 한 뒤 [종료]를 누르세요.');
    await loadPresets();
    await refreshRecordBanner();
  }

  function isJourneyPreset(preset) {
    return !!(
      preset &&
      Array.isArray(preset.fields) &&
      preset.fields.some((f) => f && (f.type === 'click' || f.type === 'keydown' || f.type === 'navigate'))
    );
  }

  async function loadPresets() {
    const resp = await sendMessage({ type: 'PRESET_LIST' });
    if (!resp.ok) {
      presets = [];
      renderList();
      showToast(resp.error || '프리셋을 불러오지 못했습니다.');
      return;
    }
    presets = Array.isArray(resp.data) ? resp.data : [];
    renderList();
  }

  async function loadGroups() {
    const resp = await sendMessage({ type: 'GROUP_LIST' });
    groups = resp.ok ? resp.data : [];
    renderGroupList();
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // background.js matchUrlPattern(135-211)과 동일한 판정 로직 (포트/IPv6/trailing slash/경로/IDN)
  function normalizeHost(host) {
    if (!/[^\x00-\x7F]/.test(host)) return host;
    try {
      return new URL('http://' + host).hostname;
    } catch (e) {
      return host;
    }
  }

  function parsePatternText(text) {
    const out = [];
    const seen = new Set();
    String(text || '')
      .split(/[\n,]+/)
      .forEach((part) => {
        const p = part.trim();
        if (!p) return;
        const key = p.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(p);
      });
    return out.slice(0, 20);
  }

  function getPresetPatterns(preset) {
    if (!preset) return [];
    if (Array.isArray(preset.urlPatterns) && preset.urlPatterns.length) {
      return parsePatternText(preset.urlPatterns.join('\n'));
    }
    if (typeof preset.urlPattern === 'string' && preset.urlPattern.trim()) {
      return parsePatternText(preset.urlPattern);
    }
    return [];
  }

  function formatPatternText(preset) {
    return getPresetPatterns(preset).join('\n');
  }

  function formatPatternMeta(preset) {
    const list = getPresetPatterns(preset);
    if (!list.length) return '(패턴 없음)';
    if (list.length === 1) return list[0];
    return list[0] + ' 외 ' + (list.length - 1) + '개';
  }

  function presetMatchesCurrent(preset) {
    return getPresetPatterns(preset).some((p) => hostMatchesPattern(p));
  }

  function hostMatchesPattern(pattern) {
    if (!pattern) return false;
    let url;
    try {
      url = new URL(currentUrl);
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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  function buildFieldCopyRows(fields) {
    if (!Array.isArray(fields) || fields.length === 0) return '';
    const MAX_VISIBLE = 5;
    const rows = fields
      .map((field, idx) => {
        if (!field || typeof field !== 'object') return '';
        const isBoolean = field.type === 'checkbox' || field.type === 'radio';
      const isSensitive = !!field.sensitive;
      const isAction = field.type === 'click' || field.type === 'keydown' || field.type === 'navigate';
      let displayValue;
      let copyValue;
      if (isAction) {
        if (field.type === 'click') displayValue = '클릭 · ' + (field.value || field.label || '요소');
        else if (field.type === 'keydown') displayValue = '키 · ' + (field.value || 'Enter');
        else displayValue = '이동 · ' + (field.value || field.label || '');
        copyValue = String(field.value || '');
      } else if (isBoolean) {
        const checked = field.value === 'true';
        displayValue = checked ? '체크됨' : '체크 안 됨';
        copyValue = checked ? 'true' : 'false';
      } else if (field.value === '' || field.value == null) {
        displayValue = '(값 없음)';
        copyValue = '';
      } else {
        displayValue = isSensitive ? '••••••' : String(field.value);
        copyValue = String(field.value);
      }
      const copyBtn =
        copyValue === ''
          ? '<button class="field-copy-btn" disabled title="복사할 값이 없습니다">📋</button>'
          : '<button class="field-copy-btn" data-copy-idx="' + idx + '" title="값 복사">📋</button>';
      return (
        '<div class="field-copy-row">' +
        '<span class="field-copy-label">' + escapeHtml(field.label) + '</span>' +
        '<span class="field-copy-value' + (isSensitive ? ' is-sensitive' : '') + '">' + escapeHtml(displayValue) + '</span>' +
        copyBtn +
        '</div>'
      );
      })
      .filter((row) => row !== '');

    const visible = rows.slice(0, MAX_VISIBLE).join('');
    const hidden = rows.slice(MAX_VISIBLE);
    let html = '<div class="field-copy-list">' + visible;
    if (hidden.length > 0) {
      html +=
        '<div class="field-copy-more hidden" data-more-fields>' + hidden.join('') + '</div>' +
        '<button class="field-copy-toggle" data-toggle-fields>' + hidden.length + '개 더보기</button>';
    }
    html += '</div>';
    return html;
  }

  function updateSelectBar() {
    const bar = $('#preset-select-bar');
    const allChk = $('#chk-select-all');
    const delBtn = $('#btn-delete-selected');
    const known = new Set(presets.map((p) => p.id));
    for (const id of [...selectedPresetIds]) {
      if (!known.has(id)) selectedPresetIds.delete(id);
    }
    if (!bar) return;
    const shown = visiblePresets();
    bar.classList.toggle('hidden', shown.length === 0);
    const selected = shown.filter((p) => selectedPresetIds.has(p.id)).length;
    const allOn = shown.length > 0 && selected === shown.length;
    if (allChk) {
      allChk.checked = allOn;
      allChk.indeterminate = selected > 0 && !allOn;
    }
    if (delBtn) {
      delBtn.disabled = selected === 0;
      delBtn.textContent = selected > 0 ? '선택 삭제 (' + selected + ')' : '선택 삭제';
    }
  }

  function renderList() {
    presetList.innerHTML = '';
    const shown = visiblePresets();
    const noneAtAll = presets.length === 0;
    const noneVisible = !noneAtAll && shown.length === 0;
    emptyState.classList.toggle('hidden', !noneAtAll);
    if (emptyFilter) emptyFilter.classList.toggle('hidden', !noneVisible);
    if (noneAtAll || noneVisible) {
      updateSelectBar();
      return;
    }

    for (const preset of shown) {
      const card = document.createElement('div');
      card.className = 'preset-card' + (presetMatchesCurrent(preset) ? ' is-matching' : '');

      const badges = [];
      if (presetMatchesCurrent(preset)) badges.push('<span class="badge badge-match">현재 사이트</span>');
      if (isJourneyPreset(preset)) badges.push('<span class="badge badge-journey">여정</span>');
      if (preset.autoApply && !isJourneyPreset(preset)) badges.push('<span class="badge badge-auto">자동 적용</span>');

      card.innerHTML =
        '<div class="preset-card-head">' +
        '<label class="preset-select">' +
        '<input type="checkbox" data-select-id="' + escapeHtml(preset.id) + '"' +
        (selectedPresetIds.has(preset.id) ? ' checked' : '') +
        ' aria-label="프리셋 선택">' +
        '</label>' +
        '<span class="preset-name">' + escapeHtml(preset.name) + '</span>' +
        '<div class="preset-badges">' + badges.join('') + '</div>' +
        '</div>' +
        '<div class="preset-meta">' + escapeHtml(formatPatternMeta(preset)) + ' · 필드 ' + (Array.isArray(preset.fields) ? preset.fields.length : 0) + '개</div>' +
        buildFieldCopyRows(preset.fields) +
        '<div class="preset-actions">' +
        '<button class="btn btn-primary" data-act="replay" data-id="' + escapeHtml(preset.id) + '">재생</button>' +
        '<div class="card-more">' +
        '<button type="button" class="btn" data-menu-toggle aria-label="더보기">⋯</button>' +
        '<div class="menu hidden">' +
        '<button type="button" class="menu-item" data-act="record" data-id="' + escapeHtml(preset.id) + '">녹화</button>' +
        '<button type="button" class="menu-item" data-act="edit" data-id="' + escapeHtml(preset.id) + '">편집</button>' +
        '<button type="button" class="menu-item" data-act="delete" data-id="' + escapeHtml(preset.id) + '">삭제</button>' +
        '</div>' +
        '</div>' +
        '</div>';

      const selectChk = card.querySelector('[data-select-id]');
      if (selectChk) {
        selectChk.addEventListener('click', (e) => e.stopPropagation());
        selectChk.addEventListener('change', (e) => {
          if (e.target.checked) selectedPresetIds.add(preset.id);
          else selectedPresetIds.delete(preset.id);
          updateSelectBar();
        });
      }
      const menuToggle = card.querySelector('[data-menu-toggle]');
      const menu = card.querySelector('.card-more .menu');
      if (menuToggle && menu) {
        menuToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = menu.classList.contains('hidden');
          closeAllMenus(open ? menu : null);
          menu.classList.toggle('hidden', !open);
        });
      }
      card.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => {
          closeAllMenus();
          handlePresetAction(btn.dataset.act, preset);
        });
      });
      card.querySelectorAll('[data-copy-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = Number(btn.dataset.copyIdx);
          const field = preset.fields[idx];
          if (!field) return;
          const isBoolean = field.type === 'checkbox' || field.type === 'radio';
          const value = isBoolean ? (field.value === 'true' ? 'true' : 'false') : String(field.value || '');
          copyToClipboard(value, !!field.sensitive);
        });
      });
      const toggleBtn = card.querySelector('[data-toggle-fields]');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
          const more = card.querySelector('[data-more-fields]');
          const isCollapsed = more.classList.toggle('hidden');
          toggleBtn.textContent = isCollapsed
            ? more.querySelectorAll('.field-copy-row').length + '개 더보기'
            : '접기';
        });
      }
      presetList.appendChild(card);
    }
    updateSelectBar();
  }

  function renderGroupList() {
    groupList.innerHTML = '';
    groupsEmpty.classList.toggle('hidden', groups.length > 0);
    if (groups.length === 0) return;

    for (const group of groups) {
      const card = document.createElement('div');
      card.className = 'preset-card';
      const steps = Array.isArray(group.steps) ? group.steps : [];

      card.innerHTML =
        '<div class="preset-card-head">' +
        '<span class="preset-name">' + escapeHtml(group.name) + '</span>' +
        '<div class="preset-badges"><span class="badge badge-group">' + steps.length + '스텝</span></div>' +
        '</div>' +
        '<div class="preset-meta">' +
        steps
          .map((s) => {
            const p = presets.find((pp) => pp.id === s.presetId);
            return escapeHtml(p ? p.name : '(삭제된 프리셋)') + (s.submitMode === 'auto' ? ' [자동 제출]' : ' [수동]');
          })
          .join(' → ') +
        '</div>' +
        '<div class="preset-actions">' +
        '<button class="btn btn-primary" data-act="run" data-id="' + escapeHtml(group.id) + '">실행</button>' +
        '<button class="btn" data-act="gedit" data-id="' + escapeHtml(group.id) + '">편집</button>' +
        '<button class="btn" data-act="gdelete" data-id="' + escapeHtml(group.id) + '">삭제</button>' +
        '</div>';

      card.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => handleGroupAction(btn.dataset.act, group));
      });
      groupList.appendChild(card);
    }
  }

  async function handlePresetAction(act, preset) {
    if (act === 'apply' || act === 'replay') {
      const resp = await sendMessage({ type: 'APPLY_PRESET', presetId: preset.id, tabId: currentTabId });
      if (!resp.ok) {
        showToast('재생 실패: ' + resp.error);
        return;
      }
      const result = resp.data || {};
      const failed = (result.failures || []).length;
      const applied = (result.applied || []).length;
      showToast('재생 완료: ' + applied + '개, 실패: ' + failed + '개');
    } else if (act === 'capture') {
      const resp = await sendMessage({ type: 'CAPTURE_START', tabId: currentTabId, presetId: preset.id });
      if (!resp.ok) {
        showToast('캡처 실패: ' + resp.error);
        return;
      }
      showToast('캡처 모드 시작! 페이지에서 입력란을 클릭하세요.');
      window.close();
    } else if (act === 'record') {
      const resp = await sendMessage({ type: 'RECORD_START', tabId: currentTabId, presetId: preset.id });
      if (!resp.ok) {
        showToast('녹화 실패: ' + resp.error);
        return;
      }
      showToast('녹화 시작! 페이지에서 평소대로 한 뒤 [종료]를 누르세요.');
      await refreshRecordBanner();
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
      selectedPresetIds.delete(preset.id);
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
          urlPatterns: currentHost ? [currentHost] : [],
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
    $('#ed-pattern').value = formatPatternText(editingPreset);
    const journey = isJourneyPreset(editingPreset);
    const autoEl = $('#ed-autoapply');
    autoEl.checked = !!editingPreset.autoApply && !journey;
    autoEl.disabled = journey;
    autoEl.title = journey ? '여정 프리셋은 페이지 진입 시 자동 적용하지 않습니다.' : '';
    const autoHint = $('#ed-autoapply-hint');
    if (autoHint) autoHint.classList.toggle('hidden', !journey);
    $('#btn-delete-preset').style.display = preset ? '' : 'none';
    $('#btn-capture').disabled = !preset;
    $('#btn-record').disabled = !preset;
    renderFields();
  }

  function renderFields() {
    const fields = Array.isArray(editingPreset.fields) ? editingPreset.fields : [];
    fieldsList.innerHTML = '';
    fieldsEmpty.classList.toggle('hidden', fields.length > 0);
    $('#field-count').textContent = fields.length;
    fields.forEach((field, idx) => {
      if (!field || typeof field !== 'object') return;
      const item = document.createElement('div');
      item.className = 'field-item';
      const isBoolean = field.type === 'checkbox' || field.type === 'radio';
      const isSensitive = !!field.sensitive;
      item.innerHTML =
        '<div class="field-item-top">' +
        '<input type="text" class="field-label-input" data-idx="' + idx + '" value="' + escapeHtml(field.label || '') + '" data-label-edit placeholder="표시 이름" maxlength="80" aria-label="표시 이름">' +
        '<span class="field-type">' +
        escapeHtml(
          field.type === 'click'
            ? '클릭'
            : field.type === 'keydown'
              ? '키'
              : field.type === 'navigate'
                ? '이동'
                : field.type
        ) +
        '</span>' +
        '</div>' +
        (field.selector
          ? '<button type="button" class="field-selector-toggle" data-sel-toggle>셀렉터 보기</button>' +
            '<div class="field-selector hidden">' + escapeHtml(field.selector) + '</div>'
          : '') +
        '<div class="field-value-row">' +
        (isBoolean
          ? '<input type="text" value="' + (field.value === 'true' ? '체크됨' : '체크 안 됨') + '" disabled>'
          : '<input type="' + (isSensitive ? 'password' : 'text') + '" data-idx="' + idx + '" value="' + escapeHtml(field.value) + '" data-value-edit>') +
        (isBoolean
          ? ''
          : '<button class="field-copy-btn" data-edit-copy="' + idx + '" title="값 복사"' + (field.value === '' ? ' disabled' : '') + '>📋</button>') +
        '<label class="field-sensitive"><input type="checkbox" data-sensitive="' + idx + '"' + (isSensitive ? ' checked' : '') + '>민감</label>' +
        '<button class="field-del" data-del="' + idx + '" title="삭제">✕</button>' +
        '</div>';
      item.querySelector('[data-del]').addEventListener('click', () => {
        editingPreset.fields.splice(idx, 1);
        renderFields();
      });
      const selToggle = item.querySelector('[data-sel-toggle]');
      const selBox = item.querySelector('.field-selector');
      if (selToggle && selBox) {
        selToggle.addEventListener('click', () => {
          const hidden = selBox.classList.toggle('hidden');
          selToggle.textContent = hidden ? '셀렉터 보기' : '셀렉터 숨기기';
        });
      }
      const sensitiveCheck = item.querySelector('[data-sensitive]');
      if (sensitiveCheck) {
        sensitiveCheck.addEventListener('change', (e) => {
          editingPreset.fields[idx].sensitive = e.target.checked;
          const input = item.querySelector('[data-value-edit]');
          if (input) input.type = e.target.checked ? 'password' : 'text';
        });
      }
      const editCopyBtn = item.querySelector('[data-edit-copy]');
      if (editCopyBtn) {
        editCopyBtn.addEventListener('click', () => {
          const f = editingPreset.fields[idx];
          if (!f) return;
          copyToClipboard(String(f.value || ''), !!f.sensitive);
        });
      }
      fieldsList.appendChild(item);
    });
  }

  fieldsList.addEventListener('input', (e) => {
    const idx = Number(e.target.dataset.idx);
    if (!Number.isInteger(idx) || !editingPreset.fields[idx]) return;
    if (e.target.dataset.labelEdit !== undefined) {
      editingPreset.fields[idx].label = e.target.value;
      return;
    }
    if (!e.target.dataset.valueEdit) return;
    editingPreset.fields[idx].value = e.target.value;
    const copyBtn = fieldsList.querySelector('[data-edit-copy="' + idx + '"]');
    if (copyBtn) copyBtn.disabled = e.target.value === '';
  });

  function normalizeFieldLabels(fields) {
    if (!Array.isArray(fields)) return;
    fields.forEach((f) => {
      if (!f || typeof f !== 'object') return;
      const label = String(f.label || '').trim();
      f.label = label || '필드';
    });
  }

  function renderPresetOptions() {
    const sel = $('#ge-preset-select');
    sel.innerHTML = '';
    for (const p of presets) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name + ' (' + formatPatternMeta(p) + ')';
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
  ['#btn-record-site', '#btn-record-site-empty', '#btn-record-site-filter'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('click', startRecordThisSite);
  });
  const moreBtn = $('#btn-more');
  const moreMenu = $('#more-menu');
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = moreMenu.classList.contains('hidden');
      closeAllMenus(open ? moreMenu : null);
      moreMenu.classList.toggle('hidden', !open);
      moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }
  const filterChk = $('#chk-filter-site');
  if (filterChk) {
    filterChk.addEventListener('change', async (e) => {
      filterCurrentSite = !!e.target.checked;
      try {
        await chrome.storage.local.set({ [FILTER_KEY]: filterCurrentSite });
      } catch (err) {
        // 저장 실패해도 이번 세션 필터는 유지
      }
      renderList();
    });
  }
  document.querySelectorAll('.pace-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pace = btn.dataset.pace;
      const resp = await sendMessage({ type: 'SETTINGS_SET', replayPace: pace });
      if (!resp.ok) {
        showToast('설정 저장 실패: ' + (resp.error || ''));
        return;
      }
      paintPaceButtons(resp.data && resp.data.replayPace ? resp.data.replayPace : pace);
      showToast(
        pace === 'fast' ? '재생 속도: 빠름 (이동 후 대기 거의 없음)' : pace === 'slow' ? '재생 속도: 느림' : '재생 속도: 보통'
      );
    });
  });
  document.addEventListener('click', () => closeAllMenus());
  const stopRecordBtn = $('#btn-stop-record');
  if (stopRecordBtn) {
    stopRecordBtn.addEventListener('click', async () => {
      const resp = await sendMessage({ type: 'RECORD_STOP', tabId: currentTabId });
      if (!resp.ok) {
        showToast('종료 실패: ' + (resp.error || ''));
        return;
      }
      const saved = resp.data && typeof resp.data.saved === 'number' ? resp.data.saved : 0;
      showToast(saved === 0 ? '기록된 행동이 없습니다.' : '저장 완료! ' + saved + '개 행동이 기록되었습니다.');
      await loadPresets();
      await refreshRecordBanner();
    });
  }

  $('#chk-select-all').addEventListener('change', (e) => {
    const shown = visiblePresets();
    if (e.target.checked) {
      shown.forEach((p) => selectedPresetIds.add(p.id));
    } else {
      shown.forEach((p) => selectedPresetIds.delete(p.id));
    }
    renderList();
  });

  $('#btn-delete-selected').addEventListener('click', async () => {
    const ids = presets.map((p) => p.id).filter((id) => selectedPresetIds.has(id));
    if (ids.length === 0) {
      showToast('삭제할 프리셋을 선택해주세요.');
      return;
    }
    if (!confirm('선택한 프리셋 ' + ids.length + '개를 삭제할까요?\n이 프리셋을 쓰는 그룹 단계도 빠집니다.')) return;
    const btn = $('#btn-delete-selected');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const resp = await sendMessage({ type: 'PRESET_DELETE_MANY', ids });
      if (!resp.ok) {
        showToast('삭제 실패: ' + resp.error);
        return;
      }
      const deleted = resp.data && resp.data.deleted ? resp.data.deleted : ids.length;
      selectedPresetIds.clear();
      showToast(deleted + '개 프리셋을 삭제했습니다.');
      await loadPresets();
      await loadGroups();
    } finally {
      updateSelectBar();
    }
  });
  $('#btn-new-group').addEventListener('click', () => openGroupEditor(null));

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
    const btn = $('#btn-save-preset');
    if (btn.disabled) return; // 저장 중 연타 방지 (UX-4)
    btn.disabled = true;
    try {
      const name = $('#ed-name').value.trim();
      const patterns = parsePatternText($('#ed-pattern').value);
      if (!name) {
        showToast('프리셋 이름을 입력해주세요.');
        return;
      }
      if (!patterns.length) {
        showToast('사이트 패턴을 입력해주세요.');
        return;
      }
      editingPreset.name = name;
      editingPreset.urlPatterns = patterns;
      editingPreset.urlPattern = patterns[0];
      editingPreset.autoApply = isJourneyPreset(editingPreset) ? false : $('#ed-autoapply').checked;
      normalizeFieldLabels(editingPreset.fields);

      let resp;
      if (editingPreset.id) {
        resp = await sendMessage({ type: 'PRESET_UPDATE', preset: editingPreset });
      } else {
        resp = await sendMessage({
          type: 'PRESET_CREATE',
          name,
          urlPattern: patterns[0],
          urlPatterns: patterns,
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
      $('#btn-record').disabled = false;
    } finally {
      btn.disabled = false;
    }
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
    selectedPresetIds.delete(editingPreset.id);
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

  $('#btn-record').addEventListener('click', async () => {
    if (!editingPreset || !editingPreset.id) return;
    const resp = await sendMessage({ type: 'RECORD_START', tabId: currentTabId, presetId: editingPreset.id });
    if (!resp.ok) {
      showToast('녹화 실패: ' + resp.error);
      return;
    }
    showToast('녹화 시작! 페이지에서 평소대로 한 뒤 [종료]를 누르세요.');
    await refreshRecordBanner();
  });

  $('#btn-save-group').addEventListener('click', async () => {
    const btn = $('#btn-save-group');
    if (btn.disabled) return; // 저장 중 연타 방지 (UX-4)
    btn.disabled = true;
    try {
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
    } finally {
      btn.disabled = false;
    }
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
    await loadFilterPref();
    await loadReplayPace();
    await Promise.all([loadPresets(), loadGroups(), refreshRecordBanner()]);
    await refreshRunStatus();
  }

  init();
})();