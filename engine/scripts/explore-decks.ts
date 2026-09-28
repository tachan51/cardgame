// いろいろなデッキを試して、すべてのカードの使用率と強さを調べる（カードリストの調整用）
//   npx tsx scripts/explore-decks.ts --decks 40 --games 2 --out ../docs/explore.md [--json out.json] [--extra a.json,b.json]
//
// 勢力の組ごとに --decks 個のデッキを乱数で組み（どのカードもなるべく同じくらい入るように）、
// 見本デッキ（と --extra のデッキ）それぞれと、先手・後手を入れ替えて --games 試合ずつ対戦する（ふつうの AI 同士）。
// 集計:
//   - カードごとの使用率（デッキに入っていた試合のうち、使った試合の割合）
//   - カードの強さ: 試合の勝ち負けを「デッキに入っている枚数」で説明する線形回帰（リッジ）の係数。1枚あたりの勝率の増減（ポイント）
//   - 勝率の高かったデッキ
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { buildCatalog, getCard, getLeader } from '../src/catalog';
import { DECK_SIZE, MAX_COPIES } from '../src/constants';
import { playGame, type GameRecord } from '../src/sim';
import type { DeckDef, FactionFile, PlayerId } from '../src/types';

const root = new URL('../../data/', import.meta.url);
const load = <T>(dir: string, names: string[]) => names.map((n) => JSON.parse(readFileSync(new URL(`${dir}/${n}`, root), 'utf8')) as T);
const cat = buildCatalog(load<FactionFile>('cards', ['knights.json', 'cyber.json', 'academy.json']));

interface Job {
  seed: number;
  a: DeckDef;
  b: DeckDef;
}

