// デッキの保存（3-2）と、テキスト形式での書き出し・読み込み
import { DECK_SIZE, validateDeck, type DeckDef } from '../../engine/src';
import { cat, decks as samples } from './data';

const KEY = 'cardgame-decks-v1';

/** 自分で作ったデッキ（ブラウザに保存したもの） */
export function loadUserDecks(): DeckDef[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as DeckDef[]) : [];
    return Array.isArray(list) ? list.filter((d) => d && Array.isArray(d.leaders) && Array.isArray(d.cards)) : [];
  } catch {
    return [];
  }
}

function store(list: DeckDef[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** 保存する（条件を満たさない作りかけのデッキも保存できる。対戦には使えない）。保存したデッキを返す */
export function saveUserDeck(deck: DeckDef): DeckDef {
  const list = loadUserDecks();
  const saved: DeckDef = { ...deck, formatVersion: 1, id: deck.id.startsWith('user-') ? deck.id : newDeckId(), cards: sortCards(deck.cards) };
  const i = list.findIndex((d) => d.id === saved.id);
  if (i >= 0) list[i] = saved;
  else list.push(saved);
  store(list);
  return saved;
}

/** 対戦に使えるか（デッキの条件を満たしているか。ルール仕様書 3.1） */
export function isPlayable(deck: DeckDef): boolean {
  return validateDeck(deck, cat).length === 0;
}

export function deleteUserDeck(id: string): void {
  store(loadUserDecks().filter((d) => d.id !== id));
}

export function newDeckId(): string {
  return `user-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function isUserDeck(id: string): boolean {
  return id.startsWith('user-');
}

/** 見本デッキと自分のデッキ */
export function allDecks(): { samples: DeckDef[]; user: DeckDef[] } {
  return { samples, user: loadUserDecks() };
}

export function findDeck(id: string): DeckDef | undefined {
  return samples.find((d) => d.id === id) ?? loadUserDecks().find((d) => d.id === id);
}

export function deckSize(deck: DeckDef): number {
  return deck.cards.reduce((s, c) => s + c.count, 0);
}

/** カードをコスト順・ID順に並べる */
export function sortCards(cards: DeckDef['cards']): DeckDef['cards'] {
  return cards
    .filter((c) => c.count > 0)
    .sort((a, b) => (cat.cards.get(a.id)?.cost ?? 99) - (cat.cards.get(b.id)?.cost ?? 99) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------- テキスト形式
// # デッキ名
// leader: leader-alto
// KN-09 x3   /   KN-09 3   /   KN-09

export function deckToText(deck: DeckDef): string {
  const lines = [`# ${deck.name}`, ...deck.leaders.map((l) => `leader: ${l}`)];
  for (const c of sortCards(deck.cards)) lines.push(`${c.id} x${c.count}`);
  return lines.join('\n');
}

export function parseDeckText(text: string): { deck: DeckDef; errors: string[] } {
  const errors: string[] = [];
  let name = '';
  const leaders: string[] = [];
  const counts = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      if (!name) name = line.replace(/^#+\s*/, '');
      return;
    }
    const lm = line.match(/^leader\s*[:：]\s*(\S+)$/i);
    if (lm) {
      if (!cat.leaders.has(lm[1])) errors.push(`${i + 1}行目: リーダー ${lm[1]} がいません`);
      else leaders.push(lm[1]);
      return;
    }
    const cm = line.match(/^(\S+)(?:\s+[x×]?\s*(\d+))?$/i);
    if (!cm) return void errors.push(`${i + 1}行目を読めません: ${line}`);
    if (!cat.cards.has(cm[1])) return void errors.push(`${i + 1}行目: カード ${cm[1]} がありません`);
    counts.set(cm[1], (counts.get(cm[1]) ?? 0) + (cm[2] ? parseInt(cm[2], 10) : 1));
  });
  const deck: DeckDef = {
    formatVersion: 1,
    id: newDeckId(),
    name: name || '読み込んだデッキ',
    leaders,
    cards: sortCards([...counts.entries()].map(([id, count]) => ({ id, count }))),
  };
  return { deck, errors };
}

export { DECK_SIZE };
