// ルールの処理の本体。GameState を直接書き換える（呼び出し側で複製してから使う）
// 効果の処理（11章）、誘発（11.2〜11.3）、戦闘（8章）、ラウンドの進行（6章）、勝敗（9章）
import { cellIndex, cellName, laneOf, leftRight, opponent, otherRow, rowOf } from './board';
import type { Catalog } from './catalog';
import { getCard, getLeader } from './catalog';
import { CELLS, HAND_LIMIT, LANES, MAX_MANA_CAP } from './constants';
import { pickRandom, shuffleInPlace } from './rng';
import type {
  Ability,
  CardDef,
  CardInstance,
  Condition,
  DelayedEntry,
  Effect,
  EffectContext,
  GameState,
  Keyword,
  LaneRef,
  LeaderAbility,
  PlayerId,
  PlayerState,
  Selector,
  TargetSpec,
  TargetValue,
  TriggerType,
  Unit,
  Value,
} from './types';

/** 効果の処理中にプレイヤーの選択が必要になった（engine.ts がアクションをやり直す） */
export class NeedChoice {
  constructor(
    public readonly player: PlayerId,
    public readonly options: { uid: number; cardId: string }[],
  ) {}
}

export class IllegalAction extends Error {}

export interface Located {
  unit: Unit;
  p: PlayerId;
  i: number;
}

export interface Cell {
  p: PlayerId;
  i: number;
}

type GameEvent =
  | { type: 'move'; uid: number; owner: PlayerId }
  | { type: 'destroyed'; uid: number; cardId: string; owner: PlayerId; cell: number }
  | { type: 'spellCast'; p: PlayerId }
  | { type: 'endure'; uid: number; owner: PlayerId }
  | { type: 'phase'; when: 'roundStart' | 'roundEnd' | 'combatStart' | 'combatEnd' };

interface QueuedTrigger {
  ctx: EffectContext;
  effects: Effect[];
  /** 手札にある間の効果は、そのカードが手札を離れていたら処理しない */
  handUid?: number;
  order: [number, number];
}

interface StaticTotals {
  units: Map<number, { attack: number; health: number; keywords: Set<Keyword> }>;
  players: Record<PlayerId, { enhanceCost: number; spellCost: number }>;
}

/** 処理中の効果の出どころ（遅延の予約に使う） */
interface Scope {
  sourceKind: DelayedEntry['sourceKind'];
  cardId: string;
  enhanced: boolean;
  delays: DelayedEntry[];
}

const BASE_ONLY_KEYWORDS: Keyword[] = ['shield', 'delay', 'quick'];

export class Runner {
  private queue: QueuedTrigger[] = [];
  private answerIndex = 0;
  private rawStats = false;
  private staticCache: StaticTotals | null = null;

  constructor(
    readonly cat: Catalog,
    readonly s: GameState,
    private readonly answers: number[] = [],
  ) {}

  // ================================================================ 参照

  pl(p: PlayerId): PlayerState {
    return this.s.players[p];
  }

  card(id: string): CardDef {
    return getCard(this.cat, id);
  }

  log(type: string, data: Record<string, unknown> = {}): void {
    this.s.log.push({ round: this.s.round, type, ...data });
  }

  /** 盤面が変わったら静的な効果を計算し直す */
  touch(): void {
    this.staticCache = null;
  }

  allUnits(): Located[] {
    const out: Located[] = [];
    for (const p of this.playerOrder()) {
      this.pl(p).board.forEach((unit, i) => {
        if (unit) out.push({ unit, p, i });
      });
    }
    return out;
  }

  findUnit(uid: number | undefined): Located | null {
    if (uid === undefined) return null;
    for (const p of ['A', 'B'] as const) {
      const i = this.pl(p).board.findIndex((u) => u?.uid === uid);
      if (i >= 0) return { unit: this.pl(p).board[i]!, p, i };
    }
    return null;
  }

  unitAt(p: PlayerId, i: number): Unit | null {
    return this.pl(p).board[i] ?? null;
  }

  /** 先手トークンを持つプレイヤー → 相手 の順 */
  playerOrder(): PlayerId[] {
    return [this.s.firstPlayer, opponent(this.s.firstPlayer)];
  }

  newUid(): number {
    return this.s.nextUid++;
  }

  // ================================================================ 能力値（10章・11.5）

  private statics(): StaticTotals {
    if (this.staticCache) return this.staticCache;
    const totals: StaticTotals = {
      units: new Map(),
      players: { A: { enhanceCost: 0, spellCost: 0 }, B: { enhanceCost: 0, spellCost: 0 } },
    };
    // 静的な効果の条件は、静的な効果を含まない値で判定する（循環を避けるため）
    this.rawStats = true;
    try {
      const apply = (abilities: Ability[] | undefined, ctx: EffectContext) => {
        for (const a of abilities ?? []) {
          if (a.kind !== 'static') continue;
          for (const m of a.modifiers) {
            if (m.target === 'allyPlayer' || m.target === 'enemyPlayer') {
              const q = m.target === 'allyPlayer' ? ctx.controller : opponent(ctx.controller);
              totals.players[q].enhanceCost += m.enhanceCost ?? 0;
              totals.players[q].spellCost += m.spellCost ?? 0;
              continue;
            }
            for (const { unit } of this.units(m.target, ctx)) {
              let t = totals.units.get(unit.uid);
              if (!t) totals.units.set(unit.uid, (t = { attack: 0, health: 0, keywords: new Set() }));
              t.attack += m.attack ?? 0;
              t.health += m.health ?? 0;
              for (const k of m.keywords ?? []) t.keywords.add(k);
            }
          }
        }
      };
      for (const { unit, p } of this.allUnits()) {
        apply(this.card(unit.cardId).abilities, this.unitCtx(unit, p));
      }
      for (const p of this.playerOrder()) {
        this.pl(p).leaders.forEach((_l, idx) => {
          apply(this.leaderPassives(p, idx), this.leaderCtx(p, idx));
        });
      }
    } finally {
      this.rawStats = false;
    }
    this.staticCache = totals;
    return totals;
  }

  private staticOf(u: Unit) {
    return this.rawStats ? undefined : this.statics().units.get(u.uid);
  }

  attack(u: Unit): number {
    const base = this.card(u.cardId).attack ?? 0;
    return Math.max(0, base + u.attackPerm + u.attackTemp + (this.staticOf(u)?.attack ?? 0));
  }

  maxHealth(u: Unit): number {
    const base = this.card(u.cardId).health ?? 0;
    return base + u.healthPerm + u.healthTemp + (this.staticOf(u)?.health ?? 0);
  }

