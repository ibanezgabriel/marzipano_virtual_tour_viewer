// Shares tab lifecycle state with the server to prevent accidental session termination
// during temporary network issues (VPN reconnects, flaky Wi-Fi, etc.).

const sockets = new Set();
let bound = false;

function emitState(state) {
  sockets.forEach((socket) => {
    try {
      socket.emit('tabState', { state });
    } catch (_e) {}
  });
}

function currentState() {
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return 'hidden';
  } catch (_e) {}
  return 'visible';
}

function bindOnce() {
  if (bound) return;
  bound = true;

  try {
    document.addEventListener(
      'visibilitychange',
      () => emitState(currentState()),
      { passive: true }
    );
  } catch (_e) {}

  const closing = (ev) => {
    try {
      if (ev && ev.persisted) return; // bfcache
    } catch (_e) {}
    emitState('closing');
  };

  try {
    window.addEventListener('pagehide', closing, { passive: true });
    window.addEventListener('beforeunload', closing, { capture: true });
  } catch (_e) {}
}

export function registerTabStateSocket(socket) {
  if (!socket || typeof socket.emit !== 'function') return;
  sockets.add(socket);
  bindOnce();
  emitState(currentState());
}

