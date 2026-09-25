// AI のマリガン（タスク 4-1 の改良）
//
// 「初手にあると勝ちやすいカード・勝ちにくいカード」を相手の勢力ごとに表にしておき（mulligan-table.json）、
// 山札から代わりに引くカードの見込みより悪いカードを戻す。
// 表は AI 同士の対戦（マリガンなし）から作る: npm run mulligan-table
// 表にないカード（見本デッキにも調査用のデッキにも入らなかったカード）は、コストで見込みを決める。
import { opponent } from './board';
import type { Catalog } from './catalog';
import { getCard, getLeader } from './catalog';
import tableJson from './mulligan-table.json';
import type { FactionId, GameState, PlayerId } from './types';

/**
 * smart … 表と相手の勢力を使う（ふつう・つよい）
 * cost  … コスト5以上を戻す（やさしい。以前のすべての強さ）
 * none  … 戻さない（表を作るとき）
 */
export type MulliganPolicy = 'smart' | 'cost' | 'none';

export interface MulliganTable {
  version: 1;
  /** 表を作った試合数 */
  games: number;
  /** 相手の勢力 → カードID → 初手にあったときの勝率の差（ポイント。0 がデッキの平均） */
  vs: Partial<Record<FactionId, Record<string, number>>>;
}

export const MULLIGAN_TABLE = tableJson as MulliganTable;

/** 戻すかどうかの余裕（ポイント）。代わりに引くカードの見込みよりこれ以上悪いときだけ戻す（0〜3 を比べて 0 が一番よかった） */
export const MULLIGAN_MARGIN = 0;

/** 表にないカードの見込み（コストが重いほど初手では役に立たない） */
function fallbackValue(cost: number): number {
  return cost >= 5 ? -4 - (cost - 5) : cost === 4 ? -1 : 0;
}

/** 相手の勢力を考えた、初手にあるときのカードの見込み（ポイント） */
export function keepValue(cat: Catalog, cardId: string, oppFactions: FactionId[], table: MulliganTable = MULLIGAN_TABLE): number {
  const vals = oppFactions.map((f) => table.vs[f]?.[cardId]).filter((v): v is number => v !== undefined);
  if (!vals.length) return fallbackValue(getCard(cat, cardId).cost);
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** マリガンで戻すカード（uid） */
export function chooseMulligan(
  cat: Catalog,
  state: GameState,
  player: PlayerId,
  policy: MulliganPolicy,
  table: MulliganTable = MULLIGAN_TABLE,
  margin = MULLIGAN_MARGIN,
): number[] {
  const me = state.players[player];
  if (policy === 'none') return [];
  if (policy === 'cost') return me.hand.filter((c) => getCard(cat, c.cardId).cost >= 5).map((c) => c.uid);
  const opp = state.players[opponent(player)].leaders.map((l) => getLeader(cat, l.id).faction);
  const value = (id: string) => keepValue(cat, id, opp, table);
  // 代わりに引くカードの見込み = 自分の山札（自分のデッキの中身は知っている）の平均
  const expected = me.deck.length ? me.deck.reduce((s, c) => s + value(c.cardId), 0) / me.deck.length : 0;
  return me.hand.filter((c) => value(c.cardId) < expected - margin).map((c) => c.uid);
}