  health(u: Unit): number {
    return this.maxHealth(u) - u.damage - u.tempDamage;
  }

  keywords(u: Unit): Set<Keyword> {
    const set = new Set<Keyword>();
    for (const k of this.card(u.cardId).keywords ?? []) if (!BASE_ONLY_KEYWORDS.includes(k)) set.add(k);
    for (const k of u.keywordsPerm) set.add(k);
    for (const k of u.keywordsTemp) set.add(k);
    for (const k of this.staticOf(u)?.keywords ?? []) set.add(k);
    set.delete('shield');
    if (u.shield) set.add('shield');
    return set;
  }

  hasKeyword(u: Unit, k: Keyword): boolean {
    return this.keywords(u).has(k);
  }

  // ================================================================ コスト（16章）

  cardCost(p: PlayerId, inst: CardInstance): number {
    const def = this.card(inst.cardId);
    let mod = def.type === 'spell' ? this.statics().players[p].spellCost : 0;
    for (const a of def.abilities ?? []) {
      if (a.kind === 'costReduction') mod -= this.value(a.by, { controller: p, source: { kind: 'hand', cardId: def.id, uid: inst.uid }, targets: {} });
    }
    return Math.max(0, def.cost + inst.costMod + mod);
  }

  enhanceCost(p: PlayerId, def: CardDef): number {
    if (!def.enhance) return 0;
    // enhanceCost の増減はスペルの強化だけにかかる（AC-16）
    const mod = def.type === 'spell' ? this.statics().players[p].enhanceCost : 0;
    return Math.max(0, def.enhance.cost + mod);
  }

  leaderAbility(p: PlayerId, idx: number): LeaderAbility | undefined {
    const st = this.pl(p).leaders[idx];
    const def = getLeader(this.cat, st.id);
    return st.grown ? def.grown.ability : def.ability;
  }

  leaderPassives(p: PlayerId, idx: number): Ability[] {
    const st = this.pl(p).leaders[idx];
    const def = getLeader(this.cat, st.id);
    return (st.grown ? def.grown.passives : def.passives) ?? [];
  }

  leaderCost(p: PlayerId, idx: number): number {
    const ab = this.leaderAbility(p, idx);
    return ab ? Math.max(0, ab.cost + this.pl(p).leaders[idx].costMod) : 0;
  }

  /**
   * 支払えるかを調べる。normal は通常マナでしか払えない分、flex は予備マナ／通常マナで払える分。
   * flex は予備マナから必ず先に払う（16.2）。払えなければ null
   */
  paymentPlan(p: PlayerId, normal: number, flex: number): { reserve: number; mana: number } | null {
    const st = this.pl(p);
    const r = Math.min(st.reserve, flex);
    const mana = normal + flex - r;
    if (mana > st.mana) return null;
    return { reserve: r, mana };
  }

  pay(p: PlayerId, plan: { reserve: number; mana: number }): void {
    this.pl(p).reserve -= plan.reserve;
    this.pl(p).mana -= plan.mana;
  }

  // ================================================================ 文脈

  unitCtx(u: Unit, p: PlayerId, targets: EffectContext['targets'] = {}): EffectContext {
    const loc = this.findUnit(u.uid);
    return {
      controller: p,
      source: { kind: 'unit', cardId: u.cardId, uid: u.uid },
      selfUid: u.uid,
      selfCell: loc?.i,
      targets,
    };
  }

  leaderCtx(p: PlayerId, idx: number, targets: EffectContext['targets'] = {}): EffectContext {
    return { controller: p, source: { kind: 'leader', cardId: this.pl(p).leaders[idx].id, leader: idx }, targets };
  }

  // ================================================================ セレクタ・数値・条件（card-data.md 4章）

  private lanes(ref: LaneRef, ctx: EffectContext): number[] {
    if (ref === 'all') return [1, 2, 3, 4];
    if (typeof ref === 'number') return [ref];
    if ('laneOf' in ref) {
      if (ref.laneOf === 'self' && ctx.selfLane !== undefined) return [ctx.selfLane];
      const us = this.units(ref.laneOf, ctx);
      if (us.length) return [...new Set(us.map((x) => laneOf(x.i)))];
      if (ref.laneOf === 'self' && ctx.selfCell !== undefined) return [laneOf(ctx.selfCell)];
      return [];
    }
    const out: number[] = [];
    for (const v of ctx.targets[ref.ref] ?? []) {
      if (v.kind === 'lane') out.push(v.lane);
      else if (v.kind === 'cell') out.push(laneOf(v.i));
      else if (v.kind === 'unit') {
        const loc = this.findUnit(v.uid);
        if (loc) out.push(laneOf(loc.i));
      }
    }
    return out;
  }

  private sideMatches(side: 'ally' | 'enemy' | 'any' | undefined, owner: PlayerId, controller: PlayerId): boolean {
    if (!side || side === 'any') return true;
    return side === 'ally' ? owner === controller : owner !== controller;
  }

  /** セレクタが指すユニット（盤面にいるものだけ） */
  units(sel: Selector, ctx: EffectContext): Located[] {
    if (sel === 'self') {
      const l = this.findUnit(ctx.selfUid);
      return l ? [l] : [];
    }
    if (sel === 'eventUnit') {
      const l = this.findUnit(ctx.eventUid);
      return l ? [l] : [];
    }
    if (sel === 'enemyPlayer' || sel === 'allyPlayer') return [];
    if ('ref' in sel) {
      const out: Located[] = [];
      for (const v of ctx.targets[sel.ref] ?? []) {
        if (v.kind === 'unit') {
          const l = this.findUnit(v.uid);
          if (l) out.push(l);
        } else if (v.kind === 'cell') {
          const u = this.unitAt(v.p, v.i);
          if (u) out.push({ unit: u, p: v.p, i: v.i });
        }
      }
      return out;
    }
    if ('cell' in sel) {
      const q = sel.cell.owner === 'ally' ? ctx.controller : opponent(ctx.controller);
      const out: Located[] = [];
      for (const lane of this.lanes(sel.cell.lane, ctx)) {
        const i = cellIndex(lane, sel.cell.row);
        const u = this.unitAt(q, i);
        if (u) out.push({ unit: u, p: q, i });
      }
      return out;
    }
    if ('cellsRelative' in sel) {
      return this.cells(sel, ctx).flatMap((c) => {
        const u = this.unitAt(c.p, c.i);
        return u ? [{ unit: u, p: c.p, i: c.i }] : [];
      });
    }
    const f = sel.units;
    let list = this.allUnits().filter((x) => this.sideMatches(f.side, x.p, ctx.controller));
    if (f.other) list = list.filter((x) => x.unit.uid !== ctx.selfUid);
    if (f.relative) {
      const self = this.findUnit(ctx.selfUid);
      if (!self) return [];
      const cells = f.relative === 'leftRight' ? leftRight(self.i) : [otherRow(self.i)];
      list = list.filter((x) => x.p === self.p && cells.includes(x.i));
    }
    if (f.lane !== undefined) {
      const lanes = this.lanes(f.lane, ctx);
      list = list.filter((x) => lanes.includes(laneOf(x.i)));
    }
    if (f.row) list = list.filter((x) => rowOf(x.i) === f.row);
    if (f.cardId) list = list.filter((x) => x.unit.cardId === f.cardId);
    if (f.where) list = list.filter((x) => this.unitMatches(x, f.where!));
    if (f.random !== undefined) list = pickRandom(this.s, list, f.random);
    return list;
  }

