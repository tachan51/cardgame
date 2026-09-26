// 調査用のデッキ（マリガンの表・手札の価値の表を作るときに、見本デッキに入っていないカードも使われるようにする）
import type { Catalog } from '../src/catalog';
import { DECK_SIZE, MAX_COPIES } from '../src/constants';
import type { DeckDef } from '../src/types';

/** 調査用のデッキ。見本デッキに入っていないカードを優先して、軽いカードが多めになるように乱数で組む */
export function probeDecks(cat: Catalog, samples: DeckDef[], perPair: number): DeckDef[] {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const used = new Set(samples.flatMap((d) => d.cards.map((c) => c.id)));
  const leaders = [...cat.leaders.values()];
  const out: DeckDef[] = [];
  for (let i = 0; i < leaders.length; i++)
    for (let j = i + 1; j < leaders.length; j++)
      for (let k = 0; k < perPair; k++) {
        const fs = [leaders[i].faction, leaders[j].faction];
        const pool = [...cat.cards.values()].filter((c) => fs.includes(c.faction) && !c.token);
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

