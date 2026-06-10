import { openModal, closeModal } from './modal.js';

// Returns Promise<boolean>
export function confirm({ title = 'Confirm', message, confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const body = document.createElement('p');
    body.style.margin = '0';
    body.textContent = message || 'Are you sure?';

    const footer = document.createDocumentFragment();
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.textContent = cancelText;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    ok.textContent = confirmText;
    footer.appendChild(cancel);
    footer.appendChild(ok);

    cancel.addEventListener('click', () => { closeModal(); resolve(false); });
    ok.addEventListener('click',     () => { closeModal(); resolve(true); });

    openModal({ title, body, footer, size: 'confirm' });
  });
}
