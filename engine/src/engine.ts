// 試合の開始とアクションの適用（「状態 + アクション → 新しい状態」。ルール仕様書 18章）
import { cellName, opponent } from './board';
import type { Catalog } from './catalog';
import { getCard, getLeader, validateDeck } from './catalog';
import { CELLS, START_HAND, START_LIFE } from './constants';
import { randomInt, shuffleInPlace } from './rng';
import { IllegalAction, NeedChoice, Runner } from './runner';
import type { Action, CardInstance, DeckDef, DelayedEntry, EffectContext, GameState, PlayerId, PlayerState, TargetSpec } from './types';

export interface NewGameOptions {
  seed: number;
  /** 第1ラウンドの先手。省略時はランダム（3.2） */
  firstPlayer?: PlayerId;
  /** デッキの条件を確かめない（テスト用） */
  skipDeckCheck?: boolean;
  /** 初期ライフ（調整の実験用。省略時はルールどおり） */
  startLife?: number;
  /** 山札をシャッフルしない（テスト用。デッキに書いた順で山札の上から並ぶ） */
  noShuffle?: boolean;
}

function emptyPlayer(leaders: string[]): PlayerState {
  return {
    life: START_LIFE,
    maxMana: 0,
    mana: 0,
    reserve: 0,
    unusedMana: 0,
    spellsCast: 0,
    castSpellIds: [],
    leaders: leaders.map((id) => ({ id, grown: false, progress: 0, usedThisRound: false, costMod: 0 })),
    deck: [],
    hand: [],
    trash: [],
    exile: [],
    board: Array.from({ length: CELLS }, () => null),
    mulliganDone: false,
  };
}

export function emptyState(seed: number, leaders: Record<PlayerId, string[]>): GameState {
  return {
    version: 1,
    phase: 'mulligan',
    round: 0,
    firstPlayer: 'A',
    activePlayer: 'A',
    passStreak: 0,
    players: { A: emptyPlayer(leaders.A), B: emptyPlayer(leaders.B) },
    delayed: [],
    roundEnd: [],
    result: null,
    pending: null,
    seed,
    rngState: seed >>> 0,
    nextUid: 1,
    nextOrder: 1,
    actionsThisRound: 0,
    log: [],
  };
}

/** 対戦開始の手順（3.2）。マリガンの前（双方4枚引いた状態）まで進める */
export function newGame(cat: Catalog, decks: Record<PlayerId, DeckDef>, opts: NewGameOptions): GameState {
  if (!opts.skipDeckCheck) {
    for (const p of ['A', 'B'] as const) {
      const problems = validateDeck(decks[p], cat);
      if (problems.length) throw new Error(`プレイヤー ${p} のデッキが条件を満たしていません: ${problems.join(' / ')}`);
    }
  }
  const s = emptyState(opts.seed, { A: decks.A.leaders, B: decks.B.leaders });
  for (const p of ['A', 'B'] as const) {
    for (const { id, count } of decks[p].cards) {
      getCard(cat, id);
      for (let k = 0; k < count; k++) s.players[p].deck.push({ uid: s.nextUid++, cardId: id, costMod: 0, revealed: false, generated: false });
    }
    if (!opts.noShuffle) shuffleInPlace(s, s.players[p].deck);
  }
  if (opts.startLife !== undefined) for (const p of ['A', 'B'] as const) s.players[p].life = opts.startLife;
  s.firstPlayer = opts.firstPlayer ?? (randomInt(s, 2) === 0 ? 'A' : 'B');
  s.activePlayer = s.firstPlayer;
  const r = new Runner(cat, s);
  for (const p of ['A', 'B'] as const) for (let k = 0; k < START_HAND; k++) r.draw(p);
  r.log('gameStart', { firstPlayer: s.firstPlayer });
  return s;
}

/**
 * アクションを適用した新しい状態を返す（元の状態は変えない）。
 * 行えないアクションなら IllegalAction を投げる。
 * 効果の処理中に選択が必要になったら、state.pending に選択肢を入れて返す（choose アクションで答える）
 */
