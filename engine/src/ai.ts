// AI（タスク 2-5・4-1・4-2）
//
// 強さは3段階。どれも相手の手札と山札の中身は見ない（publicView と、自分のデッキの中身だけを使う）。
//   easy   … 段階1。合法手を1つずつ試し、このラウンドの戦闘の結果まで見た評価で選ぶ。評価に揺らぎを入れて手加減する
//   normal … 段階2。段階1の評価に、手札のカードの重さ・予備マナ・使えるリーダー能力の価値を加える。即効の手はその後の自分の手まで、
//            良さそうな手は「相手がパスした後の自分の次の手」まで読む
//   hard   … 段階3。段階2で良さそうな手を絞り、相手の手札を推測した「ありうる状況」を何通りか作って、
//            そのラウンドの終わりまで双方が段階2の方針で打ち進めた結果の平均で選ぶ（決定化したロールアウト）。思考時間に上限がある
import { opponent } from './board';
import type { Catalog } from './catalog';
import { getCard, getLeader } from './catalog';
import { applyAction } from './engine';
import { handAdjust } from './hand-table';
import { legalActions } from './legal';
import { chooseMulligan, type MulliganPolicy } from './mulligan';
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
  /**
   * 使ったスペル1枚の価値（「使ったスペルの枚数」で強くなるカードを持っているときだけ。調整用、省略時 0）。
   * 持っている枚数（山札・手札。6枚で最大）に比例させる
   */
  spellCount?: number;
  /** 手札が多いときの、5枚目以降の手札1枚の価値の倍率（調整用、省略時 1。持ちすぎを嫌う） */
  handExtra?: number;
  /** 即効の手（追加の手番を得る手）は、その後の自分の手を1手読んで評価する（ふつう・つよいで有効） */
  quickFollow?: boolean;
  /** 自分の手札の価値を、カードごと・相手の勢力ごとの表（hand-table.json）で補正する（案 D） */
  handTable?: boolean;
  /**
   * 組み合わせを読む（案 C）。1手読みの上位 planTop 個の手について「その手 → 相手がパス → 自分の次の手」まで読み、
   * 良くなる分の planFollow 倍を評価に足す（調整用、省略時 0）
   */
  planFollow?: number;
  planTop?: number;
  /** パスの評価に足すボーナス（調整用、省略時 0）。ほかの手は、パスよりこれ以上良いときだけ選ぶ */
  passBonus?: number;
  /**
   * 相手に先に行動させて対応できる価値としてパスに足すボーナスの最大値（調整用、省略時 0）。
   * 相手の取れる行動が多いほど大きく（3つ以上で最大）、相手がすでにパスしていて自分のパスで戦闘になるときは 0
   */
  passReact?: number;
  /** 次のラウンドのマナ（最大マナ＋1と予備マナ）で使えない手札の価値の倍率（案 B の評価版。調整用、省略時 1） */
  unplayableHand?: number;
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
  // 0.3 → 0.6（ai.md 10章。同じデッキで比べて勝率 52.2%）
  reserve: 0.6,
  leaderReady: 0.8,
  // 即効の後の自分の手まで読む（ai.md 9章。同じデッキで比べて勝率 51.7%）
  quickFollow: true,
  // 組み合わせを読む（案 C。ai.md 12章。同じデッキで比べて勝率 54.0%）
  planFollow: 1,
  planTop: 6,
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
  /** hard のロールアウトで読むラウンド数（1 = このラウンドの終わりまで。案 B） */
  rolloutRounds?: number;
  /** マリガンの方針（省略時: easy は cost、normal・hard は smart） */
  mulligan?: MulliganPolicy;
  /** smart のマリガンの余裕（調整用） */
  mulliganMargin?: number;
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
  let w = opts.weights ?? (level === 'easy' ? STAGE1_WEIGHTS : STAGE2_WEIGHTS);
  // 「使ったスペルの枚数」で強くなるカードをどれだけ持っているか（自分のデッキの中身は知っている）
  if (w.spellCount) w = { ...w, spellCount: w.spellCount * spellScaling(cat, state.players[player]) };
  if (state.pending) {
    if (state.pending.player !== player) throw new Error('AI の番ではありません');
    // 山札の上から見て選ぶ: 一番コストの高いカードを取る
    const best = [...state.pending.options].sort((a, b) => getCard(cat, b.cardId).cost - getCard(cat, a.cardId).cost)[0];
    return { action: { type: 'choose', player, option: best.uid }, score: 0, baseline: 0 };
  }
  if (state.phase === 'mulligan') {
    const cards = chooseMulligan(cat, state, player, opts.mulligan ?? (level === 'easy' ? 'cost' : 'smart'), undefined, opts.mulliganMargin);
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

/**
 * 相手の取れる行動の多さ（0〜1）。自分がパスした後、相手が何かしてきたらそれに対応できる価値の目安。
 * 相手がすでにパスしていて、自分のパスで戦闘になるなら 0
 */
function reactValue(cat: Catalog, s: GameState, me: PlayerId): number {
  if (s.passStreak >= 1) return 0;
  const st = s.players[opponent(me)];
  const budget = st.mana + st.reserve;
  const r = new Runner(cat, s);
  // 手札は中身が分からないので、1枚2マナとして払える枚数だけ数える
  let k = Math.min(st.hand.length, Math.floor(budget / 2));
  for (const u of st.board) {
    if (!u) continue;
    if (!u.mobileUsed && r.hasKeyword(u, 'mobile')) k++;
    getCard(cat, u.cardId).abilities?.forEach((a, i) => {
      if (a.kind === 'activated' && a.cost <= budget && !u.activatedUsed.includes(i)) k++;
    });
  }
  st.leaders.forEach((l, idx) => {
    if (!l.usedThisRound && r.leaderAbility(opponent(me), idx) && r.leaderCost(opponent(me), idx) <= budget) k++;
  });
  return Math.min(1, k / 3);
}

function scoreAll(cat: Catalog, view: GameState, me: PlayerId, w: AiWeights): Scored[] {
  const scored = legalActions(cat, view)
    .filter((a) => a.player === me)
    .map((action) => ({ action, score: scoreAfter(cat, view, action, me, w) }));
  if (w.planFollow) planAhead(cat, view, me, w, scored);
  const passExtra = (w.passBonus ?? 0) + (w.passReact ? w.passReact * reactValue(cat, view, me) : 0);
  if (passExtra) for (const x of scored) if (x.action.type === 'pass') x.score += passExtra;
  return scored;
}

/**
 * 組み合わせを読む（案 C）: 良さそうな手の後、相手がパスしたとして、自分の次の手まで読む。
 * 次の手と合わせると良くなる手（遅延で動かしておいて、次の手番で当てるなど）の評価を上げる
 */
function planAhead(cat: Catalog, view: GameState, me: PlayerId, w: AiWeights, scored: Scored[]): void {
  const opp = opponent(me);
  const w1: AiWeights = { ...w, planFollow: 0, quickFollow: false };
  const top = scored
    .filter((x) => x.action.type !== 'pass' && Number.isFinite(x.score) && x.score < 1000)
    .sort((a, b) => b.score - a.score)
    .slice(0, w.planTop ?? 6);
  for (const x of top) {
    let s: GameState;
    try {
      s = applyAction(cat, view, x.action);
      if (s.result || s.pending || s.phase !== 'action' || s.round !== view.round || s.activePlayer !== opp) continue;
      s = applyAction(cat, s, { type: 'pass', player: opp });
    } catch {
      continue;
    }
    if (s.result || s.pending || s.phase !== 'action' || s.round !== view.round || s.activePlayer !== me) continue;
    let best = -Infinity;
    for (const b of legalActions(cat, s)) {
      if (b.player !== me || b.type === 'pass') continue;
      best = Math.max(best, scoreAfter(cat, s, b, me, w1));
    }
    if (best > x.score) x.score += (best - x.score) * w.planFollow!;
  }
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
  const here = settleScore(cat, view, next, me, w);
  // 即効で追加の手番を得たら、その手番に打つ手まで読む（打たずにパスする場合も含む）
  if (w.quickFollow && a.type !== 'pass' && !next.result && !next.pending && next.phase === 'action' && next.round === view.round && next.activePlayer === me) {
    const w1 = { ...w, quickFollow: false };
    let best = here;
    for (const b of legalActions(cat, next)) {
      if (b.player !== me || b.type === 'pass') continue;
      best = Math.max(best, scoreAfter(cat, next, b, me, w1));
    }
    return best;
  }
  return here;
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
    const oppFactions = w.handTable && p === me ? s.players[opp].leaders.map((l) => getLeader(cat, l.id).faction) : null;
    st.hand.forEach((c, i) => {
      let hv = w.hand + (w.handCost ? w.handCost * Math.min(6, cardCostGuess(cat, c)) : 0);
      if (oppFactions && c.cardId !== '?') hv = Math.max(0, hv + handAdjust(c.cardId, oppFactions));
      if (w.unplayableHand !== undefined && p === me && c.cardId !== '?') {
        const budget = Math.min(10, st.maxMana + (roundOver ? 0 : 1)) + (roundOver ? st.reserve : st.reserve + st.mana);
        if (r.cardCost(p, c) > budget) hv *= w.unplayableHand;
      }
      v += i >= 4 && w.handExtra !== undefined ? hv * w.handExtra : hv;
    });
    // 使ったスペルの枚数の価値（自分だけ。chooseAction で自分のデッキの中身に合わせて spellCount を決めてある）
    if (w.spellCount && p === me) v += w.spellCount * Math.min(12, st.spellsCast);
    const futureReserve = roundOver ? st.reserve : st.reserve + st.mana;
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

/** 「使ったスペルの枚数」で強くなるカードを、山札・手札にどれだけ持っているか（0〜1） */
function spellScaling(cat: Catalog, st: GameState['players'][PlayerId]): number {
  let n = 0;
  for (const c of [...st.deck, ...st.hand]) if (c.cardId !== '?' && scalesWithSpells(cat, c.cardId)) n++;
  return Math.min(1, n / 6);
}

const scalingCache = new Map<string, boolean>();
function scalesWithSpells(cat: Catalog, id: string): boolean {
  let v = scalingCache.get(id);
  if (v === undefined) scalingCache.set(id, (v = JSON.stringify(getCard(cat, id)).includes('spellsCastThisGame')));
  return v;
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
  const pool = [...cat.cards.values()].filter((c) => facs.has(c.faction) && !c.token).map((c) => c.id);
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
      r.total += replyValue(cat, world, r.c.action, me, opp, w, start + limit * 1.5, opts.rolloutRounds ?? 1);
      r.n += 1;
    }
  }
  let best = results[results.length - 1];
  for (const r of results) {
    if (!r.n) continue;
    // パスのボーナスはロールアウトの結果にも足す
    const bonus = (x: typeof r) => (x.c.action.type === 'pass' ? (w.passBonus ?? 0) + (w.passReact ? w.passReact * reactValue(cat, state, me) : 0) : 0);
    const avg = r.total / r.n + bonus(r);
    const bestAvg = best.n ? best.total / best.n + bonus(best) : -Infinity;
    // 同じくらいなら段階2の評価が高い方
    if (avg > bestAvg + 0.05 || (Math.abs(avg - bestAvg) <= 0.05 && r.c.score > best.c.score)) best = r;
  }
  return { action: best.c.action, score: best.n ? best.total / best.n : best.c.score, baseline };
}

/**
 * 自分が a を打った後、このラウンドが終わるまで双方が段階2の方針で打ち進めた結果の評価（ロールアウト）。
 * 相手の応手と、それに対する自分の次の手まで反映される
 */
function replyValue(cat: Catalog, world: GameState, a: Action, me: PlayerId, _opp: PlayerId, w: AiWeights, deadline: number, rounds = 1): number {
  let s: GameState;
  try {
    s = applyAction(cat, world, a);
  } catch {
    return -Infinity;
  }
  // rounds ラウンド先の終わりまで（次のラウンドの始めのドローと、マナの回復も含めて）打ち進める
  const end = world.round + rounds;
  for (let n = 0; n < 30 * rounds && !s.result && s.round < end && !s.pending; n++) {
    if (now() > deadline) break;
    const p = s.activePlayer;
    const { action } = chooseAction(cat, s, p, { level: 'normal', weights: { ...w, planFollow: 0 } });
    s = applyAction(cat, s, action);
  }
  if (s.result || s.round >= end) return evaluate(cat, s, me, w, true);
  return evaluate(cat, previewCombat(cat, s).state, me, w, false);
}
