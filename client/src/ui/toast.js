const root = document.getElementById('toast-root');

export function toast(message, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, duration);
}

export const toastSuccess = msg => toast(msg, 'success');
export const toastError   = msg => toast(msg, 'error', 4500);
export const toastInfo    = msg => toast(msg, 'info');
