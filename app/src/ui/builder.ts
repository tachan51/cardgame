// デッキ構築画面（3-1〜3-2）
// リーダー2人（異なる勢力）を選び、2勢力のカードから40枚（同名3枚まで）を選ぶ。
// 作りかけ（40枚ちょうどでない）でも保存できるが、対戦には使えない
import { MAX_COPIES, validateDeck, type CardDef, type DeckDef, type FactionId } from '../../../engine/src';
import { cat, decks as samples } from '../data';
import { deckSize, deckToText, deleteUserDeck, DECK_SIZE, loadUserDecks, newDeckId, parseDeckText, saveUserDeck, sortCards } from '../decks';
import { esc, KEYWORD_LABEL, leaderLabel, richText } from '../text';

interface BuilderState {
  draft: DeckDef;
  /** 保存済みのデッキを編集しているとき、その ID */
  editing: string | null;
  dirty: boolean;
  filter: { faction: FactionId | 'all'; type: 'all' | 'unit' | 'spell'; cost: 'all' | number; text: string };
  message: string | null;
  error: string | null;
  textBox: 'export' | 'import' | null;
  importText: string;
}

const b: BuilderState = {
  draft: emptyDeck(),
  editing: null,
  dirty: false,
  filter: { faction: 'all', type: 'all', cost: 'all', text: '' },
  message: null,
  error: null,
  textBox: null,
  importText: '',
};

function emptyDeck(): DeckDef {
  return { formatVersion: 1, id: newDeckId(), name: '新しいデッキ', leaders: [], cards: [] };
}

export interface BuilderCallbacks {
  /** 準備画面に戻る。deckId を渡すとそのデッキを選んだ状態にする */
  back: (deckId?: string) => void;
}

/** 編集を始めるデッキを指定して開く */
export function openBuilder(deckId?: string): void {
  const user = loadUserDecks().find((d) => d.id === deckId);
  if (user) {
    b.draft = structuredClone(user);
    b.editing = user.id;
  } else {
    b.draft = emptyDeck();
    b.editing = null;
  }
  b.dirty = false;
  b.message = null;
  b.error = null;
  b.textBox = null;
}

const leaderFactions = (d: DeckDef): FactionId[] => d.leaders.map((id) => cat.leaders.get(id)?.faction).filter((f): f is FactionId => !!f);

function countOf(id: string): number {
  return b.draft.cards.find((c) => c.id === id)?.count ?? 0;
}

function setCount(id: string, n: number): void {
  const cards = b.draft.cards.filter((c) => c.id !== id);
  if (n > 0) cards.push({ id, count: n });
  b.draft.cards = sortCards(cards);
  b.dirty = true;
}

/** 追加できないならその理由 */
function cannotAdd(card: CardDef): string | null {
  const facs = leaderFactions(b.draft);
  if (facs.length < 2) return 'リーダーを2人選んでください';
  if (!facs.includes(card.faction)) return 'リーダーの勢力のカードではありません';
  if (countOf(card.id) >= MAX_COPIES) return `同名のカードは${MAX_COPIES}枚までです`;
  return null;
}

// ---------------------------------------------------------------- 描画

/** 描画し直してもスクロールの位置が変わらないように、描き直す前の位置を覚えておく */
const SCROLLERS = ['.builder .center', '.deck-list', '.builder .side'];

