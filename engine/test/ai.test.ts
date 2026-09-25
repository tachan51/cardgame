// ルールベースの AI（2-5）
import { describe, expect, it } from 'vitest';
import { chooseAction } from '../src/ai';
import { applyAction, newGame } from '../src/engine';
import { legalActions } from '../src/legal';
import { chooseMulligan, keepValue, type MulliganTable } from '../src/mulligan';
import { randomInt } from '../src/rng';
import { buildState } from '../src/scenario';
import type { GameState, PlayerId } from '../src/types';
import { cat, decks } from './helpers';

type Policy = 'ai' | 'random';

function play(seed: number, a: Policy, b: Policy, dA = 0, dB = 1): { s: GameState; maxMs: number } {
  let s = newGame(cat, { A: decks[dA], B: decks[dB] }, { seed });
  const rng = { rngState: seed * 31 + 7 };
  let maxMs = 0;
  for (let n = 0; !s.result; n++) {
    if (n > 5000) throw new Error('終わらない');
    const acts = legalActions(cat, s);
    const p: PlayerId = s.pending ? s.pending.player : s.phase === 'mulligan' ? (acts[0].player as PlayerId) : s.activePlayer;
    const policy = p === 'A' ? a : b;
    let act;
    if (policy === 'ai') {
      const t = performance.now();
      act = chooseAction(cat, s, p).action;
      maxMs = Math.max(maxMs, performance.now() - t);
    } else {
      const mine = acts.filter((x) => x.player === p);
      act = mine[randomInt(rng, mine.length)];
    }
    s = applyAction(cat, s, act);
  }
  return { s, maxMs };
}

describe('ルールベースの AI', () => {
  it('ランダムなプレイヤーにほとんど勝つ', { timeout: 600_000 }, () => {
    let wins = 0;
    let maxMs = 0;
    const N = 20;
    for (let g = 0; g < N; g++) {
      const aiSide: PlayerId = g % 2 === 0 ? 'A' : 'B';
      const r = play(500 + g, aiSide === 'A' ? 'ai' : 'random', aiSide === 'B' ? 'ai' : 'random', g % 3, (g + 1) % 3);
      if (r.s.result!.winner === aiSide) wins++;
      maxMs = Math.max(maxMs, r.maxMs);
    }
    console.log(`AI の勝ち ${wins}/${N}、1手の最長 ${maxMs.toFixed(0)}ms`);
    expect(wins).toBeGreaterThanOrEqual(N * 0.8);
  });

  it('AI 同士で最後まで対戦できる', { timeout: 600_000 }, () => {
    for (let g = 0; g < 6; g++) {
      const r = play(900 + g, 'ai', 'ai', g % 3, (g + 2) % 3);
      expect(r.s.result).not.toBeNull();
    }
  });

  it('相手の手札や山札の中身を使わない（隠れた情報が違っても同じ手を選ぶ）', () => {
    const base = buildState(cat, {
      activePlayer: 'B',
      A: { hand: ['KN-23'], deck: ['KN-25', 'KN-24'] },
      B: { maxMana: 4, hand: ['KN-09', 'CY-17'], board: { '1前': 'KN-04' } },
    });
    const other = structuredClone(base);
    other.players.A.hand[0].cardId = 'AC-02';
    other.players.A.deck.reverse();
    for (const level of ['easy', 'normal', 'hard'] as const) {
      expect(chooseAction(cat, base, 'B', { level, seed: 1 }).action).toEqual(chooseAction(cat, other, 'B', { level, seed: 1 }).action);
    }
  });

  it('つよい（段階3）は思考時間の上限を守り、合法手を返す', () => {
    let s = newGame(cat, { A: decks[0], B: decks[1] }, { seed: 21 });
    s = applyAction(cat, s, { type: 'mulligan', player: 'A', cards: [] });
    s = applyAction(cat, s, { type: 'mulligan', player: 'B', cards: [] });
    for (let k = 0; k < 12 && !s.result; k++) {
      const p = s.activePlayer;
      const t = performance.now();
      const d = chooseAction(cat, s, p, { level: 'hard', timeLimitMs: 300 });
      expect(performance.now() - t).toBeLessThan(1500);
      s = applyAction(cat, s, d.action);
    }
  });

  it('とどめを刺せるなら刺す', () => {
    const s = buildState(cat, {
      activePlayer: 'B',
      A: { life: 3, board: { '1前': 'KN-20' } },
      B: { maxMana: 4, hand: ['KN-06', 'AC-02'], board: { '2前': 'KN-04' } },
    });
    // 2前の KN-04 の攻撃（2）＋火球（2）で A のライフ 3 を削りきれる
    const d = chooseAction(cat, s, 'B');
    expect(d.action.type).toBe('castSpell');
    expect(d.score).toBe(1000);
  });

  it('やさしい AI のマリガンでは重いカードを戻す', () => {
    const s = newGame(cat, { A: decks[0], B: decks[1] }, { seed: 3 });
    const d = chooseAction(cat, s, 'A', { level: 'easy' });
    expect(d.action.type).toBe('mulligan');
    const back = (d.action as { cards: number[] }).cards;
    for (const c of s.players.A.hand) expect(back.includes(c.uid)).toBe(cat.cards.get(c.cardId)!.cost >= 5);
  });

  it('ふつうの AI のマリガンは表の見込みが山札の平均より悪いカードを戻す', () => {
    const table: MulliganTable = { version: 1, games: 0, vs: { academy: { 'KN-01': 5, 'KN-03': -5 }, cyber: { 'KN-01': 5, 'KN-03': -5 } } };
    const s = buildState(cat, {
      A: { hand: ['KN-01', 'KN-03', 'KN-04', 'KN-25'], deck: ['KN-04', 'KN-04', 'KN-04'] },
      B: {},
    });
    s.phase = 'mulligan';
    const back = chooseMulligan(cat, s, 'A', 'smart', table).map((uid) => s.players.A.hand.find((c) => c.uid === uid)!.cardId);
    // KN-03 は表で悪い、KN-25（10コスト）は表にないのでコストで判断して戻す。KN-01・KN-04 は残す
    expect(back.sort()).toEqual(['KN-03', 'KN-25']);
    expect(chooseMulligan(cat, s, 'A', 'none', table)).toEqual([]);
  });

  it('マリガンの見込みは相手の勢力で変わる', () => {
    const table: MulliganTable = { version: 1, games: 0, vs: { knights: { 'CY-04': 4 }, academy: { 'CY-04': -4 } } };
    expect(keepValue(cat, 'CY-04', ['knights'], table)).toBe(4);
    expect(keepValue(cat, 'CY-04', ['academy'], table)).toBe(-4);
    expect(keepValue(cat, 'CY-04', ['knights', 'academy'], table)).toBe(0);
  });
});