  /** セレクタが指すマス */
  cells(sel: Selector, ctx: EffectContext): Cell[] {
    if (typeof sel === 'string') {
      if (sel === 'self' || sel === 'eventUnit') return this.units(sel, ctx).map((x) => ({ p: x.p, i: x.i }));
      return [];
    }
    if ('ref' in sel) {
      const out: Cell[] = [];
      for (const v of ctx.targets[sel.ref] ?? []) {
        if (v.kind === 'cell') out.push({ p: v.p, i: v.i });
        else if (v.kind === 'unit') {
          const l = this.findUnit(v.uid);
          if (l) out.push({ p: l.p, i: l.i });
        }
      }
      return out;
    }
    if ('cellsRelative' in sel) {
      const self = this.findUnit(ctx.selfUid);
      const p = self?.p ?? ctx.controller;
      const at = self?.i ?? ctx.selfCell;
      if (at === undefined) return [];
      return leftRight(at).map((i) => ({ p, i }));
    }
    if ('cell' in sel) {
      const q = sel.cell.owner === 'ally' ? ctx.controller : opponent(ctx.controller);
      return this.lanes(sel.cell.lane, ctx).map((lane) => ({ p: q, i: cellIndex(lane, sel.cell.row) }));
    }
    return this.units(sel, ctx).map((x) => ({ p: x.p, i: x.i }));
  }

  /** セレクタが指すプレイヤー（本体） */
  players(sel: Selector, ctx: EffectContext): PlayerId[] {
    if (sel === 'enemyPlayer') return [opponent(ctx.controller)];
    if (sel === 'allyPlayer') return [ctx.controller];
    if (typeof sel === 'object' && 'ref' in sel) {
      return (ctx.targets[sel.ref] ?? []).flatMap((v) => (v.kind === 'player' ? [v.p] : []));
    }
    return [];
  }

  /** セレクタが指す手札のカード（効果の持ち主の手札だけ） */
  handCards(sel: Selector, ctx: EffectContext): CardInstance[] {
    const hand = this.pl(ctx.controller).hand;
    if (sel === 'self') {
      const uid = ctx.source.kind === 'hand' ? ctx.source.uid : undefined;
      return hand.filter((c) => c.uid === uid);
    }
    if (typeof sel === 'object' && 'ref' in sel) {
      const uids = (ctx.targets[sel.ref] ?? []).flatMap((v) => (v.kind === 'card' ? [v.uid] : []));
      return hand.filter((c) => uids.includes(c.uid));
    }
    return [];
  }

  value(v: Value, ctx: EffectContext): number {
    if (typeof v === 'number') return v;
    if ('attackOf' in v) {
      const u = this.units(v.attackOf, ctx)[0];
      return u ? this.attack(u.unit) : (v.ifGone ?? 0);
    }
    if ('count' in v) return v.count === 'unitMovesThisGame' ? (this.s.unitMoves ?? 0) : this.pl(ctx.controller).spellsCast;
    return Math.min(this.value(v.max, ctx), v.cap);
  }

  unitMatches(x: Located, c: Condition): boolean {
    if ('all' in c) return c.all.every((y) => this.unitMatches(x, y));
    if ('any' in c) return c.any.some((y) => this.unitMatches(x, y));
    if ('empty' in c) return c.empty === false;
    if ('row' in c) return rowOf(x.i) === c.row;
    if ('type' in c) return c.type === 'unit';
    if ('attackAtMost' in c) return this.attack(x.unit) <= c.attackAtMost;
    if ('healthAtMost' in c) return this.health(x.unit) <= c.healthAtMost;
    if ('hasKeyword' in c) return this.hasKeyword(x.unit, c.hasKeyword);
    return false;
  }

  cellMatches(cell: Cell, c: Condition): boolean {
    const u = this.unitAt(cell.p, cell.i);
    if ('all' in c) return c.all.every((y) => this.cellMatches(cell, y));
    if ('any' in c) return c.any.some((y) => this.cellMatches(cell, y));
    if ('empty' in c) return (u === null) === c.empty;
    if ('row' in c) return rowOf(cell.i) === c.row;
    return u ? this.unitMatches({ unit: u, p: cell.p, i: cell.i }, c) : false;
  }

  cardMatches(cardId: string, c: Condition): boolean {
    if ('all' in c) return c.all.every((y) => this.cardMatches(cardId, y));
    if ('any' in c) return c.any.some((y) => this.cardMatches(cardId, y));
    if ('type' in c) return this.card(cardId).type === c.type;
    return false;
  }

  // ================================================================ 対象の選び方（7.2・11.4）

