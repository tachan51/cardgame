// AI（タスク 2-5・4-1・4-2）
//
// 強さは3段階。どれも相手の手札と山札の中身は見ない（publicView と、自分のデッキの中身だけを使う）。
//   easy   … 段階1。合法手を1つずつ試し、このラウンドの戦闘の結果まで見た評価で選ぶ。評価に揺らぎを入れて手加減する
//   normal … 段階2。段階1の評価に、手札のカードの重さ・予備マナ・使えるリーダー能力の価値を加える
//   hard   … 段階3。段階2で良さそうな手を絞り、相手の手札を推測した「ありうる状況」を何通りか作って、
//            そのラウンドの終わりまで双方が段階2の方針で打ち進めた結果の平均で選ぶ（決定化したロールアウト）。思考時間に上限がある
import { opponent } from './board';
import type { Catalog } from './catalog';
import { getCard, getLeader } from './catalog';
import { applyAction } from './engine';
import { legalActions } from './legal';
import { nextRandom, shuffleInPlace, type RngHolder } from './rng';
import { Runner } from './runner';
import type { Action, CardInstance, FactionId, GameState, PlayerId, Unit } from './types';
import { previewCombat, publicView } from './view';

/** 中身の分からないカードの代わりに置くカード（よくある安いユニットとして扱う） */
const PLACEHOLDER = 'KN-03';

export type AiLevel = 'easy' | 'normal' | 'hard';
export const AI_LEVELS: AiLevel[] = ['easy', 'normal', 'hard'];

export interface AiWeights {
  life: number;
  lowLife: number;
  attack: number;
  health: number;
  shield: number;
  keyword: number;
  unitBase: number;
  /** 手札1枚の価値 */
  hand: number;
  /** 手札のカードのコスト1あたりの価値（重いカードほど持っている価値がある） */
  handCost: number;
  reserve: number;
  growth: number;
  /** 次のラウンドに使えるリーダー能力1つの価値 */
  leaderReady: number;
}

/** 段階1の評価 */
export const STAGE1_WEIGHTS: AiWeights = {
  life: 1,
  lowLife: 0.6,
  attack: 1,
  health: 0.7,
  shield: 1.5,
  keyword: 0.5,
  unitBase: 0.5,
  hand: 1,
  handCost: 0,
  reserve: 0.25,
  growth: 3,
  leaderReady: 0,
};

/** 段階2の評価（AI 同士の対戦で調整した値） */
export const STAGE2_WEIGHTS: AiWeights = {
  ...STAGE1_WEIGHTS,
  hand: 0.7,
  handCost: 0.12,
  reserve: 0.3,
  leaderReady: 0.8,
};

export const DEFAULT_WEIGHTS = STAGE2_WEIGHTS;

export interface AiOptions {
  level?: AiLevel;
  /** 評価の重みを差し替える（調整用） */
  weights?: AiWeights;
  /** hard の思考時間の上限（ミリ秒） */
  timeLimitMs?: number;
  /** easy の揺らぎと hard の推測に使う乱数のシード（省略時は状態から決める） */
  seed?: number;
  /** hard で読む候補の数と、推測する状況の数 */
  candidates?: number;
  worlds?: number;
}

export interface AiDecision {
  action: Action;
  /** 選んだ手の評価（デバッグ・表示用） */
  score: number;
  /** 何も手を打たなかったときの評価 */
  baseline: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** player の手を選ぶ。player が判断する番でなければエラー */
export function chooseAction(cat: Catalog, state: GameState, player: PlayerId, opts: AiOptions = {}): AiDecision {
  const level = opts.level ?? 'normal';
  const w = opts.weights ?? (level === 'easy' ? STAGE1_WEIGHTS : STAGE2_WEIGHTS);
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
  const rng: RngHolder = { rngState: (opts.seed ?? state.rngState ^ (state.log.length * 2654435761)) | 0 };

  const view = sanitize(cat, publicView(state, player));
  const scored = scoreAll(cat, view, player, w);
  const baseline = scored.find((x) => x.action.type === 'pass')!.score;

  if (level === 'easy') {
    // 手加減: 評価に揺らぎを入れる
    for (const x of scored) if (Number.isFinite(x.score)) x.score += (nextRandom(rng) - 0.5) * 3;
    return pickBest(scored, baseline);
  }
  if (level === 'normal') return pickBest(scored, baseline);
  return search(cat, state, player, w, scored, baseline, rng, opts);
}

interface Scored {
  action: Action;
  score: number;
}

function scoreAll(cat: Catalog, view: GameState, me: PlayerId, w: AiWeights): Scored[] {
  return legalActions(cat, view)
    .filter((a) => a.player === me)
    .map((action) => ({ action, score: scoreAfter(cat, view, action, me, w) }));
}

function pickBest(scored: Scored[], baseline: number): AiDecision {
  let best = scored.find((x) => x.action.type === 'pass')!;
  for (const x of scored) {
    // 同じくらいなら何もしない（無駄な移動を繰り返さないように）
    if (x.action.type !== 'pass' && x.score > best.score + 0.05) best = x;
  }
  return { action: best.action, score: best.score, baseline };
}

/** 手を打った後、このラウンドの戦闘（またはラウンドの終わり）まで進めた状態の評価 */
function scoreAfter(cat: Catalog, view: GameState, a: Action, me: PlayerId, w: AiWeights): number {
  let next: GameState;
  try {
    next = applyAction(cat, view, a);
  } catch {
    return -Infinity;
  }
  return settleScore(cat, view, next, me, w);
}

function settleScore(cat: Catalog, before: GameState, next: GameState, me: PlayerId, w: AiWeights): number {
  if (next.result) return evaluate(cat, next, me, w, true);
  if (next.pending) return evaluate(cat, before, me, w, false) + 0.5;
  if (next.round > before.round) return evaluate(cat, next, me, w, true);
  const pv = previewCombat(cat, next);
  return evaluate(cat, pv.state, me, w, false);
}

// ---------------------------------------------------------------- 評価

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
    for (const c of st.hand) v += w.hand + (w.handCost ? w.handCost * Math.min(6, cardCostGuess(cat, c)) : 0);
    const futureReserve = roundOver ? st.reserve : Math.min(st.maxMana + 1, st.reserve + st.mana);
    v += futureReserve * w.reserve;
    st.leaders.forEach((l, idx) => {
      const def = getLeader(cat, l.id);
      v += l.grown ? w.growth : (Math.min(l.progress, def.growth.threshold) / def.growth.threshold) * w.growth * 0.5;
      if (w.leaderReady) {
        // 次のラウンドに払えるリーダー能力があるか
        const ab = r.leaderAbility(p, idx);
        const budget = futureReserve + Math.min(10, st.maxMana + (roundOver ? 0 : 1));
        if (ab && r.leaderCost(p, idx) <= budget) v += w.leaderReady;
      }
    });
    return v;
  };
  return side(me) - side(opp);
}

