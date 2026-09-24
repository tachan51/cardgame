import { describe, expect, it } from 'vitest';
import { catalog } from './data';
import { deckSize, deckToText, parseDeckText, validateDeck } from './deck';
import * as G from './game';
import type { GameState } from './types';

function sample(id: string) {
  const d = catalog.sampleDecks.find((x) => x.id === id);
  if (!d) throw new Error(id);
  return d;
}

// A: 守って崩す（アルト＋レイ）、B: 壁の奥から大魔法（アルト＋ノエル）
function started(seed = 42): GameState {
  const s = G.newGame(seed);
  G.setupDeck(s, 'A', sample('sample-knights-cyber'));
  G.setupDeck(s, 'B', sample('sample-knights-academy'));
  G.startGame(s, 'A');
  G.confirmMulligan(s, 'A');
  G.confirmMulligan(s, 'B');
  return s;
}

describe('データとデッキ', () => {
  it('3勢力75枚とリーダー3人、見本デッキ3つを読み込める', () => {
    expect(catalog.cards.size).toBe(75);
    expect(catalog.leaders.size).toBe(3);
    expect(catalog.sampleDecks.length).toBe(3);
  });

  it('見本デッキはすべてデッキの条件を満たす', () => {
    for (const d of catalog.sampleDecks) {
      expect(validateDeck(d, catalog)).toEqual([]);
      expect(deckSize(d)).toBe(40);
    }
  });

  it('テキスト形式を読み書きできる', () => {
    const text = deckToText(catalog.sampleDecks[0]);
    const { deck, errors } = parseDeckText(text);
    expect(errors).toEqual([]);
    expect(deck.leaders).toEqual(catalog.sampleDecks[0].leaders);
    expect(deckSize(deck)).toBe(40);
  });

  it('「KN-09 3」「KN-09」の書き方と、条件違反の警告', () => {
    const { deck } = parseDeckText('# t\nleader: leader-alto\nleader: leader-alto\nKN-09 4\nAC-01\n');
    expect(deck.cards).toEqual([
      { id: 'KN-09', count: 4 },
      { id: 'AC-01', count: 1 },
    ]);
    const w = validateDeck(deck, catalog);
    expect(w.some((x) => x.includes('異なる勢力'))).toBe(true);
    expect(w.some((x) => x.includes('3枚まで'))).toBe(true);
    expect(w.some((x) => x.includes('40枚'))).toBe(true);
  });
});

describe('試合の準備', () => {
  it('4枚引き、マリガン後に第1ラウンドが始まり1枚引く', () => {
    const s = started();
    expect(s.phase).toBe('playing');
    expect(s.round).toBe(1);
    for (const p of ['A', 'B'] as const) {
      expect(s.players[p].hand.length).toBe(5);
      expect(s.players[p].deck.length).toBe(35);
      expect(s.players[p].maxMana).toBe(1);
      expect(s.players[p].mana).toBe(1);
    }
  });

  it('マリガンで戻したカードは同じマリガンで引き直さない', () => {
    const s = G.newGame(7);
    G.setupDeck(s, 'A', catalog.sampleDecks[0]);
    G.setupDeck(s, 'B', catalog.sampleDecks[1]);
    G.startGame(s, 'A');
    const back = s.players.A.hand.map((c) => c.uid);
    for (const uid of back) G.toggleMulligan(s, 'A', uid);
    G.confirmMulligan(s, 'A');
    expect(s.players.A.hand.some((c) => back.includes(c.uid))).toBe(false);
    expect(s.players.A.hand.length + s.players.A.deck.length).toBe(40);
  });

  it('同じシードなら同じ手札になる', () => {
    const a = started(123);
    const b = started(123);
    expect(a.players.A.hand.map((c) => c.cardId)).toEqual(b.players.A.hand.map((c) => c.cardId));
  });
});

describe('ラウンドの補助', () => {
  it('使い残した通常マナが次のラウンドの予備マナになる（上限はない）', () => {
    const s = started();
    // ラウンド1: 1マナを残す → ラウンド2で予備マナ1
    G.roundEnd(s);
    G.roundStart(s);
    expect(s.players.A.maxMana).toBe(2);
    expect(s.players.A.reserve).toBe(1);
    expect(s.players.A.mana).toBe(2);
    // 予備マナに上限はない（ルール仕様書 v1.11）
    s.players.A.reserve = 3;
    s.players.A.mana = 3;
    s.players.A.maxMana = 3;
    G.roundEnd(s);
    G.roundStart(s);
    expect(s.players.A.maxMana).toBe(4);
    expect(s.players.A.reserve).toBe(6);
  });

  it('先手トークンはラウンドごとに交代する', () => {
    const s = started();
    expect(s.firstPlayer).toBe('A');
    G.roundEnd(s);
    G.roundStart(s);
    expect(s.firstPlayer).toBe('B');
    expect(s.activePlayer).toBe('B');
  });

  it('一時的な体力が受け止めたダメージはラウンド終了で消える（10.4）', () => {
    const s = started();
    G.summonToken(s, 'A', 'KN-04', 0); // 巡回騎士 2/3
    G.modifyUnit(s, 'A', 0, 0, 3, true); // 2/6
    G.damageUnit(s, 'A', 0, 4, false); // 残り2
    const u = s.players.A.board[0]!;
    expect(G.unitHealth(u)).toBe(2);
    G.roundEnd(s);
    expect(u.tempHealth).toBe(0);
    expect(u.damage).toBe(1);
    expect(G.unitHealth(u)).toBe(2);
  });

  it('双方が続けてパスしたら知らせ、パス以外の手番でリセットされる', () => {
    const s = started();
    G.endTurn(s, true);
    G.endTurn(s, false);
    expect(s.passStreak).toBe(0);
    G.endTurn(s, true);
    G.endTurn(s, true);
    expect(s.log.some((e) => e.text.includes('戦闘フェイズへ'))).toBe(true);
  });
});

