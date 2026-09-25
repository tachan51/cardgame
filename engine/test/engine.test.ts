import { describe, expect, it } from 'vitest';
import { buildCatalog, CatalogError, validateDeck } from '../src/catalog';
import { applyAction, newGame } from '../src/engine';
import { legalActions, playerToAct } from '../src/legal';
import { IllegalAction } from '../src/runner';
import { buildState } from '../src/scenario';
import type { Action, FactionFile, GameState } from '../src/types';
import { previewCombat, publicView } from '../src/view';
import { cat, deck, decks, loadFactions } from './helpers';

function started(seed = 1): GameState {
  let s = newGame(cat, { A: deck('sample-knights-cyber'), B: deck('sample-cyber-academy') }, { seed, firstPlayer: 'A' });
  s = applyAction(cat, s, { type: 'mulligan', player: 'A', cards: [] });
  s = applyAction(cat, s, { type: 'mulligan', player: 'B', cards: [] });
  return s;
}

describe('カードデータ（1-4）', () => {
  it('3勢力75枚（とトークン専用のカード）とリーダー3人を読み込める', () => {
    const cards = [...cat.cards.values()];
    expect(cards.filter((c) => !c.token).length).toBe(75);
    expect(cards.filter((c) => c.token).map((c) => c.id)).toEqual(['TK-01']);
    expect(cat.leaders.size).toBe(3);
  });

  it('トークン専用のカードはデッキに入れられない', () => {
    const d = structuredClone(deck('sample-knights-academy'));
    d.cards[0].count -= 1;
    d.cards.push({ id: 'TK-01', count: 1 });
    expect(validateDeck(d, cat).some((x) => x.includes('TK-01'))).toBe(true);
  });

  it('見本デッキはすべてデッキの条件を満たす', () => {
    for (const d of decks) expect(validateDeck(d, cat)).toEqual([]);
  });

  it('不正なデータを検出する', () => {
    const files = structuredClone(loadFactions()) as FactionFile[];
    const kn = files.find((f) => f.faction.id === 'knights')!;
    kn.cards.push({ ...kn.cards[0] }); // ID の重複
    const c = kn.cards.find((x) => x.id === 'KN-15')!;
    c.keywords = []; // 遅延の処理があるのにキーワードがない
    (c.effects![0] as { effects: { op: string }[] }).effects[0].op = 'explode'; // 知らない処理
    const cy = files.find((f) => f.faction.id === 'cyber')!;
    cy.cards.find((x) => x.id === 'CY-16')!.abilities!.push({ kind: 'trigger', when: 'onPlay', effects: [{ op: 'summon', cardId: 'XX-99', at: 'self' }] });
    try {
      buildCatalog(files);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CatalogError);
      const text = (e as CatalogError).problems.join('\n');
      expect(text).toContain('KN-01: カードIDが重複しています');
      expect(text).toContain('KN-15: キーワードに遅延がありません'.slice(0, 7));
      expect(text).toContain('処理 explode は使えません');
      expect(text).toContain('存在しないカード XX-99');
    }
  });

  it('デッキの条件違反を見つける', () => {
    const d = structuredClone(deck('sample-knights-cyber'));
    d.leaders = ['leader-alto', 'leader-alto'];
    const total = 40 - d.cards[0].count + 4;
    d.cards[0].count = 4;
    const w = validateDeck(d, cat);
    expect(w.some((x) => x.includes('異なる勢力'))).toBe(true);
    expect(w.some((x) => x.includes('3 枚まで'))).toBe(true);
    expect(w.some((x) => x.includes(`${total} 枚`))).toBe(true);
  });
});

