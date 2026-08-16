(() => {
  const capture = { active: false, presetId: null };
  const record = { active: false, presetId: null, events: [], lastRecordAt: 0, debounceTimer: null, pending: null };
  let styleEl = null;
  let panelEl = null;
  let panelTarget = null;
  let highlightObserver = null;
  let applyAbort = null;
  let recordChipEl = null;

  function injectStyles() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.textContent = [
      '.fp-capture-input{outline:2px dashed #3b82f6 !important;outline-offset:2px !important;cursor:copy !important}',
      '.fp-capture-input:hover{outline-style:solid !important;background-color:rgba(59,130,246,.08) !important}',
      '.fp-panel{position:fixed !important;top:16px !important;left:50% !important;transform:translateX(-50%) !important;z-index:2147483647 !important;width:320px !important;max-width:calc(100vw - 32px) !important;background:#fff !important;color:#111 !important;border:1px solid #d1d5db !important;border-radius:10px !important;box-shadow:0 8px 30px rgba(0,0,0,.25) !important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important;font-size:13px !important;padding:14px !important;box-sizing:border-box !important}',
      '.fp-panel *{box-sizing:border-box !important;margin:0 !important}',
      '.fp-panel h3{font-size:14px !important;font-weight:600 !important;margin-bottom:10px !important;color:#111 !important}',
      '.fp-panel label{display:block !important;font-size:11px !important;font-weight:600 !important;color:#4b5563 !important;margin:8px 0 3px !important}',
      '.fp-panel input[type=text],.fp-panel input[type=password],.fp-panel select{width:100% !important;padding:6px 8px !important;border:1px solid #d1d5db !important;border-radius:6px !important;font-size:13px !important;background:#fff !important;color:#111 !important}',
      '.fp-panel input[type=text]:focus,.fp-panel select:focus{outline:2px solid #3b82f6 !important;outline-offset:-1px !important;border-color:#3b82f6 !important}',
      '.fp-panel .fp-check{display:flex !important;align-items:center !important;gap:6px !important;margin:10px 0 0 !important}',
      '.fp-panel .fp-check input{width:auto !important}',
      '.fp-panel .fp-actions{display:flex !important;gap:8px !important;margin-top:14px !important}',
      '.fp-panel button{flex:1 !important;padding:7px 10px !important;border-radius:6px !important;font-size:13px !important;font-weight:600 !important;cursor:pointer !important;border:1px solid transparent !important}',
      '.fp-panel .fp-save{background:#3b82f6 !important;color:#fff !important}',
      '.fp-panel .fp-save:hover{background:#2563eb !important}',
      '.fp-panel .fp-cancel{background:#f3f4f6 !important;color:#374151 !important;border-color:#d1d5db !important}',
      '.fp-panel .fp-status{font-size:12px !important;font-weight:600 !important;text-align:center !important;margin-top:10px !important;color:#059669 !important}',
      '.fp-panel .fp-hint{font-size:11px !important;color:#6b7280 !important;margin-top:8px !important;line-height:1.4 !important}',
      '.fp-panel .fp-chip{display:inline-block !important;max-width:100% !important;overflow:hidden !important;text-overflow:ellipsis !important;white-space:nowrap !important;font-size:11px !important;color:#1d4ed8 !important;background:#dbeafe !important;border-radius:4px !important;padding:2px 6px !important;margin-top:4px !important}',
      '.fp-apply-flash{outline:2px solid #10b981 !important;outline-offset:2px !important;transition:outline-color .8s ease !important}',
      '.fp-record-chip{position:fixed !important;top:16px !important;left:50% !important;transform:translateX(-50%) !important;z-index:2147483647 !important;display:flex !important;align-items:center !important;gap:10px !important;background:#111 !important;color:#fff !important;border-radius:8px !important;padding:8px 14px !important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important;font-size:13px !important;font-weight:600 !important;box-shadow:0 4px 16px rgba(0,0,0,.3) !important;box-sizing:border-box !important}',
      '.fp-record-chip *{box-sizing:border-box !important;margin:0 !important}',
      '.fp-record-chip .fp-record-dot{width:10px !important;height:10px !important;border-radius:50% !important;background:#ef4444 !important;animation:fp-blink 1s infinite !important;flex:none !important}',
      '.fp-record-chip button{background:#ef4444 !important;color:#fff !important;border:none !important;border-radius:6px !important;padding:4px 12px !important;font-size:12px !important;font-weight:600 !important;cursor:pointer !important}',
      '.fp-record-chip button:hover{background:#dc2626 !important}',
      '.fp-record-chip.fp-record-done{background:#059669 !important}',
      '@keyframes fp-blink{50%{opacity:.3}}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isFormField(el) {
    if (!(el instanceof Element)) return false;
    if (el instanceof HTMLInputElement) {
      const t = el.type;
      if (t === 'hidden') return false;
      return true;
    }
    return el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement;
  }

  function detectFieldType(el) {
    if (el instanceof HTMLSelectElement) return 'select';
    if (el instanceof HTMLTextAreaElement) return 'textarea';
    if (el instanceof HTMLInputElement) {
      const t = el.type;
      if (t === 'checkbox' || t === 'radio') return t;
    }
    return 'text';
  }

  function detectFieldLabel(el) {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.placeholder) return el.placeholder;
    }
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.name) return el.name;
    if (el.id) {
      const lbl = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
      if (lbl && lbl.textContent.trim()) return lbl.textContent.trim().slice(0, 40);
    }
    const parent = el.closest('label');
    if (parent && parent.textContent.trim()) return parent.textContent.trim().slice(0, 40);
    return '필드';
  }

  function buildCssPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        part += '#' + cssEscape(node.id);
        parts.unshift(part);
        break;
      }
      if (node.classList.length) {
        part += '.' + Array.from(node.classList).map((c) => cssEscape(c)).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
        }
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(' > ');
  }

  function isUniqueSelector(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (e) {
      return false;
    }
  }

  function generateSelector(el) {
    const candidates = [];
    if (el.id && isUniqueSelector('#' + cssEscape(el.id))) {
      candidates.push('#' + cssEscape(el.id));
    }
    if (el.name && isUniqueSelector('[name="' + cssEscape(el.name) + '"]')) {
      candidates.push('[name="' + cssEscape(el.name) + '"]');
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && isUniqueSelector('[aria-label="' + cssEscape(ariaLabel) + '"]')) {
      candidates.push('[aria-label="' + cssEscape(ariaLabel) + '"]');
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.placeholder && isUniqueSelector('[placeholder="' + cssEscape(el.placeholder) + '"]')) {
        candidates.push('[placeholder="' + cssEscape(el.placeholder) + '"]');
      }
    }
    for (const attr of ['data-testid', 'data-test', 'data-id', 'data-name']) {
      const v = el.getAttribute(attr);
      if (v && isUniqueSelector('[' + attr + '="' + cssEscape(v) + '"]')) {
        candidates.push('[' + attr + '="' + cssEscape(v) + '"]');
        break;
      }
    }
    const path = buildCssPath(el);
    if (isUniqueSelector(path)) candidates.push(path);
    return candidates[0] || path;
  }

  function highlightAll() {
    if (!capture.active) return;
    document.querySelectorAll('input, select, textarea').forEach((el) => {
      if (isFormField(el)) el.classList.add('fp-capture-input');
    });
  }

  function unobserveHighlights() {
    if (highlightObserver) {
      highlightObserver.disconnect();
      highlightObserver = null;
    }
  }

  function observeHighlights() {
    unobserveHighlights();
    highlightObserver = new MutationObserver(() => {
      if (capture.active) highlightAll();
    });
    highlightObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function onCaptureClick(e) {
    // 프리셋 등록 폼 패널 내부 클릭은 절대 DOM 선택(pick) 모드를 트리거하지 않는다.
    if (panelEl && e.target instanceof Element && e.target.closest('.fp-panel')) return;
    const target = e.target instanceof Element ? e.target.closest('input, select, textarea') : null;
    if (!target || !isFormField(target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    openPanel(target);
  }

  function openPanel(el) {
    closePanel();
    panelTarget = el;
    injectStyles();
    panelEl = document.createElement('div');
    panelEl.className = 'fp-panel';
    const type = detectFieldType(el);
    const label = detectFieldLabel(el);

    const isBoolean = type === 'checkbox' || type === 'radio';
    let valueHtml = '';
    if (isBoolean) {
      valueHtml =
        '<div id="fp-value-row" style="display:none">' +
        '<label class="fp-check"><input type="checkbox" id="fp-value" ' +
        (el.checked ? 'checked' : '') +
        '><span>체크된 상태로 저장</span></label>' +
        '</div>';
    } else {
      valueHtml =
        '<div id="fp-value-row" style="display:none">' +
        '<label for="fp-value">저장할 값</label><input type="text" id="fp-value" autocomplete="off">' +
        '</div>';
    }

    const sensitiveHtml =
      '<label class="fp-check"><input type="checkbox" id="fp-sensitive"><span>민감 값 (목록에서 마스킹 표시)</span></label>';

    panelEl.innerHTML =
      '<h3>필드 저장</h3>' +
      '<label for="fp-label">표시 이름</label>' +
      '<input type="text" id="fp-label" value="' + escapeHtml(label) + '">' +
      '<div class="fp-chip">' + escapeHtml(generateSelector(el)) + '</div>' +
      valueHtml +
      sensitiveHtml +
      '<div class="fp-actions"><button class="fp-save" id="fp-save">저장</button><button class="fp-cancel" id="fp-cancel">취소</button></div>' +
      '<div class="fp-hint">표시 이름 입력 후 Enter → 값 입력, 값 입력 후 Enter로 저장합니다. 계속 캡처 모드가 유지됩니다.</div>' +
      '<div class="fp-status" id="fp-status" style="display:none"></div>';

    document.body.appendChild(panelEl);

    const labelInput = panelEl.querySelector('#fp-label');
    const valueRow = panelEl.querySelector('#fp-value-row');
    const valueInput = panelEl.querySelector('#fp-value');
    const sensitiveInput = panelEl.querySelector('#fp-sensitive');

    // 개인정보 자동 감지 (type=password / autocomplete / 메타데이터 키워드) → 민감 체크박스 기본 체크
    if (window.PiiDetect && window.PiiDetect.isSensitive(el, isBoolean ? String(el.checked) : el.value)) {
      sensitiveInput.checked = true;
    }

    function isImeComposing(e) {
      return e.isComposing || e.keyCode === 229;
    }

    function revealValue() {
      valueRow.style.display = 'block';
      valueInput.focus();
      if (!isBoolean) valueInput.select();
    }

    function saveFromPanel() {
      const field = {
        id: crypto.randomUUID(),
        label: labelInput.value.trim() || label,
        selector: generateSelector(el),
        value: isBoolean
          ? String(valueInput.checked)
          : valueInput.value,
        type: type
      };
      if (
        sensitiveInput.checked ||
        (window.PiiDetect && window.PiiDetect.isSensitive(el, field.value))
      ) {
        field.sensitive = true;
      }
      if (!isBoolean && !field.value) {
        showStatus('값을 입력해주세요.', true);
        return;
      }
      saveField(field);
    }

    panelEl.querySelector('#fp-save').addEventListener('click', saveFromPanel);
    panelEl.querySelector('#fp-cancel').addEventListener('click', closePanel);
    panelEl.addEventListener('click', (e) => e.stopPropagation());

    sensitiveInput.addEventListener('change', () => {
      if (!isBoolean) valueInput.type = sensitiveInput.checked ? 'password' : 'text';
    });

    labelInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || isImeComposing(e)) return;
      e.preventDefault();
      revealValue();
    });

    valueInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || isImeComposing(e)) return;
      e.preventDefault();
      saveFromPanel();
    });

    labelInput.focus();
    if (!isBoolean) labelInput.select();
  }

  function showStatus(text, isError) {
    const statusEl = panelEl && panelEl.querySelector('#fp-status');
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.display = 'block';
    statusEl.style.color = isError ? '#dc2626' : '#059669';
    setTimeout(() => {
      if (statusEl.isConnected) statusEl.style.display = 'none';
    }, 2000);
  }

  function saveField(field) {
    chrome.runtime.sendMessage(
      { type: 'CAPTURE_SAVE_FIELD', presetId: capture.presetId, field },
      (resp) => {
        if (chrome.runtime.lastError) {
          showStatus('저장 실패: ' + chrome.runtime.lastError.message, true);
          return;
        }
        if (!resp || !resp.ok) {
          showStatus('저장 실패: ' + (resp && resp.error ? resp.error : '알 수 없는 오류'), true);
          return;
        }
        if (panelTarget) panelTarget.classList.remove('fp-capture-input');
        panelTarget = null;
        showStatus('저장 완료!');
      }
    );
  }

  function closePanel() {
    if (panelEl) {
      panelEl.remove();
      panelEl = null;
    }
    panelTarget = null;
  }

  function startCaptureMode(presetId) {
    capture.active = true;
    capture.presetId = presetId;
    injectStyles();
    highlightAll();
    observeHighlights();
    document.addEventListener('click', onCaptureClick, true);
  }

  function stopCaptureMode() {
    capture.active = false;
    capture.presetId = null;
    closePanel();
    unobserveHighlights();
    document.removeEventListener('click', onCaptureClick, true);
    document.querySelectorAll('.fp-capture-input').forEach((el) => el.classList.remove('fp-capture-input'));
  }

  // ---------- 녹화 모드 (행동 기록) ----------

  const RECORD_MAX_DELAY = 5000;

  function showRecordChip() {
    if (recordChipEl) return;
    recordChipEl = document.createElement('div');
    recordChipEl.className = 'fp-record-chip';
    recordChipEl.innerHTML =
      '<span class="fp-record-dot"></span>' +
      '<span id="fp-record-label">녹화 중 · 0개</span>' +
      '<button id="fp-record-stop">종료</button>';
    document.body.appendChild(recordChipEl);
    recordChipEl.querySelector('#fp-record-stop').addEventListener('click', () => stopRecordingMode());
  }

  function updateRecordChip() {
    if (!recordChipEl) return;
    const label = recordChipEl.querySelector('#fp-record-label');
    if (label) label.textContent = '녹화 중 · ' + record.events.length + '개';
  }

  function hideRecordChip() {
    if (recordChipEl) {
      recordChipEl.remove();
      recordChipEl = null;
    }
  }

  function showRecordToast(text) {
    const toast = document.createElement('div');
    toast.className = 'fp-record-chip fp-record-done';
    toast.innerHTML = '<span>' + escapeHtml(text) + '</span>';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  function recordEvent(el, type, value) {
    const now = Date.now();
    const delay = record.lastRecordAt ? Math.min(now - record.lastRecordAt, RECORD_MAX_DELAY) : 0;
    record.lastRecordAt = now;
    const field = {
      id: crypto.randomUUID(),
      label: detectFieldLabel(el),
      selector: generateSelector(el),
      value: String(value),
      type: type,
      delay: delay
    };
    // 개인정보 자동 감지 (메타데이터 + 값 정규식) → 민감 필드로 자동 암호화
    if (window.PiiDetect && window.PiiDetect.isSensitive(el, field.value)) {
      field.sensitive = true;
    }
    const last = record.events[record.events.length - 1];
    // 같은 필드를 연속 수정하면 새 행동을 추가하지 않고 마지막 값만 갱신
    if (last && last.selector === field.selector && last.type === field.type) {
      last.value = field.value;
    } else {
      record.events.push(field);
    }
    updateRecordChip();
  }

  function flushPendingRecord() {
    if (!record.active || !record.pending) return;
    const pending = record.pending;
    record.pending = null;
    recordEvent(pending.el, pending.type, pending.el.value);
  }

  function onRecordInput(e) {
    if (!record.active) return;
    const el = e.target;
    if (!(el instanceof Element) || !isFormField(el)) return;
    const type = detectFieldType(el);
    if (type === 'select' || type === 'checkbox' || type === 'radio') return;
    // 다른 필드로 이동하면 이전 필드의 대기 입력을 즉시 확정 (값 유실 방지)
    if (record.pending && record.pending.el !== el) {
      flushPendingRecord();
    }
    record.pending = { el, type };
    clearTimeout(record.debounceTimer);
    record.debounceTimer = setTimeout(flushPendingRecord, 400);
  }

  function onRecordChange(e) {
    if (!record.active) return;
    const el = e.target;
    if (!(el instanceof Element) || !isFormField(el)) return;
    const type = detectFieldType(el);
    if (type !== 'select' && type !== 'checkbox' && type !== 'radio') return;
    // 다른 필드의 대기 중인 텍스트 입력을 먼저 확정 (입력 → 선택 순서 보존)
    if (record.pending && record.pending.el !== el) {
      flushPendingRecord();
    }
    const value = type === 'checkbox' || type === 'radio' ? String(el.checked) : el.value;
    recordEvent(el, type, value);
  }

  function startRecordingMode(presetId) {
    record.active = true;
    record.presetId = presetId;
    record.events = [];
    record.lastRecordAt = 0;
    record.pending = null;
    injectStyles();
    showRecordChip();
    document.addEventListener('input', onRecordInput, true);
    document.addEventListener('change', onRecordChange, true);
  }

  function stopRecordingMode() {
    if (!record.active) return;
    clearTimeout(record.debounceTimer);
    flushPendingRecord();
    record.active = false;
    hideRecordChip();
    document.removeEventListener('input', onRecordInput, true);
    document.removeEventListener('change', onRecordChange, true);
    const presetId = record.presetId;
    const events = record.events.slice();
    record.presetId = null;
    record.events = [];
    record.lastRecordAt = 0;
    if (events.length === 0) {
      showRecordToast('기록된 입력이 없습니다.');
      return;
    }
    chrome.runtime.sendMessage({ type: 'RECORD_SAVE', presetId, events }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        showRecordToast('저장 실패: ' + (resp && resp.error ? resp.error : '알 수 없는 오류'));
        return;
      }
      showRecordToast('저장 완료! ' + events.length + '개 입력이 기록되었습니다.');
    });
  }

  // ---------- 순차 재생 (녹화된 행동을 타이밍대로 재생) ----------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForElement(selector, timeoutMs) {
    return new Promise((resolve) => {
      let found = null;
      try {
        found = document.querySelector(selector);
      } catch (e) {
        resolve(null);
        return;
      }
      if (found) {
        resolve(found);
        return;
      }
      const start = Date.now();
      const timer = setInterval(() => {
        let el = null;
        try {
          el = document.querySelector(selector);
        } catch (e) {
          el = null;
        }
        if (el) {
          clearInterval(timer);
          resolve(el);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 100);
    });
  }

  async function replaySequential(preset) {
    const fields = Array.isArray(preset.fields) ? preset.fields : [];
    const applied = [];
    const failures = [];
    for (const field of fields) {
      const delay = Number.isFinite(field.delay) ? Math.min(Math.max(field.delay, 0), RECORD_MAX_DELAY) : 150;
      await sleep(delay);
      const el = await waitForElement(field.selector, 5000);
      if (!el) {
        failures.push({ ok: false, label: field.label, reason: '요소를 찾을 수 없음' });
        continue;
      }
      const res = applyField(field);
      if (res.ok) {
        applied.push(res);
        el.classList.add('fp-apply-flash');
        setTimeout(() => el.classList.remove('fp-apply-flash'), 1200);
      } else {
        failures.push(res);
      }
    }
    return { applied, failures };
  }

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    descriptor.set.call(el, value);
  }

  function setNativeChecked(el, checked) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    descriptor.set.call(el, checked);
  }

  function applyField(field) {
    let el;
    try {
      el = document.querySelector(field.selector);
    } catch (e) {
      return { ok: false, label: field.label, reason: '잘못된 셀렉터' };
    }
    if (!el) return { ok: false, label: field.label, reason: '요소를 찾을 수 없음' };

    if (field.type === 'checkbox' || field.type === 'radio') {
      const checked = String(field.value) === 'true';
      if (el.checked !== checked) {
        setNativeChecked(el, checked);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, label: field.label };
    }

    if (field.type === 'select') {
      let targetValue = field.value;
      let matched = Array.from(el.options).some((o) => o.value === field.value);
      if (!matched) {
        const textMatched = Array.from(el.options).find((o) => o.text === field.value);
        if (textMatched) {
          targetValue = textMatched.value;
          matched = true;
        }
      }
      if (!matched) {
        const opt = document.createElement('option');
        opt.value = field.value;
        opt.text = field.value;
        el.appendChild(opt);
      }
      setNativeValue(el, targetValue);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, label: field.label };
    }

    setNativeValue(el, field.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, label: field.label };
  }

  function applyPreset(preset) {
    if (applyAbort) {
      clearTimeout(applyAbort.timer);
      applyAbort.observer.disconnect();
      applyAbort = null;
    }

    // 녹화된 필드(delay 포함)는 순차 재생 — 기록된 순서와 타이밍대로 적용
    const hasDelay = Array.isArray(preset.fields) && preset.fields.some((f) => Number.isFinite(f.delay));
    if (hasDelay) return replaySequential(preset);

    return new Promise((resolve) => {
      const failures = [];
      const applied = [];

      function tryApply() {
        if (!applyAbort) return;
        const remaining = applyAbort.failures;
        const next = [];
        for (const field of remaining) {
          const res = applyField(field);
          if (res.ok) {
            applied.push(res);
            const el = document.querySelector(field.selector);
            if (el) {
              el.classList.add('fp-apply-flash');
              setTimeout(() => el.classList.remove('fp-apply-flash'), 1200);
            }
          } else {
            next.push(field);
          }
        }
        applyAbort.failures = next;
        if (next.length === 0) {
          clearTimeout(applyAbort.timer);
          applyAbort.observer.disconnect();
          applyAbort = null;
          resolve({ applied, failures: [] });
        }
      }

      const observer = new MutationObserver(() => {
        if (!applyAbort) return;
        clearTimeout(applyAbort.timer);
        applyAbort.timer = setTimeout(tryApply, 300);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });

      applyAbort = {
        failures: preset.fields.slice(),
        observer,
        timer: null
      };
      applyAbort.timer = setTimeout(tryApply, 0);

      setTimeout(() => {
        if (!applyAbort) return;
        const failed = applyAbort.failures;
        clearTimeout(applyAbort.timer);
        applyAbort.observer.disconnect();
        applyAbort = null;
        resolve({ applied, failures: failed });
      }, 15000);
    });
  }

  function submitForm(selector) {
    return new Promise((resolve) => {
      function trySubmit() {
        let btn = null;
        if (selector) {
          try {
            btn = document.querySelector(selector);
          } catch (e) {
            btn = null;
          }
        }
        if (!btn) {
          btn =
            document.querySelector('button[type="submit"], input[type="submit"], input[type="image"]') ||
            document.querySelector('form button') ||
            document.querySelector('form input[type="button"]');
        }
        if (btn) {
          btn.click();
          resolve({ ok: true, clicked: true });
          return;
        }
        const form = document.querySelector('form');
        if (form) {
          try {
            form.requestSubmit();
            resolve({ ok: true, clicked: false });
            return;
          } catch (e) {
            resolve({ ok: false, reason: '폼 제출에 실패했습니다.' });
            return;
          }
        }
        resolve({ ok: false, reason: '제출 버튼을 찾을 수 없습니다.' });
      }
      setTimeout(trySubmit, 0);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CAPTURE_START') {
      startCaptureMode(msg.presetId);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'CAPTURE_STOP') {
      stopCaptureMode();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'RECORD_START') {
      startRecordingMode(msg.presetId);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'RECORD_STOP') {
      stopRecordingMode();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'APPLY_PRESET') {
      applyPreset(msg.preset).then((result) => {
        sendResponse({ result: result });
      });
      return true;
    }
    if (msg.type === 'SUBMIT_FORM') {
      submitForm(msg.selector).then((result) => {
        sendResponse(result);
      });
      return true;
    }
    return false;
  });

  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    chrome.runtime.sendMessage({ type: 'AUTO_APPLY_CHECK', url: location.href }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.ok) return;
      for (const preset of resp.data) {
        applyPreset(preset);
      }
    });
  }

  const pushState = history.pushState;
  history.pushState = function (...args) {
    const result = pushState.apply(this, args);
    setTimeout(checkUrlChange, 0);
    return result;
  };
  const replaceState = history.replaceState;
  history.replaceState = function (...args) {
    const result = replaceState.apply(this, args);
    setTimeout(checkUrlChange, 0);
    return result;
  };
  window.addEventListener('popstate', checkUrlChange);
  window.addEventListener('hashchange', checkUrlChange);
})();