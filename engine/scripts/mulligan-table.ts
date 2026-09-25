// AI のマリガンに使う表（src/mulligan-table.json）を作る
//   npx tsx scripts/mulligan-table.ts --games 150 --extra-games 30
//
// 双方マリガンなし（ふつうの AI）で対戦し、「そのカードが初手の4枚にあった試合の勝率」が
// 同じ組み合わせ（デッキ・相手のデッキ・先手か後手か）の平均からどれだけずれたかを、相手の勢力ごとに求める。
// 試合数の少ないカードは 0 に寄せる（縮小推定）。
// 見本デッキに入っていないカードも表に載るように、調査用のデッキ（勢力の組ごとに乱数で組む）も混ぜる。
//   --games N        見本デッキ同士の組み合わせごとの試合数
//   --extra-games N  調査用のデッキが入る組み合わせごとの試合数
//   --random N       勢力の組ごとの調査用のデッキの数
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { buildCatalog, getLeader } from '../src/catalog';
import { DECK_SIZE, MAX_COPIES } from '../src/constants';
import type { MulliganTable } from '../src/mulligan';
import { playGame, type GameRecord } from '../src/sim';
import type { DeckDef, FactionFile, FactionId, PlayerId } from '../src/types';

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

/** 調査用のデッキ。見本デッキに入っていないカードを優先して、軽いカードが多めになるように乱数で組む */
function randomDecks(perPair: number): DeckDef[] {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const used = new Set(samples.flatMap((d) => d.cards.map((c) => c.id)));
  const leaders = [...cat.leaders.values()];
  const out: DeckDef[] = [];
  for (let i = 0; i < leaders.length; i++)
    for (let j = i + 1; j < leaders.length; j++)
      for (let k = 0; k < perPair; k++) {
        const fs = [leaders[i].faction, leaders[j].faction];
        const pool = [...cat.cards.values()].filter((c) => fs.includes(c.faction));
        // 使われていないカードは優先し、重いカードは入りにくくする
        const key = (c: (typeof pool)[number]) => rnd() * (used.has(c.id) ? 1 : 2) * (c.cost >= 6 ? 0.4 : c.cost >= 4 ? 0.8 : 1);
        const pick = pool.map((c) => ({ c, k: key(c) })).sort((a, b) => b.k - a.k);
        const cards: DeckDef['cards'] = [];
        let n = 0;
        for (const { c } of pick) {
          if (n >= DECK_SIZE) break;
          const count = Math.min(MAX_COPIES, DECK_SIZE - n);
          cards.push({ id: c.id, count });
          n += count;
        }
        out.push({ formatVersion: 1, id: `probe-${fs.join('-')}-${k + 1}`, name: `調査用 ${fs.join('+')} ${k + 1}`, leaders: [leaders[i].id, leaders[j].id], cards });
      }
  return out;
}

const decks = [...samples, ...randomDecks(Number(arg('random', '2')))];

interface Job {
  seed: number;
  a: string;
  b: string;
}

function run(job: Job): GameRecord {
  const deck = (id: string) => decks.find((d) => d.id === id)!;
  return playGame(cat, { A: deck(job.a), B: deck(job.b) }, { seed: job.seed, levels: { A: 'normal', B: 'normal' }, ai: { A: { mulligan: 'none' }, B: { mulligan: 'none' } } });
}

if (!isMainThread) {
  for (const j of workerData as Job[]) parentPort!.postMessage(run(j));
} else {
  const games = Number(arg('games', '150'));
  const extraGames = Number(arg('extra-games', '30'));
  const jobsN = Number(arg('jobs', String(cpus().length)));
  const shrink = Number(arg('shrink', '60'));
  const isSample = (id: string) => samples.some((d) => d.id === id);
  const jobs: Job[] = [];
  let seed = Number(arg('seed', '500000'));
  for (const a of decks)
    for (const b of decks) {
      const n = isSample(a.id) && isSample(b.id) ? games : extraGames;
      for (let g = 0; g < n; g++) jobs.push({ seed: seed++, a: a.id, b: b.id });
    }
  const chunks: Job[][] = Array.from({ length: jobsN }, () => []);
  jobs.forEach((j, i) => chunks[i % jobsN].push(j));
  const records: GameRecord[] = [];
  const t0 = Date.now();
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL('./mulligan-table-worker.mjs', import.meta.url), { workerData: chunk });
          w.on('message', (r: GameRecord) => {
            records.push(r);
            if (records.length % 200 === 0) process.stderr.write(`${records.length}/${jobs.length}\n`);
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );

  // 席ごとの結果（勝ち 1・引き分け 0.5・負け 0）
  const factionsOf = (deckId: string): FactionId[] => decks.find((d) => d.id === deckId)!.leaders.map((l) => getLeader(cat, l).faction);
  const seats = records.flatMap((r) =>
    (['A', 'B'] as PlayerId[]).map((p) => {
      const o: PlayerId = p === 'A' ? 'B' : 'A';
      return { deck: r.decks[p], opp: r.decks[o], first: r.first === p, win: r.winner === p ? 1 : r.winner === null ? 0.5 : 0, opening: r.opening[p] };
    }),
  );
  // 組み合わせ（デッキ・相手のデッキ・先手か後手か）ごとの平均
  const base = new Map<string, { s: number; n: number }>();
  const bkey = (x: (typeof seats)[number]) => `${x.deck}|${x.opp}|${x.first}`;
  for (const x of seats) {
    const b = base.get(bkey(x)) ?? { s: 0, n: 0 };
    b.s += x.win;
    b.n++;
    base.set(bkey(x), b);
  }
  // 相手の勢力 → カード → 平均からのずれの合計と試合数
  const acc = new Map<string, { s: number; n: number }>();
  for (const x of seats) {
    const b = base.get(bkey(x))!;
    const resid = x.win - b.s / b.n;
    for (const f of factionsOf(x.opp))
      for (const id of new Set(x.opening)) {
        const k = `${f}|${id}`;
        const a = acc.get(k) ?? { s: 0, n: 0 };
        a.s += resid;
        a.n++;
        acc.set(k, a);
      }
  }
  const table: MulliganTable = { version: 1, games: records.length, vs: {} };
  for (const [k, a] of [...acc.entries()].sort()) {
    const [f, id] = k.split('|') as [FactionId, string];
    (table.vs[f] ??= {})[id] = Math.round((a.s / (a.n + shrink)) * 1000) / 10;
  }
  writeFileSync(join(import.meta.dirname, '..', 'src', 'mulligan-table.json'), JSON.stringify(table, null, 1) + '\n');
  process.stderr.write(`${records.length}試合、${((Date.now() - t0) / 1000).toFixed(0)}秒\n`);
}