export function applyAction(cat: Catalog, state: GameState, action: Action): GameState {
  if (state.result) throw new IllegalAction('試合は終わっています');
  if (state.pending) {
    const pd = state.pending;
    if (action.type !== 'choose' || action.player !== pd.player) throw new IllegalAction('選択を待っています');
    if (!pd.options.some((o) => o.uid === action.option)) throw new IllegalAction('選べない選択肢です');
    return run(cat, pd.before, pd.action, [...pd.answers, action.option]);
  }
  if (action.type === 'choose') throw new IllegalAction('選ぶものがありません');
  return run(cat, state, action, []);
}

function run(cat: Catalog, before: GameState, action: Action, answers: number[]): GameState {
  const s = structuredClone(before);
  const r = new Runner(cat, s, answers);
  try {
    execute(r, action);
  } catch (e) {
    if (e instanceof NeedChoice) {
      const kept = structuredClone(before);
      kept.pending = { player: e.player, kind: 'pickCard', options: e.options, action, answers, before };
      return kept;
    }
    throw e;
  }
  return s;
}

// ---------------------------------------------------------------- アクションの実行

function execute(r: Runner, a: Action): void {
  const s = r.s;
  if (a.type === 'mulligan') return mulligan(r, a.player, a.cards);
  if (s.phase !== 'action') throw new IllegalAction('行動フェイズではありません');
  if (a.player !== s.activePlayer) throw new IllegalAction('行動権がありません');
  let quick = false;
  switch (a.type) {
    case 'playUnit':
      playUnit(r, a);
      break;
    case 'castSpell':
      quick = castSpell(r, a);
      break;
    case 'mobileMove':
      mobileMove(r, a.player, a.unit, a.to);
      break;
    case 'activate':
      activate(r, a);
      break;
    case 'leaderAbility':
      leaderAbility(r, a);
      break;
    case 'pass':
      r.log('pass', { player: a.player });
      break;
    default:
      throw new IllegalAction('行えないアクションです');
  }
  r.settle();
  s.actionsThisRound += 1;
  s.passStreak = a.type === 'pass' ? s.passStreak + 1 : 0;
  if (s.result) return;
  // 即効なら追加の手番（14.2）
  s.activePlayer = quick ? a.player : opponent(a.player);
  if (quick) r.log('quickTurn', { player: a.player });
  proceed(r);
}

/** 行動権を持つプレイヤーの判断が必要になるまで進める（遅延の発動、戦闘、ラウンドの切り替え） */
function proceed(r: Runner): void {
  const s = r.s;
  for (let guard = 0; guard < 1000 && !s.result; guard++) {
    if (s.passStreak >= 2 && s.delayed.length === 0) {
      r.combatPhase();
      if (s.result) return;
      r.endPhase();
      if (s.result) return;
      r.startRound(false);
      continue;
    }
    const p = s.activePlayer;
    if (s.delayed.some((d) => d.owner === p)) {
      // 手番の始めに遅延効果が発動し、それがこの手番のアクションになる（14.1）
      r.resolveDelays(p);
      s.passStreak = 0;
      s.actionsThisRound += 1;
      s.activePlayer = opponent(p);
      continue;
    }
    return;
  }
}

function mulligan(r: Runner, p: PlayerId, uids: number[]): void {
  const s = r.s;
  if (s.phase !== 'mulligan') throw new IllegalAction('マリガンの時間ではありません');
  const st = s.players[p];
  if (st.mulliganDone) throw new IllegalAction('マリガンは済んでいます');
  if (new Set(uids).size !== uids.length) throw new IllegalAction('同じカードを2回選んでいます');
  const aside: CardInstance[] = uids.map((uid) => {
    const i = st.hand.findIndex((c) => c.uid === uid);
    if (i < 0) throw new IllegalAction('手札にないカードです');
    return st.hand.splice(i, 1)[0];
  });
  // 脇に置いた枚数を引いてから、脇に置いたカードを山札に戻してシャッフルする（3.3）
  for (let k = 0; k < aside.length; k++) r.draw(p);
  st.deck.push(...aside);
  if (aside.length) shuffleInPlace(s, st.deck);
  st.mulliganDone = true;
  r.log('mulligan', { player: p, count: aside.length });
  if (s.players.A.mulliganDone && s.players.B.mulliganDone) {
    s.phase = 'action';
    r.startRound(true);
    proceed(r);
  }
}

