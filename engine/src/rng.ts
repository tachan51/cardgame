// シード付き乱数（mulberry32）。状態は GameState.rngState に持ち、同じシードと同じ操作なら同じ結果になる
export interface RngHolder {
  rngState: number;
}

export function nextRandom(h: RngHolder): number {
  let t = (h.rngState = (h.rngState + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 0 以上 n 未満の整数 */
export function randomInt(h: RngHolder, n: number): number {
  return Math.floor(nextRandom(h) * n);
}

export function shuffleInPlace<T>(h: RngHolder, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(h, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** 候補から重複なく n 個をランダムに選ぶ（候補の元の並びは変えない） */
export function pickRandom<T>(h: RngHolder, items: readonly T[], n: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(randomInt(h, pool.length), 1)[0]);
  return out;
}
