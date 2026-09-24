// 調整の実験（タスク 4-4）: カードやルールを仮に変えて AI 同士で対戦させ、変える前と比べる
//   npx tsx scripts/experiment.ts --games 20 --out ../docs/experiments.md
// 実験の内容は下の VARIANTS に書く。data/ のファイルは変えない（読み込んだ後に書き換える）
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { buildCatalog } from '../src/catalog';
import { playGame, summarize, type GameRecord } from '../src/sim';
import type { CardDef, DeckDef, FactionFile, LeaderDef } from '../src/types';

interface Variant {
  name: string;
  note: string;
  cards?: Record<string, Partial<CardDef>>;
  leaders?: Record<string, (l: LeaderDef) => void>;
  startLife?: number;
}

const LEADER_PATCHES = {
  'leader-alto': (l: LeaderDef) => void (l.growth.threshold = 4),
  'leader-rei': (l: LeaderDef) => void (l.growth.threshold = 2),
  'leader-noel': (l: LeaderDef) => void (l.ability!.cost = 12),
};

const VARIANTS: Variant[] = [
  { name: '現在', note: 'data/ のまま' },
  { name: 'A: 軽い先制を弱める', note: 'CY-04 ストリートサムライ 3/2→2/2、KN-14 突撃騎兵 5/1→4/1', cards: { 'CY-04': { attack: 2 }, 'KN-14': { attack: 4 } } },
  {
    name: 'B: 学院の序盤を強める',
    note: 'AC-03 見習い魔法使い 1/1→1/2、AC-13 学院の石像 0/3→1/3、AC-12 結界術の教師 コスト4→3',
    cards: { 'AC-03': { health: 2 }, 'AC-13': { attack: 1 }, 'AC-12': { cost: 3 } },
  },
  { name: 'C: リーダーを成長しやすく', note: 'アルト 6→4回、レイ 4→2回、ノエルの能力 20→12', leaders: LEADER_PATCHES },
  { name: 'D: 初期ライフ25', note: '初期ライフ 20→25（試合を長くして重いカードを出せるように）', startLife: 25 },
  {
    name: 'A+B+C+D',
    note: 'A・B・C・D をすべて',
    cards: { 'CY-04': { attack: 2 }, 'KN-14': { attack: 4 }, 'AC-03': { health: 2 }, 'AC-13': { attack: 1 }, 'AC-12': { cost: 3 } },
    leaders: LEADER_PATCHES,
    startLife: 25,
  },
];

const DATA = join(import.meta.dirname, '..', '..', 'data');
const load = <T>(dir: string): T[] =>
  readdirSync(join(DATA, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DATA, dir, f), 'utf8')) as T);
const decks = load<DeckDef>('decks');

function catalogFor(v: Variant) {
  const files = load<FactionFile>('cards');
  for (const f of files) {
    for (const c of f.cards) Object.assign(c, v.cards?.[c.id] ?? {});
    v.leaders?.[f.leader.id]?.(f.leader);
  }
  return buildCatalog(files);
}

interface Job {
  variant: number;
  seeds: number[];
  games: number;
}

if (!isMainThread) {
  const job = workerData as Job;
  const v = VARIANTS[job.variant];
  const cat = catalogFor(v);
  const out: GameRecord[] = [];
  let k = 0;
  for (const a of decks)
    for (const b of decks)
      for (let g = 0; g < job.games; g++) out.push(playGame(cat, { A: a, B: b }, { seed: job.seeds[0] + k++, levels: { A: 'normal', B: 'normal' }, startLife: v.startLife }));
  parentPort!.postMessage(out);
} else {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
  const games = Number(arg('games', '20'));
  const out = arg('out', '');
  const t0 = Date.now();
  const results: GameRecord[][] = new Array(VARIANTS.length);
  const queue = VARIANTS.map((_, i) => i);
  const runOne = (i: number) =>
    new Promise<void>((resolve, reject) => {
      const w = new Worker(new URL('./experiment-worker.mjs', import.meta.url), { workerData: { variant: i, seeds: [1], games } satisfies Job });
      w.on('message', (r: GameRecord[]) => (results[i] = r));
      w.on('error', reject);
      w.on('exit', () => resolve());
    });
  const lanes = Array.from({ length: Math.min(cpus().length, queue.length) }, async () => {
    while (queue.length) await runOne(queue.shift()!);
  });
  await Promise.all(lanes);

  const name = (id: string) => decks.find((d) => d.id === id)!.name.replace(/^見本:\s*/, '');
  const lines = [
    '# 調整の実験',
    '',
    `AI（ふつう）同士で、デッキの組み合わせ（順序つき9通り）ごとに ${games} 試合、実験ごとに ${games * 9} 試合。同じシードで比べている。`,
    '',
    `| 実験 | 内容 | ${decks.map((d) => name(d.id)).join(' | ')} | 先手の勝率 | ラウンド数（平均） | アルト成長 | レイ成長 | ノエル成長 |`,
    `|---|---|${decks.map(() => '---').join('|')}|---|---|---|---|---|`,
  ];
  VARIANTS.forEach((v, i) => {
    const sum = summarize(results[i], decks);
    const pct = (w: number, g: number) => (g ? `${((w / g) * 100).toFixed(0)}%` : '—');
    const lead = (id: string) => {
      const e = sum.leaders[id];
      return e ? `${pct(e.grown, e.games)}${e.grown ? `（${(e.roundSum / e.grown).toFixed(1)}R）` : ''}` : '—';
    };
    lines.push(
      `| ${v.name} | ${v.note} | ${decks.map((d) => pct(sum.decks[d.id].win, sum.decks[d.id].games)).join(' | ')} | ${pct(sum.first.win, sum.first.games)} | ${sum.rounds.avg.toFixed(1)} | ${lead('leader-alto')} | ${lead('leader-rei')} | ${lead('leader-noel')} |`,
    );
  });
  lines.push('', `（${((Date.now() - t0) / 1000).toFixed(0)}秒）`, '');
  const md = lines.join('\n');
  if (out) writeFileSync(out, md);
  process.stdout.write(md);
}
