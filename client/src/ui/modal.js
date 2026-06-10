// Reusable modal with focus management + Esc to close.
// openModal({ title, body, footer }) => { close, root }

const root = document.getElementById('modal-root');
let activeModal = null;
let lastFocused = null;

function bindGlobalEsc() {
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || !activeModal) return;
    if (activeModal.allowEscClose !== false) {
      e.preventDefault();
      activeModal.close();
    }
  });
}
bindGlobalEsc();

root.addEventListener('click', e => {
  if (!activeModal) return;
  if (e.target === root && activeModal.allowBackdropClose !== false) activeModal.close();
});

export function openModal({ title, body, footer, size = 'normal', allowEscClose = true, allowBackdropClose = true }) {
  closeModal();

  const wrap = document.createElement('div');
  wrap.className = 'modal' + (size === 'confirm' ? ' modal-confirm' : '');

  const head = document.createElement('div');
  head.className = 'modal-head';
  const h = document.createElement('h3');
  h.textContent = title || '';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-icon';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', () => closeModal());
  head.appendChild(h);
  head.appendChild(closeBtn);
  wrap.appendChild(head);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'modal-body';
  if (body instanceof Node) bodyEl.appendChild(body);
  else if (typeof body === 'string') bodyEl.textContent = body;
  wrap.appendChild(bodyEl);

  if (footer) {
    const footEl = document.createElement('div');
    footEl.className = 'modal-foot';
    if (footer instanceof Node) footEl.appendChild(footer);
    wrap.appendChild(footEl);
  }

  root.replaceChildren(wrap);
  root.hidden = false;

  lastFocused = document.activeElement;

  // Focus first interactive element
  setTimeout(() => {
    const focusable = wrap.querySelector('input:not([type=hidden]), select, textarea, button:not(.btn-ghost.btn-icon)');
    if (focusable) focusable.focus();
  }, 10);

  // Trap focus
  wrap.addEventListener('keydown', trapTab);

  activeModal = {
    wrap,
    bodyEl,
    allowEscClose,
    allowBackdropClose,
    close: () => closeModal()
  };
  return activeModal;
}

function trapTab(e) {
  if (e.key !== 'Tab' || !activeModal) return;
  const focusables = activeModal.wrap.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  );
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
}

export function closeModal() {
  if (!activeModal) return;
  activeModal.wrap.removeEventListener('keydown', trapTab);
  root.replaceChildren();
  root.hidden = true;
  activeModal = null;
  if (lastFocused && typeof lastFocused.focus === 'function') {
    try { lastFocused.focus(); } catch {}
  }
  lastFocused = null;
}