  /**
   * 対象の指定1つについて、選べる値の一覧を返す（count が2以上なら組み合わせ）。
   * chosen はそれより前の対象で選んだ値、exclude は選べない手札（今使っているカード）
   */
  targetOptions(spec: TargetSpec, controller: PlayerId, chosen: EffectContext['targets'], exclude?: number): TargetValue[][] {
    const singles: TargetValue[] = [];
    const opp = opponent(controller);
    switch (spec.kind) {
      case 'unit':
      case 'unitOrPlayer': {
        for (const x of this.allUnits()) {
          if (!this.sideMatches(spec.side, x.p, controller)) continue;
          if (spec.where && !this.unitMatches(x, spec.where)) continue;
          singles.push({ kind: 'unit', uid: x.unit.uid });
        }
        if (spec.kind === 'unitOrPlayer') {
          for (const q of [controller, opp]) if (this.sideMatches(spec.side, q, controller)) singles.push({ kind: 'player', p: q });
        }
        break;
      }
      case 'cell': {
        let owners: PlayerId[];
        const o = spec.cellOwner ?? 'any';
        if (o === 'ally') owners = [controller];
        else if (o === 'enemy') owners = [opp];
        else if (o === 'any') owners = [controller, opp];
        else if ('ownerOf' in o) {
          const v = chosen[o.ownerOf]?.[0];
          const loc = v?.kind === 'unit' ? this.findUnit(v.uid) : null;
          owners = loc ? [loc.p] : [];
        } else {
          const v = chosen[o.sameOwnerAs]?.[0];
          owners = v?.kind === 'cell' ? [v.p] : [];
        }
        const taken = Object.values(chosen)
          .flat()
          .filter((v): v is Extract<TargetValue, { kind: 'cell' }> => v.kind === 'cell');
        for (const p of owners) {
          for (let i = 0; i < CELLS; i++) {
            if (taken.some((t) => t.p === p && t.i === i)) continue;
            if (spec.where && !this.cellMatches({ p, i }, spec.where)) continue;
            singles.push({ kind: 'cell', p, i });
          }
        }
        break;
      }
      case 'lane':
        for (let lane = 1; lane <= LANES; lane++) singles.push({ kind: 'lane', lane });
        break;
      case 'cardInHand': {
        const q = spec.side === 'enemy' ? opp : controller;
        for (const c of this.pl(q).hand) {
          if (c.uid === exclude) continue;
          if (spec.where && !this.cardMatches(c.cardId, spec.where)) continue;
          singles.push({ kind: 'card', uid: c.uid });
        }
        break;
      }
    }
    const count = Math.min(spec.count ?? 1, singles.length);
    if (count <= 0) return [];
    return combinations(singles, count);
  }

  /** 対象の指定の並びに対して、選べる組み合わせをすべて返す。必要な対象を選べなければ空 */
  targetCombos(specs: TargetSpec[] | undefined, controller: PlayerId, required: boolean, exclude?: number): EffectContext['targets'][] {
    let acc: EffectContext['targets'][] = [{}];
    for (const spec of specs ?? []) {
      const next: EffectContext['targets'][] = [];
      for (const chosen of acc) {
        const opts = this.targetOptions(spec, controller, chosen, exclude);
        if (!opts.length) {
          if (required && !spec.optional) continue;
          next.push({ ...chosen, [spec.id]: [] });
          continue;
        }
        for (const o of opts) next.push({ ...chosen, [spec.id]: o });
      }
      acc = next;
    }
    return acc;
  }

  /** 選んだ対象が正しいかを調べる。正しくなければ理由を返す */
  checkTargets(
    specs: TargetSpec[] | undefined,
    given: EffectContext['targets'] | undefined,
    controller: PlayerId,
    required: boolean,
    exclude?: number,
  ): string | null {
    const chosen: EffectContext['targets'] = {};
    for (const spec of specs ?? []) {
      const val = given?.[spec.id] ?? [];
      const opts = this.targetOptions(spec, controller, chosen, exclude);
      if (!opts.length) {
        if (required && !spec.optional) return `対象 ${spec.id} を選べません`;
        if (val.length) return `対象 ${spec.id} は選べません`;
        chosen[spec.id] = [];
        continue;
      }
      if (!val.length && spec.optional) {
        chosen[spec.id] = [];
        continue;
      }
      const key = canonical(val);
      if (!opts.some((o) => canonical(o) === key)) return `対象 ${spec.id} の選び方が正しくありません`;
      chosen[spec.id] = val;
    }
    return null;
  }

  // ================================================================ 盤面の操作

  newUnit(p: PlayerId, cardId: string, uid: number, isToken: boolean, generated = false): Unit {
    return {
      uid,
      cardId,
      owner: p,
      isToken,
      generated,
      damage: 0,
      tempDamage: 0,
      attackPerm: 0,
      healthPerm: 0,
      attackTemp: 0,
      healthTemp: 0,
      keywordsPerm: [],
      keywordsTemp: [],
      shield: (this.card(cardId).keywords ?? []).includes('shield'),
      mobileUsed: false,
      activatedUsed: [],
    };
  }

  toInstance(u: Unit): CardInstance {
    return { uid: u.uid, cardId: u.cardId, costMod: 0, revealed: false, generated: u.generated };
  }

  placeUnit(p: PlayerId, i: number, u: Unit): void {
    this.pl(p).board[i] = u;
    this.touch();
  }

  /** ユニットにダメージを与える。盾で防いだら blocked。amount が0以下なら何もしない */
  damageUnit(u: Unit, amount: number, reason: string): { hit: boolean; blocked: boolean } {
    if (amount <= 0) return { hit: false, blocked: false };
    if (u.shield) {
      u.shield = false;
      this.touch();
      this.log('shieldBlock', { uid: u.uid, card: u.cardId, amount, reason });
      return { hit: true, blocked: true };
    }
    const pool = Math.max(0, u.healthTemp - u.tempDamage);
    const absorbed = Math.min(amount, pool);
    u.tempDamage += absorbed;
    u.damage += amount - absorbed;
    this.log('damage', { uid: u.uid, card: u.cardId, amount, reason });
    return { hit: true, blocked: false };
  }

  damagePlayer(p: PlayerId, amount: number, reason: string): void {
    if (amount <= 0) return;
    this.pl(p).life -= amount;
    this.log('lifeDamage', { player: p, amount, life: this.pl(p).life, reason });
  }

  heal(u: Unit, amount: number): void {
    if (amount <= 0) return;
    const a = Math.min(u.damage, amount);
    u.damage -= a;
    u.tempDamage = Math.max(0, u.tempDamage - (amount - a));
    this.log('heal', { uid: u.uid, card: u.cardId, amount });
  }

  /** 盤面から取り除く（トークンは消える）。取り除いたカードを返す */
  removeFromBoard(loc: Located): CardInstance | null {
    this.pl(loc.p).board[loc.i] = null;
    this.touch();
    return loc.unit.isToken ? null : this.toInstance(loc.unit);
  }

  /** ユニットを同時に破壊する（10.3） */
  destroyUnits(list: Located[], reason: string): void {
    if (!list.length) return;
    const events: GameEvent[] = [];
    for (const loc of list) {
      const inst = this.removeFromBoard(loc);
      if (inst) this.pl(loc.unit.owner).trash.push(inst);
      this.log('destroy', { uid: loc.unit.uid, card: loc.unit.cardId, player: loc.p, cell: cellName(loc.i), reason });
      events.push({ type: 'destroyed', uid: loc.unit.uid, cardId: loc.unit.cardId, owner: loc.p, cell: loc.i });
    }
    this.emit(events);
  }

