// 操作の組み立て（2-2）: 合法手の一覧を、クリックで選んだ内容に合うものへ絞り込んでいく
import { canonical } from '../../engine/src/runner';
import { getCard, legalActions, type Action, type GameState, type TargetSpec, type TargetValue } from '../../engine/src';
import { onPlayTargetSpecs, spellTargetSpecs } from '../../engine/src/engine';
import { Runner } from '../../engine/src/runner';
import { cat } from './data';
import { HUMAN } from './text';

export type Source = { kind: 'hand'; uid: number } | { kind: 'unit'; uid: number; mode: 'mobileMove' | 'activate'; ability?: number } | { kind: 'leader'; idx: number };

export interface Selection {
  source: Source;
  enhance?: boolean;
  cell?: number;
  to?: number;
  picks: Record<string, TargetValue[]>;
  confirmed?: boolean;
}

/** 次に決めること */
export type Step =
  | { kind: 'enhance'; options: { enhance: boolean; cost: number }[] }
  | { kind: 'cell' | 'to'; cells: number[] }
  | { kind: 'target'; id: string; spec: TargetSpec | undefined; values: TargetValue[]; picked: TargetValue[]; need: number }
  | { kind: 'confirm'; action: Action }
  | { kind: 'ready'; action: Action }
  | { kind: 'none' };

type WithTargets = Action & { targets?: Record<string, TargetValue[]>; enhance?: boolean };

function sourceMatches(a: Action, src: Source): boolean {
  switch (src.kind) {
    case 'hand':
      return (a.type === 'playUnit' || a.type === 'castSpell') && a.card === src.uid;
    case 'unit':
      if (src.mode === 'mobileMove') return a.type === 'mobileMove' && a.unit === src.uid;
      return a.type === 'activate' && a.unit === src.uid && a.ability === src.ability;
    case 'leader':
      return a.type === 'leaderAbility' && a.leader === src.idx;
  }
}

const key = (v: TargetValue) => canonical([v]);

/** 手札のカードなどが使える合法手（同名カードの重複を除かずに、そのカードの uid で並べる） */
export function allLegal(state: GameState): Action[] {
  const base = legalActions(cat, state);
  // legalActions は同名・同コストの手札を1枚にまとめるので、他の同名カードの分も同じ手を複製する
  const out: Action[] = [...base];
  const hand = state.players[HUMAN].hand;
  for (const a of base) {
    if (a.type !== 'playUnit' && a.type !== 'castSpell') continue;
    const src = hand.find((c) => c.uid === a.card)!;
    for (const c of hand) {
      if (c.uid === src.uid || c.cardId !== src.cardId || c.costMod !== src.costMod) continue;
      out.push({ ...a, card: c.uid });
    }
  }
  return out;
}

export function candidates(all: Action[], sel: Selection, _state: GameState): WithTargets[] {
  return (all as WithTargets[]).filter((a) => {
    if (!sourceMatches(a, sel.source)) return false;
    if (sel.enhance !== undefined && !!a.enhance !== sel.enhance) return false;
    if (sel.cell !== undefined && a.type === 'playUnit' && a.cell !== sel.cell) return false;
    if (sel.to !== undefined && a.type === 'mobileMove' && a.to !== sel.to) return false;
    for (const [id, picked] of Object.entries(sel.picks)) {
      const have = new Set((a.targets?.[id] ?? []).map(key));
      if (!picked.every((v) => have.has(key(v)))) return false;
    }
    return true;
  });
}

/** 対象の名前から、その指定（種類・敵味方）を探す */
export function specFor(state: GameState, src: Source, enhance: boolean, id: string): TargetSpec | undefined {
  const r = new Runner(cat, state);
  let specs: TargetSpec[] = [];
  if (src.kind === 'hand') {
    const c = state.players[HUMAN].hand.find((x) => x.uid === src.uid);
    if (c) specs = getCard(cat, c.cardId).type === 'unit' ? onPlayTargetSpecs(r, c.cardId, enhance) : spellTargetSpecs(r, c.cardId, enhance);
  } else if (src.kind === 'unit' && src.mode === 'activate') {
    const u = r.findUnit(src.uid);
    const ab = u && getCard(cat, u.unit.cardId).abilities?.[src.ability ?? -1];
    if (ab && ab.kind === 'activated') specs = ab.targets ?? [];
  } else if (src.kind === 'leader') {
    specs = r.leaderAbility(HUMAN, src.idx)?.targets ?? [];
  }
  return specs.find((s) => s.id === id);
}

/** 今の選択で、次に何を決めるか */
export function nextStep(all: Action[], sel: Selection, state: GameState): Step {
  const cands = candidates(all, sel, state);
  if (!cands.length) return { kind: 'none' };
  const first = cands[0];
  const distinct = <T>(f: (a: WithTargets) => T) => [...new Set(cands.map((a) => JSON.stringify(f(a))))].map((x) => JSON.parse(x) as T);

  if (sel.enhance === undefined) {
    const opts = distinct((a) => !!a.enhance);
    if (opts.length > 1) {
      const r = new Runner(cat, state);
      const c = sel.source.kind === 'hand' ? state.players[HUMAN].hand.find((x) => x.uid === (sel.source as { uid: number }).uid) : null;
      const base = c ? r.cardCost(HUMAN, c) : 0;
      const en = c ? r.enhanceCost(HUMAN, getCard(cat, c.cardId)) : 0;
      return { kind: 'enhance', options: [{ enhance: false, cost: base }, { enhance: true, cost: base + en }] };
    }
  }
  if (first.type === 'playUnit' && sel.cell === undefined) {
    const cells = distinct((a) => (a.type === 'playUnit' ? a.cell : -1));
    if (cells.length > 1 || !sel.confirmed) return { kind: 'cell', cells };
  }
  if (first.type === 'mobileMove' && sel.to === undefined) {
    return { kind: 'to', cells: distinct((a) => (a.type === 'mobileMove' ? a.to : -1)) };
  }
  for (const id of Object.keys(first.targets ?? {})) {
    const combos = distinct((a) => canonical(a.targets?.[id] ?? []));
    if (combos.length <= 1) continue;
    const picked = sel.picks[id] ?? [];
    const pickedKeys = new Set(picked.map(key));
    const values = new Map<string, TargetValue>();
    for (const a of cands) for (const v of a.targets?.[id] ?? []) if (!pickedKeys.has(key(v))) values.set(key(v), v);
    const need = Math.max(...cands.map((a) => (a.targets?.[id] ?? []).length));
    return { kind: 'target', id, spec: specFor(state, sel.source, !!first.enhance, id), values: [...values.values()], picked, need };
  }
  // 1クリックで決まってしまう手（対象のないスペルなど）は確認してから行う
  const action = first;
  const clicks = [Object.keys(sel.picks).length ? true : undefined, sel.cell, sel.to, sel.enhance].filter((x) => x !== undefined).length;
  if (clicks === 0 && !sel.confirmed) return { kind: 'confirm', action };
  return { kind: 'ready', action };
}
