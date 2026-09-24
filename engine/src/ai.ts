// ルールベースの AI（段階1。タスク 2-5）
// 公開情報（publicView）だけを使う。合法手を1つずつ試し、その後の戦闘の結果まで見て、評価の一番高い手を選ぶ。
// 相手の応手は考えない（先読みは M4 の段階2・3で行う）
import type { Catalog } from './catalog';
import { getCard, getLeader } from './catalog';
import { applyAction } from './engine';
import { legalActions } from './legal';
import { Runner } from './runner';
import type { Action, GameState, PlayerId, Unit } from './types';
import { previewCombat, publicView } from './view';
import { opponent } from './board';

/** 隠れたカードの代わりに置くカード（中身が分からないので、よくある安いユニットとして扱う） */
const PLACEHOLDER = 'KN-03';

export interface AiWeights {
  life: number;
  lowLife: number;
  attack: number;
  health: number;
  shield: number;
  keyword: number;
  unitBase: number;
  hand: number;
  reserve: number;
  growth: number;
}

export const DEFAULT_WEIGHTS: AiWeights = {
  life: 1,
  lowLife: 0.6,
  attack: 1,
  health: 0.7,
  shield: 1.5,
  keyword: 0.5,
  unitBase: 0.5,
  hand: 1,
  reserve: 0.25,
  growth: 3,
};

export interface AiDecision {
  action: Action;
  /** 選んだ手の評価（デバッグ・表示用） */
  score: number;
  /** 何も手を打たなかったときの評価 */
  baseline: number;
}

/** player の手を選ぶ。player が判断する番でなければエラー */
export function chooseAction(cat: Catalog, state: GameState, player: PlayerId, w: AiWeights = DEFAULT_WEIGHTS): AiDecision {
  if (state.pending) {
    if (state.pending.player !== player) throw new Error('AI の番ではありません');
    // 山札の上から見て選ぶ: 一番コストの高いカードを取る
    const best = [...state.pending.options].sort((a, b) => getCard(cat, b.cardId).cost - getCard(cat, a.cardId).cost)[0];
    return { action: { type: 'choose', player, option: best.uid }, score: 0, baseline: 0 };
  }
  if (state.phase === 'mulligan') {
    // 重いカード（5コスト以上）を戻す
    const cards = state.players[player].hand.filter((c) => getCard(cat, c.cardId).cost >= 5).map((c) => c.uid);
    return { action: { type: 'mulligan', player, cards }, score: 0, baseline: 0 };
  }
  if (state.activePlayer !== player) throw new Error('AI の番ではありません');

  const view = sanitize(cat, publicView(state, player));
  const acts = legalActions(cat, view);
  const pass = acts.find((a) => a.type === 'pass')!;
  const baseline = scoreAfter(cat, view, pass, player, w);
  let best: AiDecision = { action: pass, score: baseline, baseline };
  for (const a of acts) {
    if (a.type === 'pass') continue;
    const score = scoreAfter(cat, view, a, player, w);
    // 同じくらいなら何もしない（無駄な移動を繰り返さないように）
    if (score > best.score + 0.05) best = { action: a, score, baseline };
  }
  return best;
}

/** 手を打った後、このラウンドの戦闘（またはラウンドの終わり）まで進めた状態の評価 */
function scoreAfter(cat: Catalog, view: GameState, a: Action, me: PlayerId, w: AiWeights): number {
  let next: GameState;
  try {
    next = applyAction(cat, view, a);
  } catch {
    return -Infinity;
  }
  if (next.result) return evaluate(cat, next, me, w, true);
  if (next.pending) return evaluate(cat, view, me, w, false) + 0.5;
  if (next.round > view.round) return evaluate(cat, next, me, w, true);
  const pv = previewCombat(cat, next);
  return evaluate(cat, pv.state, me, w, false);
}

/**
 * 盤面の評価（me から見て大きいほど良い）。
 * roundOver が false のときは、使い残した通常マナを次のラウンドの予備マナとして数える
 */
export function evaluate(cat: Catalog, s: GameState, me: PlayerId, w: AiWeights = DEFAULT_WEIGHTS, roundOver = false): number {
  const opp = opponent(me);
  if (s.result) return s.result.winner === me ? 1000 : s.result.winner === opp ? -1000 : 0;
  const r = new Runner(cat, s);
  const side = (p: PlayerId) => {
    const st = s.players[p];
    let v = st.life * w.life - Math.max(0, 8 - st.life) * w.lowLife;
    for (const u of st.board) if (u) v += unitValue(r, u, w);
    v += st.hand.length * w.hand;
    const futureReserve = roundOver ? st.reserve : Math.min(st.maxMana + 1, st.reserve + st.mana);
    v += futureReserve * w.reserve;
    for (const l of st.leaders) {
      const def = getLeader(cat, l.id);
      v += l.grown ? w.growth : (Math.min(l.progress, def.growth.threshold) / def.growth.threshold) * w.growth * 0.5;
    }
    return v;
  };
  return side(me) - side(opp);
}

function unitValue(r: Runner, u: Unit, w: AiWeights): number {
  const kws = r.keywords(u);
  let v = w.unitBase + r.attack(u) * w.attack + Math.max(0, r.health(u)) * w.health;
  if (u.shield) v += w.shield;
  for (const k of ['ranged', 'pierce', 'firstStrike', 'mobile'] as const) if (kws.has(k)) v += w.keyword;
  return v;
}

/** 公開情報の状態を、エンジンで先を試せる形にする（隠れたカードを仮のカードに置き換える） */
function sanitize(cat: Catalog, v: GameState): GameState {
  getCard(cat, PLACEHOLDER);
  v.log = [];
  for (const p of ['A', 'B'] as const) {
    const st = v.players[p];
    for (const zone of [st.deck, st.hand]) {
      for (const c of zone) {
        if (c.cardId !== '?') continue;
        c.cardId = PLACEHOLDER;
        c.uid = v.nextUid++;
      }
    }
  }
  return v;
}