  /** 残り体力が0以下のユニットをすべて破壊する。常時効果が変わって続けて破壊される分も処理する */
  checkDeaths(): void {
    for (let guard = 0; guard < 100; guard++) {
      const dead = this.allUnits().filter((x) => this.health(x.unit) <= 0);
      if (!dead.length) return;
      this.destroyUnits(dead, 'noHealth');
    }
  }

  /** ユニットを移動させる（12章）。by は移動させたプレイヤー */
  moveUnits(moves: { from: Located; to: number }[], by: PlayerId): void {
    if (!moves.length) return;
    for (const m of moves) this.pl(m.from.p).board[m.from.i] = null;
    const events: GameEvent[] = [];
    for (const m of moves) {
      this.pl(m.from.p).board[m.to] = m.from.unit;
      this.log('move', { uid: m.from.unit.uid, card: m.from.unit.cardId, player: m.from.p, from: cellName(m.from.i), to: cellName(m.to), by });
      this.s.unitMoves = (this.s.unitMoves ?? 0) + 1;
      // レイの成長条件: 自分がユニットを移動させた回数（カード・能力の効果と、自分の遊撃。敵味方問わず）
      this.addProgress(by, 'unitMoved', 1);
      events.push({ type: 'move', uid: m.from.unit.uid, owner: m.from.unit.owner });
    }
    this.touch();
    this.emit(events);
  }

  // ================================================================ 山札・手札

  addToHand(p: PlayerId, inst: CardInstance): boolean {
    const st = this.pl(p);
    inst.costMod = 0;
    inst.revealed = false;
    if (st.hand.length >= HAND_LIMIT) {
      st.trash.push(inst);
      this.log('handFull', { player: p, card: inst.cardId });
      return false;
    }
    st.hand.push(inst);
    return true;
  }

  /** カードを1枚引く。山札が0枚なら false（効果で引くときは何もしない） */
  draw(p: PlayerId): boolean {
    const st = this.pl(p);
    const inst = st.deck.shift();
    if (!inst) return false;
    this.log('draw', { player: p });
    this.addToHand(p, inst);
    return true;
  }

  generate(p: PlayerId, cardId: string): void {
    const st = this.pl(p);
    if (st.hand.length >= HAND_LIMIT) return;
    st.hand.push({ uid: this.newUid(), cardId, costMod: 0, revealed: false, generated: true });
    this.log('generate', { player: p, card: cardId });
  }

  /** 手札のカードを取り除いて返す（コストの変化と公開はなくなる） */
  takeFromHand(p: PlayerId, uid: number): CardInstance {
    const hand = this.pl(p).hand;
    const i = hand.findIndex((c) => c.uid === uid);
    if (i < 0) throw new IllegalAction('そのカードは手札にありません');
    const [inst] = hand.splice(i, 1);
    inst.costMod = 0;
    inst.revealed = false;
    return inst;
  }

  // ================================================================ 選択

  ask(player: PlayerId, options: { uid: number; cardId: string }[]): number {
    if (options.length === 1) return options[0].uid;
    if (this.answerIndex < this.answers.length) {
      const a = this.answers[this.answerIndex++];
      if (!options.some((o) => o.uid === a)) throw new IllegalAction('選べない選択肢です');
      return a;
    }
    throw new NeedChoice(player, options);
  }

  // ================================================================ 誘発（11.2〜11.3）

  private emit(events: GameEvent[]): void {
    const found: QueuedTrigger[] = [];
    const order = this.playerOrder();
    for (const ev of events) {
      for (const q of order) {
        const po = order.indexOf(q);
        const st = this.pl(q);
        if (ev.type === 'destroyed') {
          if (ev.owner !== q) continue;
          for (const a of this.card(ev.cardId).abilities ?? []) {
            if (a.kind === 'trigger' && a.when === 'onDestroyed') {
              found.push({
                ctx: { controller: q, source: { kind: 'unit', cardId: ev.cardId, uid: ev.uid }, selfUid: ev.uid, selfCell: ev.cell, targets: {} },
                effects: a.effects,
                order: [po, ev.cell],
              });
            }
          }
          continue;
        }
        st.board.forEach((u, i) => {
          if (!u) return;
          for (const a of this.card(u.cardId).abilities ?? []) {
            if (a.kind !== 'trigger' || !this.eventMatches(a.when, ev, q, u.uid)) continue;
            const ctx = this.unitCtx(u, q);
            if ('uid' in ev) ctx.eventUid = ev.uid;
            if (a.condition && !this.unitMatches({ unit: u, p: q, i }, a.condition)) continue;
            found.push({ ctx, effects: a.effects, order: [po, i] });
          }
        });
        st.leaders.forEach((_, idx) => {
          for (const a of this.leaderPassives(q, idx)) {
            if (a.kind !== 'trigger' || !this.eventMatches(a.when, ev, q)) continue;
            const ctx = this.leaderCtx(q, idx);
            if ('uid' in ev) ctx.eventUid = ev.uid;
            found.push({ ctx, effects: a.effects, order: [po, CELLS + idx] });
          }
        });
        st.hand.forEach((c, hi) => {
          for (const a of this.card(c.cardId).abilities ?? []) {
            if (a.kind !== 'inHand' || !this.eventMatches(a.when, ev, q)) continue;
            const ctx: EffectContext = { controller: q, source: { kind: 'hand', cardId: c.cardId, uid: c.uid }, targets: {} };
            if ('uid' in ev) ctx.eventUid = ev.uid;
            found.push({ ctx, effects: a.effects, handUid: c.uid, order: [po, CELLS + 2 + hi] });
          }
        });
      }
    }
    found.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
    this.queue.push(...found);
  }

  private eventMatches(when: TriggerType, ev: GameEvent, q: PlayerId, selfUid?: number): boolean {
    switch (when) {
      case 'onMove':
        return ev.type === 'move' && ev.uid === selfUid;
      case 'onEnemyMove':
        return ev.type === 'move' && ev.owner !== q;
      case 'onAnyUnitMove':
        return ev.type === 'move';
      case 'onSpellCast':
        return ev.type === 'spellCast' && ev.p === q;
      case 'onAllyEndureCombatDamage':
        return ev.type === 'endure' && ev.owner === q;
      case 'roundStart':
      case 'roundEnd':
      case 'combatStart':
      case 'combatEnd':
        return ev.type === 'phase' && ev.when === when;
      default:
        return false;
    }
  }

