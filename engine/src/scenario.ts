// テストシナリオ: 「初期状態 + 操作 → 期待する状態」を JSON で書き、エンジンで確かめる（タスク 1-13）
// 形式は engine/scenarios/README.md を参照。Godot 版でも同じファイルを使う
import { parseCellName } from './board';
import type { Catalog } from './catalog';
import { getCard } from './catalog';
import { applyAction, emptyState } from './engine';
import { Runner } from './runner';
import type { Action, CardInstance, GameState, Keyword, PlayerId, TargetValue, Targets } from './types';

export interface ScenarioUnit {
  card: string;
  damage?: number;
  /** 永続の強化 */
  attack?: number;
  health?: number;
  /** このラウンド中の強化 */
  tempAttack?: number;
  tempHealth?: number;
  keywords?: Keyword[];
  tempKeywords?: Keyword[];
  shield?: boolean;
  token?: boolean;
  mobileUsed?: boolean;
}

export interface ScenarioPlayer {
  life?: number;
  mana?: number;
  maxMana?: number;
  reserve?: number;
  unusedMana?: number;
  spellsCast?: number;
  castSpells?: string[];
  leaders?: (string | { id: string; grown?: boolean; progress?: number; used?: boolean; costMod?: number })[];
  hand?: (string | { card: string; costMod?: number })[];
  /** 山札（先頭が一番上）。省略時は KN-03 を10枚 */
  deck?: string[];
  trash?: string[];
  board?: Record<string, string | ScenarioUnit>;
}

export interface ScenarioSetup {
  seed?: number;
  round?: number;
  firstPlayer?: PlayerId;
  activePlayer?: PlayerId;
  passStreak?: number;
  A?: ScenarioPlayer;
  B?: ScenarioPlayer;
}

export interface ExpectUnit {
  card?: string;
  attack?: number;
  /** 残り体力 */
  health?: number;
  maxHealth?: number;
  damage?: number;
  shield?: boolean;
  /** 持っているキーワード（ここに書いたものをすべて持つ） */
  keywords?: Keyword[];
  /** 持っていないキーワード */
  noKeywords?: Keyword[];
  token?: boolean;
}

export interface ExpectPlayer {
  life?: number;
  mana?: number;
  maxMana?: number;
  reserve?: number;
  unusedMana?: number;
  spellsCast?: number;
  /** 手札のカードID（順不同） */
  hand?: string[];
  handCount?: number;
  /** 手札のカードのコスト（カードID → コスト） */
  handCosts?: Record<string, number>;
  revealed?: string[];
  deckCount?: number;
  /** 山札の上から順のカードID（書いた枚数だけ比べる） */
  deckTop?: string[];
  trash?: string[];
  exile?: string[];
  board?: Record<string, ExpectUnit | null>;
  leaders?: { grown?: boolean; progress?: number; used?: boolean; cost?: number }[];
  delayed?: string[];
}

export interface ScenarioExpect {
  round?: number;
  activePlayer?: PlayerId;
  firstPlayer?: PlayerId;
  passStreak?: number;
  result?: { winner: PlayerId | null; reason?: string } | null;
  pending?: boolean;
  A?: ExpectPlayer;
  B?: ExpectPlayer;
}

/** シナリオの中の対象の書き方: {"unit":"B:2前"} {"cell":"A:1後"} {"lane":3} {"player":"B"} {"card":"AC-02"} */
export type ScenarioTarget = { unit: string } | { cell: string } | { lane: number } | { player: PlayerId } | { card: string };

export type ScenarioStep =
  | ({ type: string; player: PlayerId; illegal?: boolean; note?: string } & Record<string, unknown>)
  | { do: 'combat' | 'endRound' | 'startRound' | 'roundEnd'; note?: string }
  | { expect: ScenarioExpect; note?: string };

export interface Scenario {
  name: string;
  /** 関係するルール仕様書の節やカード */
  refs?: string[];
  setup: ScenarioSetup;
  steps: ScenarioStep[];
  expect?: ScenarioExpect;
}

export interface ScenarioResult {
  ok: boolean;
  errors: string[];
  state: GameState;
}

// ---------------------------------------------------------------- 初期状態

const DEFAULT_LEADERS: Record<PlayerId, string[]> = { A: ['leader-alto', 'leader-rei'], B: ['leader-rei', 'leader-noel'] };

