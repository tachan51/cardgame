import './style.css';
import { Store, freshGame, load } from './store';
import { closeMenu, closeModal, isModalOpen } from './ui/common';
import { renderSetup } from './ui/setup';
import { cancelPending, renderMulligan, renderTable } from './ui/table';

const app = document.getElementById('app')!;
const store = new Store(load() ?? freshGame());

function render(): void {
  closeMenu();
  // 毎回新しい入れ物に描画する（古い要素のイベントを残さないため）
  const container = document.createElement('div');
  container.className = 'root';
  app.replaceChildren(container);
  const s = store.state;
  if (s.phase === 'setup') renderSetup(container, store);
  else if (s.phase === 'mulligan') renderMulligan(container, store);
  else renderTable(container, store);
}

store.subscribe(render);
render();

document.addEventListener('click', () => closeMenu());
document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
  if (e.key === 'Escape') {
    closeMenu();
    if (isModalOpen()) closeModal();
    else if (cancelPending()) render();
    return;
  }
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault();
    store.undo();
  } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
    e.preventDefault();
    store.redo();
  }
});
