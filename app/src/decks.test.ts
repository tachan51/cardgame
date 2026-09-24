import { beforeEach, describe, expect, it } from 'vitest';
import { decks as samples } from './data';
import { deckToText, deleteUserDeck, findDeck, loadUserDecks, parseDeckText, saveUserDeck } from './decks';

// Node には localStorage がないので、テスト用に置き換える
const mem = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: () => null,
  length: 0,
};

describe('デッキの保存（3-2）', () => {
  beforeEach(() => mem.clear());

  it('条件を満たすデッキを保存・読み込み・削除できる', () => {
    const saved = saveUserDeck({ ...structuredClone(samples[0]), id: 'tmp', name: '自作' });
    expect(saved.id.startsWith('user-')).toBe(true);
    expect(loadUserDecks().map((d) => d.name)).toEqual(['自作']);
    expect(findDeck(saved.id)?.name).toBe('自作');
    // 上書き
    saveUserDeck({ ...saved, name: '自作2' });
    expect(loadUserDecks().map((d) => d.name)).toEqual(['自作2']);
    deleteUserDeck(saved.id);
    expect(loadUserDecks()).toEqual([]);
  });

  it('条件を満たさないデッキは保存できない（3-1）', () => {
    const d = structuredClone(samples[0]);
    d.cards[0].count -= 1; // 39枚
    expect(() => saveUserDeck(d)).toThrow(/40/);
    const same = { ...structuredClone(samples[0]), leaders: ['leader-alto', 'leader-alto'] };
    expect(() => saveUserDeck(same)).toThrow(/異なる勢力/);
    expect(loadUserDecks()).toEqual([]);
  });

  it('保存データが壊れていても空として扱う', () => {
    mem.set('cardgame-decks-v1', '{broken');
    expect(loadUserDecks()).toEqual([]);
  });
});

describe('テキスト形式', () => {
  it('書き出したテキストを読み込むと同じデッキになる', () => {
    for (const d of samples) {
      const { deck, errors } = parseDeckText(deckToText(d));
      expect(errors).toEqual([]);
      expect(deck.leaders).toEqual(d.leaders);
      const sum = (x: typeof d) => Object.fromEntries(x.cards.map((c) => [c.id, c.count]));
      expect(sum(deck)).toEqual(sum(d));
    }
  });

  it('知らないカード・リーダーや読めない行を知らせる', () => {
    const { deck, errors } = parseDeckText('# t\nleader: leader-xx\nleader: leader-rei\nKN-09 3\nZZ-01 x2\nKN-01\n?? ?? ??');
    expect(deck.name).toBe('t');
    expect(deck.leaders).toEqual(['leader-rei']);
    expect(deck.cards).toEqual([
      { id: 'KN-01', count: 1 },
      { id: 'KN-09', count: 3 },
    ]);
    expect(errors.length).toBe(3);
  });
});
