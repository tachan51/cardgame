// AI 同士の自動対戦と集計（タスク 4-3）
import { chooseAction, type AiLevel, type AiOptions } from './ai';
import type { Catalog } from './catalog';
import { getCard, getLeader } from './catalog';
import { applyAction, newGame } from './engine';
import { playerToAct } from './legal';
import type { DeckDef, PlayerId } from './types';

export interface GameRecord {
  seed: number;
  decks: Record<PlayerId, string>;
  levels: Record<PlayerId, AiLevel>;
  /** 第1ラウンドの先手 */
  first: PlayerId;
  winner: PlayerId | null;
  reason: string;
  rounds: number;
  /** 使ったカード（プレイヤー・カード・ラウンド） */
  plays: { p: PlayerId; card: string; round: number }[];
  /** リーダーが成長したラウンド */
  growth: { p: PlayerId; leader: string; round: number }[];
  life: Record<PlayerId, number>;
  actions: number;
  thinkMs: Record<PlayerId, number>;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function playGame(
  cat: Catalog,
  decks: Record<PlayerId, DeckDef>,
  opts: { seed: number; levels: Record<PlayerId, AiLevel>; ai?: Partial<Record<PlayerId, AiOptions>>; maxActions?: number },
): GameRecord {
  let s = newGame(cat, decks, { seed: opts.seed });
  const think: Record<PlayerId, number> = { A: 0, B: 0 };
  let actions = 0;
  while (!s.result) {
    if (++actions > (opts.maxActions ?? 5000)) throw new Error(`seed ${opts.seed}: 終わらない試合`);
    const p = playerToAct(s)[0];
    const t = now();
    const { action } = chooseAction(cat, s, p, { level: opts.levels[p], seed: opts.seed * 7919 + actions, ...opts.ai?.[p] });
    think[p] += now() - t;
    s = applyAction(cat, s, action);
  }
  const first = s.log.find((e) => e.type === 'gameStart')!.firstPlayer as PlayerId;
  return {
    seed: opts.seed,
    decks: { A: decks.A.id, B: decks.B.id },
    levels: opts.levels,
    first,
    winner: s.result!.winner,
    reason: s.result!.reason,
    rounds: s.round,
    plays: s.log
      .filter((e) => e.type === 'playUnit' || e.type === 'castSpell')
      .map((e) => ({ p: e.player as PlayerId, card: e.card as string, round: e.round })),
    growth: s.log.filter((e) => e.type === 'grow').map((e) => ({ p: e.player as PlayerId, leader: e.leader as string, round: e.round })),
    life: { A: s.players.A.life, B: s.players.B.life },
    actions,
    thinkMs: think,
  };
}

// ---------------------------------------------------------------- 集計

export interface Rate {
  win: number;
  games: number;
}

const pct = (r: Rate) => (r.games ? `${((r.win / r.games) * 100).toFixed(0)}%` : '—');

export interface Summary {
  games: number;
  decks: Record<string, Rate>;
  matchups: Record<string, Record<string, Rate>>;
  first: Rate;
  levels: Record<string, Rate>;
  rounds: { avg: number; min: number; max: number; hist: Record<number, number> };
  reasons: Record<string, number>;
  cards: Record<string, { inDeckGames: number; plays: number; playedGames: number; playedWin: number; avgRound: number; byDeck: Record<string, { games: number; win: number }>; delta: number }>;
  leaders: Record<string, { games: number; grown: number; roundSum: number }>;
  thinkMsPerAction: Record<string, number>;
}

/** 引き分けは勝ち0.5として数える */
export function summarize(records: GameRecord[], decks: DeckDef[]): Summary {
  const deckById = new Map(decks.map((d) => [d.id, d]));
  const sum: Summary = {
    games: records.length,
    decks: {},
    matchups: {},
    first: { win: 0, games: 0 },
    levels: {},
    rounds: { avg: 0, min: Infinity, max: 0, hist: {} },
    reasons: {},
    cards: {},
    leaders: {},
    thinkMsPerAction: {},
  };
  const thinkTotals: Record<string, { ms: number; n: number }> = {};
  for (const g of records) {
    const result = (p: PlayerId): number => (g.winner === null ? 0.5 : g.winner === p ? 1 : 0);
    for (const p of ['A', 'B'] as const) {
      const q: PlayerId = p === 'A' ? 'B' : 'A';
      const r = result(p);
      const d = g.decks[p];
      const od = g.decks[q];
      sum.decks[d] ??= { win: 0, games: 0 };
      sum.decks[d].games += 1;
      sum.decks[d].win += r;
      sum.matchups[d] ??= {};
      sum.matchups[d][od] ??= { win: 0, games: 0 };
      sum.matchups[d][od].games += 1;
      sum.matchups[d][od].win += r;
      if (g.levels[p] !== g.levels[q]) {
        const k = `${g.levels[p]} 対 ${g.levels[q]}`;
        sum.levels[k] ??= { win: 0, games: 0 };
        sum.levels[k].games += 1;
        sum.levels[k].win += r;
      }
      // カード
      const deck = deckById.get(d);
      const played = new Set(g.plays.filter((x) => x.p === p).map((x) => x.card));
      for (const { id } of deck?.cards ?? []) {
        const c = (sum.cards[id] ??= { inDeckGames: 0, plays: 0, playedGames: 0, playedWin: 0, avgRound: 0, byDeck: {}, delta: 0 });
        c.inDeckGames += 1;
        if (played.has(id)) {
          c.playedGames += 1;
          c.playedWin += r;
          const bd = (c.byDeck[d] ??= { games: 0, win: 0 });
          bd.games += 1;
          bd.win += r;
        }
      }
      for (const x of g.plays) {
        if (x.p !== p) continue;
        const c = (sum.cards[x.card] ??= { inDeckGames: 0, plays: 0, playedGames: 0, playedWin: 0, avgRound: 0, byDeck: {}, delta: 0 });
        c.plays += 1;
        c.avgRound += x.round;
      }
      // リーダー
      for (const l of deck?.leaders ?? []) {
        const e = (sum.leaders[l] ??= { games: 0, grown: 0, roundSum: 0 });
        e.games += 1;
        const gr = g.growth.find((x) => x.p === p && x.leader === l);
        if (gr) {
          e.grown += 1;
          e.roundSum += gr.round;
        }
      }
      const t = (thinkTotals[g.levels[p]] ??= { ms: 0, n: 0 });
      t.ms += g.thinkMs[p];
      t.n += g.actions / 2;
    }
    sum.first.games += 1;
    sum.first.win += g.winner === null ? 0.5 : g.winner === g.first ? 1 : 0;
    sum.rounds.avg += g.rounds;
    sum.rounds.min = Math.min(sum.rounds.min, g.rounds);
    sum.rounds.max = Math.max(sum.rounds.max, g.rounds);
    sum.rounds.hist[g.rounds] = (sum.rounds.hist[g.rounds] ?? 0) + 1;
    sum.reasons[g.reason] = (sum.reasons[g.reason] ?? 0) + 1;
  }
  sum.rounds.avg /= records.length || 1;
  for (const c of Object.values(sum.cards)) {
    c.avgRound = c.plays ? c.avgRound / c.plays : 0;
    // デッキの強さの影響を除くため、そのデッキの勝率との差を平均する
    let diff = 0;
    let n = 0;
    for (const [d, bd] of Object.entries(c.byDeck)) {
      const deckRate = sum.decks[d].win / sum.decks[d].games;
      diff += bd.win - deckRate * bd.games;
      n += bd.games;
    }
    c.delta = n ? diff / n : 0;
  }
  for (const [k, t] of Object.entries(thinkTotals)) sum.thinkMsPerAction[k] = t.n ? t.ms / t.n : 0;
  return sum;
}

/** 集計を Markdown の表にする */
export function toMarkdown(cat: Catalog, sum: Summary, decks: DeckDef[], title = 'AI 同士の自動対戦の集計'): string {
  const name = (id: string) => decks.find((d) => d.id === id)?.name.replace(/^見本:\s*/, '') ?? id;
  const ids = decks.map((d) => d.id).filter((id) => sum.decks[id]);
  const out: string[] = [`# ${title}`, '', `試合数: ${sum.games}`, ''];
  out.push('## デッキの勝率', '', '| デッキ | 勝率 | 試合 |', '|---|---|---|');
  for (const id of ids) out.push(`| ${name(id)} | ${pct(sum.decks[id])} | ${sum.decks[id].games} |`);
  out.push('', '## 相性（行のデッキから見た勝率）', '', `| | ${ids.map(name).join(' | ')} |`, `|---|${ids.map(() => '---').join('|')}|`);
  for (const a of ids) out.push(`| ${name(a)} | ${ids.map((b) => (sum.matchups[a]?.[b] ? pct(sum.matchups[a][b]) : '—')).join(' | ')} |`);
  out.push('', '## 試合の流れ', '');
  out.push(`- 第1ラウンドの先手の勝率: ${pct(sum.first)}`);
  out.push(`- ラウンド数: 平均 ${sum.rounds.avg.toFixed(1)}（最短 ${sum.rounds.min}、最長 ${sum.rounds.max}）`);
  out.push(`- 決着: ${Object.entries(sum.reasons).map(([k, v]) => `${({ life: 'ライフ', deckOut: '山札切れ', draw: '引き分け' } as Record<string, string>)[k] ?? k} ${v}`).join('、')}`);
  const hist = Object.entries(sum.rounds.hist).sort((a, b) => Number(a[0]) - Number(b[0]));
  out.push(`- ラウンド数の分布: ${hist.map(([r, n]) => `${r}R:${n}`).join(' ')}`);
  if (Object.keys(sum.levels).length) {
    out.push('', '## AI の強さ', '', '| 組み合わせ | 前者の勝率 | 試合 |', '|---|---|---|');
    for (const [k, r] of Object.entries(sum.levels)) out.push(`| ${k} | ${pct(r)} | ${r.games} |`);
  }
  out.push('', '## リーダー', '', '| リーダー | 成長した試合 | 成長したラウンド（平均） |', '|---|---|---|');
  for (const [id, e] of Object.entries(sum.leaders)) {
    const l = getLeader(cat, id);
    out.push(`| ${l.name} | ${e.games ? ((e.grown / e.games) * 100).toFixed(0) : 0}%（${e.grown}/${e.games}） | ${e.grown ? (e.roundSum / e.grown).toFixed(1) : '—'} |`);
  }
  out.push(
    '',
    '## カード',
    '',
    '- 使用率 = 使った試合 ÷ デッキに入っていた試合',
    '- デッキ比 = 使った試合の勝率 − そのデッキ全体の勝率（ポイント）。大きいカードは強い、または勝っているときに使われやすい。小さいカードは弱い、または負けているときに使われやすい',
    '',
  );
  out.push('| カード | コスト | 使用率 | 1試合あたりの使用回数 | 使った試合の勝率 | デッキ比 | 使ったラウンド（平均） |', '|---|---|---|---|---|---|---|');
  const rows = Object.entries(sum.cards)
    .filter(([, c]) => c.inDeckGames > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  for (const [id, c] of rows) {
    const def = getCard(cat, id);
    out.push(
      `| ${id} ${def.name} | ${def.cost} | ${((c.playedGames / c.inDeckGames) * 100).toFixed(0)}% | ${(c.plays / c.inDeckGames).toFixed(2)} | ${c.playedGames ? pct({ win: c.playedWin, games: c.playedGames }) : '—'} | ${c.playedGames ? `${c.delta >= 0 ? '+' : ''}${(c.delta * 100).toFixed(0)}` : '—'} | ${c.plays ? c.avgRound.toFixed(1) : '—'} |`,
    );
  }
  out.push('', '## 思考時間（1手あたり）', '');
  for (const [k, v] of Object.entries(sum.thinkMsPerAction)) out.push(`- ${k}: ${v.toFixed(1)}ms`);
  return out.join('\n') + '\n';
}