describe('対戦開始とマリガン（3章）', () => {
  it('双方4枚引いてマリガンを待ち、双方が終えると第1ラウンドが始まる', () => {
    let s = newGame(cat, { A: decks[0], B: decks[1] }, { seed: 5, firstPlayer: 'B' });
    expect(s.phase).toBe('mulligan');
    expect(s.players.A.hand.length).toBe(4);
    expect(playerToAct(s)).toEqual(['A', 'B']);
    expect(legalActions(cat, s).filter((a) => a.player === 'A').length).toBe(16);
    s = applyAction(cat, s, { type: 'mulligan', player: 'B', cards: [] });
    expect(s.round).toBe(0);
    s = applyAction(cat, s, { type: 'mulligan', player: 'A', cards: [] });
    expect(s.phase).toBe('action');
    expect(s.round).toBe(1);
    expect(s.activePlayer).toBe('B');
    for (const p of ['A', 'B'] as const) {
      expect(s.players[p].hand.length).toBe(5);
      expect(s.players[p].deck.length).toBe(35);
      expect(s.players[p].maxMana).toBe(1);
    }
  });

  it('マリガンで戻したカードは同じマリガンで引き直さない', () => {
    let s = newGame(cat, { A: decks[0], B: decks[1] }, { seed: 9 });
    const back = s.players.A.hand.map((c) => c.uid);
    s = applyAction(cat, s, { type: 'mulligan', player: 'A', cards: back });
    expect(s.players.A.hand.some((c) => back.includes(c.uid))).toBe(false);
    expect(s.players.A.hand.length + s.players.A.deck.length).toBe(40);
    expect(() => applyAction(cat, s, { type: 'mulligan', player: 'A', cards: [] })).toThrow(IllegalAction);
  });

  it('先手を省略するとシードで決まる', () => {
    const firsts = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => newGame(cat, { A: decks[0], B: decks[1] }, { seed }).firstPlayer));
    expect(firsts.size).toBe(2);
  });

  it('条件を満たさないデッキでは始められない', () => {
    const d = structuredClone(decks[0]);
    d.cards.pop();
    expect(() => newGame(cat, { A: d, B: decks[1] }, { seed: 1 })).toThrow(/条件/);
  });
});

describe('合法手（18章）', () => {
  it('合法手はすべて適用でき、元の状態は変わらない', () => {
    const s = started(3);
    const before = JSON.stringify(s);
    const acts = legalActions(cat, s);
    expect(acts.some((a) => a.type === 'pass')).toBe(true);
    for (const a of acts) applyAction(cat, s, a);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('強化のコストは予備マナから必ず先に払う（内訳違いの手はない）', () => {
    const s = buildState(cat, { A: { maxMana: 5, reserve: 3, hand: ['KN-06'], board: { '1前': 'KN-04' } } });
    const acts = legalActions(cat, s).filter((a) => a.type === 'castSpell' && a.enhance);
    expect(acts.length).toBe(1);
    const next = applyAction(cat, s, acts[0]);
    expect(next.players.A.reserve).toBe(1);
    expect(next.players.A.mana).toBe(3);
  });

  it('対象を選べないスペルは合法手に入らない', () => {
    const s = buildState(cat, { A: { hand: ['CY-02'] } });
    expect(legalActions(cat, s).some((a) => a.type === 'castSpell')).toBe(false);
  });
});

describe('選択（山札の上から見て選ぶ）', () => {
  it('CY-06 データ検索: 選択を待ち、選んだカードが手札に入る', () => {
    let s = buildState(cat, { A: { maxMana: 3, hand: ['CY-06'], deck: ['KN-01', 'KN-09', 'KN-23', 'KN-25'] } });
    s = applyAction(cat, s, { type: 'castSpell', player: 'A', card: s.players.A.hand[0].uid });
    expect(s.pending?.options.map((o) => o.cardId)).toEqual(['KN-01', 'KN-09']);
    expect(playerToAct(s)).toEqual(['A']);
    const acts = legalActions(cat, s);
    expect(acts.length).toBe(2);
    expect(() => applyAction(cat, s, { type: 'pass', player: 'A' })).toThrow(IllegalAction);
    const pick = acts.find((a) => a.type === 'choose' && s.pending!.options.find((o) => o.uid === a.option)!.cardId === 'KN-09')!;
    s = applyAction(cat, s, pick);
    expect(s.pending).toBeNull();
    expect(s.players.A.hand.map((c) => c.cardId)).toEqual(['KN-09']);
    expect(s.players.A.deck.map((c) => c.cardId)).toEqual(['KN-01', 'KN-23', 'KN-25']);
    expect(s.activePlayer).toBe('A'); // 即効
  });

  it('相手から見ると選択肢は見えない', () => {
    let s = buildState(cat, { A: { maxMana: 3, hand: ['CY-06'], deck: ['KN-01', 'KN-09', 'KN-23'] } });
    s = applyAction(cat, s, { type: 'castSpell', player: 'A', card: s.players.A.hand[0].uid });
    const v = publicView(s, 'B');
    expect(v.pending?.options).toEqual([]);
    expect(v.pending?.before).toBeNull();
  });
});

describe('公開情報とプレビュー', () => {
  it('相手の手札と山札の中身は見えない', () => {
    const s = started(4);
    const v = publicView(s, 'A');
    expect(v.players.B.hand.every((c) => c.cardId === '?')).toBe(true);
    expect(v.players.A.hand.every((c) => c.cardId !== '?')).toBe(true);
    expect(v.players.A.deck.every((c) => c.cardId === '?')).toBe(true);
    expect(v.players.B.deck.length).toBe(s.players.B.deck.length);
  });

  it('公開された手札は相手にも見える', () => {
    const s = buildState(cat, { B: { hand: ['AC-02', 'AC-05'] } });
    s.players.B.hand[0].revealed = true;
    const v = publicView(s, 'A');
    expect(v.players.B.hand.map((c) => c.cardId)).toEqual(['AC-02', '?']);
  });

  it('戦闘のプレビューは元の状態を変えない', () => {
    const s = buildState(cat, { A: { board: { '1前': 'KN-23' } }, B: { board: { '1前': 'KN-04' } } });
    const before = JSON.stringify(s);
    const pv = previewCombat(cat, s);
    expect(JSON.stringify(s)).toBe(before);
    expect(pv.life.B).toBe(11);
    expect(pv.destroyed.length).toBe(1);
  });
});

describe('ログ（1-14）', () => {
  it('アクションと出来事を順番に記録する', () => {
    let s = buildState(cat, { A: { maxMana: 3, hand: ['KN-09'] }, B: { board: { '1前': 'KN-04' } } });
    s = applyAction(cat, s, { type: 'playUnit', player: 'A', card: s.players.A.hand[0].uid, cell: 0 });
    s = applyAction(cat, s, { type: 'pass', player: 'B' });
    s = applyAction(cat, s, { type: 'pass', player: 'A' });
    const types = s.log.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['playUnit', 'pass', 'combatStart', 'combatStep', 'shieldBlock', 'damage', 'endure', 'roundEnd', 'roundStart', 'draw']));
    expect(types.indexOf('playUnit')).toBeLessThan(types.indexOf('combatStep'));
  });
});

