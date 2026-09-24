// ランダムに手を選ぶ仮のプレイヤー同士で最後まで対戦させる（タスク 1-15）
import { describe, expect, it } from 'vitest';
import { applyAction, newGame } from '../src/engine';
import { legalActions } from '../src/legal';
import { randomInt } from '../src/rng';
import type { GameState } from '../src/types';
import { cat, decks } from './helpers';

const GAMES = Number(process.env.SIM_GAMES ?? 60);
const MAX_ACTIONS_PER_ROUND = 400;

export function playRandom(seed: number, deckA: number, deckB: number): GameState {
  let s = newGame(cat, { A: decks[deckA], B: decks[deckB] }, { seed });
  const pick = { rngState: seed ^ 0x5bd1e995 };
  for (let steps = 0; !s.result; steps++) {
    if (steps > 20000) throw new Error(`seed ${seed}: 終わらない試合`);
    if (s.actionsThisRound > MAX_ACTIONS_PER_ROUND) throw new Error(`seed ${seed}: 1ラウンドのアクションが多すぎる`);
    const acts = legalActions(cat, s);
    expect(acts.length).toBeGreaterThan(0);
    // パスばかりにならないよう、パス以外を選びやすくする
    const nonPass = acts.filter((a) => a.type !== 'pass');
    const pool = nonPass.length && randomInt(pick, 4) > 0 ? nonPass : acts;
    const a = pool[randomInt(pick, pool.length)];
    try {
      s = applyAction(cat, s, a);
    } catch (e) {
      throw new Error(`seed ${seed} round ${s.round}: ${JSON.stringify(a)}: ${(e as Error).stack}`);
    }
  }
  return s;
}

describe('ランダムな対戦', () => {
  it(`${GAMES} 試合を最後まで行える`, () => {
    const results = { A: 0, B: 0, draw: 0 };
    let rounds = 0;
    for (let g = 0; g < GAMES; g++) {
      const s = playRandom(1000 + g, g % decks.length, (g + 1) % decks.length);
      expect(s.result).not.toBeNull();
      results[s.result!.winner ?? 'draw'] += 1;
      rounds += s.round;
    }
    console.log('勝敗', results, '平均ラウンド数', (rounds / GAMES).toFixed(1));
  });

  it('同じシードと同じ手なら同じ結果になる', () => {
    const a = playRandom(77, 0, 1);
    const b = playRandom(77, 0, 1);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
