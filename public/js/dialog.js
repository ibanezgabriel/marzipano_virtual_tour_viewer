// Show a non-dismissible progress dialog (e.g., for uploads)
let progressDialogActive = false;
function ensureProgressUI() {
  const box = getBox();
  if (!box) return null;
  let wrap = box.querySelector('.app-dialog-progress-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'app-dialog-progress-wrap';
    const bar = document.createElement('div');
    bar.className = 'app-dialog-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'app-dialog-progress-fill';
    bar.appendChild(fill);
    const label = document.createElement('div');
    label.className = 'app-dialog-progress-label';
    wrap.appendChild(bar);
    wrap.appendChild(label);
    const actions = getActions();
    box.insertBefore(wrap, actions);
  }
  return wrap;
}
export function showProgressDialog(message = 'Uploading, please wait...') {
  getOrCreateDialog();
  const titleEl = getTitle();
  const messageEl = getMessage();
  const inputWrap = getInput().closest('.app-dialog-input-wrap');
  const actionsEl = getActions();
  const selectWrap = getSelectWrap();

  titleEl.textContent = '';
  titleEl.style.display = 'none';
  messageEl.textContent = message;
  messageEl.style.display = 'block';
  inputWrap.style.display = 'none';
  selectWrap.style.display = 'none';
  actionsEl.innerHTML = '';
  const wrap = ensureProgressUI();
  if (wrap) {
    const fill = wrap.querySelector('.app-dialog-progress-fill');
    const label = wrap.querySelector('.app-dialog-progress-label');
    fill.style.width = '0%';
    label.textContent = '0%';
    wrap.style.display = 'block';
  }

  showOverlay();
  progressDialogActive = true;
}

export function hideProgressDialog() {
  if (progressDialogActive) {
    const box = getBox();
    if (box) {
      const wrap = box.querySelector('.app-dialog-progress-wrap');
      if (wrap) wrap.style.display = 'none';
    }
    hideOverlay();
    progressDialogActive = false;
  }
}
export function updateProgressDialog(percent) {
  const wrap = ensureProgressUI();
  if (!wrap) return;
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const fill = wrap.querySelector('.app-dialog-progress-fill');
  const label = wrap.querySelector('.app-dialog-progress-label');
  fill.style.width = p + '%';
  label.textContent = p + '%';
}
export function setProgressDialogMessage(message) {
  const messageEl = getMessage();
  if (messageEl) {
    messageEl.textContent = message;
  }
}
/**
 * Centered dialog helpers: alert, confirm, prompt (replacing window.alert/confirm/prompt)
 */

const DIALOG_OVERLAY_ID = 'app-dialog-overlay';
const DIALOG_BOX_ID = 'app-dialog-box';
const DIALOG_TITLE_ID = 'app-dialog-title';
const DIALOG_MESSAGE_ID = 'app-dialog-message';
const DIALOG_INPUT_ID = 'app-dialog-input';
const DIALOG_ACTIONS_ID = 'app-dialog-actions';

/** @type {HTMLElement | null} Element that had focus before the dialog opened (for restore on close). */
let previousActiveElement = null;

function getOrCreateDialog() {
  let overlay = document.getElementById(DIALOG_OVERLAY_ID);
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = DIALOG_OVERLAY_ID;
  overlay.className = 'app-dialog-overlay';
  // aria-hidden only when overlay is hidden; removed when visible so focused dialog content stays exposed to a11y

  const box = document.createElement('div');
  box.id = DIALOG_BOX_ID;
  box.className = 'app-dialog-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', DIALOG_TITLE_ID);

  const title = document.createElement('div');
  title.id = DIALOG_TITLE_ID;
  title.className = 'app-dialog-title';

  const message = document.createElement('div');
  message.id = DIALOG_MESSAGE_ID;
  message.className = 'app-dialog-message';

  const inputWrap = document.createElement('div');
  inputWrap.className = 'app-dialog-input-wrap';
  const input = document.createElement('input');
  input.id = DIALOG_INPUT_ID;
  input.type = 'text';
  input.className = 'app-dialog-input';

  const actions = document.createElement('div');
  actions.id = DIALOG_ACTIONS_ID;
  actions.className = 'app-dialog-actions';

  const selectWrap = document.createElement('div');
  selectWrap.className = 'app-dialog-select-wrap';

  inputWrap.appendChild(input);
  box.appendChild(title);
  box.appendChild(message);
  box.appendChild(inputWrap);
  box.appendChild(selectWrap);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  overlay.setAttribute('aria-hidden', 'true'); // overlay is hidden by CSS until shown
  return overlay;
}

