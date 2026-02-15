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

  inputWrap.appendChild(input);
  box.appendChild(title);
  box.appendChild(message);
  box.appendChild(inputWrap);
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
