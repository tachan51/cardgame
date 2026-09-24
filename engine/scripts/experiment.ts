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
  /** 見本デッキの中身を差し替える（デッキID → 増減するカードと枚数） */
  decks?: Record<string, Record<string, number>>;
}

/** 学院のデッキのスペルを減らし、ユニットを増やす（ユニットの少なさが原因かを確かめる） */
const MORE_UNITS: Variant['decks'] = {
  'sample-cyber-academy': { 'AC-14': -2, 'CY-09': -2, 'AC-06': -1, 'CY-13': -1, 'AC-11': 3, 'AC-23': 2, 'AC-04': 1 },
  'sample-knights-academy': { 'AC-14': -2, 'AC-05': -2, 'AC-15': -1, 'AC-11': 1, 'AC-23': 2, 'KN-03': 2 },
};

const VARIANTS: Variant[] = [
  { name: '現在', note: 'data/ のまま（カードリスト v0.7）' },
  { name: 'E: 学院のデッキのユニットを増やす', note: '電脳＋学院・騎士団＋学院のスペル5〜6枚を、動く氷像・水の精霊などのユニットに入れ替える', decks: MORE_UNITS },
  { name: 'F: 遅延のスペルを強める', note: '火球 2→3ダメージ、軌道レーザー照準 3→2コスト、EMPグレネード 4→3コスト', cards: { 'CY-17': { cost: 2 }, 'CY-11': { cost: 3 } } },
  { name: 'E+F', note: 'E と F の両方', decks: MORE_UNITS, cards: { 'CY-17': { cost: 2 }, 'CY-11': { cost: 3 } } },
];

const DATA = join(import.meta.dirname, '..', '..', 'data');
const load = <T>(dir: string): T[] =>
  readdirSync(join(DATA, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(DATA, dir, f), 'utf8')) as T);
const baseDecks = load<DeckDef>('decks');
const decks = baseDecks;

function decksFor(v: Variant): DeckDef[] {
  return baseDecks.map((d) => {
    const diff = v.decks?.[d.id];
    if (!diff) return d;
    const counts = new Map(d.cards.map((c) => [c.id, c.count]));
    for (const [id, n] of Object.entries(diff)) counts.set(id, (counts.get(id) ?? 0) + n);
    const cards = [...counts.entries()].filter(([, n]) => n > 0).map(([id, count]) => ({ id, count }));
    return { ...d, cards };
  });
}

function catalogFor(v: Variant) {
  const files = load<FactionFile>('cards');
  for (const f of files) {
    for (const c of f.cards) Object.assign(c, v.cards?.[c.id] ?? {});
    v.leaders?.[f.leader.id]?.(f.leader);
    // 火球のダメージ（F）
    if (v.name.includes('F')) {
      const fire = f.cards.find((c) => c.id === 'AC-02');
      const dmg = (fire?.effects?.[0] as { effects?: { amount: number }[] } | undefined)?.effects?.[0];
      if (dmg) dmg.amount = 3;
    }
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
  const vd = decksFor(v);
  const out: GameRecord[] = [];
  let k = 0;
  for (const a of vd)
    for (const b of vd)
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
