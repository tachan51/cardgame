import { describe, expect, it } from 'vitest';
import { buildState } from '../../engine/src/scenario';
import { cat } from './data';
import { allLegal, nextStep, type Selection } from './select';


const handUid = (s: ReturnType<typeof buildState>, id: string) => s.players.A.hand.find((c) => c.cardId === id)!.uid;

describe('操作の組み立て', () => {
  it('ユニットはマスを選ぶと決まる', () => {
    const s = buildState(cat, { A: { maxMana: 3, hand: ['KN-09'] } });
    const sel: Selection = { source: { kind: 'hand', uid: handUid(s, 'KN-09') }, picks: {} };
    const all = allLegal(s);
    const st = nextStep(all, sel, s);
    expect(st.kind).toBe('cell');
    if (st.kind === 'cell') expect(st.cells.length).toBe(8);
    sel.cell = 3;
    expect(nextStep(all, sel, s)).toMatchObject({ kind: 'ready', action: { type: 'playUnit', cell: 3 } });
  });

  it('対象のないスペルは確認してから使う', () => {
    const s = buildState(cat, { A: { hand: ['AC-07'] } });
    const sel: Selection = { source: { kind: 'hand', uid: handUid(s, 'AC-07') }, picks: {} };
    const all = allLegal(s);
    expect(nextStep(all, sel, s).kind).toBe('confirm');
    sel.confirmed = true;
    expect(nextStep(all, sel, s)).toMatchObject({ kind: 'ready', action: { type: 'castSpell' } });
  });

  it('強化するかを選び、予備マナの内訳を選ぶ', () => {
    const s = buildState(cat, { A: { maxMana: 5, reserve: 2, hand: ['KN-06'], board: { '1前': 'KN-04' } } });
    const sel: Selection = { source: { kind: 'hand', uid: handUid(s, 'KN-06') }, picks: {} };
    const all = allLegal(s);
    const st = nextStep(all, sel, s);
    expect(st).toMatchObject({ kind: 'enhance', options: [{ enhance: false, cost: 2 }, { enhance: true, cost: 4 }] });
    sel.enhance = true;
    // 対象の味方は1体だけなので自動で決まり、支払い方を選ぶ
    const st2 = nextStep(all, sel, s);
    expect(st2.kind).toBe('reserve');
    if (st2.kind === 'reserve') expect(st2.options.map((o) => o.reserve)).toEqual([2, 1, 0]);
    sel.reserve = 1;
    expect(nextStep(all, sel, s)).toMatchObject({ kind: 'ready', action: { type: 'castSpell', enhance: true, reserve: 1 } });
  });

  it('ユニット → その持ち主の空きマス の順に選ぶ（小型転送）', () => {
    const s = buildState(cat, { A: { maxMana: 2, hand: ['CY-09'], board: { '2前': 'KN-04' } }, B: { board: { '1前': 'KN-05' } } });
    const sel: Selection = { source: { kind: 'hand', uid: handUid(s, 'CY-09') }, picks: {} };
    const all = allLegal(s);
    const st = nextStep(all, sel, s);
    expect(st).toMatchObject({ kind: 'target', id: 'unit' });
    const enemy = s.players.B.board[0]!.uid;
    sel.picks.unit = [{ kind: 'unit', uid: enemy }];
    const st2 = nextStep(all, sel, s);
    expect(st2.kind).toBe('target');
    if (st2.kind === 'target') {
      expect(st2.id).toBe('cell');
      expect(st2.values.every((v) => v.kind === 'cell' && v.p === 'B')).toBe(true);
      expect(st2.values.length).toBe(7);
    }
    sel.picks.cell = [{ kind: 'cell', p: 'B', i: 7 }];
    expect(nextStep(all, sel, s)).toMatchObject({ kind: 'ready', action: { targets: { unit: [{ uid: enemy }], cell: [{ i: 7 }] } } });
  });

  it('2つ選ぶ対象は1つずつ選ぶ（召喚の魔法陣）', () => {
    const s = buildState(cat, { A: { maxMana: 3, hand: ['AC-15'], board: { '1前': 'KN-04', '1後': 'KN-04', '2前': 'KN-04', '2後': 'KN-04', '3前': 'KN-04' } } });
    const sel: Selection = { source: { kind: 'hand', uid: handUid(s, 'AC-15') }, picks: {} };
    const all = allLegal(s);
    const st = nextStep(all, sel, s);
    expect(st).toMatchObject({ kind: 'target', id: 'cells', need: 2 });
    sel.picks.cells = [{ kind: 'cell', p: 'A', i: 5 }];
    const st2 = nextStep(all, sel, s);
    expect(st2.kind).toBe('target');
    if (st2.kind === 'target') expect(st2.values.length).toBe(2);
    sel.picks.cells.push({ kind: 'cell', p: 'A', i: 7 });
    expect(nextStep(all, sel, s).kind).toBe('ready');
  });

  it('同名のカードが2枚あっても、どちらも選べる', () => {
    const s = buildState(cat, { A: { maxMana: 3, hand: ['KN-09', 'KN-09'] } });
    const all = allLegal(s);
    for (const c of s.players.A.hand) {
      const sel: Selection = { source: { kind: 'hand', uid: c.uid }, picks: {}, cell: 0 };
      expect(nextStep(all, sel, s)).toMatchObject({ kind: 'ready', action: { card: c.uid } });
    }
  });

  it('機動は移動先を選ぶ', () => {
    const s = buildState(cat, { A: { board: { '1前': 'CY-01' } } });
    const uid = s.players.A.board[0]!.uid;
    const sel: Selection = { source: { kind: 'unit', uid, mode: 'mobileMove' }, picks: {}, confirmed: true };
    const all = allLegal(s);
    expect(nextStep(all, sel, s)).toMatchObject({ kind: 'to' });
    sel.to = 6;
    expect(nextStep(all, sel, s)).toMatchObject({ kind: 'ready', action: { type: 'mobileMove', to: 6 } });
  });
});
