// ランダムに手を選ぶ仮のプレイヤー同士で最後まで対戦させる（タスク 1-15）
import { describe, expect, it } from 'vitest';
import { applyAction, newGame } from '../src/engine';
import { legalActions } from '../src/legal';
import { randomInt } from '../src/rng';
import { HAND_LIMIT, MAX_MANA_CAP } from '../src/constants';
import { Runner } from '../src/runner';
import type { GameState } from '../src/types';
import { cat, decks } from './helpers';

/** どの時点でも成り立つはずのこと */
export function checkInvariants(s: GameState): string[] {
  const out: string[] = [];
  const r = new Runner(cat, s);
  const uids = new Set<number>();
  for (const p of ['A', 'B'] as const) {
    const st = s.players[p];
    if (st.mana < 0 || st.reserve < 0) out.push(`${p}: マナが負`);
    if (st.maxMana > MAX_MANA_CAP) out.push(`${p}: 最大マナが上限を超えた`);
    if (st.reserve > st.maxMana) out.push(`${p}: 予備マナが最大マナを超えた`);
    if (st.hand.length > HAND_LIMIT) out.push(`${p}: 手札が上限を超えた`);
    if (st.board.length !== 8) out.push(`${p}: 盤面のマスの数が違う`);
    for (const zone of [st.deck, st.hand, st.trash, st.exile]) for (const c of zone) {
      if (uids.has(c.uid)) out.push(`${p}: uid ${c.uid} が重複`);
      uids.add(c.uid);
    }
    st.board.forEach((u) => {
      if (!u) return;
      if (uids.has(u.uid)) out.push(`${p}: uid ${u.uid} が重複`);
      uids.add(u.uid);
      if (u.owner !== p) out.push(`${p}: 相手のユニットが盤面にいる`);
      if (!s.result && r.health(u) <= 0) out.push(`${p}: 体力0以下の ${u.cardId} が残っている`);
      if (u.damage < 0 || u.tempDamage < 0) out.push(`${p}: ダメージが負`);
    });
  }
  for (const d of s.delayed) if (d.card) {
    if (uids.has(d.card.uid)) out.push(`遅延のカード uid ${d.card.uid} が重複`);
    uids.add(d.card.uid);
  }
  return out;
}

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
    const bad = checkInvariants(s);
    if (bad.length) throw new Error(`seed ${seed} round ${s.round} ${JSON.stringify(a)}: ${bad.join(' / ')}`);
  }
  return s;
}

describe('ランダムな対戦', () => {
  it(`${GAMES} 試合を最後まで行える`, { timeout: 600_000 }, () => {
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
