// UI の共通部品: エスケープ、右クリックメニュー、モーダル、ダウンロード

export function esc(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
}

let openMenuEl: HTMLElement | null = null;

export function closeMenu(): void {
  openMenuEl?.remove();
  openMenuEl = null;
}

export function showMenu(x: number, y: number, title: string, items: MenuItem[]): void {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  const head = document.createElement('div');
  head.className = 'ctx-title';
  head.textContent = title;
  el.appendChild(head);
  for (const it of items) {
    if (it.separator) {
      const hr = document.createElement('div');
      hr.className = 'ctx-sep';
      el.appendChild(hr);
      continue;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    b.disabled = !!it.disabled;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeMenu();
      it.action?.();
    });
    el.appendChild(b);
  }
  document.body.appendChild(el);
  // 画面からはみ出さないように位置を調整
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 8))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 8))}px`;
  openMenuEl = el;
}

let openModalEl: HTMLElement | null = null;

export function closeModal(): void {
  openModalEl?.remove();
  openModalEl = null;
}

// body には HTML を渡す。ボタンの処理は onMount で要素に登録する
export function showModal(title: string, body: string, onMount?: (el: HTMLElement) => void, wide = false): void {
  closeModal();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal${wide ? ' wide' : ''}"><div class="modal-head"><span>${esc(title)}</span><button class="modal-close" title="閉じる（Esc）">×</button></div><div class="modal-body">${body}</div></div>`;
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) closeModal();
  });
  back.querySelector('.modal-close')!.addEventListener('click', closeModal);
  document.body.appendChild(back);
  openModalEl = back;
  onMount?.(back.querySelector('.modal-body') as HTMLElement);
}

export function isModalOpen(): boolean {
  return openModalEl !== null;
}

export function askNumber(message: string, def = '1'): number | null {
  const v = window.prompt(message, def);
  if (v === null) return null;
  const n = parseInt(v.replace(/[＋+]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

// 「+2/-1」「2 1」などを [攻撃力, 体力] に
export function askStats(message: string): [number, number] | null {
  const v = window.prompt(message, '+1/+1');
  if (v === null) return null;
  const m = v.replace(/[＋]/g, '+').replace(/[－−]/g, '-').match(/^\s*([+-]?\d+)\s*[/／\s]\s*([+-]?\d+)\s*$/);
  if (!m) {
    window.alert('「+2/+1」の形で入力してください');
    return null;
  }
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

export function download(filename: string, text: string, type = 'text/plain'): void {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function pickFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      resolve(f ? await f.text() : null);
    });
    input.click();
  });
}