function showOverlay() {
  previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = getOrCreateDialog();
  overlay.removeAttribute('aria-hidden'); // dialog is visible and will receive focus; do not hide from a11y
  overlay.classList.add('app-dialog-visible');
}

function hideOverlay() {
  const overlay = document.getElementById(DIALOG_OVERLAY_ID);
  if (overlay) {
    overlay.classList.remove('app-dialog-visible');
    // Move focus out before setting aria-hidden so the focused element is never inside a hidden ancestor
    if (overlay.contains(document.activeElement)) {
      if (previousActiveElement && previousActiveElement !== document.body && document.contains(previousActiveElement)) {
        previousActiveElement.focus({ focusVisible: false });
      } else {
        document.body.focus({ focusVisible: false });
      }
    }
    previousActiveElement = null;
    overlay.setAttribute('aria-hidden', 'true');
  }
}

function getBox() {
  return document.getElementById(DIALOG_BOX_ID);
}

function getTitle() {
  return document.getElementById(DIALOG_TITLE_ID);
}

function getMessage() {
  return document.getElementById(DIALOG_MESSAGE_ID);
}

function getInput() {
  return document.getElementById(DIALOG_INPUT_ID);
}

function getActions() {
  return document.getElementById(DIALOG_ACTIONS_ID);
}

function getSelectWrap() {
  return document.querySelector(`#${DIALOG_BOX_ID} .app-dialog-select-wrap`);
}

/**
 * Show an alert dialog (message + OK). Returns a Promise that resolves when OK is clicked.
 */
export function showAlert(message, title = 'Notice') {
  return new Promise((resolve) => {
    getOrCreateDialog();
    const titleEl = getTitle();
    const messageEl = getMessage();
    const inputWrap = getInput().closest('.app-dialog-input-wrap');
    const actionsEl = getActions();

    titleEl.textContent = title;
    titleEl.style.display = 'block';
    messageEl.textContent = message;
    messageEl.style.display = 'block';
    inputWrap.style.display = 'none';

    actionsEl.innerHTML = '';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'app-dialog-btn app-dialog-btn-primary';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', () => {
      hideOverlay();
      resolve();
    });
    actionsEl.appendChild(okBtn);

    showOverlay();
    okBtn.focus();
  });
}

/**
 * Show a confirm dialog (message + OK + Cancel). Returns Promise<boolean>.
 */
export function showConfirm(message, title = 'Confirm') {
  return new Promise((resolve) => {
    getOrCreateDialog();
    const titleEl = getTitle();
    const messageEl = getMessage();
    const inputWrap = getInput().closest('.app-dialog-input-wrap');
    const actionsEl = getActions();

    titleEl.textContent = title;
    titleEl.style.display = 'block';
    messageEl.textContent = message;
    messageEl.style.display = 'block';
    inputWrap.style.display = 'none';

    actionsEl.innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'app-dialog-btn app-dialog-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      hideOverlay();
      resolve(false);
    });
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'app-dialog-btn app-dialog-btn-primary';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', () => {
      hideOverlay();
      resolve(true);
    });
    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);

    showOverlay();
    cancelBtn.focus();
  });
}

/**
 * Show a prompt dialog (message + input + OK + Cancel). Returns Promise<string | null>.
 */
export function showPrompt(message, defaultValue = '', title = 'Input') {
  return new Promise((resolve) => {
    getOrCreateDialog();
    const titleEl = getTitle();
    const messageEl = getMessage();
    const inputEl = getInput();
    const inputWrap = inputEl.closest('.app-dialog-input-wrap');
    const actionsEl = getActions();

    titleEl.textContent = title;
    titleEl.style.display = 'block';
    messageEl.textContent = message;
    messageEl.style.display = 'block';
    inputWrap.style.display = 'block';
    inputEl.value = defaultValue;
    inputEl.style.display = 'block';

    actionsEl.innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'app-dialog-btn app-dialog-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      hideOverlay();
      resolve(null);
    });
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'app-dialog-btn app-dialog-btn-primary';
    okBtn.textContent = 'OK';
    const submit = () => {
      hideOverlay();
      resolve(inputEl.value.trim());
    };
    okBtn.addEventListener('click', submit);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideOverlay();
        resolve(null);
      }
    });
    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);

    showOverlay();
    inputEl.focus();
    inputEl.select();
  });
}

