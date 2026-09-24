// カードデータ（JSON）の読み込みと検証（docs/card-data.md 8章、タスク 1-4）
import { DECK_SIZE, MAX_COPIES } from './constants';
import type {
  Ability,
  CardDef,
  Condition,
  DeckDef,
  Effect,
  FactionFile,
  FactionId,
  LeaderDef,
  Selector,
  TargetSpec,
  Value,
} from './types';
import { KEYWORDS } from './types';

export interface Catalog {
  cards: Map<string, CardDef>;
  leaders: Map<string, LeaderDef>;
  factions: Map<FactionId, string>;
}

export class CatalogError extends Error {
  constructor(public readonly problems: string[]) {
    super(`カードデータに ${problems.length} 件の問題があります:\n${problems.join('\n')}`);
  }
}

const OPS = new Set([
  'damage', 'destroy', 'exile', 'heal', 'buff', 'grantKeyword', 'move', 'moveToOtherRow', 'swapCells',
  'returnToHand', 'summon', 'draw', 'drawUntil', 'lookAtTopPickOne', 'tutorRandom', 'generate',
  'generateFromCastSpells', 'gainReserve', 'gainLife', 'refillMana', 'fight', 'resolveCombat', 'modifyCost',
  'modifyLeaderAbilityCost', 'reveal', 'delay', 'atRoundEnd', 'if', 'forEach',
]);
const TRIGGERS = new Set([
  'onPlay', 'onDestroyed', 'onMove', 'onEnemyMove', 'onAnyUnitMove', 'onSpellCast',
  'onAllyEndureCombatDamage', 'roundStart', 'roundEnd', 'combatStart', 'combatEnd',
]);
const TARGET_KINDS = new Set(['unit', 'cell', 'lane', 'unitOrPlayer', 'cardInHand']);
const GROWTH = new Set(['allyEnduredCombatDamage', 'unitMoved', 'leaderAbilityUsed']);

/** 勢力ファイルからカタログを作る。問題があれば CatalogError を投げる */
export function buildCatalog(files: FactionFile[]): Catalog {
  const cat: Catalog = { cards: new Map(), leaders: new Map(), factions: new Map() };
  const problems: string[] = [];
  for (const f of files) {
    if (f.formatVersion !== 1) problems.push(`${f.faction?.id}: formatVersion が 1 ではありません`);
    cat.factions.set(f.faction.id, f.faction.name);
    if (cat.leaders.has(f.leader.id)) problems.push(`${f.leader.id}: リーダーIDが重複しています`);
    cat.leaders.set(f.leader.id, f.leader);
    for (const c of f.cards) {
      if (cat.cards.has(c.id)) problems.push(`${c.id}: カードIDが重複しています`);
      cat.cards.set(c.id, c);
    }
  }
  for (const c of cat.cards.values()) problems.push(...validateCard(c, cat));
  for (const l of cat.leaders.values()) problems.push(...validateLeader(l, cat));
  if (problems.length) throw new CatalogError(problems);
  return cat;
}

export function getCard(cat: Catalog, id: string): CardDef {
  const c = cat.cards.get(id);
  if (!c) throw new Error(`カードがありません: ${id}`);
  return c;
}

export function getLeader(cat: Catalog, id: string): LeaderDef {
  const l = cat.leaders.get(id);
  if (!l) throw new Error(`リーダーがいません: ${id}`);
  return l;
}

// ---------------------------------------------------------------- 検証

class Checker {
  problems: string[] = [];
  constructor(
    private readonly where: string,
    private readonly cat: Catalog,
  ) {}

  add(msg: string): void {
    this.problems.push(`${this.where}: ${msg}`);
  }

  cardRef(id: string): void {
    if (!this.cat.cards.has(id)) this.add(`存在しないカード ${id} を参照しています`);
  }

  targets(specs: TargetSpec[] | undefined): Set<string> {
    const ids = new Set<string>();
    for (const t of specs ?? []) {
      if (!TARGET_KINDS.has(t.kind)) this.add(`対象の種類 ${t.kind} は使えません`);
      if (ids.has(t.id)) this.add(`対象の名前 ${t.id} が重複しています`);
      if (t.where) this.condition(t.where);
      const owner = t.cellOwner;
      if (owner && typeof owner === 'object') {
        const ref = 'ownerOf' in owner ? owner.ownerOf : owner.sameOwnerAs;
        if (!ids.has(ref)) this.add(`cellOwner が先に選ぶ対象 ${ref} を参照していません`);
      }
      ids.add(t.id);
    }
    return ids;
  }

  condition(c: Condition): void {
    const keys = Object.keys(c);
    if (keys.length !== 1) return this.add(`条件の形が不正です: ${JSON.stringify(c)}`);
    const k = keys[0];
    if ('all' in c) c.all.forEach((x) => this.condition(x));
    else if ('any' in c) c.any.forEach((x) => this.condition(x));
    else if ('hasKeyword' in c) {
      if (!KEYWORDS.includes(c.hasKeyword)) this.add(`キーワード ${c.hasKeyword} は使えません`);
    } else if (!['empty', 'row', 'type', 'attackAtMost', 'healthAtMost'].includes(k)) this.add(`条件 ${k} は使えません`);
  }