function handCard(r: Runner, p: PlayerId, uid: number): CardInstance {
  const c = r.pl(p).hand.find((x) => x.uid === uid);
  if (!c) throw new IllegalAction('そのカードは手札にありません');
  return c;
}

/** ユニットの配置時の効果の対象の指定（強化で差し替えるものを含む） */
export function onPlayTargetSpecs(r: Runner, cardId: string, enhanced: boolean): TargetSpec[] {
  const def = getCard(r.cat, cardId);
  const out: TargetSpec[] = [];
  (def.abilities ?? []).forEach((ab, idx) => {
    if (ab.kind !== 'trigger' || ab.when !== 'onPlay') return;
    if (enhanced && def.enhance && def.enhance.appliesTo === idx && def.enhance.mode === 'replace' && def.enhance.targets) {
      out.push(...def.enhance.targets);
    } else out.push(...(ab.targets ?? []));
  });
  return out;
}

/** スペルを使うときの対象の指定 */
export function spellTargetSpecs(r: Runner, cardId: string, enhanced: boolean): TargetSpec[] {
  const def = getCard(r.cat, cardId);
  if (enhanced && def.enhance?.mode === 'replace' && def.enhance.targets) return def.enhance.targets;
  return def.targets ?? [];
}

function playUnit(r: Runner, a: Extract<Action, { type: 'playUnit' }>): void {
  const p = a.player;
  const inst = handCard(r, p, a.card);
  const def = getCard(r.cat, inst.cardId);
  if (def.type !== 'unit') throw new IllegalAction('ユニットではありません');
  if (!Number.isInteger(a.cell) || a.cell < 0 || a.cell >= CELLS || r.unitAt(p, a.cell)) throw new IllegalAction('そのマスには置けません');
  const enhanced = !!a.enhance;
  if (enhanced && !def.enhance) throw new IllegalAction('強化できないカードです');
  const plan = r.paymentPlan(p, r.cardCost(p, inst), enhanced ? r.enhanceCost(p, def) : 0);
  if (!plan) throw new IllegalAction('マナが足りません');
  const specs = onPlayTargetSpecs(r, inst.cardId, enhanced);
  const err = r.checkTargets(specs, a.targets, p, false, inst.uid);
  if (err) throw new IllegalAction(err);

  r.takeFromHand(p, inst.uid);
  r.pay(p, plan);
  const u = r.newUnit(p, inst.cardId, inst.uid, false, inst.generated);
  r.placeUnit(p, a.cell, u);
  r.log('playUnit', { player: p, card: inst.cardId, uid: u.uid, cell: cellName(a.cell), enhanced, paid: plan });
  // 配置時の効果（7.1 手順6）
  const targets = a.targets ?? {};
  (def.abilities ?? []).forEach((ab, idx) => {
    if (ab.kind !== 'trigger' || ab.when !== 'onPlay' || r.s.result) return;
    const ctx = r.unitCtx(u, p, targets);
    const scope = { sourceKind: 'unit' as const, cardId: def.id, enhanced, delays: [] };
    const en = enhanced && def.enhance && def.enhance.appliesTo === idx ? def.enhance : null;
    if (!en || en.mode === 'add') r.runEffects(ab.effects, ctx, scope);
    if (en) r.runEffects(en.effects, ctx, scope);
  });
}

function castSpell(r: Runner, a: Extract<Action, { type: 'castSpell' }>): boolean {
  const p = a.player;
  const inst = handCard(r, p, a.card);
  const def = getCard(r.cat, inst.cardId);
  if (def.type !== 'spell') throw new IllegalAction('スペルではありません');
  const enhanced = !!a.enhance;
  if (enhanced && !def.enhance) throw new IllegalAction('強化できないカードです');
  const plan = r.paymentPlan(p, r.cardCost(p, inst), enhanced ? r.enhanceCost(p, def) : 0);
  if (!plan) throw new IllegalAction('マナが足りません');
  const specs = spellTargetSpecs(r, inst.cardId, enhanced);
  const err = r.checkTargets(specs, a.targets, p, true, inst.uid);
  if (err) throw new IllegalAction(err);

  const card = r.takeFromHand(p, inst.uid);
  r.pay(p, plan);
  r.log('castSpell', { player: p, card: def.id, uid: card.uid, enhanced, targets: a.targets ?? {}, paid: plan });
  const ctx: EffectContext = { controller: p, source: { kind: 'card', cardId: def.id, uid: card.uid }, targets: a.targets ?? {} };
  const scope = { sourceKind: 'spell' as const, cardId: def.id, enhanced, delays: [] as DelayedEntry[] };
  const en = enhanced ? def.enhance! : null;
  if (!en || en.mode === 'add') r.runEffects(def.effects ?? [], ctx, scope);
  if (en) r.runEffects(en.effects, ctx, scope);
  // 遅延を予約したスペルは遅延ゾーンへ、それ以外はトラッシュへ（7.2 手順6）
  if (scope.delays.length) scope.delays[0].card = card;
  else r.pl(p).trash.push(card);
  // 使ったスペルの枚数は効果を処理し終えた時点で増える（11.7）
  r.pl(p).spellsCast += 1;
  r.pl(p).castSpellIds.push(def.id);
  r.spellCastEvent(p);
  return (def.keywords ?? []).includes('quick');
}

