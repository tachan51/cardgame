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
  /** 見本デッキの中身をまるごと置き換える（デッキID → カードと枚数） */
  replaceDecks?: Record<string, Record<string, number>>;
  /** AI の強さ（省略時はふつう） */
  level?: 'easy' | 'normal' | 'hard';
}

/** ユーザーが提案した電脳＋学院のデッキ（スペル中心） */
const USER_CYBER_ACADEMY: Record<string, number> = {
  'AC-01': 3, 'AC-07': 3, 'AC-13': 3, 'AC-02': 3, 'AC-04': 3, 'AC-05': 3, 'CY-09': 3, 'CY-13': 3,
  'AC-08': 3, 'AC-15': 3, 'AC-23': 3, 'CY-15': 3, 'CY-17': 2, 'AC-10': 2,
};


const VARIANTS: Variant[] = [
  { name: '現在（ふつう）', note: 'data/ の見本デッキ' },
  { name: '提案デッキ（ふつう）', note: '電脳＋学院を提案のデッキ（スペル中心）に置き換え', replaceDecks: { 'sample-cyber-academy': USER_CYBER_ACADEMY } },
  { name: '現在（つよい）', note: 'data/ の見本デッキ', level: 'hard' },
  { name: '提案デッキ（つよい）', note: '電脳＋学院を提案のデッキに置き換え', replaceDecks: { 'sample-cyber-academy': USER_CYBER_ACADEMY }, level: 'hard' },
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
    const whole = v.replaceDecks?.[d.id];
    if (whole) return { ...d, cards: Object.entries(whole).map(([id, count]) => ({ id, count })) };
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
    if (v.name.startsWith('F') || v.name.includes('+F')) {
      const fire = f.cards.find((c) => c.id === 'AC-02');
      const dmg = (fire?.effects?.[0] as { effects?: { amount: number }[] } | undefined)?.effects?.[0];
      if (dmg) dmg.amount = 3;
    }
  }
  return buildCatalog(files);
}

/** 1試合ぶんの仕事（ワーカーに分けて並列に動かす） */
interface Job {
  variant: number;
  a: number;
  b: number;
  seed: number;
}

if (!isMainThread) {
  const jobs = workerData as Job[];
  const cache = new Map<number, { cat: ReturnType<typeof catalogFor>; decks: DeckDef[] }>();
  for (const j of jobs) {
    const v = VARIANTS[j.variant];
    let c = cache.get(j.variant);
    if (!c) cache.set(j.variant, (c = { cat: catalogFor(v), decks: decksFor(v) }));
    const lv = v.level ?? 'normal';
    const r = playGame(c.cat, { A: c.decks[j.a], B: c.decks[j.b] }, { seed: j.seed, levels: { A: lv, B: lv }, startLife: v.startLife, ai: { A: { timeLimitMs: 800 }, B: { timeLimitMs: 800 } } });
    parentPort!.postMessage({ variant: j.variant, record: r });
  }
} else {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
  const games = Number(arg('games', '20'));
  /** つよいは遅いので、試合数を別に指定できる */
  const hardGames = Number(arg('hard-games', String(Math.max(1, Math.round(games / 3)))));
  const out = arg('out', '');
  const only = arg('only', '');
  const t0 = Date.now();
  const results: GameRecord[][] = VARIANTS.map(() => []);
  const jobs: Job[] = [];
  VARIANTS.forEach((v, vi) => {
    if (only && !only.split(',').includes(String(vi))) return;
    const n = v.level === 'hard' ? hardGames : games;
    let seed = 1;
    for (let a = 0; a < baseDecks.length; a++) for (let b = 0; b < baseDecks.length; b++) for (let g = 0; g < n; g++) jobs.push({ variant: vi, a, b, seed: seed++ });
  });
  const lanes = Math.min(cpus().length, jobs.length);
  const chunks: Job[][] = Array.from({ length: lanes }, () => []);
  jobs.forEach((j, i) => chunks[i % lanes].push(j));
  let done = 0;
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL('./experiment-worker.mjs', import.meta.url), { workerData: chunk });
          w.on('message', (m: { variant: number; record: GameRecord }) => {
            results[m.variant].push(m.record);
            if (++done % 50 === 0) process.stderr.write(`${done}/${jobs.length}\n`);
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );

  const name = (id: string) => decks.find((d) => d.id === id)!.name.replace(/^見本:\s*/, '');
  const lines = [
    '# 調整の実験',
    '',
    `AI 同士（実験名に書いた強さ）で、デッキの組み合わせ（順序つき9通り）ごとに ふつう ${games} 試合・つよい ${hardGames} 試合。同じシードで比べている。`,
    '',
    `| 実験 | 内容 | ${decks.map((d) => name(d.id)).join(' | ')} | 先手の勝率 | ラウンド数（平均） | アルト成長 | レイ成長 | ノエル成長 |`,
    `|---|---|${decks.map(() => '---').join('|')}|---|---|---|---|---|`,
  ];
  VARIANTS.forEach((v, i) => {
    if (!results[i].length) return;
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
