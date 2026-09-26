// AI の手札の価値の表（src/hand-table.json）を作る（ai.md 9章の案 D）
//   npx tsx scripts/hand-table.ts --games 150 --extra-games 20
//
// ふつうの AI 同士で対戦し、各ラウンドの始めの状態を集める。
// 「今の評価値（手札は一律の価値で数えたもの）」と「手札の各カードの枚数」から勝ち負けをロジスティック回帰で予測し、
// カードの係数を評価値の単位に直したものを「手札1枚の価値の補正」とする（相手の勢力ごと）。
// 補正が負のカードは、一律の価値より持っている価値が低い（使ったほうがよい）。
//   --games N        見本デッキ同士の組み合わせごとの試合数
//   --extra-games N  調査用のデッキが入る組み合わせごとの試合数
//   --l2 X           補正の正則化の強さ（大きいほど 0 に寄る）
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { chooseAction, evaluate, STAGE2_WEIGHTS } from '../src/ai';
import { buildCatalog, getLeader } from '../src/catalog';
import { applyAction, newGame } from '../src/engine';
import type { HandTable } from '../src/hand-table';
import { playerToAct } from '../src/legal';
import type { DeckDef, FactionFile, FactionId, GameState, PlayerId } from '../src/types';
import { probeDecks } from './probe-decks';

const DATA = join(import.meta.dirname, '..', '..', 'data');
const load = <T>(dir: string): T[] =>
  readdirSync(join(DATA, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DATA, dir, f), 'utf8')) as T);
const cat = buildCatalog(load<FactionFile>('cards'));
const samples = load<DeckDef>('decks');
const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const decks = [...samples, ...probeDecks(cat, samples, Number(arg('random', '2')))];

interface Job {
  seed: number;
  a: string;
  b: string;
}
/** ラウンドの始めの、あるプレイヤーから見た状態 */
interface Row {
  x: number;
  round: number;
  hand: string[];
  opp: FactionId[];
  win: number;
}

function run(j: Job): Row[] {
  const deck = (id: string) => decks.find((d) => d.id === id)!;
  let s: GameState = newGame(cat, { A: deck(j.a), B: deck(j.b) }, { seed: j.seed });
  const rows: (Omit<Row, 'win'> & { p: PlayerId })[] = [];
  let round = 0;
  for (let n = 0; !s.result && n < 5000; n++) {
    if (s.phase === 'action' && s.round !== round) {
      round = s.round;
      for (const p of ['A', 'B'] as PlayerId[]) {
        const q: PlayerId = p === 'A' ? 'B' : 'A';
        rows.push({
          p,
          x: evaluate(cat, s, p, STAGE2_WEIGHTS, true),
          round,
          hand: s.players[p].hand.map((c) => c.cardId),
          opp: s.players[q].leaders.map((l) => getLeader(cat, l.id).faction),
        });
      }
    }
    const p = playerToAct(s)[0];
    s = applyAction(cat, s, chooseAction(cat, s, p, { level: 'normal', seed: j.seed * 7919 + n }).action);
  }
  const w = s.result?.winner;
  return rows.map(({ p, ...r }) => ({ ...r, win: w === p ? 1 : w ? 0 : 0.5 }));
}