function mobileMove(r: Runner, p: PlayerId, uid: number, to: number): void {
  const loc = r.findUnit(uid);
  if (!loc || loc.p !== p) throw new IllegalAction('自分のユニットではありません');
  if (!r.hasKeyword(loc.unit, 'mobile')) throw new IllegalAction('機動を持っていません');
  if (loc.unit.mobileUsed) throw new IllegalAction('このラウンドはもう機動を使いました');
  if (!Number.isInteger(to) || to < 0 || to >= CELLS || r.unitAt(p, to)) throw new IllegalAction('移動先が空きマスではありません');
  loc.unit.mobileUsed = true;
  r.log('mobile', { player: p, card: loc.unit.cardId });
  r.moveUnits([{ from: loc, to }], p);
}

function activate(r: Runner, a: Extract<Action, { type: 'activate' }>): void {
  const p = a.player;
  const loc = r.findUnit(a.unit);
  if (!loc || loc.p !== p) throw new IllegalAction('自分のユニットではありません');
  const def = getCard(r.cat, loc.unit.cardId);
  const ab = def.abilities?.[a.ability];
  if (!ab || ab.kind !== 'activated') throw new IllegalAction('起動能力がありません');
  if (loc.unit.activatedUsed.includes(a.ability)) throw new IllegalAction('このラウンドはもう使いました');
  const plan = r.paymentPlan(p, 0, ab.cost);
  if (!plan) throw new IllegalAction('マナが足りません');
  const err = r.checkTargets(ab.targets, a.targets, p, true);
  if (err) throw new IllegalAction(err);

  r.pay(p, plan);
  loc.unit.activatedUsed.push(a.ability);
  r.log('activate', { player: p, card: def.id, uid: loc.unit.uid, ability: a.ability, targets: a.targets ?? {}, paid: plan });
  r.runEffects(ab.effects, r.unitCtx(loc.unit, p, a.targets ?? {}), { sourceKind: 'activated', cardId: def.id, enhanced: false, delays: [] });
}

function leaderAbility(r: Runner, a: Extract<Action, { type: 'leaderAbility' }>): void {
  const p = a.player;
  const st = r.pl(p).leaders[a.leader];
  if (!st) throw new IllegalAction('そのリーダーはいません');
  const ab = r.leaderAbility(p, a.leader);
  if (!ab) throw new IllegalAction('リーダー能力を使えません');
  if (st.usedThisRound) throw new IllegalAction('このラウンドはもう使いました');
  const plan = r.paymentPlan(p, 0, r.leaderCost(p, a.leader));
  if (!plan) throw new IllegalAction('マナが足りません');
  const err = r.checkTargets(ab.targets, a.targets, p, true);
  if (err) throw new IllegalAction(err);

  r.pay(p, plan);
  st.usedThisRound = true;
  r.log('leaderAbility', { player: p, leader: st.id, name: ab.name, targets: a.targets ?? {}, paid: plan });
  r.addProgress(p, 'leaderAbilityUsed', 1, a.leader);
  r.runEffects(ab.effects, r.leaderCtx(p, a.leader, a.targets ?? {}), {
    sourceKind: 'leader',
    cardId: getLeader(r.cat, st.id).id,
    enhanced: false,
    delays: [],
  });
}