  selector(s: Selector, refs: Set<string>): void {
    if (typeof s === 'string') {
      if (!['self', 'eventUnit', 'enemyPlayer', 'allyPlayer'].includes(s)) this.add(`セレクタ ${s} は使えません`);
      return;
    }
    if ('ref' in s) {
      if (!refs.has(s.ref)) this.add(`対象 ${s.ref} が targets にありません`);
    } else if ('units' in s) {
      const u = s.units;
      if (u.cardId) this.cardRef(u.cardId);
      if (u.where) this.condition(u.where);
      if (u.lane !== undefined) this.lane(u.lane, refs);
    } else if ('cell' in s) {
      this.lane(s.cell.lane, refs);
    } else if (!('cellsRelative' in s)) this.add(`セレクタの形が不正です: ${JSON.stringify(s)}`);
  }

  lane(l: unknown, refs: Set<string>): void {
    if (typeof l === 'number') {
      if (l < 1 || l > 4) this.add(`レーン番号 ${l} が範囲外です`);
    } else if (l === 'all') return;
    else if (l && typeof l === 'object' && 'ref' in l) this.selector(l as Selector, refs);
    else if (l && typeof l === 'object' && 'laneOf' in l) this.selector((l as { laneOf: Selector }).laneOf, refs);
    else this.add(`レーンの指定が不正です: ${JSON.stringify(l)}`);
  }

  value(v: Value, refs: Set<string>): void {
    if (typeof v === 'number') return;
    if ('attackOf' in v) this.selector(v.attackOf, refs);
    else if ('count' in v) {
      if (v.count !== 'spellsCastThisGame' && v.count !== 'unitMovesThisGame') this.add(`数値 ${v.count} は使えません`);
    } else if ('max' in v) this.value(v.max, refs);
  }

  /** 効果の一覧を調べ、遅延の処理を含むかを返す */
  effects(list: Effect[], refs: Set<string>): boolean {
    let hasDelay = false;
    for (const e of list) {
      if (!OPS.has(e.op)) {
        this.add(`処理 ${e.op} は使えません`);
        continue;
      }
      const any = e as Record<string, unknown>;
      for (const key of ['target', 'to', 'a', 'b', 'subject', 'targets', 'at']) {
        if (any[key] !== undefined) this.selector(any[key] as Selector, refs);
      }
      for (const key of ['amount', 'attack', 'health', 'count']) {
        if (any[key] !== undefined && !(e.op === 'tutorRandom' || e.op === 'generateFromCastSpells' || e.op === 'generate'))
          this.value(any[key] as Value, refs);
      }
      if ('keywords' in e) for (const k of e.keywords) if (!KEYWORDS.includes(k)) this.add(`キーワード ${k} は使えません`);
      if ('cardId' in e) this.cardRef(e.cardId);
      if ('where' in e) this.condition(e.where);
      if ('condition' in e) this.condition(e.condition);
      if (e.op === 'resolveCombat') this.lane(e.lanes, refs);
      // 山札から加えたカードに名前を付け、後の効果で参照できる
      if (e.op === 'tutorRandom' && e.as) refs.add(e.as);
      if (e.op === 'delay') {
        hasDelay = true;
        this.effects(e.effects, refs);
      }
      if (e.op === 'atRoundEnd' || e.op === 'forEach') hasDelay = this.effects(e.effects, refs) || hasDelay;
      if (e.op === 'if') {
        hasDelay = this.effects(e.then, refs) || hasDelay;
        if (e.else) hasDelay = this.effects(e.else, refs) || hasDelay;
      }
    }
    return hasDelay;
  }

  /** 能力を調べ、遅延（起動能力の中のものは除く）を含むかを返す */
  ability(a: Ability, extraRefs: Set<string> = new Set()): boolean {
    switch (a.kind) {
      case 'trigger': {
        if (!TRIGGERS.has(a.when)) this.add(`きっかけ ${a.when} は使えません`);
        if (a.targets?.length && a.when !== 'onPlay') this.add('対象を選ぶ誘発能力は配置時のものだけです');
        if (a.condition) this.condition(a.condition);
        const refs = this.targets(a.targets);
        for (const r of extraRefs) refs.add(r);
        return this.effects(a.effects, refs);
      }
      case 'costReduction':
        this.value(a.by, new Set());
        return false;
      case 'inHand':
        if (!TRIGGERS.has(a.when)) this.add(`きっかけ ${a.when} は使えません`);
        this.effects(a.effects, new Set());
        return false;
      case 'activated':
        if (a.cost < 0) this.add('起動のコストが負です');
        this.effects(a.effects, this.targets(a.targets));
        return false;
      case 'static':
        for (const m of a.modifiers) {
          this.selector(m.target, new Set());
          for (const k of m.keywords ?? []) if (!KEYWORDS.includes(k)) this.add(`キーワード ${k} は使えません`);
        }
        return false;
      default:
        this.add(`能力の種類 ${(a as { kind: string }).kind} は使えません`);
        return false;
    }
  }
}