export function buildState(cat: Catalog, setup: ScenarioSetup): GameState {
  const leaders = { A: leaderIds(setup.A, 'A'), B: leaderIds(setup.B, 'B') };
  const s = emptyState(setup.seed ?? 1, leaders);
  s.phase = 'action';
  s.round = setup.round ?? 1;
  s.firstPlayer = setup.firstPlayer ?? 'A';
  s.activePlayer = setup.activePlayer ?? s.firstPlayer;
  s.passStreak = setup.passStreak ?? 0;
  const r = new Runner(cat, s);
  const inst = (cardId: string): CardInstance => {
    getCard(cat, cardId);
    return { uid: s.nextUid++, cardId, costMod: 0, revealed: false, generated: false };
  };
  for (const p of ['A', 'B'] as const) {
    const sp = setup[p] ?? {};
    const st = s.players[p];
    st.mulliganDone = true;
    st.life = sp.life ?? st.life;
    st.maxMana = sp.maxMana ?? sp.mana ?? s.round;
    st.mana = sp.mana ?? st.maxMana;
    st.reserve = sp.reserve ?? 0;
    st.unusedMana = sp.unusedMana ?? 0;
    st.castSpellIds = [...(sp.castSpells ?? [])];
    st.spellsCast = sp.spellsCast ?? st.castSpellIds.length;
    (sp.leaders ?? []).forEach((l, idx) => {
      if (typeof l === 'string') return;
      const ls = st.leaders[idx];
      ls.grown = l.grown ?? false;
      ls.progress = l.progress ?? 0;
      ls.usedThisRound = l.used ?? false;
      ls.costMod = l.costMod ?? 0;
    });
    for (const h of sp.hand ?? []) {
      const c = inst(typeof h === 'string' ? h : h.card);
      if (typeof h !== 'string') c.costMod = h.costMod ?? 0;
      st.hand.push(c);
    }
    st.deck = (sp.deck ?? Array(10).fill('KN-03')).map(inst);
    st.trash = (sp.trash ?? []).map(inst);
    for (const [name, v] of Object.entries(sp.board ?? {})) {
      const su: ScenarioUnit = typeof v === 'string' ? { card: v } : v;
      const def = getCard(cat, su.card);
      if (def.type !== 'unit') throw new Error(`${su.card} はユニットではありません`);
      const u = r.newUnit(p, su.card, s.nextUid++, su.token ?? false);
      u.damage = su.damage ?? 0;
      u.attackPerm = su.attack ?? 0;
      u.healthPerm = su.health ?? 0;
      u.attackTemp = su.tempAttack ?? 0;
      u.healthTemp = su.tempHealth ?? 0;
      u.keywordsPerm = [...(su.keywords ?? [])].filter((k) => k !== 'shield');
      u.keywordsTemp = [...(su.tempKeywords ?? [])];
      if (su.keywords?.includes('shield')) u.shield = true;
      if (su.shield !== undefined) u.shield = su.shield;
      u.mobileUsed = su.mobileUsed ?? false;
      st.board[parseCellName(name)] = u;
    }
  }
  return s;
}

function leaderIds(sp: ScenarioPlayer | undefined, p: PlayerId): string[] {
  const ls = sp?.leaders;
  if (!ls?.length) return DEFAULT_LEADERS[p];
  return ls.map((l) => (typeof l === 'string' ? l : l.id));
}

// ---------------------------------------------------------------- 操作

function parseSide(ref: string): { p: PlayerId; i: number } {
  const m = /^([AB]):(.+)$/.exec(ref);
  if (!m) throw new Error(`"A:2前" の形で書いてください: ${ref}`);
  return { p: m[1] as PlayerId, i: parseCellName(m[2]) };
}

function unitUid(s: GameState, ref: string): number {
  const { p, i } = parseSide(ref);
  const u = s.players[p].board[i];
  if (!u) throw new Error(`${ref} にユニットがいません`);
  return u.uid;
}

function handUid(s: GameState, p: PlayerId, cardId: string, used: Set<number>): number {
  const c = s.players[p].hand.find((x) => x.cardId === cardId && !used.has(x.uid));
  if (!c) throw new Error(`${p} の手札に ${cardId} がありません`);
  used.add(c.uid);
  return c.uid;
}

function toTargets(s: GameState, p: PlayerId, raw: Record<string, ScenarioTarget | ScenarioTarget[]> | undefined, used: Set<number>): Targets | undefined {
  if (!raw) return undefined;
  const out: Targets = {};
  for (const [id, v] of Object.entries(raw)) {
    const list = Array.isArray(v) ? v : [v];
    out[id] = list.map((t): TargetValue => {
      if ('unit' in t) return { kind: 'unit', uid: unitUid(s, t.unit) };
      if ('cell' in t) {
        const c = parseSide(t.cell);
        return { kind: 'cell', p: c.p, i: c.i };
      }
      if ('lane' in t) return { kind: 'lane', lane: t.lane };
      if ('player' in t) return { kind: 'player', p: t.player };
      return { kind: 'card', uid: handUid(s, p, t.card, used) };
    });
  }
  return out;
}

