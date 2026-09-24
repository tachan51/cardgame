// マスの番号とレーン・列の変換（ルール仕様書 5章）
import { LANES } from './constants';
import type { PlayerId, Row } from './types';

/** レーン(1〜4)と列からマスの番号（0〜7）。盤面の順番 1前→1後→2前→… と同じ */
export function cellIndex(lane: number, row: Row): number {
  return (lane - 1) * 2 + (row === 'front' ? 0 : 1);
}
export function laneOf(i: number): number {
  return Math.floor(i / 2) + 1;
}
export function rowOf(i: number): Row {
  return i % 2 === 0 ? 'front' : 'back';
}
export function otherRow(i: number): number {
  return i % 2 === 0 ? i + 1 : i - 1;
}
/** 左右隣のマス（同じ列でレーン番号が1違う。1と4は隣ではない） */
export function leftRight(i: number): number[] {
  const lane = laneOf(i);
  const row = rowOf(i);
  const out: number[] = [];
  if (lane > 1) out.push(cellIndex(lane - 1, row));
  if (lane < LANES) out.push(cellIndex(lane + 1, row));
  return out;
}
/** "2前" のような表記 */
export function cellName(i: number): string {
  return `${laneOf(i)}${rowOf(i) === 'front' ? '前' : '後'}`;
}
export function parseCellName(s: string): number {
  const m = /^([1-4])(前|後)$/.exec(s);
  if (!m) throw new Error(`マスの表記が不正です: ${s}`);
  return cellIndex(Number(m[1]), m[2] === '前' ? 'front' : 'back');
}
export function opponent(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}