/** ロジスティック回帰（勾配法）。logit = b0 + a·x/10 + r·round/10 + Σ adj_c·n_c。adj は L2 で 0 に寄せる */
function fit(rows: Row[], cards: string[], l2: number): { a: number; adj: Map<string, number>; seen: Map<string, number> } {
  const idx = new Map(cards.map((c, i) => [c, i]));
  const K = cards.length;
  const th = new Float64Array(3 + K);
  const m = new Float64Array(3 + K);
  const v = new Float64Array(3 + K);
  const seen = new Map<string, number>();
  const feats = rows.map((r) => {
    const counts = new Map<number, number>();
    for (const c of r.hand) {
      const i = idx.get(c);
      if (i === undefined) continue;
      counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    for (const c of new Set(r.hand)) seen.set(c, (seen.get(c) ?? 0) + 1);
    return { x: r.x / 10, rd: Math.min(r.round, 15) / 10, counts: [...counts.entries()], y: r.win };
  });
  const N = feats.length;
  for (let it = 1; it <= 600; it++) {
    const g = new Float64Array(3 + K);
    for (const f of feats) {
      let z = th[0] + th[1] * f.x + th[2] * f.rd;
      for (const [i, n] of f.counts) z += th[3 + i] * n;
      const e = 1 / (1 + Math.exp(-z)) - f.y;
      g[0] += e;
      g[1] += e * f.x;
      g[2] += e * f.rd;
      for (const [i, n] of f.counts) g[3 + i] += e * n;
    }
    for (let k = 0; k < 3 + K; k++) {
      let gk = g[k] / N;
      if (k >= 3) gk += (l2 * th[k]) / N;
      // Adam
      m[k] = 0.9 * m[k] + 0.1 * gk;
      v[k] = 0.999 * v[k] + 0.001 * gk * gk;
      th[k] -= (0.05 * (m[k] / (1 - 0.9 ** it))) / (Math.sqrt(v[k] / (1 - 0.999 ** it)) + 1e-8);
    }
  }
  const a = th[1] / 10; // 評価値1あたりの logit
  const adj = new Map(cards.map((c, i) => [c, th[3 + i] / a]));
  return { a, adj, seen };
}

if (!isMainThread) {
  for (const j of workerData as Job[]) parentPort!.postMessage(run(j));
} else {
  const games = Number(arg('games', '150'));
  const extraGames = Number(arg('extra-games', '20'));
  const jobsN = Number(arg('jobs', String(cpus().length)));
  const l2 = Number(arg('l2', '30'));
  const minSeen = Number(arg('min-seen', '40'));
  const isSample = (id: string) => samples.some((d) => d.id === id);
  const jobs: Job[] = [];
  let seed = Number(arg('seed', '700000'));
  for (const a of decks)
    for (const b of decks) {
      const n = isSample(a.id) && isSample(b.id) ? games : extraGames;
      for (let g = 0; g < n; g++) jobs.push({ seed: seed++, a: a.id, b: b.id });
    }
  const chunks: Job[][] = Array.from({ length: jobsN }, () => []);
  jobs.forEach((j, i) => chunks[i % jobsN].push(j));
  const rows: Row[] = [];
  let done = 0;
  const t0 = Date.now();
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL('./hand-table-worker.mjs', import.meta.url), { workerData: chunk });
          w.on('message', (r: Row[]) => {
            rows.push(...r);
            if (++done % 200 === 0) process.stderr.write(`${done}/${jobs.length}\n`);
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );
  const cards = [...cat.cards.values()].filter((c) => !c.token).map((c) => c.id);
  const table: HandTable = { version: 1, games: jobs.length, vs: {} };
  for (const f of cat.factions.keys()) {
    const sub = rows.filter((r) => r.opp.includes(f));
    const { a, adj, seen } = fit(sub, cards, l2);
    process.stderr.write(`${f}: ${sub.length}件、評価値1あたりの logit ${a.toFixed(3)}\n`);
    const out: Record<string, number> = {};
    for (const c of cards) {
      if ((seen.get(c) ?? 0) < minSeen) continue;
      out[c] = Math.round(Math.max(-2, Math.min(2, adj.get(c)!)) * 100) / 100;
    }
    table.vs[f] = out;
  }
  writeFileSync(join(import.meta.dirname, '..', 'src', 'hand-table.json'), JSON.stringify(table, null, 1) + '\n');
  process.stderr.write(`${jobs.length}試合、${rows.length}件、${((Date.now() - t0) / 1000).toFixed(0)}秒\n`);
}