function validateCard(c: CardDef, cat: Catalog): string[] {
  const ch = new Checker(c.id, cat);
  if (!c.name) ch.add('name がありません');
  if (!cat.factions.has(c.faction)) ch.add(`勢力 ${c.faction} がありません`);
  if (c.cost < 0) ch.add('コストが負です');
  for (const k of c.keywords ?? []) if (!KEYWORDS.includes(k)) ch.add(`キーワード ${k} は使えません`);
  let hasDelay = false;
  if (c.type === 'unit') {
    if (typeof c.attack !== 'number' || typeof c.health !== 'number') ch.add('ユニットに attack / health がありません');
    if (c.targets || c.effects) ch.add('ユニットは targets / effects を持てません（abilities に書く）');
  } else if (c.type === 'spell') {
    if (c.attack !== undefined || c.health !== undefined) ch.add('スペルが attack / health を持っています');
    if (c.abilities?.length) ch.add('スペルは abilities を持てません');
    hasDelay = ch.effects(c.effects ?? [], ch.targets(c.targets));
  } else ch.add(`種類 ${c.type} は使えません`);
  (c.abilities ?? []).forEach((a) => {
    hasDelay = ch.ability(a) || hasDelay;
  });
  if (c.enhance) {
    const en = c.enhance;
    if (en.cost < 0) ch.add('強化のコストが負です');
    let refs: Set<string>;
    if (en.appliesTo === 'effects' || en.appliesTo === undefined) {
      if (c.type !== 'spell') ch.add('ユニットの強化は appliesTo に能力の番号を書きます');
      refs = en.targets ? ch.targets(en.targets) : ch.targets(c.targets);
    } else {
      const a = c.abilities?.[en.appliesTo];
      if (!a || a.kind !== 'trigger' || a.when !== 'onPlay') ch.add(`強化の appliesTo ${en.appliesTo} が配置時の能力を指していません`);
      refs = ch.targets(en.targets ?? (a && a.kind === 'trigger' ? a.targets : undefined));
    }
    hasDelay = ch.effects(en.effects, refs) || hasDelay;
  }
  const kwDelay = (c.keywords ?? []).includes('delay');
  if (kwDelay && !hasDelay) ch.add('キーワードに遅延がありますが、効果に遅延の処理がありません');
  if (!kwDelay && hasDelay) ch.add('効果に遅延の処理がありますが、キーワードに遅延がありません');
  return ch.problems;
}

function validateLeader(l: LeaderDef, cat: Catalog): string[] {
  const ch = new Checker(l.id, cat);
  if (!cat.factions.has(l.faction)) ch.add(`勢力 ${l.faction} がありません`);
  if (!GROWTH.has(l.growth?.counter)) ch.add(`成長条件 ${l.growth?.counter} は使えません`);
  if (!(l.growth?.threshold > 0)) ch.add('成長条件の回数が正ではありません');
  for (const ab of [l.ability, l.grown?.ability]) if (ab) ch.effects(ab.effects, ch.targets(ab.targets));
  for (const p of [...(l.passives ?? []), ...(l.grown?.passives ?? [])]) ch.ability(p);
  return ch.problems;
}

// ---------------------------------------------------------------- デッキ

/** デッキの条件（ルール仕様書 3.1）を満たさない点を返す。空なら対戦できる */
export function validateDeck(deck: DeckDef, cat: Catalog): string[] {
  const out: string[] = [];
  const factions: FactionId[] = [];
  if (deck.leaders.length !== 2) out.push('リーダーはちょうど2人選びます');
  for (const id of deck.leaders) {
    const l = cat.leaders.get(id);
    if (!l) out.push(`リーダー ${id} がいません`);
    else factions.push(l.faction);
  }
  if (factions.length === 2 && factions[0] === factions[1]) out.push('2人のリーダーは異なる勢力から選びます');
  let total = 0;
  for (const { id, count } of deck.cards) {
    const c = cat.cards.get(id);
    total += count;
    if (!c) {
      out.push(`カード ${id} がありません`);
      continue;
    }
    if (!factions.includes(c.faction)) out.push(`${id} ${c.name} はリーダーの勢力のカードではありません`);
    if (count > MAX_COPIES) out.push(`${id} ${c.name} が ${count} 枚あります（同名は ${MAX_COPIES} 枚まで）`);
  }
  if (total !== DECK_SIZE) out.push(`デッキが ${total} 枚です（ちょうど ${DECK_SIZE} 枚）`);
  return out;
}