describe('決定性（1-3）', () => {
  it('同じシードと同じアクション列なら同じ状態になる', () => {
    const run = () => {
      let s = started(11);
      const acts: Action[] = [];
      for (let k = 0; k < 30 && !s.result; k++) {
        const list = legalActions(cat, s);
        const a = list[(k * 7) % list.length];
        acts.push(a);
        s = applyAction(cat, s, a);
      }
      return s;
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe('ランダムな効果（カードリスト v0.8）', () => {
  const cast = (s: GameState, card: string, targets: Record<string, unknown> = {}, enhance = false): GameState => {
    const uid = s.players.A.hand.find((c) => c.cardId === card)!.uid;
    return applyAction(cat, s, { type: 'castSpell', player: 'A', card: uid, targets, enhance } as Action);
  };
  const totalDamage = (s: GameState) => s.players.B.board.reduce((n, u) => n + (u?.damage ?? 0), 0);

  it('数打ちゃ当たる: 相手の8マスが埋まっていれば、使ったスペルの枚数だけ必ず当たる', () => {
    const full = Object.fromEntries(['1前', '1後', '2前', '2後', '3前', '3後', '4前', '4後'].map((c) => [c, { card: 'KN-04', health: 10 }]));
    for (let seed = 1; seed <= 10; seed++) {
      const s = buildState(cat, { seed, A: { mana: 2, spellsCast: 5, hand: ['AC-08'] }, B: { board: full } });
      expect(totalDamage(cast(s, 'AC-08'))).toBe(5);
    }
  });

  it('数打ちゃ当たる: 空きマスも選ばれるので、ユニットが1体だけなら外れもある', () => {
    let hits = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const s = buildState(cat, { seed, A: { mana: 2, spellsCast: 16, hand: ['AC-08'] }, B: { board: { '2前': { card: 'KN-04', health: 30 } } } });
      const d = totalDamage(cast(s, 'AC-08'));
      expect(d).toBeLessThan(16);
      hits += d;
    }
    // 1マスに当たる確率は 1/8。160回のうちおよそ20回
    expect(hits).toBeGreaterThan(5);
    expect(hits).toBeLessThan(40);
  });

  it('召喚ガチャ（強化）: 名前の異なる2体を、4種類の候補から出す', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) {
      const s = buildState(cat, { seed, A: { mana: 5, hand: ['AC-09'] } });
      const after = cast(s, 'AC-09', { cells: [{ kind: 'cell', p: 'A', i: 0 }, { kind: 'cell', p: 'A', i: 5 }] }, true);
      const ids = [after.players.A.board[0]!.cardId, after.players.A.board[5]!.cardId];
      expect(ids[0]).not.toBe(ids[1]);
      for (const id of ids) {
        expect(['KN-03', 'KN-04', 'CY-04', 'CY-05']).toContain(id);
        seen.add(id);
      }
      expect(after.players.A.board[0]!.isToken).toBe(true);
    }
    expect(seen.size).toBe(4);
  });
});