/** シナリオの書き方のアクションを、エンジンのアクションにする */
export function toAction(cat: Catalog, s: GameState, step: Record<string, unknown>): Action {
  const p = step.player as PlayerId;
  const used = new Set<number>();
  const targets = () => toTargets(s, p, step.targets as Record<string, ScenarioTarget>, used);
  switch (step.type) {
    case 'playUnit': {
      const card = handUid(s, p, step.card as string, used);
      return { type: 'playUnit', player: p, card, cell: parseCellName(step.cell as string), enhance: !!step.enhance, targets: targets(), reserve: step.reserve as number | undefined };
    }
    case 'castSpell': {
      const card = handUid(s, p, step.card as string, used);
      return { type: 'castSpell', player: p, card, enhance: !!step.enhance, targets: targets(), reserve: step.reserve as number | undefined };
    }
    case 'advance':
      return { type: 'advance', player: p, cell: parseCellName(step.cell as string) };
    case 'mobileMove':
      return { type: 'mobileMove', player: p, unit: unitUid(s, `${p}:${step.unit as string}`), to: parseCellName(step.to as string) };
    case 'activate':
      return { type: 'activate', player: p, unit: unitUid(s, `${p}:${step.unit as string}`), ability: (step.ability as number) ?? firstActivated(cat, s, p, step.unit as string), targets: targets(), reserve: step.reserve as number | undefined };
    case 'leaderAbility':
      return { type: 'leaderAbility', player: p, leader: step.leader as number, targets: targets(), reserve: step.reserve as number | undefined };
    case 'pass':
      return { type: 'pass', player: p };
    case 'choose': {
      const opt = s.pending?.options.find((o) => o.cardId === step.card);
      if (!opt) throw new Error(`選択肢に ${step.card as string} がありません`);
      return { type: 'choose', player: p, option: opt.uid };
    }
    case 'mulligan':
      return { type: 'mulligan', player: p, cards: ((step.cards as string[]) ?? []).map((c) => handUid(s, p, c, used)) };
    default:
      throw new Error(`アクションの種類 ${String(step.type)} は使えません`);
  }
}

function firstActivated(cat: Catalog, s: GameState, p: PlayerId, cell: string): number {
  const u = s.players[p].board[parseCellName(cell)];
  if (!u) return 0;
  const idx = (getCard(cat, u.cardId).abilities ?? []).findIndex((a) => a.kind === 'activated');
  return Math.max(0, idx);
}

// ---------------------------------------------------------------- 期待する状態