  /** 順番待ちの誘発効果をすべて処理する（処理中に起きたものは列の最後に加わる） */
  drain(): void {
    for (let guard = 0; this.queue.length && !this.s.result; guard++) {
      if (guard > 10000) throw new Error('誘発効果が止まりません');
      const t = this.queue.shift()!;
      if (t.handUid !== undefined && !this.pl(t.ctx.controller).hand.some((c) => c.uid === t.handUid)) continue;
      this.runEffects(t.effects, t.ctx, { sourceKind: 'unit', cardId: t.ctx.source.cardId, enhanced: false, delays: [] });
    }
  }

  phaseEvent(when: 'roundStart' | 'roundEnd' | 'combatStart' | 'combatEnd'): void {
    this.emit([{ type: 'phase', when }]);
  }

  /** スペル使用時（7.2 手順7） */
  spellCastEvent(p: PlayerId): void {
    this.emit([{ type: 'spellCast', p }]);
  }

  // ================================================================ 効果の処理（11章・card-data.md 5.2）

  runEffects(list: Effect[], ctx: EffectContext, scope: Scope): void {
    for (const e of list) {
      if (this.s.result) return;
      this.runEffect(e, ctx, scope);
      this.checkDeaths();
    }
  }

  private runEffect(e: Effect, ctx: EffectContext, scope: Scope): void {
    const me = ctx.controller;
    const reason = ctx.source.cardId;
    switch (e.op) {
      case 'damage': {
        const amount = this.value(e.amount, ctx);
        const targets = this.units(e.target, ctx);
        const players = this.players(e.target, ctx);
        for (let n = 0; n < (e.times ?? 1); n++) {
          for (const x of targets) if (this.findUnit(x.unit.uid)) this.damageUnit(x.unit, amount, reason);
          for (const q of players) this.damagePlayer(q, amount, reason);
        }
        return;
      }
      case 'destroy':
        return this.destroyUnits(this.units(e.target, ctx), reason);
      case 'exile':
        for (const x of this.units(e.target, ctx)) {
          const inst = this.removeFromBoard(x);
          if (inst) this.pl(x.unit.owner).exile.push(inst);
          this.log('exile', { uid: x.unit.uid, card: x.unit.cardId, player: x.p, reason });
        }
        return;
      case 'heal': {
        const amount = this.value(e.amount, ctx);
        for (const x of this.units(e.target, ctx)) this.heal(x.unit, amount);
        return;
      }
      case 'buff': {
        const atk = e.attack === undefined ? 0 : this.value(e.attack, ctx);
        const hp = e.health === undefined ? 0 : this.value(e.health, ctx);
        for (const x of this.units(e.target, ctx)) {
          if (e.duration === 'thisRound') {
            x.unit.attackTemp += atk;
            x.unit.healthTemp += hp;
          } else {
            x.unit.attackPerm += atk;
            x.unit.healthPerm += hp;
          }
          this.log('buff', { uid: x.unit.uid, card: x.unit.cardId, attack: atk, health: hp, duration: e.duration, reason });
        }
        this.touch();
        return;
      }
      case 'grantKeyword':
        for (const x of this.units(e.target, ctx)) {
          for (const k of e.keywords) {
            if (k === 'shield') x.unit.shield = true;
            else {
              const list = e.duration === 'thisRound' ? x.unit.keywordsTemp : x.unit.keywordsPerm;
              if (!list.includes(k)) list.push(k);
            }
          }
          this.log('grantKeyword', { uid: x.unit.uid, card: x.unit.cardId, keywords: e.keywords, duration: e.duration, reason });
        }
        this.touch();
        return;
      case 'move': {
        const x = this.units(e.target, ctx)[0];
        const to = this.cells(e.to, ctx)[0];
        if (!x || !to || to.p !== x.p || this.unitAt(to.p, to.i)) return;
        return this.moveUnits([{ from: x, to: to.i }], me);
      }
      case 'moveToOtherRow': {
        const moves = this.units(e.target, ctx)
          .filter((x) => !this.unitAt(x.p, otherRow(x.i)))
          .map((x) => ({ from: x, to: otherRow(x.i) }));
        return this.moveUnits(moves, me);
      }
      case 'swapCells': {
        const a = this.cells(e.a, ctx)[0];
        const b = this.cells(e.b, ctx)[0];
        if (!a || !b || a.p !== b.p || a.i === b.i) return;
        const moves: { from: Located; to: number }[] = [];
        const ua = this.unitAt(a.p, a.i);
        const ub = this.unitAt(b.p, b.i);
        if (ua) moves.push({ from: { unit: ua, p: a.p, i: a.i }, to: b.i });
        if (ub) moves.push({ from: { unit: ub, p: b.p, i: b.i }, to: a.i });
        return this.moveUnits(moves, me);
      }
      case 'returnToHand':
        for (const x of this.units(e.target, ctx)) {
          const inst = this.removeFromBoard(x);
          this.log('returnToHand', { uid: x.unit.uid, card: x.unit.cardId, player: x.p });
          if (inst) this.addToHand(x.unit.owner, inst);
        }
        return;
      case 'summon':
        for (const c of this.cells(e.at, ctx)) {
          if (this.unitAt(c.p, c.i)) continue;
          const u = this.newUnit(c.p, e.cardId, this.newUid(), true);
          this.placeUnit(c.p, c.i, u);
          this.log('summon', { uid: u.uid, card: e.cardId, player: c.p, cell: cellName(c.i) });
        }
        return;
      case 'draw': {
        const n = this.value(e.count, ctx);
        for (let k = 0; k < n; k++) this.draw(me);
        return;
      }
      case 'drawUntil':
        while (this.pl(me).hand.length < e.handSize && this.draw(me));
        return;
      case 'lookAtTopPickOne': {
        const top = this.pl(me).deck.slice(0, e.look);
        if (!top.length) return;
        const uid = this.ask(
          me,
          top.map((c) => ({ uid: c.uid, cardId: c.cardId })),
        );
        const deck = this.pl(me).deck;
        const [inst] = deck.splice(
          deck.findIndex((c) => c.uid === uid),
          1,
        );
        this.log('pick', { player: me, looked: top.length });
        this.addToHand(me, inst);
        return;
      }
      case 'tutorRandom': {
        const st = this.pl(me);
        const room = Math.max(0, HAND_LIMIT - st.hand.length);
        const candidates = st.deck.filter((c) => this.cardMatches(c.cardId, e.where));
        let picked: CardInstance[];
        if (e.distinctNames) {
          // 名前の異なるカード: まず名前を選び、その名前のカードを1枚ずつ取る
          const names = pickRandom(this.s, [...new Set(candidates.map((c) => c.cardId))], Math.min(e.count, room));
          picked = names.map((id) => pickRandom(this.s, candidates.filter((c) => c.cardId === id), 1)[0]);
        } else picked = pickRandom(this.s, candidates, Math.min(e.count, room));
        for (const c of picked) {
          st.deck.splice(st.deck.indexOf(c), 1);
          st.hand.push(c);
        }
        shuffleInPlace(this.s, st.deck);
        this.log('tutor', { player: me, count: picked.length });
        // 加えたカードを後の効果（公開・コストの変化など）で参照できるようにする
        if (e.as) ctx.targets[e.as] = picked.map((c): TargetValue => ({ kind: 'card', uid: c.uid }));
        return;
      }
      case 'generate':
        for (let k = 0; k < (e.count ?? 1); k++) this.generate(me, e.cardId);
        return;
      case 'generateFromCastSpells': {
        const names = [...new Set(this.pl(me).castSpellIds)];
        const picked = e.distinctNames
          ? pickRandom(this.s, names, e.count)
          : Array.from({ length: names.length ? e.count : 0 }, () => pickRandom(this.s, this.pl(me).castSpellIds, 1)[0]);
        for (const id of picked) this.generate(me, id);
        return;
      }
      case 'gainReserve': {
        const st = this.pl(me);
        st.reserve += this.value(e.amount, ctx);
        this.log('gainReserve', { player: me, reserve: st.reserve });
        return;
      }
      case 'gainLife': {
        const st = this.pl(me);
        const n = this.value(e.amount, ctx);
        st.life += n;
        this.log('gainLife', { player: me, amount: n, life: st.life });
        return;
      }
      case 'refillMana':
        this.pl(me).mana = this.pl(me).maxMana;
        this.log('refillMana', { player: me });
        return;
      case 'fight': {
        const a = this.units(e.a, ctx)[0];
        const b = this.units(e.b, ctx)[0];
        if (!a || !b) return;
        const atkA = this.attack(a.unit);
        const atkB = this.attack(b.unit);
        this.damageUnit(b.unit, atkA, reason);
        this.damageUnit(a.unit, atkB, reason);
        return;
      }
      case 'resolveCombat':
        return this.combatSteps(this.lanes(e.lanes, ctx));
      case 'modifyCost':
        for (const c of this.handCards(e.target, ctx)) {
          c.costMod += e.amount;
          this.log('modifyCost', { player: me, card: c.cardId, amount: e.amount });
        }
        return;
      case 'modifyLeaderAbilityCost': {
        const idx = ctx.source.leader;
        if (idx === undefined) return;
        this.pl(me).leaders[idx].costMod += e.amount;
        return;
      }
      case 'reveal':
        for (const c of this.handCards(e.target, ctx)) {
          c.revealed = true;
          this.log('reveal', { player: me, card: c.cardId });
        }
        return;
      case 'delay': {
        const self = this.findUnit(ctx.selfUid);
        const entry: DelayedEntry = {
          id: this.newUid(),
          owner: me,
          cardId: scope.cardId,
          sourceKind: scope.sourceKind,
          enhanced: scope.enhanced,
          effects: structuredClone(e.effects),
          ctx: { ...structuredClone(ctx), selfLane: self ? laneOf(self.i) : ctx.selfLane },
          order: this.s.nextOrder++,
        };
        this.s.delayed.push(entry);
        scope.delays.push(entry);
        this.log('delayReserve', { player: me, card: scope.cardId, targets: ctx.targets });
        return;
      }
      case 'atRoundEnd':
        this.s.roundEnd.push({ effects: structuredClone(e.effects), ctx: structuredClone(ctx) });
        return;
      case 'if': {
        const subject = this.units(e.subject, ctx)[0];
        const ok = subject ? this.unitMatches(subject, e.condition) : false;
        this.runEffects(ok ? e.then : (e.else ?? []), ctx, scope);
        return;
      }
      case 'forEach':
        for (const x of this.units(e.targets, ctx)) this.runEffects(e.effects, { ...ctx, eventUid: x.unit.uid }, scope);
        return;
    }
  }