describe('カードの操作', () => {
  it('手札から配置すると通常マナから自動で払う', () => {
    const s = started();
    s.players.A.mana = 5;
    s.players.A.hand.push(G.newInstance(s, 'KN-09'));
    const uid = s.players.A.hand[s.players.A.hand.length - 1].uid;
    expect(G.moveCard(s, { p: 'A', zone: 'hand', uid }, { p: 'A', zone: 'board', index: 2 })).toBe(true);
    expect(s.players.A.mana).toBe(2);
    expect(s.players.A.board[2]!.shield).toBe(true); // 盾持ちの衛兵は盾を持つ
  });

  it('相手の盤面や埋まったマスには置けない', () => {
    const s = started();
    const uid = s.players.A.hand[0].uid;
    expect(G.moveCard(s, { p: 'A', zone: 'hand', uid }, { p: 'B', zone: 'board', index: 0 })).toBe(false);
    G.summonToken(s, 'A', 'CY-01', 0);
    expect(G.moveCard(s, { p: 'A', zone: 'hand', uid }, { p: 'A', zone: 'board', index: 0 })).toBe(false);
  });

  it('トークンは盤面を離れると消える', () => {
    const s = started();
    G.summonToken(s, 'A', 'CY-01', 0);
    G.moveCard(s, { p: 'A', zone: 'board', index: 0 }, { p: 'A', zone: 'trash' });
    expect(s.players.A.trash.length).toBe(0);
    expect(s.players.A.board[0]).toBeNull();
  });

  it('手札に戻すと盤面で得たものはなくなる', () => {
    const s = started();
    G.summonToken(s, 'A', 'KN-09', 1);
    s.players.A.board[1]!.isToken = false;
    G.modifyUnit(s, 'A', 1, 2, 2, false);
    G.moveCard(s, { p: 'A', zone: 'board', index: 1 }, { p: 'A', zone: 'board', index: 3 });
    expect(s.players.A.board[3]!.attackMod).toBe(2); // 盤面内の移動では残る
    G.moveCard(s, { p: 'A', zone: 'board', index: 3 }, { p: 'A', zone: 'hand' });
    const back = s.players.A.hand[s.players.A.hand.length - 1];
    expect(back.cardId).toBe('KN-09');
    expect('attackMod' in back).toBe(false);
  });

  it('盾はダメージを1回防いで外れる', () => {
    const s = started();
    G.summonToken(s, 'A', 'KN-09', 0);
    G.damageUnit(s, 'A', 0, 5, true);
    const u = s.players.A.board[0]!;
    expect(u.damage).toBe(0);
    expect(u.shield).toBe(false);
    G.damageUnit(s, 'A', 0, 2, true);
    expect(u.damage).toBe(2);
  });

  it('スペルを使うと使ったスペルの枚数が増え、遅延はゾーンに残る', () => {
    const s = started();
    s.players.A.hand.push(G.newInstance(s, 'AC-02'), G.newInstance(s, 'KN-11'));
    const [delay, normal] = s.players.A.hand.slice(-2);
    G.useSpell(s, 'A', delay.uid, 'delay', '相手の本体');
    G.useSpell(s, 'A', normal.uid, 'trash');
    expect(s.players.A.spellsCast).toBe(2);
    expect(s.players.A.delayed.length).toBe(1);
    G.resolveDelay(s, 'A', s.players.A.delayed[0].uid);
    expect(s.players.A.delayed.length).toBe(0);
    // 鼓舞の号令はすぐトラッシュへ、火球は遅延が発動してからトラッシュへ
    expect(s.players.A.trash.map((c) => c.cardId)).toEqual(['KN-11', 'AC-02']);
  });

  it('手札が上限のときに引いたカードはトラッシュへ', () => {
    const s = started();
    while (s.players.A.hand.length < G.HAND_LIMIT) G.drawCards(s, 'A', 1);
    const trash = s.players.A.trash.length;
    G.drawCards(s, 'A', 1);
    expect(s.players.A.hand.length).toBe(G.HAND_LIMIT);
    expect(s.players.A.trash.length).toBe(trash + 1);
  });

  it('リーダー能力は予備マナから優先して払う', () => {
    const s = started();
    s.players.A.reserve = 3;
    s.players.A.mana = 4;
    G.useLeaderAbility(s, 'A', 0); // アルト: 盾の誓い（4）
    expect(s.players.A.reserve).toBe(0);
    expect(s.players.A.mana).toBe(3);
    expect(s.players.A.leaders[0].usedThisRound).toBe(true);
    G.roundEnd(s);
    G.roundStart(s);
    expect(s.players.A.leaders[0].usedThisRound).toBe(false);
  });

  it('ランダムなユニットを手札に加える', () => {
    const s = started();
    const before = s.players.A.hand.length;
    G.tutorRandom(s, 'A', 'unit', 2);
    const added = s.players.A.hand.slice(before);
    expect(added.length).toBe(2);
    expect(added.every((c) => catalog.cards.get(c.cardId)!.type === 'unit')).toBe(true);
  });
});
