// マリガンの方針どうしの比べ合い
//   npx tsx scripts/mulligan-ab.ts --games 100 --policies smart,cost --level normal [--extra a.json] [--margin 1]
//   --margin N  1つめの方針が smart のときの余裕（src/mulligan.ts の MULLIGAN_MARGIN）
//   環境変数 AB_OPTS（JSON）: 1つめの側だけ AI の設定を差し替える（例: {"rolloutRounds":2} と --level hard）
//   環境変数 AB_WEIGHTS（JSON）: 1つめの側だけ評価の重みを差し替える（--policies smart,smart と合わせて、AI の改良を比べる）
// 見本デッキの組み合わせ（順序つき）ごとに、同じシードで方針を入れ替えた2試合を行い、1つめの方針の勝率を出す。
// マリガン以外（対戦中の手の選び方）は同じ AI。
import { readFileSync, readdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { STAGE2_WEIGHTS, type AiLevel, type AiOptions, type AiWeights } from '../src/ai';
import { buildCatalog } from '../src/catalog';
import type { MulliganPolicy } from '../src/mulligan';
import { playGame, type GameRecord } from '../src/sim';
import type { DeckDef, FactionFile } from '../src/types';

const DATA = join(import.meta.dirname, '..', '..', 'data');
const load = <T>(dir: string): T[] =>
  readdirSync(join(DATA, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DATA, dir, f), 'utf8')) as T);
const cat = buildCatalog(load<FactionFile>('cards'));
const decks = load<DeckDef>('decks');
{
  const i = process.argv.indexOf('--extra');
  const extra = i >= 0 ? process.argv[i + 1] : process.env.STATS_EXTRA;
  if (extra) {
    process.env.STATS_EXTRA = extra;
    for (const f of extra.split(',')) decks.push(JSON.parse(readFileSync(f, 'utf8')) as DeckDef);
  }
}

interface Job {
  seed: number;
  a: string;
  b: string;
  level: AiLevel;
  pa: MulliganPolicy;
  pb: MulliganPolicy;
  margin?: number;
  /** 1つめの方針（と AB_WEIGHTS）を使う側 */
  first: 'A' | 'B';
}

// 環境変数 AB_OPTS（JSON）: 1つめの側だけ AI の設定（rolloutRounds など）を差し替える
const abOpts = process.env.AB_OPTS ? (JSON.parse(process.env.AB_OPTS) as Partial<AiOptions>) : {};
const abWeights = process.env.AB_WEIGHTS ? { ...STAGE2_WEIGHTS, ...(JSON.parse(process.env.AB_WEIGHTS) as Partial<AiWeights>) } : undefined;

function run(j: Job): GameRecord & { job: Job } {
  const deck = (id: string) => decks.find((d) => d.id === id)!;
  const r = playGame(cat, { A: deck(j.a), B: deck(j.b) }, {
    seed: j.seed,
    levels: { A: j.level, B: j.level },
    ai: {
      A: { mulligan: j.pa, mulliganMargin: j.margin, timeLimitMs: 800, ...(abWeights && j.first === 'A' ? { weights: abWeights } : {}), ...(j.first === 'A' ? abOpts : {}) },
      B: { mulligan: j.pb, mulliganMargin: j.margin, timeLimitMs: 800, ...(abWeights && j.first === 'B' ? { weights: abWeights } : {}), ...(j.first === 'B' ? abOpts : {}) },
    },
  });
  return { ...r, job: j };
}

if (!isMainThread) {
  for (const j of workerData as Job[]) parentPort!.postMessage(run(j));
} else {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const games = Number(arg('games', '100'));
  const [p1, p2] = arg('policies', 'smart,cost').split(',') as MulliganPolicy[];
  const level = arg('level', 'normal') as AiLevel;
  const jobsN = Number(arg('jobs', String(cpus().length)));
  const margin = args.includes('--margin') ? Number(arg('margin', '1')) : undefined;
  const jobs: Job[] = [];
  let seed = Number(arg('seed', '900000'));
  for (const a of decks)
    for (const b of decks)
      for (let g = 0; g < games; g++) {
        jobs.push({ seed, a: a.id, b: b.id, level, pa: p1, pb: p2, margin, first: 'A' });
        jobs.push({ seed, a: a.id, b: b.id, level, pa: p2, pb: p1, margin, first: 'B' });
        seed++;
      }
  const chunks: Job[][] = Array.from({ length: jobsN }, () => []);
  jobs.forEach((j, i) => chunks[i % jobsN].push(j));
  const recs: (GameRecord & { job: Job })[] = [];
  const t0 = Date.now();
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL('./mulligan-ab-worker.mjs', import.meta.url), { workerData: chunk });
          w.on('message', (r: GameRecord & { job: Job }) => {
            recs.push(r);
            if (recs.length % 200 === 0) process.stderr.write(`${recs.length}/${jobs.length}\n`);
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );
  // 1つめの方針の側から見た結果
  const rows = recs.map((r) => {
    const side = r.job.first;
    const other = side === 'A' ? 'B' : 'A';
    return {
      deck: r.decks[side],
      opp: r.decks[other],
      win: r.winner === side ? 1 : r.winner === null ? 0.5 : 0,
      mull: [r.mulligans[side], r.mulligans[other]],
    };
  });
  const rate = (xs: typeof rows) => {
    const m = xs.reduce((s, x) => s + x.win, 0) / xs.length;
    const se = Math.sqrt((m * (1 - m)) / xs.length);
    return `${(m * 100).toFixed(1)}% ±${(se * 196).toFixed(1)}（${xs.length}試合）`;
  };
  const name = (id: string) => decks.find((d) => d.id === id)!.name.replace(/^見本: /, '');
  const lines = [`# マリガン ${p1}${margin !== undefined ? `（余裕 ${margin}）` : ''} 対 ${p2}（${level}）`, '', `${p1} の勝率: ${rate(rows)}`, ''];
  const avg = (i: 0 | 1) => (rows.reduce((s, x) => s + x.mull[i], 0) / rows.length).toFixed(2);
  lines.push(`戻した枚数の平均: ${p1} ${avg(0)} 枚 / ${p2} ${avg(1)} 枚`, '', `| デッキ | ${p1} で使ったときの勝率 | ${p2} で使ったときの勝率 | 差 |`, '|---|---|---|---|');
  // デッキごとの改善 = そのデッキを p1 で使ったときの勝率 − p2 で使ったときの勝率（相手は同じ）
  for (const d of decks) {
    const a = rows.filter((x) => x.deck === d.id);
    const b = rows.filter((x) => x.opp === d.id);
    const wa = a.reduce((s, x) => s + x.win, 0) / a.length;
    const wb = 1 - b.reduce((s, x) => s + x.win, 0) / b.length;
    lines.push(`| ${name(d.id)} | ${(wa * 100).toFixed(1)}% | ${(wb * 100).toFixed(1)}% | ${((wa - wb) * 100).toFixed(1)} |`);
  }
  lines.push('', `| ${p1} 側のデッキ ＼ 相手 | ${decks.map((d) => name(d.id)).join(' | ')} |`, `|---|${decks.map(() => '---|').join('')}`);
  for (const d of decks)
    lines.push(
      `| ${name(d.id)} | ${decks
        .map((o) => {
          const xs = rows.filter((x) => x.deck === d.id && x.opp === o.id);
          return `${((xs.reduce((s, x) => s + x.win, 0) / xs.length) * 100).toFixed(0)}%`;
        })
        .join(' | ')} |`,
    );
  lines.push('', `（${recs.length}試合、${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  console.log(lines.join('\n'));
}
