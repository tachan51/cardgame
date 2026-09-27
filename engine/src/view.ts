// 公開情報だけにした状態（ルール仕様書 4章）と、戦闘のプレビュー（18章）
import { opponent } from './board';
import type { Catalog } from './catalog';
import { Runner } from './runner';
import type { CardInstance, GameState, PlayerId } from './types';

const HIDDEN = '?';

function hide(_c: CardInstance): CardInstance {
  return { uid: -1, cardId: HIDDEN, costMod: 0, revealed: false, generated: false };
}

/**
 * viewer から見える情報だけにした状態を返す。
 * 山札は枚数だけ（中身と順番は自分のものも隠す）、相手の手札は公開されたカードだけ見える。
 * AI はこの状態だけを使って判断する
 */
export function publicView(state: GameState, viewer: PlayerId, opts: { remember?: boolean } = {}): GameState {
  const v = structuredClone(state);
  for (const p of ['A', 'B'] as const) {
    const st = v.players[p];
    st.deck = st.deck.map(hide);
    // remember: 相手の手札のうち、生成した・手札に戻したなどで中身が分かっているカードも見える（覚えておく）
    if (p !== viewer) st.hand = st.hand.map((c) => (c.revealed || (opts.remember && c.known) ? c : hide(c)));
  }
  if (v.pending) {
    const mine = v.pending.player === viewer;
    v.pending = { ...v.pending, before: null as unknown as GameState, options: mine ? v.pending.options : [] };
  }
  v.rngState = 0;
  v.log = v.log.filter((e) => !(e.type === 'pick' && e.player === opponent(viewer)));
  return v;
}

export interface CombatPreview {
  /** 戦闘フェイズを終えた後の状態（戦闘開始時・戦闘終了時の効果を含む） */
  state: GameState;
  life: Record<PlayerId, number>;
  /** 破壊されるユニットの uid */
  destroyed: number[];
}

/**
 * 「このまま戦闘になったら」の結果を計算する（元の状態は変えない）。
 * 予約中の遅延効果は戦闘の前に必ず発動するので（6.2）、行動権を持つプレイヤーの分から先に発動させてから戦闘を行う
 */
export function previewCombat(cat: Catalog, state: GameState, opts: { withDelays?: boolean } = {}): CombatPreview {
  const s = structuredClone(state);
  s.pending = null;
  const r = new Runner(cat, s);
  const before = new Set(r.allUnits().map((x) => x.unit.uid));
  if (opts.withDelays ?? true) {
    for (const p of [s.activePlayer, opponent(s.activePlayer)]) if (!s.result) r.resolveDelays(p);
  }
  if (!s.result) r.combatPhase();
  const after = new Set(r.allUnits().map((x) => x.unit.uid));
  return {
    state: s,
    life: { A: s.players.A.life, B: s.players.B.life },
    destroyed: [...before].filter((uid) => !after.has(uid)),
  };
}