  // ================================================================ 戦闘（8章）

  /** 指定レーンで先制ステップと通常ステップを行う */
  combatSteps(lanes: number[]): void {
    const attacked = new Set<number>();
    for (const first of [true, false]) {
      if (this.s.result) return;
      this.combatStep(lanes, first, attacked);
    }
  }

  private combatStep(lanes: number[], firstStrike: boolean, attacked: Set<number>): void {
    type Attack = { unit: Unit; p: PlayerId; i: number; amount: number; pierce: boolean };
    const attacks: Attack[] = [];
    for (const p of this.playerOrder()) {
      for (const lane of lanes) {
        for (const row of ['front', 'back'] as const) {
          const i = cellIndex(lane, row);
          const u = this.unitAt(p, i);
          if (!u) continue;
          const amount = this.attack(u);
          if (amount < 1) continue;
          if (row === 'back' && !this.hasKeyword(u, 'ranged')) continue;
          if (firstStrike ? !this.hasKeyword(u, 'firstStrike') : attacked.has(u.uid)) continue;
          attacks.push({ unit: u, p, i, amount, pierce: this.hasKeyword(u, 'pierce') });
        }
      }
    }
    if (!attacks.length) return;
    for (const a of attacks) attacked.add(a.unit.uid);
    this.log('combatStep', { step: firstStrike ? 'firstStrike' : 'normal', lanes });

    // 対象はステップの開始時点の盤面で決める（8.3）
    const plan = attacks.map((a) => {
      const q = opponent(a.p);
      const lane = laneOf(a.i);
      const front = this.unitAt(q, cellIndex(lane, 'front'));
      const back = this.unitAt(q, cellIndex(lane, 'back'));
      return { ...a, q, lane, target: front ?? back ?? null, back };
    });
    const hitUnits = new Set<number>();
    const hit = (target: Unit | null, q: PlayerId, lane: number, amount: number, pierce: boolean, isFront: boolean, src: Unit) => {
      if (amount <= 0) return;
      if (!target) return this.damagePlayer(q, amount, src.cardId);
      const before = this.health(target);
      const r = this.damageUnit(target, amount, src.cardId);
      hitUnits.add(target.uid);
      if (!pierce || r.blocked) return;
      const excess = amount - Math.max(0, before);
      if (excess <= 0) return;
      // 貫通: 同じレーンの次の対象（相手の後列 → 相手本体）へ
      const back = isFront ? this.unitAt(q, cellIndex(lane, 'back')) : null;
      hit(back, q, lane, excess, pierce, false, src);
    };
    // 同じ対象への攻撃は、前列のユニット → 後列のユニットの順に割り当てる（8.4）
    for (const a of plan) {
      const isFront = a.target !== null && a.target === this.unitAt(a.q, cellIndex(a.lane, 'front'));
      hit(a.target, a.q, a.lane, a.amount, a.pierce, isFront, a.unit);
    }
    this.checkDeaths();
    if (this.checkWinner()) return;
    // 戦闘ダメージを耐えた（11.7）
    const endured = this.allUnits().filter((x) => hitUnits.has(x.unit.uid));
    if (endured.length) {
      for (const x of endured) {
        this.log('endure', { uid: x.unit.uid, card: x.unit.cardId, player: x.p });
        this.addProgress(x.p, 'allyEnduredCombatDamage', 1);
      }
      this.emit(endured.map((x) => ({ type: 'endure', uid: x.unit.uid, owner: x.p })));
    }
    this.settle();
  }

