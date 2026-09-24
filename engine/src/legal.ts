// 合法手の一覧（ルール仕様書 18章）。AI と UI の両方で使う
import type { Catalog } from './catalog';
import { getCard } from './catalog';
import { CELLS } from './constants';
import { onPlayTargetSpecs, spellTargetSpecs } from './engine';
import { otherRow, rowOf } from './board';
import { Runner } from './runner';
import type { Action, GameState, PlayerId } from './types';

export interface LegalOptions {
  /** 予備マナと通常マナの内訳の違いも別の手として並べる（省略時は予備マナから優先して払う手だけ） */
  paymentSplits?: boolean;
}

/** 今行えるアクションをすべて返す。マリガン中は、まだマリガンしていない双方の手を返す */
export function legalActions(cat: Catalog, state: GameState, opts: LegalOptions = {}): Action[] {
  if (state.result) return [];
  if (state.pending) {
    const pd = state.pending;
    return pd.options.map((o) => ({ type: 'choose', player: pd.player, option: o.uid }));
  }
  if (state.phase === 'mulligan') {
    const out: Action[] = [];
    for (const p of ['A', 'B'] as const) {
      const st = state.players[p];
      if (st.mulliganDone) continue;
      for (const cards of subsets(st.hand.map((c) => c.uid))) out.push({ type: 'mulligan', player: p, cards });
    }
    return out;
  }
  const r = new Runner(cat, state);
  const p = state.activePlayer;
  const st = state.players[p];
  const out: Action[] = [{ type: 'pass', player: p }];
  const splits = (normal: number, flex: number): (number | undefined)[] => {
    const def = r.paymentPlan(p, normal, flex);
    if (!def) return [];
    if (!opts.paymentSplits || flex === 0) return [undefined];
    const list: number[] = [];
    for (let k = 0; k <= Math.min(flex, st.reserve); k++) if (r.paymentPlan(p, normal, flex, k)) list.push(k);
    return list;
  };

  // 手札のカード（重複する同名カードは1枚だけ見る）
  const seen = new Set<string>();
  for (const inst of st.hand) {
    const cost = r.cardCost(p, inst);
    const sig = `${inst.cardId}/${cost}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const def = getCard(cat, inst.cardId);
    for (const enhance of def.enhance ? [false, true] : [false]) {
      const pays = splits(cost, enhance ? r.enhanceCost(p, def) : 0);
      if (!pays.length) continue;
      if (def.type === 'unit') {
        const empties = [...Array(CELLS).keys()].filter((i) => !st.board[i]);
        if (!empties.length) continue;
        const combos = r.targetCombos(onPlayTargetSpecs(r, inst.cardId, enhance), p, false, inst.uid);
        for (const cell of empties)
          for (const targets of combos)
            for (const reserve of pays)
              out.push(clean({ type: 'playUnit', player: p, card: inst.uid, cell, enhance, targets, reserve }));
      } else {
        const combos = r.targetCombos(spellTargetSpecs(r, inst.cardId, enhance), p, true, inst.uid);
        for (const targets of combos)
          for (const reserve of pays) out.push(clean({ type: 'castSpell', player: p, card: inst.uid, enhance, targets, reserve }));
      }
    }
  }

  // 盤面のユニット
  st.board.forEach((u, i) => {
    if (!u) return;
    if (rowOf(i) === 'back' && !st.board[otherRow(i)]) out.push({ type: 'advance', player: p, cell: i });
    if (!u.mobileUsed && r.hasKeyword(u, 'mobile')) {
      for (let to = 0; to < CELLS; to++) if (!st.board[to]) out.push({ type: 'mobileMove', player: p, unit: u.uid, to });
    }
    (getCard(cat, u.cardId).abilities ?? []).forEach((ab, idx) => {
      if (ab.kind !== 'activated' || u.activatedUsed.includes(idx)) return;
      const pays = splits(0, ab.cost);
      if (!pays.length) return;
      for (const targets of r.targetCombos(ab.targets, p, true))
        for (const reserve of pays) out.push(clean({ type: 'activate', player: p, unit: u.uid, ability: idx, targets, reserve }));
    });
  });

  // リーダー能力
  st.leaders.forEach((l, idx) => {
    const ab = r.leaderAbility(p, idx);
    if (!ab || l.usedThisRound) return;
    const pays = splits(0, r.leaderCost(p, idx));
    if (!pays.length) return;
    for (const targets of r.targetCombos(ab.targets, p, true))
      for (const reserve of pays) out.push(clean({ type: 'leaderAbility', player: p, leader: idx, targets, reserve }));
  });
  return out;
}

/** 行動権を持つプレイヤー（マリガン中・選択中はその人） */
export function playerToAct(state: GameState): PlayerId[] {
  if (state.result) return [];
  if (state.pending) return [state.pending.player];
  if (state.phase === 'mulligan') return (['A', 'B'] as const).filter((p) => !state.players[p].mulliganDone);
  return [state.activePlayer];
}

function subsets<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 0; mask < 1 << items.length; mask++) out.push(items.filter((_, i) => mask & (1 << i)));
  return out;
}

/** 省略できる項目を消す（手を比べやすくするため） */
function clean<A extends Action>(a: A): A {
  const x = a as Record<string, unknown>;
  if (x.reserve === undefined) delete x.reserve;
  if (x.enhance === false) delete x.enhance;
  if (x.targets && Object.keys(x.targets as object).length === 0) delete x.targets;
  return a;
}