if (!isMainThread) {
  for (const j of workerData as Job[]) {
    const r = playGame(cat, { A: j.a, B: j.b }, { seed: j.seed, levels: { A: 'normal', B: 'normal' } });
    parentPort!.postMessage(r);
  }
} else {
  const args = process.argv.slice(2);
  const arg = (k: string, d: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : d;
  };
  const perPair = Number(arg('decks', '40'));
  const games = Number(arg('games', '2'));
  const jobsN = Number(arg('jobs', String(cpus().length)));
  const samples = load<DeckDef>('decks', ['sample-cyber-academy.json', 'sample-knights-academy.json', 'sample-knights-cyber.json']);
  const extra = arg('extra', '');
  if (extra) for (const f of extra.split(',')) samples.push(JSON.parse(readFileSync(f, 'utf8')) as DeckDef);

  // ---------------------------------------------------------------- デッキを組む
  let rs = Number(arg('seed', '777'));
  const rnd = () => ((rs = (rs * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const leaders = [...cat.leaders.values()];
  const decks: DeckDef[] = [];
  for (let i = 0; i < leaders.length; i++)
    for (let j = i + 1; j < leaders.length; j++) {
      const fs = [leaders[i].faction, leaders[j].faction];
      const pool = [...cat.cards.values()].filter((c) => fs.includes(c.faction) && !c.token);
      const used = new Map(pool.map((c) => [c.id, 0]));
      for (let k = 0; k < perPair; k++) {
        // あまり使っていないカードを優先し、軽いカードを多めにする（2〜3枚ずつ）
        const weight = (id: string) => {
          const cost = getCard(cat, id).cost;
          const curve = cost <= 2 ? 1.4 : cost <= 4 ? 1.0 : cost <= 6 ? 0.7 : 0.45;
          return curve / (1 + used.get(id)!);
        };
        const order = pool.map((c) => ({ id: c.id, key: Math.pow(rnd(), 1 / weight(c.id)) })).sort((a, b) => b.key - a.key);
        const cards: DeckDef['cards'] = [];
        let n = 0;
        for (const { id } of order) {
          if (n >= DECK_SIZE) break;
          const count = Math.min(rnd() < 0.6 ? MAX_COPIES : 2, DECK_SIZE - n);
          cards.push({ id, count });
          used.set(id, used.get(id)! + 1);
          n += count;
        }
        decks.push({ formatVersion: 1, id: `r-${fs.join('-')}-${k + 1}`, name: `${getLeader(cat, leaders[i].id).name}＋${getLeader(cat, leaders[j].id).name} ${k + 1}`, leaders: [leaders[i].id, leaders[j].id], cards });
      }
    }

  // ---------------------------------------------------------------- 対戦
  const jobs: Job[] = [];
  let seed = 1;
  for (const d of decks)
    for (const s of samples)
      for (let g = 0; g < games; g++) {
        jobs.push({ seed: seed++, a: d, b: s });
        jobs.push({ seed: seed++, a: s, b: d });
      }
  const chunks: Job[][] = Array.from({ length: jobsN }, () => []);
  jobs.forEach((j, i) => chunks[i % jobsN].push(j));
  const records: GameRecord[] = [];
  const t0 = Date.now();
  await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL('./explore-decks-worker.mjs', import.meta.url), { workerData: chunk });
          w.on('message', (r: GameRecord) => {
            records.push(r);
            if (records.length % 100 === 0) process.stderr.write(`${records.length}/${jobs.length}\n`);
          });
          w.on('error', reject);
          w.on('exit', () => resolve());
        }),
    ),
  );

  // ---------------------------------------------------------------- 集計
  const byId = new Map(decks.map((d) => [d.id, d]));
  type CardStat = { inDeck: number; used: number; winsUsed: number };
  const cs = new Map<string, CardStat>();
  const deckStat = new Map<string, { games: number; wins: number }>();
  // 回帰用の行: 調べたデッキの側から見た勝ち（1/0/0.5）、そのデッキの各カードの枚数、相手
  const rows: { y: number; x: Map<string, number>; opp: string }[] = [];
  for (const r of records) {
    for (const p of ['A', 'B'] as PlayerId[]) {
      const d = byId.get(r.decks[p]);
      if (!d) continue;
      const y = r.winner === p ? 1 : r.winner === null ? 0.5 : 0;
      const ds = deckStat.get(d.id) ?? { games: 0, wins: 0 };
      ds.games++;
      ds.wins += y;
      deckStat.set(d.id, ds);
      const played = new Set(r.plays.filter((x) => x.p === p).map((x) => x.card));
      for (const { id } of d.cards) {
        const c = cs.get(id) ?? { inDeck: 0, used: 0, winsUsed: 0 };
        c.inDeck++;
        if (played.has(id)) {
          c.used++;
          c.winsUsed += y;
        }
        cs.set(id, c);
      }
      rows.push({ y, x: new Map(d.cards.map((c) => [c.id, c.count])), opp: r.decks[p === 'A' ? 'B' : 'A'] });
    }
  }
  const beta = ridge(rows, 30);

  const names = (id: string) => getCard(cat, id).name;
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const lines: string[] = [];
  lines.push('# いろいろなデッキでの自動対戦（カードリスト v0.9）', '');
  lines.push(`勢力の組ごとに ${perPair} 個、合計 ${decks.length} 個のデッキを乱数で組み（どのカードも同じくらい入るように）、見本デッキ${samples.length}つと先手・後手を入れ替えて ${games} 試合ずつ対戦した（ふつう同士、${records.length} 試合）。`, '');
  lines.push('- 使用率 = そのカードがデッキに入っていた試合のうち、使った試合の割合');
  lines.push('- 強さ = 勝ち負けを、デッキに入っている枚数で説明する線形回帰（リッジ）の係数。1枚増やしたときの勝率の増減（ポイント）。相手のデッキの強さは別の項で取り除いている');
  lines.push('- 使った試合の勝率は、勝っているときに使いやすいカード（重いカードなど）ほど高く出る', '');
  for (const fac of ['knights', 'cyber', 'academy'] as const) {
    lines.push(`## ${cat.factions.get(fac)}`, '', '| カード | コスト | 入ったデッキの試合 | 使用率 | 使った試合の勝率 | 強さ（1枚あたり） |', '|---|---|---|---|---|---|');
    const ids = [...cat.cards.values()].filter((c) => c.faction === fac && !c.token).map((c) => c.id);
    for (const id of ids) {
      const c = cs.get(id) ?? { inDeck: 0, used: 0, winsUsed: 0 };
      const b = beta.get(id) ?? 0;
      lines.push(`| ${id} ${names(id)} | ${getCard(cat, id).cost} | ${c.inDeck} | ${pct(c.used, c.inDeck)} | ${pct(c.winsUsed, c.used)} | ${b >= 0 ? '+' : ''}${(b * 100).toFixed(1)} |`);
    }
    lines.push('');
  }
  const ranked = [...deckStat.entries()].map(([id, s]) => ({ d: byId.get(id)!, rate: s.wins / s.games, games: s.games })).sort((a, b) => b.rate - a.rate);
  lines.push('## 勝率の高かったデッキ（見本デッキとの対戦）', '', '| デッキ | 勝率 | 試合 | カード |', '|---|---|---|---|');
  for (const x of ranked.slice(0, 12)) {
    lines.push(`| ${x.d.name} | ${Math.round(x.rate * 100)}% | ${x.games} | ${x.d.cards.map((c) => `${names(c.id)}×${c.count}`).join('、')} |`);
  }
  lines.push('', `（${records.length}試合、${((Date.now() - t0) / 1000).toFixed(0)}秒）`, '');
  const md = lines.join('\n');
  const out = arg('out', '');
  if (out) writeFileSync(out, md);
  else process.stdout.write(md);
  const json = arg('json', '');
  if (json) writeFileSync(json, JSON.stringify({ beta: Object.fromEntries(beta), decks: ranked.map((x) => ({ ...x.d, rate: x.rate, games: x.games })) }, null, 1));
}

/** y ≒ 切片 + Σ 枚数×β + 相手の項 のリッジ回帰（カードの係数だけ返す） */
function ridge(rows: { y: number; x: Map<string, number>; opp: string }[], lambda: number): Map<string, number> {
  const feats = [...new Set(rows.flatMap((r) => [...r.x.keys()]))];
  const opps = [...new Set(rows.map((r) => r.opp))];
  const cols = ['(1)', ...feats, ...opps.map((o) => `opp:${o}`)];
  const idx = new Map(cols.map((c, i) => [c, i]));
  const n = cols.length;
  const A = Array.from({ length: n }, () => new Float64Array(n));
  const b = new Float64Array(n);
  for (const r of rows) {
    const v: [number, number][] = [[0, 1], ...[...r.x].map(([k, c]): [number, number] => [idx.get(k)!, c]), [idx.get(`opp:${r.opp}`)!, 1]];
    for (const [i, xi] of v) {
      b[i] += xi * r.y;
      for (const [j, xj] of v) A[i][j] += xi * xj;
    }
  }
  for (let i = 1; i < n; i++) A[i][i] += lambda;
  // ガウスの消去法
  const x = new Float64Array(n);
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return new Map(feats.map((f) => [f, x[idx.get(f)!]]));
}