  // ================================================================ リーダーの成長（13.4）

  addProgress(p: PlayerId, counter: 'allyEnduredCombatDamage' | 'unitMoved' | 'leaderAbilityUsed', n: number, leader?: number): void {
    this.pl(p).leaders.forEach((l, idx) => {
      if (l.grown) return;
      if (leader !== undefined && leader !== idx) return;
      if (getLeader(this.cat, l.id).growth.counter === counter) l.progress += n;
    });
  }

  checkGrowth(): void {
    for (const p of this.playerOrder()) {
      this.pl(p).leaders.forEach((l) => {
        if (l.grown) return;
        if (l.progress >= getLeader(this.cat, l.id).growth.threshold) {
          l.grown = true;
          this.touch();
          this.log('grow', { player: p, leader: l.id });
        }
      });
    }
  }

  // ================================================================ 勝敗（9章）

  checkWinner(): boolean {
    if (this.s.result) return true;
    const a = this.pl('A').life;
    const b = this.pl('B').life;
    if (a > 0 && b > 0) return false;
    let winner: PlayerId | null;
    if (a <= 0 && b <= 0) winner = a === b ? null : a < b ? 'B' : 'A';
    else winner = a <= 0 ? 'B' : 'A';
    this.endGame(winner, winner ? 'life' : 'draw');
    return true;
  }

  endGame(winner: PlayerId | null, reason: 'life' | 'deckOut' | 'draw'): void {
    this.s.result = { winner, reason };
    this.s.phase = 'gameOver';
    this.queue = [];
    this.log('gameOver', { winner, reason });
  }

  /** 処理の区切り: 破壊 → 誘発 → 成長 → 勝敗 */
  settle(): void {
    this.checkDeaths();
    this.drain();
    this.checkDeaths();
    this.checkGrowth();
    this.checkWinner();
  }

  // ================================================================ ラウンドの進行（6章）

  startRound(first: boolean): void {
    const s = this.s;
    s.round += 1;
    for (const p of ['A', 'B'] as const) {
      const st = this.pl(p);
      st.maxMana = Math.min(MAX_MANA_CAP, st.maxMana + 1);
      st.reserve += st.unusedMana;
      st.unusedMana = 0;
      st.mana = st.maxMana;
    }
    this.log('roundStart', { firstPlayer: first ? s.firstPlayer : opponent(s.firstPlayer) });
    const out = (['A', 'B'] as const).filter((p) => !this.draw(p));
    if (out.length === 2) return this.endGame(null, 'deckOut');
    if (out.length === 1) return this.endGame(opponent(out[0]), 'deckOut');
    if (!first) s.firstPlayer = opponent(s.firstPlayer);
    for (const p of ['A', 'B'] as const) {
      for (const l of this.pl(p).leaders) l.usedThisRound = false;
      for (const u of this.pl(p).board) {
        if (!u) continue;
        u.mobileUsed = false;
        u.activatedUsed = [];
      }
    }
    s.activePlayer = s.firstPlayer;
    s.passStreak = 0;
    s.actionsThisRound = 0;
    this.phaseEvent('roundStart');
    this.settle();
  }

  combatPhase(): void {
    this.log('combatStart');
    this.phaseEvent('combatStart');
    this.settle();
    if (this.s.result) return;
    this.combatSteps([1, 2, 3, 4]);
    if (this.s.result) return;
    this.phaseEvent('combatEnd');
    this.settle();
  }

  endPhase(): void {
    // 1. ラウンド終了時の効果（誘発効果 → 効果で予約した「ラウンドの終了時」の処理の順）
    this.phaseEvent('roundEnd');
    const scheduled = this.s.roundEnd;
    this.s.roundEnd = [];
    for (const r of scheduled) this.queue.push({ ctx: r.ctx, effects: r.effects, order: [0, 0] });
    this.settle();
    if (this.s.result) return;
    // 2. 「このラウンド中」の効果が終わる
    for (const { unit } of this.allUnits()) {
      unit.attackTemp = 0;
      unit.healthTemp = 0;
      unit.tempDamage = 0;
      unit.keywordsTemp = [];
    }
    this.touch();
    this.settle();
    if (this.s.result) return;
    // 3. 使い残した通常マナを記録する
    for (const p of ['A', 'B'] as const) this.pl(p).unusedMana = this.pl(p).mana;
    this.log('roundEnd');
  }

  /** 予約中の遅延効果を予約した順にすべて発動する（14.1） */
  resolveDelays(p: PlayerId): void {
    const mine = this.s.delayed.filter((d) => d.owner === p).sort((a, b) => a.order - b.order);
    this.s.delayed = this.s.delayed.filter((d) => d.owner !== p);
    for (const d of mine) {
      if (this.s.result) return;
      this.log('delayResolve', { player: p, card: d.cardId });
      this.runEffects(d.effects, d.ctx, { sourceKind: d.sourceKind, cardId: d.cardId, enhanced: d.enhanced, delays: [] });
      if (d.card) this.pl(p).trash.push(d.card);
      this.settle();
    }
  }
}

// ---------------------------------------------------------------- 補助

function combinations<T>(items: T[], k: number): T[][] {
  if (k === 1) return items.map((x) => [x]);
  const out: T[][] = [];
  const rec = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i++) rec(i + 1, [...acc, items[i]]);
  };
  rec(0, []);
  return out;
}

function key(v: TargetValue): string {
  switch (v.kind) {
    case 'unit':
      return `u${v.uid}`;
    case 'card':
      return `c${v.uid}`;
    case 'cell':
      return `x${v.p}${v.i}`;
    case 'lane':
      return `l${v.lane}`;
    case 'player':
      return `p${v.p}`;
  }
}

export function canonical(vals: TargetValue[]): string {
  return vals.map(key).sort().join(',');
}
