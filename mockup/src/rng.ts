// シード付き乱数（mulberry32）。状態は数値1つなので、ゲームの状態に含めて保存できる。

export function nextRandom(state: number): [number, number] {
  let t = (state + 0x6d2b79f5) | 0;
  const next = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, next];
}

// state を持つオブジェクトから乱数を取り出す
export interface RngHolder {
  rngState: number;
}

export function random(h: RngHolder): number {
  const [v, s] = nextRandom(h.rngState);
  h.rngState = s;
  return v;
}

export function randomInt(h: RngHolder, n: number): number {
  return Math.floor(random(h) * n);
}

export function shuffleInPlace<T>(h: RngHolder, arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(h, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
