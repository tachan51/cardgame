// AI 同士の自動対戦を行い、集計を Markdown で出力する（タスク 4-3）
//   npx tsx scripts/stats.ts --games 30 --levels normal,normal --out ../docs/stats.md
//   --games N      組み合わせ（デッキの順序つきの組）ごとの試合数
//   --levels a,b   A と B の AI の強さ（easy / normal / hard）。「hard,normal」なら強さの比較にもなる
//   --swap         強さを入れ替えた試合も行う（強さの比較のとき、先手・デッキの偏りをなくす）
//   --jobs N       並列に動かす数（省略時は CPU の数）
//   --extra files  data/decks 以外のデッキ（JSON、カンマ区切り）も加えて総当たりにする
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { STAGE2_WEIGHTS, type AiLevel, type AiWeights } from '../src/ai';
import { buildCatalog } from '../src/catalog';
import { playGame, summarize, toMarkdown, type GameRecord } from '../src/sim';
import type { DeckDef, FactionFile } from '../src/types';

const DATA = join(import.meta.dirname, '..', '..', 'data');
const load = <T>(dir: string): T[] =>
  readdirSync(join(DATA, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DATA, dir, f), 'utf8')) as T);

const cat = buildCatalog(load<FactionFile>('cards'));
const decks = load<DeckDef>('decks');
// --extra a.json,b.json で、data/decks 以外のデッキも加えて総当たりにする
// （ワーカーには引数が渡らないので、環境変数 STATS_EXTRA でも受け取る）
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
  levels: { A: AiLevel; B: AiLevel };
}

// 環境変数 STATS_WEIGHTS（JSON）で、ふつう・つよいの評価の重みを一部差し替える（調整の実験用）
const weights = process.env.STATS_WEIGHTS ? { ...STAGE2_WEIGHTS, ...(JSON.parse(process.env.STATS_WEIGHTS) as Partial<AiWeights>) } : undefined;

function run(job: Job): GameRecord {
  const deck = (id: string) => decks.find((d) => d.id === id)!;
  const ai = (l: AiLevel) => ({ timeLimitMs: 800, ...(weights && l !== 'easy' ? { weights } : {}) });
  return playGame(cat, { A: deck(job.a), B: deck(job.b) }, { seed: job.seed, levels: job.levels, ai: { A: ai(job.levels.A), B: ai(job.levels.B) } });
}

if (!isMainThread) {
  const jobs = workerData as Job[];
  for (const j of jobs) parentPort!.postMessage(run(j));
} else {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const games = Number(arg('games', '20'));
  const [la, lb] = arg('levels', 'normal,normal').split(',') as AiLevel[];
  const swap = args.includes('--swap');
  const jobsN = Number(arg('jobs', String(cpus().length)));
  const out = arg('out', '');
  const title = arg('title', 'AI 同士の自動対戦の集計');

  const jobs: Job[] = [];
  let seed = Number(arg('seed', '1'));
  for (const a of decks)
    for (const b of decks)
      for (let g = 0; g < games; g++) {
        jobs.push({ seed: seed++, a: a.id, b: b.id, levels: { A: la, B: lb } });
        if (swap) jobs.push({ seed: seed++, a: a.id, b: b.id, levels: { A: lb, B: la } });
      }
  const chunks: Job[][] = Array.from({ length: jobsN }, () => []);
  jobs.forEach((j, i) => chunks[i % jobsN].push(j));
  const records: GameRecord[] = [];
  const t0 = Date.now();
  await Promise.all(
    chunks
      .filter((c) => c.length)
      .map(
        (chunk) =>
          new Promise<void>((resolve, reject) => {
            const w = new Worker(new URL('./stats-worker.mjs', import.meta.url), { workerData: chunk });
            w.on('message', (r: GameRecord) => {
              records.push(r);
              if (records.length % 20 === 0) process.stderr.write(`${records.length}/${jobs.length}\n`);
            });
            w.on('error', reject);
            w.on('exit', () => resolve());
          }),
      ),
  );
  const md = toMarkdown(cat, summarize(records, decks), decks, title) + `\n（${jobs.length}試合、${((Date.now() - t0) / 1000).toFixed(0)}秒、強さ ${la} / ${lb}${swap ? '（入れ替えあり）' : ''}）\n`;
  if (out) writeFileSync(out, md);
  else process.stdout.write(md);
}