export function renderBuilder(root: HTMLElement, cb: BuilderCallbacks): void {
  const rerender = () => renderBuilder(root, cb);
  const scroll = SCROLLERS.map((sel) => root.querySelector(sel)?.scrollTop ?? 0);
  const winY = window.scrollY;
  const d = b.draft;
  const problems = validateDeck(d, cat);
  const size = deckSize(d);
  const facs = leaderFactions(d);

  root.innerHTML = `<div class="builder">
    <header class="topbar">
      <div class="title">デッキ構築</div>
      <div class="status">${b.error ? `<span class="error">${esc(b.error)}</span>` : b.message ? `<span class="ok">${esc(b.message)}</span>` : '<span class="muted">リーダー2人を選び、その2勢力のカードから40枚を選んでください（同名3枚まで）</span>'}</div>
      <div class="actions"><button data-b="back">準備画面に戻る</button></div>
    </header>
    <div class="builder-layout">
      <aside class="side">${deckListHtml()}</aside>
      <main class="center">
        <section class="box">
          <label>デッキ名 <input data-b="name" value="${esc(d.name)}" maxlength="40" /></label>
          <h3 style="margin-top:10px">リーダー（2人・異なる勢力）</h3>
          <div class="leader-pick">${[...cat.leaders.values()]
            .map((l) => {
              const on = d.leaders.includes(l.id);
              return `<button class="leader-opt fac-${l.faction} ${on ? 'on' : ''}" data-b="leader" data-id="${l.id}" data-leader-id="${l.id}">
                <b>${esc(leaderLabel(l.id))}</b><span class="small muted">${esc(cat.factions.get(l.faction) ?? '')}</span></button>`;
            })
            .join('')}</div>
        </section>
        ${filterHtml(facs)}
        <div class="pool">${poolHtml(facs)}</div>
      </main>
      <aside class="side right">${summaryHtml(d, size, problems)}
        <div class="detail" id="detail"><div class="muted">カードにマウスを乗せると詳しく表示します</div></div>
      </aside>
    </div>
    ${b.textBox ? textBoxHtml() : ''}
  </div>`;

  SCROLLERS.forEach((sel, i) => {
    const el = root.querySelector(sel);
    if (el) el.scrollTop = scroll[i];
  });
  window.scrollTo(0, winY);

  root.onclick = (e) => onClick(e, root, cb, rerender);
  root.onmouseover = (e) => onHover(e, root);
  root.oncontextmenu = (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-card]');
    if (!el) return;
    e.preventDefault();
    const id = el.dataset.card!;
    if (countOf(id) > 0) {
      setCount(id, countOf(id) - 1);
      b.message = b.error = null;
      rerender();
    }
  };
  const name = root.querySelector<HTMLInputElement>('[data-b="name"]');
  name?.addEventListener('input', () => {
    b.draft.name = name.value;
    b.dirty = true;
  });
  const search = root.querySelector<HTMLInputElement>('[data-b="search"]');
  search?.addEventListener('input', () => {
    b.filter.text = search.value;
    const pool = root.querySelector('.pool');
    if (pool) pool.innerHTML = poolHtml(leaderFactions(b.draft));
  });
  const imp = root.querySelector<HTMLTextAreaElement>('[data-b="import-text"]');
  imp?.addEventListener('input', () => {
    b.importText = imp.value;
  });
}

function deckListHtml(): string {
  const user = loadUserDecks();
  const item = (dk: DeckDef, mine: boolean) => {
    const active = b.editing === dk.id;
    return `<div class="deck-item ${active ? 'active' : ''}">
      <div><b>${esc(dk.name)}</b></div>
      <div class="small muted">${dk.leaders.map((l) => (cat.leaders.get(l) ? cat.leaders.get(l)!.name : l)).join('＋')}</div>
      <div class="row small">${
        mine
          ? `<button data-b="edit" data-id="${esc(dk.id)}">編集</button><button data-b="delete" data-id="${esc(dk.id)}">削除</button>`
          : `<button data-b="copy" data-id="${esc(dk.id)}">コピーして編集</button>`
      }</div></div>`;
  };
  return `<section class="box">
      <div class="row"><button class="primary" data-b="new">新しいデッキ</button><button data-b="open-import">テキストから読み込む</button></div>
      <h3>自分のデッキ（${user.length}）</h3>
      ${user.length ? user.map((dk) => item(dk, true)).join('') : '<div class="muted small">まだありません</div>'}
      <h3 style="margin-top:10px">見本デッキ</h3>
      ${samples.map((dk) => item(dk, false)).join('')}
    </section>`;
}

function filterHtml(facs: FactionId[]): string {
  const f = b.filter;
  const facOpts = (facs.length ? facs : ([...cat.factions.keys()] as FactionId[]))
    .map((id) => `<button data-b="f-faction" data-v="${id}" class="${f.faction === id ? 'on' : ''}">${esc(cat.factions.get(id) ?? id)}</button>`)
    .join('');
  const costs = [1, 2, 3, 4, 5, 6, 7]
    .map((c) => `<button data-b="f-cost" data-v="${c}" class="${f.cost === c ? 'on' : ''}">${c === 7 ? '7+' : c}</button>`)
    .join('');
  return `<section class="filters box">
    <span class="small muted">勢力</span><button data-b="f-faction" data-v="all" class="${f.faction === 'all' ? 'on' : ''}">すべて</button>${facOpts}
    <span class="small muted">種類</span>${(['all', 'unit', 'spell'] as const)
      .map((t) => `<button data-b="f-type" data-v="${t}" class="${f.type === t ? 'on' : ''}">${t === 'all' ? 'すべて' : t === 'unit' ? 'ユニット' : 'スペル'}</button>`)
      .join('')}
    <span class="small muted">コスト</span><button data-b="f-cost" data-v="all" class="${f.cost === 'all' ? 'on' : ''}">すべて</button>${costs}
    <input data-b="search" placeholder="名前・効果で探す" value="${esc(f.text)}" />
  </section>`;
}

