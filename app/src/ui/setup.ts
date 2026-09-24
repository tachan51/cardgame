// 対戦の準備: 自分のデッキと AI のデッキ（固定の見本デッキ）を選ぶ（2-6）
import { getLeader, validateDeck } from '../../../engine/src';
import { cat, deckById, decks } from '../data';
import type { Game } from '../game';
import { esc } from '../text';

const choice = { human: decks[0]?.id ?? '', ai: decks[1]?.id ?? decks[0]?.id ?? '', first: 'random' as 'A' | 'B' | 'random' };

function deckInfo(id: string): string {
  const d = deckById(id);
  if (!d) return '';
  const leaders = d.leaders.map((l) => {
    const def = getLeader(cat, l);
    return `${def.title} ${def.name}`;
  });
  const warn = validateDeck(d, cat);
  return `<div class="deck-info"><div>リーダー: ${esc(leaders.join(' ＋ '))}</div>${d.description ? `<div class="muted">${esc(d.description)}</div>` : ''}${
    warn.length ? `<div class="error">${esc(warn.join(' / '))}</div>` : ''
  }</div>`;
}

export function renderSetup(root: HTMLElement, game: Game, hasSave: boolean): void {
  const opts = (sel: string) => decks.map((d) => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  root.innerHTML = `<div class="setup">
    <h1>カードゲーム 試遊版</h1>
    <p class="muted">見本デッキを選んで AI と対戦します。ルールはすべて自動で処理されます。</p>
    <div class="setup-cols">
      <section><h2>あなたのデッキ</h2><select data-sel="human">${opts(choice.human)}</select>${deckInfo(choice.human)}</section>
      <section><h2>AI のデッキ</h2><select data-sel="ai">${opts(choice.ai)}</select>${deckInfo(choice.ai)}</section>
    </div>
    <div class="row">
      <label>第1ラウンドの先手
        <select data-sel="first">
          <option value="random" ${choice.first === 'random' ? 'selected' : ''}>ランダム</option>
          <option value="A" ${choice.first === 'A' ? 'selected' : ''}>あなた</option>
          <option value="B" ${choice.first === 'B' ? 'selected' : ''}>AI</option>
        </select></label>
      <button class="primary" data-go>対戦を始める</button>
      ${hasSave ? '<button data-resume>前回の続きから</button>' : ''}
    </div>
    <details class="rules"><summary>遊び方（かんたんな説明）</summary>
      <ul>
        <li>毎ラウンド、交互に1つずつ行動します（カードを使う・ユニットを前進させる・リーダー能力を使う・パスなど）。双方が続けてパスすると戦闘です。</li>
        <li>戦闘では、前列のユニット（と射撃を持つ後列のユニット）が同じレーンの正面を攻撃します。相手の前列 → 後列 → 本体の順に当たります。</li>
        <li>通常マナ（◆）は毎ラウンド全回復します。使い残した分は次のラウンドに予備マナ（◇）として貯まり、リーダー能力・強化・起動に使えます。</li>
        <li>遅延（⏳）の効果は、使った人の次の手番の始めに発動します。発動までの間に、移動などで避けられます。</li>
        <li>右側の「このまま戦闘になったら」に、今の盤面で戦闘になったときの結果が表示されます。</li>
        <li>詳しいルールは <a href="https://github.com/tachan51/cardgame/blob/main/docs/rules.md" target="_blank" rel="noopener">ルール仕様書</a> を見てください。</li>
      </ul>
    </details>
  </div>`;
  root.querySelectorAll<HTMLSelectElement>('[data-sel]').forEach((sel) =>
    sel.addEventListener('change', () => {
      const k = sel.dataset.sel as 'human' | 'ai' | 'first';
      if (k === 'first') choice.first = sel.value as 'A' | 'B' | 'random';
      else choice[k] = sel.value;
      renderSetup(root, game, hasSave);
    }),
  );
  root.querySelector('[data-go]')!.addEventListener('click', () => {
    const h = deckById(choice.human);
    const a = deckById(choice.ai);
    if (h && a) game.start(h, a, choice.first);
  });
  root.querySelector('[data-resume]')?.addEventListener('click', () => game.resume());
}
