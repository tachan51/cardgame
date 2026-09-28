// 強いデッキを探す（山登り）。出発点のデッキを少しずつ変え、相手のデッキたちへの勝率が上がった変更を残す
//   npx tsx scripts/climb-decks.ts --start a.json --opponents b.json,c.json --steps 8 --variants 6 --games 3 --out best.json
//
// 1手ごとに --variants 個の変えたデッキを作り、それぞれ相手のデッキと先手・後手を入れ替えて --games 試合ずつ対戦する（ふつう同士）。
// 今のデッキも同じ試合で測り直し、一番勝率の高いものを次の出発点にする。
// 変え方: 1種類のカードを抜いて、デッキにないカードを同じ枚数入れる（--beta の JSON があれば、強さの係数が高いカードほど入りやすい）。
// または、2種類のカードの間で1枚動かす
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import { buildCatalog, getCard, getLeader } from '../src/catalog';
import { MAX_COPIES } from '../src/constants';
import type { GameRecord } from '../src/sim';
import type { DeckDef, FactionFile } from '../src/types';

const root = new URL('../../data/', import.meta.url);
const cat = buildCatalog(['knights.json', 'cyber.json', 'academy.json'].map((n) => JSON.parse(readFileSync(new URL(`cards/${n}`, root), 'utf8')) as FactionFile));
const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};
const readDeck = (f: string) => JSON.parse(readFileSync(f, 'utf8')) as DeckDef;
let current = readDeck(arg('start', ''));
const opponents = arg('opponents', '').split(',').map(readDeck);
const steps = Number(arg('steps', '8'));
const variants = Number(arg('variants', '6'));
const games = Number(arg('games', '3'));
const jobsN = Number(arg('jobs', String(cpus().length)));
const beta: Record<string, number> = arg('beta', '') ? (JSON.parse(readFileSync(arg('beta', ''), 'utf8')) as { beta: Record<string, number> }).beta : {};
let rs = Number(arg('seed', '4242'));
const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pickW = <T>(items: T[], w: (x: T) => number): T => {
  const ws = items.map((x) => Math.max(1e-6, w(x)));
  let r = rnd() * ws.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) if ((r -= ws[i]) <= 0) return items[i];
  return items[items.length - 1];
};

const factions = current.leaders.map((l) => getLeader(cat, l).faction);
const pool = [...cat.cards.values()].filter((c) => factions.includes(c.faction) && !c.token).map((c) => c.id);

function mutate(d: DeckDef, n: number): DeckDef {
  const cards = d.cards.map((c) => ({ ...c }));
  if (rnd() < 0.7 || cards.length < 2) {
    // 1種類を抜いて、別のカードを入れる
    const out = pickW(cards, (c) => Math.exp(-(beta[c.id] ?? 0) * 30));
    const cand = pool.filter((id) => !cards.some((c) => c.id === id));
    const inId = pickW(cand, (id) => Math.exp((beta[id] ?? 0) * 30));
    out.id = inId;
  } else {
    // 1枚動かす
    const from = pickW(cards, () => 1);
    const to = pickW(cards.filter((c) => c !== from && c.count < MAX_COPIES), () => 1);
    if (to) {
      from.count--;
      to.count++;
    }
  }
  return { ...d, id: `${d.id.split('~')[0]}~${n}`, cards: cards.filter((c) => c.count > 0) };
}

async function evaluate(decks: DeckDef[]): Promise<number[]> {
  const jobs: { seed: number; a: DeckDef; b: DeckDef; k: number; side: 'A' | 'B' }[] = [];
  let seed = Math.floor(rnd() * 1e6);
  decks.forEach((d, k) => {
    // どのデッキも同じシードで測る
    let s = seed;
    for (const o of opponents)
      for (let g = 0; g < games; g++) {
        jobs.push({ seed: s++, a: d, b: o, k, side: 'A' });
        jobs.push({ seed: s++, a: o, b: d, k, side: 'B' });
      }
  });
  seed += 10000;
  const wins = decks.map(() => 0);
  const n = decks.map(() => 0);
  const chunks: (typeof jobs)[] = Array.from({ length: jobsN }, () => []);
  jobs.forEach((j, i) => chunks[i % jobsN].push(j));
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL('./explore-decks-worker.mjs', import.meta.url), { workerData: chunk.map(({ seed, a, b }) => ({ seed, a, b })) });
          let i = 0;
          w.on('message', (r: GameRecord) => {
            const j = chunk[i++];
            n[j.k]++;
            wins[j.k] += r.winner === j.side ? 1 : r.winner === null ? 0.5 : 0;
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );
  return wins.map((w, k) => w / n[k]);
}

const show = (d: DeckDef) => d.cards.map((c) => `${getCard(cat, c.id).name}×${c.count}`).join('、');
for (let step = 1; step <= steps; step++) {
  const cands = [current, ...Array.from({ length: variants }, (_, k) => mutate(current, step * 100 + k))];
  const rates = await evaluate(cands);
  let best = 0;
  rates.forEach((r, k) => {
    if (r > rates[best]) best = k;
  });
  process.stderr.write(`step ${step}: 今 ${(rates[0] * 100).toFixed(0)}% / 最良 ${(rates[best] * 100).toFixed(0)}%${best ? '（変更を採用）' : ''}\n`);
  current = cands[best];
}
const finalRate = (await evaluate([current]))[0];
process.stderr.write(`最終: ${(finalRate * 100).toFixed(1)}% ${show(current)}\n`);
const out = arg('out', '');
if (out) writeFileSync(out, JSON.stringify({ ...current, id: current.id.split('~')[0] }, null, 2) + '\n');
