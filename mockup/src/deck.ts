// デッキの読み込み（テキスト形式・JSON）と条件の確認（docs/mockup.md 7.3、ルール仕様書 3.1）
import type { Catalog } from './data';
import type { DeckDef } from './types';

export const DECK_SIZE = 40;
export const MAX_COPIES = 3;

// テキスト形式:
//   # デッキ名
//   leader: leader-alto
//   KN-09 x3   /   KN-09 3   /   KN-09
export function parseDeckText(text: string): { deck: DeckDef; errors: string[] } {
  const errors: string[] = [];
  let name = '';
  const leaders: string[] = [];
  const counts = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      if (!name) name = line.replace(/^#+\s*/, '');
      return;
    }
    const lm = line.match(/^leader\s*[:：]\s*(\S+)$/i);
    if (lm) {
      leaders.push(lm[1]);
      return;
    }
    const cm = line.match(/^(\S+)(?:\s+[x×]?\s*(\d+))?$/i);
    if (!cm) {
      errors.push(`${i + 1}行目を読めません: ${line}`);
      return;
    }
    const n = cm[2] ? parseInt(cm[2], 10) : 1;
    counts.set(cm[1], (counts.get(cm[1]) ?? 0) + n);
  });
  const deck: DeckDef = {
    id: 'pasted',
    name: name || '貼り付けたデッキ',
    leaders,
    cards: [...counts.entries()].map(([id, count]) => ({ id, count })),
  };
  return { deck, errors };
}

export function deckToText(deck: DeckDef): string {
  const lines = [`# ${deck.name}`, ...deck.leaders.map((l) => `leader: ${l}`)];
  for (const c of deck.cards) lines.push(`${c.id} x${c.count}`);
  return lines.join('\n');
}

export function parseDeckJson(text: string): DeckDef {
  const d = JSON.parse(text) as DeckDef;
  if (!Array.isArray(d.leaders) || !Array.isArray(d.cards)) {
    throw new Error('デッキの JSON に leaders と cards がありません');
  }
  return { ...d, id: d.id ?? 'loaded', name: d.name ?? '読み込んだデッキ' };
}

// デッキの条件を確認し、警告の一覧を返す（警告があっても遊べる）
export function validateDeck(deck: DeckDef, cat: Catalog): string[] {
  const w: string[] = [];
  if (deck.leaders.length !== 2) w.push(`リーダーは2人必要です（現在 ${deck.leaders.length}人）`);
  const leaderFactions: string[] = [];
  for (const l of deck.leaders) {
    const ld = cat.leaders.get(l);
    if (!ld) w.push(`不明なリーダー: ${l}`);
    else leaderFactions.push(ld.faction);
  }
  if (leaderFactions.length === 2 && leaderFactions[0] === leaderFactions[1]) {
    w.push('2人のリーダーは異なる勢力でなければなりません');
  }
  let total = 0;
  for (const { id, count } of deck.cards) {
    total += count;
    const c = cat.cards.get(id);
    if (!c) {
      w.push(`不明なカード: ${id}`);
      continue;
    }
    if (count > MAX_COPIES) w.push(`${c.name}（${id}）が ${count}枚あります（${MAX_COPIES}枚まで）`);
    if (leaderFactions.length === 2 && !leaderFactions.includes(c.faction)) {
      w.push(`${c.name}（${id}）はリーダーの勢力のカードではありません`);
    }
  }
  if (total !== DECK_SIZE) w.push(`デッキは ${DECK_SIZE}枚ちょうどが必要です（現在 ${total}枚）`);
  return w;
}

export function deckSize(deck: DeckDef): number {
  return deck.cards.reduce((s, c) => s + c.count, 0);
}
