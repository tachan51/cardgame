// 評価の重みを、自分のデッキと相手のデッキの組み合わせごとに変えたら勝率が上がるかを調べる（ai.md 10章）
//   npx tsx scripts/weights-tune.ts --seeds 20 [--extra a.json,b.json] --out result.md
// 自分のデッキ D（重みを変える側）× 相手のデッキ O（見本デッキ、ふつうの AI のまま）ごとに、
// 同じシード・同じ席で「重みを変えた D」と「変えない D」の試合を行い、勝率の差を出す（D が先手・後手の両方）。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { STAGE2_WEIGHTS, type AiWeights } from '../src/ai';
import { buildCatalog } from '../src/catalog';
import { playGame } from '../src/sim';
import type { DeckDef, FactionFile, PlayerId } from '../src/types';

const DATA = join(import.meta.dirname, '..', '..', 'data');
const load = <T>(dir: string): T[] =>
  readdirSync(join(DATA, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DATA, dir, f), 'utf8')) as T);
const cat = buildCatalog(load<FactionFile>('cards'));
const samples = load<DeckDef>('decks');
const mine = [...samples];
{
  const i = process.argv.indexOf('--extra');
  const extra = i >= 0 ? process.argv[i + 1] : process.env.STATS_EXTRA;
  if (extra) {
    process.env.STATS_EXTRA = extra;
    for (const f of extra.split(',')) mine.push(JSON.parse(readFileSync(f, 'utf8')) as DeckDef);
  }
}

type Mult = Partial<Record<keyof AiWeights, number>>;
/** 試す重みの変え方（段階2の重みに掛ける倍率） */
export const VARIANTS: { name: string; mult: Mult }[] = [
  { name: 'ライフ×1.5', mult: { life: 1.5, lowLife: 1.5 } },
  { name: 'ライフ×0.6', mult: { life: 0.6, lowLife: 0.6 } },
  { name: '攻撃力×1.4', mult: { attack: 1.4 } },
  { name: '体力×1.4', mult: { health: 1.4 } },
  { name: 'ユニット×2', mult: { unitBase: 2 } },
  { name: '手札×0.6', mult: { hand: 0.6, handCost: 0.6 } },
  { name: '手札×1.5', mult: { hand: 1.5, handCost: 1.5 } },
  { name: '予備マナ×0.3', mult: { reserve: 0.3 } },
  { name: '予備マナ×2', mult: { reserve: 2 } },
  { name: '成長×2', mult: { growth: 2 } },
];

function weightsOf(m: Mult): AiWeights {
  const w = { ...STAGE2_WEIGHTS } as AiWeights & Record<string, unknown>;
  for (const [k, x] of Object.entries(m)) (w as Record<string, number>)[k] = (STAGE2_WEIGHTS as unknown as Record<string, number>)[k] * (x as number);
  return w;
}

interface Job {
  seed: number;
  d: string;
  o: string;
  side: PlayerId;
  /** -1 は変えない重み */
  variant: number;
}

function run(j: Job): { job: Job; win: number } {
  const deck = (id: string) => mine.find((x) => x.id === id)!;
  const other: PlayerId = j.side === 'A' ? 'B' : 'A';
  const decks = { [j.side]: deck(j.d), [other]: deck(j.o) } as Record<PlayerId, DeckDef>;
  const ai = j.variant >= 0 ? { [j.side]: { weights: weightsOf(VARIANTS[j.variant].mult) } } : {};
  const r = playGame(cat, decks, { seed: j.seed, levels: { A: 'normal', B: 'normal' }, ai });
  return { job: j, win: r.winner === j.side ? 1 : r.winner === null ? 0.5 : 0 };
}

if (!isMainThread) {
  for (const j of workerData as Job[]) parentPort!.postMessage(run(j));
} else {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const seeds = Number(arg('seeds', '20'));
  const jobsN = Number(arg('jobs', String(cpus().length)));
  const jobs: Job[] = [];
  let seed = Number(arg('seed', '950000'));
  for (const d of mine)
    for (const o of samples)
      for (let k = 0; k < seeds; k++, seed++)
        for (const side of ['A', 'B'] as PlayerId[]) for (let v = -1; v < VARIANTS.length; v++) jobs.push({ seed, d: d.id, o: o.id, side, variant: v });
  const chunks: Job[][] = Array.from({ length: jobsN }, () => []);
  jobs.forEach((j, i) => chunks[i % jobsN].push(j));
  const res: { job: Job; win: number }[] = [];
  const t0 = Date.now();
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL('./weights-tune-worker.mjs', import.meta.url), { workerData: chunk });
          w.on('message', (r: { job: Job; win: number }) => {
            res.push(r);
            if (res.length % 500 === 0) process.stderr.write(`${res.length}/${jobs.length}\n`);
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );
  const key = (j: Job) => `${j.seed}|${j.d}|${j.o}|${j.side}`;
  const base = new Map(res.filter((r) => r.job.variant < 0).map((r) => [key(r.job), r.win]));
  const name = (id: string) => mine.find((x) => x.id === id)!.name.replace(/^見本: /, '');
  const cell = (v: number, d: string, o?: string) => {
    const xs = res.filter((r) => r.job.variant === v && r.job.d === d && (!o || r.job.o === o));
    const diffs = xs.map((r) => r.win - base.get(key(r.job))!);
    const m = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, diffs.length - 1));
    return { m: m * 100, se: (sd / Math.sqrt(diffs.length)) * 100 };
  };
  const fmt = (c: { m: number; se: number }) => `${c.m >= 0 ? '+' : ''}${c.m.toFixed(0)}${Math.abs(c.m) > 2 * c.se ? '*' : ''}`;
  const lines = [
    '# 重みを変えたときの勝率の差（ポイント。変えない場合との差、同じシード・同じ席）',
    '',
    `1マス: 自分のデッキ1つ × 相手の見本デッキ3つ × ${seeds}シード × 先手後手 = ${seeds * 6} 組。* は差が標準誤差の2倍より大きいもの`,
    '',
    `| 重みの変え方 | ${mine.map((d) => name(d.id)).join(' | ')} |`,
    `|---|${mine.map(() => '---|').join('')}`,
  ];
  VARIANTS.forEach((v, vi) => lines.push(`| ${v.name} | ${mine.map((d) => fmt(cell(vi, d.id))).join(' | ')} |`));
  lines.push('', '## 相手のデッキ別（自分のデッキ ＼ 相手）', '');
  VARIANTS.forEach((v, vi) => {
    lines.push(`### ${v.name}`, '', `| 自分 ＼ 相手 | ${samples.map((o) => name(o.id)).join(' | ')} |`, `|---|${samples.map(() => '---|').join('')}`);
    for (const d of mine) lines.push(`| ${name(d.id)} | ${samples.map((o) => fmt(cell(vi, d.id, o.id))).join(' | ')} |`);
    lines.push('');
  });
  lines.push(`（${res.length}試合、${((Date.now() - t0) / 1000).toFixed(0)}秒）`);
  const out = arg('out', '');
  if (out) writeFileSync(out, lines.join('\n') + '\n');
  else console.log(lines.join('\n'));
}