function poolCards(facs: FactionId[]): CardDef[] {
  const f = b.filter;
  const text = f.text.trim();
  return [...cat.cards.values()]
    .filter((c) => !c.token)
    .filter((c) => (facs.length ? facs.includes(c.faction) : true))
    .filter((c) => f.faction === 'all' || c.faction === f.faction)
    .filter((c) => f.type === 'all' || c.type === f.type)
    .filter((c) => f.cost === 'all' || (f.cost === 7 ? c.cost >= 7 : c.cost === f.cost))
    .filter((c) => !text || c.name.includes(text) || c.text.includes(text) || (c.keywords ?? []).some((k) => KEYWORD_LABEL[k].includes(text)))
    .sort((a, c) => a.cost - c.cost || a.faction.localeCompare(c.faction) || a.id.localeCompare(c.id));
}

function poolHtml(facs: FactionId[]): string {
  const list = poolCards(facs);
  const note = facs.length < 2 ? '<div class="hint">リーダーを2人選ぶと、その2勢力のカードを追加できます。</div>' : '';
  if (!list.length) return `${note}<div class="muted">条件に合うカードはありません</div>`;
  return (
    note +
    list
      .map((c) => {
        const n = countOf(c.id);
        const reason = cannotAdd(c);
        return `<div class="card pool-card fac-${c.faction} ${n ? 'in-deck' : ''} ${reason ? 'unusable' : 'usable'}" data-card="${c.id}" data-card-id="${c.id}" title="${esc(reason ?? 'クリックで追加、右クリックで減らす')}">
          <div class="cost">${c.cost}</div>
          <div class="cname">${esc(c.name)}</div>
          <div class="ctype small">${c.type === 'unit' ? `ユニット　⚔${c.attack} ♥${c.health}` : 'スペル'}</div>
          <div class="kws">${(c.keywords ?? []).map((k) => `<span class="kw">${KEYWORD_LABEL[k]}</span>`).join('')}</div>
          <div class="ctext">${richText(c.text)}</div>
          <div class="count-row"><button data-b="minus" data-id="${c.id}" ${n ? '' : 'disabled'}>−</button><span class="count">${n}/${MAX_COPIES}</span><button data-b="plus" data-id="${c.id}" ${reason ? 'disabled' : ''}>＋</button></div>
        </div>`;
      })
      .join('')
  );
}

function summaryHtml(d: DeckDef, size: number, problems: string[]): string {
  const curve = [0, 0, 0, 0, 0, 0, 0];
  let units = 0;
  const byFac = new Map<string, number>();
  for (const { id, count } of d.cards) {
    const c = cat.cards.get(id);
    if (!c) continue;
    curve[Math.min(Math.max(c.cost, 1), 7) - 1] += count;
    if (c.type === 'unit') units += count;
    byFac.set(c.faction, (byFac.get(c.faction) ?? 0) + count);
  }
  const max = Math.max(4, ...curve);
  const bars = curve
    .map(
      (n, i) =>
        `<div class="bar"><div class="n">${n}</div><div class="col"><div class="fill" style="height:${(n / max) * 100}%"></div></div><div class="c">${i === 6 ? '7+' : i + 1}</div></div>`,
    )
    .join('');
  const list = d.cards
    .map(({ id, count }) => {
      const c = cat.cards.get(id);
      return `<div class="deck-line fac-${c?.faction}" data-card-id="${id}"><span class="lc">${c?.cost ?? '?'}</span><span class="ln">${esc(c?.name ?? id)}</span><span class="lx">×${count}</span><button data-b="minus" data-id="${id}">−</button></div>`;
    })
    .join('');
  const valid = problems.length === 0;
  return `<section class="box summary">
    <h2>${esc(d.name || '（名前なし）')}</h2>
    <div class="size ${size === DECK_SIZE ? 'ok' : size > DECK_SIZE ? 'over' : ''}">${size} / ${DECK_SIZE} 枚</div>
    <div class="small">ユニット ${units}　スペル ${size - units}${[...byFac.entries()].map(([f, n]) => `　${esc(cat.factions.get(f as FactionId) ?? f)} ${n}`).join('')}</div>
    <div class="curve">${bars}</div>
    <div class="deck-list">${list || '<div class="muted small">カードを選ぶとここに並びます</div>'}</div>
    ${valid ? '<div class="ok small">デッキの条件を満たしています</div>' : `<ul class="warn small">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul><div class="muted small">条件を満たしていなくても保存できます（対戦には使えません）</div>`}
    <div class="row">
      <button class="primary" data-b="save">${b.editing ? '上書き保存' : '保存'}</button>
      ${b.editing ? `<button data-b="save-as">別のデッキとして保存</button>` : ''}
      <button data-b="open-export">テキストで書き出す</button>
      <button data-b="clear">カードを全部外す</button>
    </div>
    ${b.editing && !b.dirty && valid ? `<button class="primary wide" data-b="play">このデッキで対戦する</button>` : ''}
  </section>`;
}