export function checkExpect(cat: Catalog, s: GameState, ex: ScenarioExpect, label = ''): string[] {
  const errs: string[] = [];
  const r = new Runner(cat, s);
  const eq = (what: string, actual: unknown, expected: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errs.push(`${label}${what}: 期待 ${JSON.stringify(expected)} / 実際 ${JSON.stringify(actual)}`);
  };
  const sorted = (xs: string[]) => [...xs].sort();
  if (ex.round !== undefined) eq('round', s.round, ex.round);
  if (ex.activePlayer !== undefined) eq('activePlayer', s.activePlayer, ex.activePlayer);
  if (ex.firstPlayer !== undefined) eq('firstPlayer', s.firstPlayer, ex.firstPlayer);
  if (ex.passStreak !== undefined) eq('passStreak', s.passStreak, ex.passStreak);
  if (ex.pending !== undefined) eq('pending', !!s.pending, ex.pending);
  if (ex.result !== undefined) {
    if (ex.result === null) eq('result', s.result, null);
    else {
      eq('result.winner', s.result?.winner, ex.result.winner);
      if (ex.result.reason) eq('result.reason', s.result?.reason, ex.result.reason);
    }
  }
  for (const p of ['A', 'B'] as const) {
    const e = ex[p];
    if (!e) continue;
    const st = s.players[p];
    const L = `${p}.`;
    if (e.life !== undefined) eq(L + 'life', st.life, e.life);
    if (e.mana !== undefined) eq(L + 'mana', st.mana, e.mana);
    if (e.maxMana !== undefined) eq(L + 'maxMana', st.maxMana, e.maxMana);
    if (e.reserve !== undefined) eq(L + 'reserve', st.reserve, e.reserve);
    if (e.unusedMana !== undefined) eq(L + 'unusedMana', st.unusedMana, e.unusedMana);
    if (e.spellsCast !== undefined) eq(L + 'spellsCast', st.spellsCast, e.spellsCast);
    if (e.hand) eq(L + 'hand', sorted(st.hand.map((c) => c.cardId)), sorted(e.hand));
    if (e.handCount !== undefined) eq(L + 'handCount', st.hand.length, e.handCount);
    if (e.handCosts) {
      for (const [id, cost] of Object.entries(e.handCosts)) {
        const c = st.hand.find((x) => x.cardId === id);
        eq(`${L}handCosts.${id}`, c ? r.cardCost(p, c) : null, cost);
      }
    }
    if (e.revealed) eq(L + 'revealed', sorted(st.hand.filter((c) => c.revealed).map((c) => c.cardId)), sorted(e.revealed));
    if (e.deckCount !== undefined) eq(L + 'deckCount', st.deck.length, e.deckCount);
    if (e.deckTop) eq(L + 'deckTop', st.deck.slice(0, e.deckTop.length).map((c) => c.cardId), e.deckTop);
    if (e.trash) eq(L + 'trash', sorted(st.trash.map((c) => c.cardId)), sorted(e.trash));
    if (e.exile) eq(L + 'exile', sorted(st.exile.map((c) => c.cardId)), sorted(e.exile));
    if (e.delayed) eq(L + 'delayed', s.delayed.filter((d) => d.owner === p).map((d) => d.cardId), e.delayed);
    (e.leaders ?? []).forEach((el, idx) => {
      const l = st.leaders[idx];
      if (el.grown !== undefined) eq(`${L}leaders[${idx}].grown`, l.grown, el.grown);
      if (el.progress !== undefined) eq(`${L}leaders[${idx}].progress`, l.progress, el.progress);
      if (el.used !== undefined) eq(`${L}leaders[${idx}].used`, l.usedThisRound, el.used);
      if (el.cost !== undefined) eq(`${L}leaders[${idx}].cost`, r.leaderCost(p, idx), el.cost);
    });
    for (const [name, eu] of Object.entries(e.board ?? {})) {
      const u = st.board[parseCellName(name)];
      const W = `${L}board.${name}`;
      if (eu === null) {
        if (u) errs.push(`${label}${W}: 空きマスのはずが ${u.cardId} がいます`);
        continue;
      }
      if (!u) {
        errs.push(`${label}${W}: ユニットがいません（期待 ${eu.card ?? '?'}）`);
        continue;
      }
      if (eu.card !== undefined) eq(W + '.card', u.cardId, eu.card);
      if (eu.attack !== undefined) eq(W + '.attack', r.attack(u), eu.attack);
      if (eu.health !== undefined) eq(W + '.health', r.health(u), eu.health);
      if (eu.maxHealth !== undefined) eq(W + '.maxHealth', r.maxHealth(u), eu.maxHealth);
      if (eu.damage !== undefined) eq(W + '.damage', u.damage + u.tempDamage, eu.damage);
      if (eu.shield !== undefined) eq(W + '.shield', u.shield, eu.shield);
      if (eu.token !== undefined) eq(W + '.token', u.isToken, eu.token);
      const kws = r.keywords(u);
      for (const k of eu.keywords ?? []) if (!kws.has(k)) errs.push(`${label}${W}: キーワード ${k} を持っていません`);
      for (const k of eu.noKeywords ?? []) if (kws.has(k)) errs.push(`${label}${W}: キーワード ${k} を持っています`);
    }
  }
  return errs;
}

// ---------------------------------------------------------------- 実行

export function runScenario(cat: Catalog, sc: Scenario): ScenarioResult {
  let s = buildState(cat, sc.setup);
  const errors: string[] = [];
  sc.steps.forEach((step, n) => {
    if (errors.length || s.result) {
      if ('type' in step || 'do' in step) {
        if (!errors.length && s.result) errors.push(`手順${n + 1}: 試合が終わった後の手順があります`);
      } else errors.push(...checkExpect(cat, s, (step as { expect: ScenarioExpect }).expect, `手順${n + 1}の時点 `));
      return;
    }
    const label = `手順${n + 1}`;
    try {
      if ('expect' in step) {
        errors.push(...checkExpect(cat, s, (step as { expect: ScenarioExpect }).expect, `${label}の時点 `));
      } else if ('do' in step) {
        s = structuredClone(s);
        const r = new Runner(cat, s);
        if (step.do === 'combat') r.combatPhase();
        else if (step.do === 'roundEnd') r.endPhase();
        else if (step.do === 'startRound') r.startRound(false);
        else {
          r.endPhase();
          if (!s.result) r.startRound(false);
        }
      } else {
        const action = toAction(cat, s, step as Record<string, unknown>);
        if ((step as { illegal?: boolean }).illegal) {
          let threw = false;
          try {
            applyAction(cat, s, action);
          } catch {
            threw = true;
          }
          if (!threw) errors.push(`${label}: 行えないはずのアクションが行えました ${JSON.stringify(step)}`);
        } else s = applyAction(cat, s, action);
      }
    } catch (e) {
      errors.push(`${label}: ${(e as Error).message}`);
    }
  });
  if (sc.expect) errors.push(...checkExpect(cat, s, sc.expect));
  return { ok: errors.length === 0, errors, state: s };
}

