// 手札のカードの価値の表（ai.md 9章の案 D）
//
// 評価関数では手札1枚の価値を「hand ＋ handCost × コスト」で一律に決めている。
// この表は、カードごとの補正（評価値の単位）を相手の勢力ごとに持つ。値が小さいカードは、持っているより使ったほうがよい。
// 表は AI 同士の対戦から作る: npm run hand-table
import type { FactionId } from './types';
import tableJson from './hand-table.json';

export interface HandTable {
  version: 1;
  /** 表を作った試合数 */
  games: number;
  /** 相手の勢力 → カードID → 手札1枚の価値の補正 */
  vs: Partial<Record<FactionId, Record<string, number>>>;
}

export const HAND_TABLE = tableJson as HandTable;

/** 相手の勢力を考えた補正（表にないカードは 0） */
export function handAdjust(cardId: string, oppFactions: FactionId[], table: HandTable = HAND_TABLE): number {
  let sum = 0;
  let n = 0;
  for (const f of oppFactions) {
    const v = table.vs[f]?.[cardId];
    if (v !== undefined) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : 0;
}