function textBoxHtml(): string {
  if (b.textBox === 'export') {
    return `<div class="overlay"><div class="dialog wide"><h2>テキストで書き出す</h2>
      <p class="muted small">コピーして保存・共有できます。「テキストから読み込む」で戻せます。</p>
      <textarea rows="16" readonly data-b="export-text">${esc(deckToText(b.draft))}</textarea>
      <div class="row"><button data-b="copy-text">コピー</button><button data-b="close-text">閉じる</button></div></div></div>`;
  }
  return `<div class="overlay"><div class="dialog wide"><h2>テキストから読み込む</h2>
    <p class="muted small">1行目に「# デッキ名」、リーダーは「leader: leader-alto」、カードは「KN-09 x3」のように書きます。</p>
    <textarea rows="16" data-b="import-text" placeholder="# デッキ名&#10;leader: leader-alto&#10;leader: leader-rei&#10;KN-09 x3">${esc(b.importText)}</textarea>
    <div class="row"><button class="primary" data-b="do-import">読み込んで編集する</button><button data-b="close-text">閉じる</button></div></div></div>`;
}

// ---------------------------------------------------------------- 操作

function confirmDiscard(): boolean {
  return !b.dirty || window.confirm('保存していない変更があります。破棄してよいですか？');
}

function onClick(e: MouseEvent, root: HTMLElement, cb: BuilderCallbacks, rerender: () => void): void {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLElement>('[data-b]');
  const act = btn?.dataset.b;
  const id = btn?.dataset.id ?? '';
  const v = btn?.dataset.v ?? '';
  if (act !== 'copy-text') {
    b.message = null;
    b.error = null;
  }

  switch (act) {
    case 'back':
      if (!confirmDiscard()) return;
      return cb.back(b.editing ?? undefined);
    case 'play':
      return cb.back(b.editing ?? undefined);
    case 'new':
      if (!confirmDiscard()) return;
      openBuilder();
      return rerender();
    case 'edit':
      if (!confirmDiscard()) return;
      openBuilder(id);
      return rerender();
    case 'copy': {
      if (!confirmDiscard()) return;
      const src = samples.find((dk) => dk.id === id);
      if (!src) return;
      b.draft = { ...structuredClone(src), id: newDeckId(), name: `${src.name.replace(/^見本:\s*/, '')}（コピー）` };
      b.editing = null;
      b.dirty = true;
      b.message = '見本デッキをコピーしました。編集して保存してください';
      return rerender();
    }
    case 'delete': {
      const dk = loadUserDecks().find((x) => x.id === id);
      if (!dk || !window.confirm(`「${dk.name}」を削除しますか？`)) return;
      deleteUserDeck(id);
      if (b.editing === id) {
        b.editing = null;
        b.draft.id = newDeckId();
        b.dirty = true;
      }
      b.message = `「${dk.name}」を削除しました`;
      return rerender();
    }
    case 'leader': {
      const l = cat.leaders.get(id)!;
      const leaders = b.draft.leaders.filter((x) => x !== id);
      if (leaders.length === b.draft.leaders.length) {
        // 追加する。同じ勢力のリーダーはいないが、2人を超えるなら古い方を外す
        const others = leaders.filter((x) => cat.leaders.get(x)?.faction !== l.faction);
        if (others.length >= 2) others.shift();
        b.draft.leaders = [...others, id];
      } else b.draft.leaders = leaders;
      // リーダーの勢力でなくなったカードは外す
      const facs = leaderFactions(b.draft);
      const before = deckSize(b.draft);
      if (facs.length === 2) b.draft.cards = b.draft.cards.filter((c) => facs.includes(cat.cards.get(c.id)!.faction));
      const removed = before - deckSize(b.draft);
      if (removed) b.message = `リーダーの勢力ではなくなったカードを${removed}枚外しました`;
      if (b.filter.faction !== 'all' && !facs.includes(b.filter.faction)) b.filter.faction = 'all';
      b.dirty = true;
      return rerender();
    }
    case 'plus': {
      const c = cat.cards.get(id)!;
      const reason = cannotAdd(c);
      if (reason) b.error = reason;
      else setCount(id, countOf(id) + 1);
      return rerender();
    }
    case 'minus':
      if (countOf(id) > 0) setCount(id, countOf(id) - 1);
      return rerender();
    case 'f-faction':
      b.filter.faction = v as FactionId | 'all';
      return rerender();
    case 'f-type':
      b.filter.type = v as 'all' | 'unit' | 'spell';
      return rerender();
    case 'f-cost':
      b.filter.cost = v === 'all' ? 'all' : Number(v);
      return rerender();
    case 'save':
    case 'save-as':
      try {
        const deck = act === 'save-as' ? { ...b.draft, id: newDeckId() } : b.draft;
        const saved = saveUserDeck(deck);
        b.draft = structuredClone(saved);
        b.editing = saved.id;
        b.dirty = false;
        b.message = validateDeck(saved, cat).length ? `「${saved.name}」を保存しました（条件を満たしていないので、対戦にはまだ使えません）` : `「${saved.name}」を保存しました`;
      } catch (err) {
        b.error = `保存できません: ${(err as Error).message}`;
      }
      return rerender();
    case 'clear':
      if (!b.draft.cards.length || !window.confirm('カードを全部外しますか？')) return;
      b.draft.cards = [];
      b.dirty = true;
      return rerender();
    case 'open-export':
      b.textBox = 'export';
      return rerender();
    case 'open-import':
      b.textBox = 'import';
      return rerender();
    case 'close-text':
      b.textBox = null;
      return rerender();
    case 'copy-text': {
      const ta = root.querySelector<HTMLTextAreaElement>('[data-b="export-text"]');
      if (ta) {
        ta.select();
        navigator.clipboard?.writeText(ta.value).catch(() => document.execCommand('copy'));
      }
      return;
    }
    case 'do-import': {
      if (!confirmDiscard()) return;
      const { deck, errors } = parseDeckText(b.importText);
      b.draft = deck;
      b.editing = null;
      b.dirty = true;
      b.textBox = null;
      if (errors.length) b.error = `読み込めなかった行があります: ${errors.join(' / ')}`;
      else b.message = '読み込みました。確認して保存してください';
      return rerender();
    }
  }

  // カードの札そのもののクリックは1枚追加
  const card = t.closest<HTMLElement>('[data-card]');
  if (card && !btn) {
    const c = cat.cards.get(card.dataset.card!)!;
    const reason = cannotAdd(c);
    if (reason) b.error = reason;
    else setCount(c.id, countOf(c.id) + 1);
    rerender();
  }
}

function onHover(e: MouseEvent, root: HTMLElement): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-card-id],[data-leader-id]');
  const box = root.querySelector('#detail');
  if (!el || !box) return;
  if (el.dataset.leaderId) {
    const l = cat.leaders.get(el.dataset.leaderId)!;
    box.innerHTML = `<h3>${esc(l.title)} ${esc(l.name)}</h3><div class="ctext">${richText(l.text)}</div>`;
    return;
  }
  const c = cat.cards.get(el.dataset.cardId!);
  if (!c) return;
  box.innerHTML = `<h3>${esc(c.name)} <span class="muted small">${c.id}</span></h3>
    <div class="small">${c.type === 'unit' ? 'ユニット' : 'スペル'}　コスト${c.cost}${c.type === 'unit' ? `　${c.attack}/${c.health}` : ''}　${esc(cat.factions.get(c.faction) ?? '')}</div>
    <div class="kws">${(c.keywords ?? []).map((k) => `<span class="kw">${KEYWORD_LABEL[k]}</span>`).join('')}</div>
    <div class="ctext">${richText(c.text || '（効果なし）')}</div>`;
}
