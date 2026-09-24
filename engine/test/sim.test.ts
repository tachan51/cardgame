// AI 同士の自動対戦と集計（4-3）
import { describe, expect, it } from 'vitest';
import { playGame, summarize, toMarkdown } from '../src/sim';
import { cat, decks } from './helpers';

describe('自動対戦の集計', () => {
  it('試合の記録を集計して Markdown にできる', { timeout: 120_000 }, () => {
    const records = [0, 1, 2, 3].map((g) =>
      playGame(cat, { A: decks[g % 3], B: decks[(g + 1) % 3] }, { seed: 300 + g, levels: { A: 'normal', B: g % 2 ? 'easy' : 'normal' } }),
    );
    for (const r of records) {
      expect(['A', 'B', null]).toContain(r.winner);
      expect(r.rounds).toBeGreaterThan(0);
      expect(r.plays.length).toBeGreaterThan(0);
    }
    const sum = summarize(records, decks);
    expect(sum.games).toBe(4);
    const total = Object.values(sum.decks).reduce((a, d) => a + d.games, 0);
    expect(total).toBe(8);
    expect(sum.levels['normal 対 easy'].games).toBe(2);
    const md = toMarkdown(cat, sum, decks);
    expect(md).toContain('## デッキの勝率');
    expect(md).toContain('## カード');
  });
});
