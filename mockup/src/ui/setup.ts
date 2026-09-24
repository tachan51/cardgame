// 試合の準備画面: デッキの選択（見本・テキスト貼り付け・JSON）、先手の決定（docs/mockup.md 7章）
import { catalog, leader } from '../data';
import { deckSize, deckToText, parseDeckJson, parseDeckText, validateDeck } from '../deck';
import { setupDeck, startGame } from '../game';
import type { Store } from '../store';
import type { DeckDef, PlayerId } from '../types';
import { esc, pickFile } from './common';

interface Draft {
  deck: DeckDef | null;
  source: string; // 見本デッキの id、または 'text' / 'json'
  text: string;
  errors: string[];
}

const drafts: Record<PlayerId, Draft> = {
  A: sampleDraft(0),
  B: sampleDraft(1),
};
let firstChoice: PlayerId | 'random' = 'random';

function sampleDraft(i: number): Draft {
  const d = catalog.sampleDecks[i] ?? catalog.sampleDecks[0] ?? null;
  return { deck: d, source: d?.id ?? '', text: d ? deckToText(d) : '', errors: [] };
}

function deckSummary(d: DeckDef): string {
  const leaders = d.leaders.map((id) => {
    try {
      const l = leader(id);
      return `${l.title} ${l.name}`;
    } catch {
      return id;
    }
  });
  const warnings = validateDeck(d, catalog);
  return `<div class="deck-summary">
    <div><b>${esc(d.name)}</b>（${deckSize(d)}枚）</div>
    <div class="muted">リーダー: ${esc(leaders.join(' ＋ '))}</div>
    ${d.description ? `<div class="desc">${esc(d.description)}</div>` : ''}
    ${warnings.length ? `<ul class="warn">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul><div class="muted">警告があっても遊べます。</div>` : '<div class="ok">デッキの条件を満たしています</div>'}
  </div>`;
}

function playerColumn(p: PlayerId): string {
  const d = drafts[p];
  const options = catalog.sampleDecks
    .map((s) => `<option value="${esc(s.id)}" ${d.source === s.id ? 'selected' : ''}>${esc(s.name)}</option>`)
    .join('');
  return `<section class="setup-col">
    <h2>プレイヤー ${p}</h2>
    <label>見本デッキ <select data-setup-sample="${p}">${options}${d.source === 'text' || d.source === 'json' ? '<option selected>（読み込んだデッキ）</option>' : ''}</select></label>
    <details ${d.source === 'text' ? 'open' : ''}>
      <summary>テキストを貼り付けて読み込む</summary>
      <textarea data-setup-text="${p}" rows="10" spellcheck="false" placeholder="# デッキ名&#10;leader: leader-alto&#10;leader: leader-rei&#10;KN-09 x3&#10;CY-17 2">${esc(d.text)}</textarea>
      <div class="row"><button data-setup-parse="${p}">テキストを読み込む</button><button data-setup-json="${p}">JSON ファイルを読み込む</button></div>
      ${d.errors.length ? `<ul class="warn">${d.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    </details>
    ${d.deck ? deckSummary(d.deck) : '<div class="warn">デッキが選ばれていません</div>'}
  </section>`;
}

export function renderSetup(root: HTMLElement, store: Store): void {
  root.innerHTML = `<div class="setup">
    <h1>手動モックアップ — 試合の準備</h1>
    <p class="muted">ルールの判定はしません。カードの移動や数値の変更は手で行い、ルールが正しいかは遊ぶ人が判断します。</p>
    <p><a href="./play/">ルールを自動で処理する AI 対戦の試遊版はこちら →</a></p>
    <div class="setup-cols">${playerColumn('A')}${playerColumn('B')}</div>
    <div class="setup-foot">
      <label>第1ラウンドの先手
        <select data-setup-first>
          <option value="random" ${firstChoice === 'random' ? 'selected' : ''}>ランダム</option>
          <option value="A" ${firstChoice === 'A' ? 'selected' : ''}>A</option>
          <option value="B" ${firstChoice === 'B' ? 'selected' : ''}>B</option>
        </select></label>
      <button class="primary" data-setup-start ${drafts.A.deck && drafts.B.deck ? '' : 'disabled'}>試合を始める（4枚引いてマリガンへ）</button>
      <button data-setup-load>保存した試合を読み込む（JSON）</button>
    </div>
  </div>`;

  const rerender = () => renderSetup(root, store);

  root.querySelectorAll<HTMLSelectElement>('[data-setup-sample]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const p = sel.dataset.setupSample as PlayerId;
      const d = catalog.sampleDecks.find((x) => x.id === sel.value);
      if (d) drafts[p] = { deck: d, source: d.id, text: deckToText(d), errors: [] };
      rerender();
    });
  });
  root.querySelectorAll<HTMLTextAreaElement>('[data-setup-text]').forEach((ta) => {
    ta.addEventListener('input', () => {
      drafts[ta.dataset.setupText as PlayerId].text = ta.value;
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-setup-parse]').forEach((b) => {
    b.addEventListener('click', () => {
      const p = b.dataset.setupParse as PlayerId;
      const { deck, errors } = parseDeckText(drafts[p].text);
      drafts[p] = { deck, source: 'text', text: drafts[p].text, errors };
      rerender();
    });
  });
  root.querySelectorAll<HTMLButtonElement>('[data-setup-json]').forEach((b) => {
    b.addEventListener('click', async () => {
      const p = b.dataset.setupJson as PlayerId;
      const text = await pickFile('.json,application/json');
      if (!text) return;
      try {
        const deck = parseDeckJson(text);
        drafts[p] = { deck, source: 'json', text: deckToText(deck), errors: [] };
      } catch (e) {
        drafts[p].errors = [String((e as Error).message)];
      }
      rerender();
    });
  });
  root.querySelector<HTMLSelectElement>('[data-setup-first]')!.addEventListener('change', (e) => {
    firstChoice = (e.target as HTMLSelectElement).value as PlayerId | 'random';
  });
  root.querySelector('[data-setup-start]')!.addEventListener('click', () => {
    const a = drafts.A.deck;
    const b = drafts.B.deck;
    if (!a || !b) return;
    store.dispatch('試合開始', (s) => {
      setupDeck(s, 'A', a);
      setupDeck(s, 'B', b);
      startGame(s, firstChoice);
    });
  });
  root.querySelector('[data-setup-load]')!.addEventListener('click', async () => {
    const text = await pickFile('.json,application/json');
    if (!text) return;
    try {
      const s = JSON.parse(text);
      if (s.version !== 1 || !s.players) throw new Error('試合のファイルではありません');
      store.replace(s);
    } catch (e) {
      window.alert(`読み込めませんでした: ${(e as Error).message}`);
    }
  });
}
