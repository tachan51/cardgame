// 対戦の準備: 自分のデッキと AI のデッキを選ぶ（2-6・3-3）。見本デッキと自分で作ったデッキから選べる
import { getLeader, validateDeck, type AiLevel, type DeckDef } from '../../../engine/src';
import { cat } from '../data';
import { allDecks, findDeck, isPlayable } from '../decks';
import { LEVEL_LABEL, type Game } from '../game';
import { esc } from '../text';

const choice = { human: '', ai: '', first: 'random' as 'A' | 'B' | 'random', level: 'normal' as AiLevel };

/** 準備画面で最初に選んでおくデッキ（デッキ構築から戻ったときなど） */
export function selectHumanDeck(id: string): void {
  choice.human = id;
}

function ensureChoice(): void {
  const { samples, user } = allDecks();
  const ids = [...samples, ...user].map((d) => d.id);
  if (!ids.includes(choice.human)) choice.human = user.find(isPlayable)?.id ?? samples[0]?.id ?? '';
  if (!ids.includes(choice.ai) || choice.ai === '') choice.ai = samples.find((d) => d.id !== choice.human)?.id ?? samples[0]?.id ?? '';
}

function deckInfo(id: string): string {
  const d = findDeck(id);
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

function options(sel: string): string {
  const { samples, user } = allDecks();
  const opt = (d: DeckDef) => `<option value="${esc(d.id)}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}${isPlayable(d) ? '' : '（未完成・対戦に使えない）'}</option>`;
  return `<optgroup label="見本デッキ">${samples.map(opt).join('')}</optgroup>${user.length ? `<optgroup label="自分のデッキ">${user.map(opt).join('')}</optgroup>` : ''}`;
}

export function renderSetup(root: HTMLElement, game: Game, hasSave: boolean, openBuilder: (deckId?: string) => void): void {
  ensureChoice();
  const opts = options;
  const playable = [choice.human, choice.ai].every((id) => {
    const d = findDeck(id);
    return !!d && isPlayable(d);
  });
  root.innerHTML = `<div class="setup">
    <h1>カードゲーム 試遊版</h1>
    <p class="muted">デッキを選んで AI と対戦します。ルールはすべて自動で処理されます。自分でデッキを作ることもできます。</p>
    <div class="setup-cols">
      <section><h2>あなたのデッキ</h2><select data-sel="human">${opts(choice.human)}</select>${deckInfo(choice.human)}
        <div class="row"><button data-builder="new">デッキを作る</button>${choice.human.startsWith('user-') ? '<button data-builder="edit">このデッキを編集する</button>' : ''}</div></section>
      <section><h2>AI のデッキ</h2><select data-sel="ai">${opts(choice.ai)}</select>${deckInfo(choice.ai)}</section>
    </div>
    <div class="row">
      <label>第1ラウンドの先手
        <select data-sel="first">
          <option value="random" ${choice.first === 'random' ? 'selected' : ''}>ランダム</option>
          <option value="A" ${choice.first === 'A' ? 'selected' : ''}>あなた</option>
          <option value="B" ${choice.first === 'B' ? 'selected' : ''}>AI</option>
        </select></label>
      <label>AI の強さ
        <select data-sel="level">
          ${(['easy', 'normal', 'hard'] as AiLevel[]).map((l) => `<option value="${l}" ${choice.level === l ? 'selected' : ''}>${LEVEL_LABEL[l]}</option>`).join('')}
        </select></label>
      <button class="primary" data-go ${playable ? '' : 'disabled'}>対戦を始める</button>
      ${playable ? '' : '<span class="error small">条件を満たしていないデッキでは対戦できません（デッキ構築で直してください）</span>'}
      ${hasSave ? '<button data-resume>前回の続きから</button>' : ''}
    </div>
    <details class="rules"><summary>遊び方（かんたんな説明）</summary>
      <ul>
        <li>毎ラウンド、交互に1つずつ行動します（カードを使う・ユニットを遊撃で動かす・リーダー能力を使う・パスなど）。双方が続けてパスすると戦闘です。</li>
        <li>戦闘では、前列のユニット（と射撃を持つ後列のユニット）が同じレーンの正面を攻撃します。相手の前列 → 後列 → 本体の順に当たります。</li>
        <li>通常マナ（◆）は毎ラウンド全回復します。使い残した分は次のラウンドに予備マナ（◇）として貯まり、リーダー能力・強化・起動に使えます。</li>
        <li>遅延（⏳）の効果は、使った人の次の手番の始めに発動します。発動までの間に、移動などで避けられます。</li>
        <li>右側の「このまま戦闘になったら」に、今の盤面で戦闘になったときの結果が表示されます。</li>
        <li>AI の強さ: やさしい＝その場で良さそうな手を選ぶ（少し手加減する）、ふつう＝その場で一番良い手を選ぶ、つよい＝相手の手札を推測し、ラウンドの終わりまで先を読む。</li>
        <li>詳しいルールは <a href="https://github.com/tachan51/cardgame/blob/main/docs/rules.md" target="_blank" rel="noopener">ルール仕様書</a> を見てください。</li>
      </ul>
    </details>
  </div>`;
  root.querySelectorAll<HTMLSelectElement>('[data-sel]').forEach((sel) =>
    sel.addEventListener('change', () => {
      const k = sel.dataset.sel as 'human' | 'ai' | 'first' | 'level';
      if (k === 'first') choice.first = sel.value as 'A' | 'B' | 'random';
      else if (k === 'level') choice.level = sel.value as AiLevel;
      else choice[k] = sel.value;
      renderSetup(root, game, hasSave, openBuilder);
    }),
  );
  root.querySelector('[data-go]')!.addEventListener('click', () => {
    const h = findDeck(choice.human);
    const a = findDeck(choice.ai);
    if (h && a && isPlayable(h) && isPlayable(a)) game.start(h, a, choice.first, choice.level);
  });
  root.querySelector('[data-resume]')?.addEventListener('click', () => game.resume());
  root.querySelector('[data-builder="new"]')?.addEventListener('click', () => openBuilder());
  root.querySelector('[data-builder="edit"]')?.addEventListener('click', () => openBuilder(choice.human));
}
