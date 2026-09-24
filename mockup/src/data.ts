// カードデータと見本デッキの読み込み（ビルド時に data/ から取り込む）
import type { CardDef, DeckDef, FactionFile, LeaderDef } from './types';

const factionModules = import.meta.glob<FactionFile>('../../data/cards/*.json', { eager: true, import: 'default' });
const deckModules = import.meta.glob<DeckDef>('../../data/decks/*.json', { eager: true, import: 'default' });

export interface Catalog {
  factions: { id: string; name: string }[];
  cards: Map<string, CardDef>;
  leaders: Map<string, LeaderDef>;
  sampleDecks: DeckDef[];
}

const FACTION_ORDER = ['knights', 'cyber', 'academy'];

export function buildCatalog(files: FactionFile[], decks: DeckDef[]): Catalog {
  const sorted = [...files].sort(
    (a, b) => FACTION_ORDER.indexOf(a.faction.id) - FACTION_ORDER.indexOf(b.faction.id),
  );
  const cards = new Map<string, CardDef>();
  const leaders = new Map<string, LeaderDef>();
  for (const f of sorted) {
    leaders.set(f.leader.id, f.leader);
    for (const c of f.cards) cards.set(c.id, c);
  }
  return {
    factions: sorted.map((f) => f.faction),
    cards,
    leaders,
    sampleDecks: [...decks].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export const catalog: Catalog = buildCatalog(Object.values(factionModules), Object.values(deckModules));

export function card(id: string): CardDef {
  const c = catalog.cards.get(id);
  if (!c) throw new Error(`カードが見つかりません: ${id}`);
  return c;
}

export function leader(id: string): LeaderDef {
  const l = catalog.leaders.get(id);
  if (!l) throw new Error(`リーダーが見つかりません: ${id}`);
  return l;
}

export function factionName(id: string): string {
  return catalog.factions.find((f) => f.id === id)?.name ?? id;
}