/**
 * Show a selection dialog (title + select + OK + Cancel). Returns Promise<string | null>.
 * @param {string} title - Dialog title.
 * @param {string[]} options - Option labels (value and label are the same).
 * @returns {Promise<string | null>} Selected option or null if cancelled.
 */
export function showSelect(title, options) {
  return new Promise((resolve) => {
    getOrCreateDialog();
    const titleEl = getTitle();
    const messageEl = getMessage();
    const inputWrap = getInput().closest('.app-dialog-input-wrap');
    const selectWrap = getSelectWrap();
    const actionsEl = getActions();

    titleEl.textContent = title;
    titleEl.style.display = 'block';
    messageEl.style.display = 'none';
    inputWrap.style.display = 'none';
    selectWrap.style.display = 'block';
    selectWrap.innerHTML = '';

    const select = document.createElement('select');
    select.className = 'app-dialog-select';
    options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      select.appendChild(option);
    });
    selectWrap.appendChild(select);

    actionsEl.innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'app-dialog-btn app-dialog-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
      selectWrap.style.display = 'none';
      hideOverlay();
      resolve(null);
    });
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'app-dialog-btn app-dialog-btn-primary';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', () => {
      const value = select.value;
      selectWrap.style.display = 'none';
      hideOverlay();
      resolve(value);
    });
    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(okBtn);

    showOverlay();
    select.focus();
  });
}

const PREVIEW_BAR_ID = 'app-dialog-preview-bar';

/**
 * Show a selection dialog with a Preview button. User can preview the selection before confirming.
 * @param {string} title - Dialog title.
 * @param {string[]} options - Option labels (value and label are the same).
 * @param {(value: string) => void} onPreview - Called when Preview is clicked; e.g. load the panorama.
 * @returns {Promise<string | null>} Selected option or null if cancelled.
 */
export function showSelectWithPreview(title, options, onPreview) {
  return new Promise((resolve) => {
    getOrCreateDialog();
    const titleEl = getTitle();
    const messageEl = getMessage();
    const inputWrap = getInput().closest('.app-dialog-input-wrap');
    const selectWrap = getSelectWrap();
    const actionsEl = getActions();

    titleEl.textContent = title;
    titleEl.style.display = 'block';
    messageEl.style.display = 'none';
    inputWrap.style.display = 'none';
    selectWrap.style.display = 'block';
    selectWrap.innerHTML = '';

    const select = document.createElement('select');
    select.className = 'app-dialog-select';
    options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt;
      select.appendChild(option);
    });
    selectWrap.appendChild(select);

    function hidePreviewBar() {
      const bar = document.getElementById(PREVIEW_BAR_ID);
      if (bar) bar.remove();
    }

    function finish(value) {
      hidePreviewBar();
      hideOverlay();
      selectWrap.style.display = 'none';
      resolve(value);
    }

    actionsEl.innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'app-dialog-btn app-dialog-btn-secondary';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => finish(null));

    const previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'app-dialog-btn app-dialog-btn-secondary';
    previewBtn.textContent = 'Preview';
    previewBtn.addEventListener('click', () => {
      const value = select.value;
      onPreview(value);
      hideOverlay();
      selectWrap.style.display = 'none';

      let bar = document.getElementById(PREVIEW_BAR_ID);
      if (!bar) {
        bar = document.createElement('div');
        bar.id = PREVIEW_BAR_ID;
        bar.className = 'app-dialog-preview-bar';
        document.body.appendChild(bar);
      }
      bar.innerHTML = '';
      const label = document.createElement('span');
      label.className = 'app-dialog-preview-bar-label';
      label.textContent = `Previewing: ${value}. Confirm link?`;
      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'app-dialog-btn app-dialog-btn-primary';
      okBtn.textContent = 'OK';
      okBtn.addEventListener('click', () => finish(value));
      const cancelBarBtn = document.createElement('button');
      cancelBarBtn.type = 'button';
      cancelBarBtn.className = 'app-dialog-btn app-dialog-btn-secondary';
      cancelBarBtn.textContent = 'Cancel';
      cancelBarBtn.addEventListener('click', () => finish(null));
      bar.appendChild(label);
      bar.appendChild(okBtn);
      bar.appendChild(cancelBarBtn);
    });

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'app-dialog-btn app-dialog-btn-primary';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', () => {
      const value = select.value;
      finish(value);
    });

    actionsEl.appendChild(cancelBtn);
    actionsEl.appendChild(previewBtn);
    actionsEl.appendChild(okBtn);

    showOverlay();
    select.focus();
  });
}
