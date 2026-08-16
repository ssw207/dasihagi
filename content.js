(() => {
  const capture = { active: false, presetId: null };
  let styleEl = null;
  let panelEl = null;
  let panelTarget = null;
  let highlightObserver = null;
  let applyAbort = null;

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
      '.fp-apply-flash{outline:2px solid #10b981 !important;outline-offset:2px !important;transition:outline-color .8s ease !important}'
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

    panelEl.innerHTML =
      '<h3>필드 저장</h3>' +
      '<label for="fp-label">표시 이름</label>' +
      '<input type="text" id="fp-label" value="' + escapeHtml(label) + '">' +
      '<div class="fp-chip">' + escapeHtml(generateSelector(el)) + '</div>' +
      valueHtml +
      '<div class="fp-actions"><button class="fp-save" id="fp-save">저장</button><button class="fp-cancel" id="fp-cancel">취소</button></div>' +
      '<div class="fp-hint">표시 이름 입력 후 Enter → 값 입력, 값 입력 후 Enter로 저장합니다. 계속 캡처 모드가 유지됩니다.</div>' +
      '<div class="fp-status" id="fp-status" style="display:none"></div>';

    document.body.appendChild(panelEl);

    const labelInput = panelEl.querySelector('#fp-label');
    const valueRow = panelEl.querySelector('#fp-value-row');
    const valueInput = panelEl.querySelector('#fp-value');

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
      if (!isBoolean && !field.value) {
        showStatus('값을 입력해주세요.', true);
        return;
      }
      saveField(field);
    }

    panelEl.querySelector('#fp-save').addEventListener('click', saveFromPanel);
    panelEl.querySelector('#fp-cancel').addEventListener('click', closePanel);
    panelEl.addEventListener('click', (e) => e.stopPropagation());

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