function cardCostGuess(cat: Catalog, c: CardInstance): number {
  return c.cardId === '?' ? 3 : getCard(cat, c.cardId).cost;
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

// ---------------------------------------------------------------- 段階3: 決定化したロールアウト

/**
 * 相手の隠れた情報を推測した「ありうる状況」を作る。
 * 相手の手札と山札は、相手のリーダーの勢力のカードからランダムに選ぶ（公開されたカードはそのまま）。
 * 自分の山札は、中身（自分のデッキ）は分かるが順番は分からないのでシャッフルする
 */
export function determinize(cat: Catalog, state: GameState, me: PlayerId, rng: RngHolder): GameState {
  const w = structuredClone(state);
  w.log = [];
  w.pending = null;
  const opp = opponent(me);
  const facs = new Set<FactionId>(w.players[opp].leaders.map((l) => getLeader(cat, l.id).faction));
  const pool = [...cat.cards.values()].filter((c) => facs.has(c.faction)).map((c) => c.id);
  const sample = (): CardInstance => ({ uid: w.nextUid++, cardId: pool[Math.floor(nextRandom(rng) * pool.length)], costMod: 0, revealed: false, generated: false });
  const st = w.players[opp];
  st.hand = st.hand.map((c) => (c.revealed ? c : sample()));
  st.deck = st.deck.map(() => sample());
  shuffleInPlace(rng, w.players[me].deck);
  w.rngState = Math.floor(nextRandom(rng) * 2 ** 31);
  return w;
}

function search(
  cat: Catalog,
  state: GameState,
  me: PlayerId,
  w: AiWeights,
  scored: Scored[],
  baseline: number,
  rng: RngHolder,
  opts: AiOptions,
): AiDecision {
  const start = now();
  const limit = opts.timeLimitMs ?? 1500;
  const K = opts.candidates ?? 6;
  const D = opts.worlds ?? 3;
  const opp = opponent(me);
  // 段階2の評価で良い順に候補を絞る（パスは必ず入れる）
  const ranked = scored.filter((x) => Number.isFinite(x.score)).sort((a, b) => b.score - a.score);
  const cands = ranked.slice(0, K);
  const pass = scored.find((x) => x.action.type === 'pass')!;
  if (!cands.includes(pass)) cands.push(pass);
  if (cands.length === 1) return { action: pass.action, score: pass.score, baseline };
  // とどめを刺せる手があれば読むまでもない
  const lethal = cands.find((x) => x.score >= 1000);
  if (lethal) return { action: lethal.action, score: lethal.score, baseline };

  const worlds = Array.from({ length: D }, () => determinize(cat, state, me, rng));
  const results: { c: Scored; total: number; n: number }[] = cands.map((c) => ({ c, total: 0, n: 0 }));
  // 状況を1つずつ増やしながら全候補を読む（時間切れになったら、そこまでの平均で決める）
  outer: for (const world of worlds) {
    for (const r of results) {
      if (now() - start > limit && results.every((x) => x.n > 0)) break outer;
      r.total += replyValue(cat, world, r.c.action, me, opp, w, start + limit * 1.5);
      r.n += 1;
    }
  }
  let best = results[results.length - 1];
  for (const r of results) {
    if (!r.n) continue;
    const avg = r.total / r.n;
    const bestAvg = best.n ? best.total / best.n : -Infinity;
    // 同じくらいなら段階2の評価が高い方
    if (avg > bestAvg + 0.05 || (Math.abs(avg - bestAvg) <= 0.05 && r.c.score > best.c.score)) best = r;
  }
  return { action: best.c.action, score: best.n ? best.total / best.n : best.c.score, baseline };
}

/**
 * 自分が a を打った後、このラウンドが終わるまで双方が段階2の方針で打ち進めた結果の評価（ロールアウト）。
 * 相手の応手と、それに対する自分の次の手まで反映される
 */
function replyValue(cat: Catalog, world: GameState, a: Action, me: PlayerId, _opp: PlayerId, w: AiWeights, deadline: number): number {
  let s: GameState;
  try {
    s = applyAction(cat, world, a);
  } catch {
    return -Infinity;
  }
  const round = world.round;
  for (let n = 0; n < 30 && !s.result && s.round === round && !s.pending; n++) {
    if (now() > deadline) break;
    const p = s.activePlayer;
    const { action } = chooseAction(cat, s, p, { level: 'normal', weights: w });
    s = applyAction(cat, s, action);
  }
  if (s.result || s.round > round) return evaluate(cat, s, me, w, true);
  return evaluate(cat, previewCombat(cat, s).state, me, w, false);
}
