// カードデータと見本デッキを読み込む（ビルド時に JS に組み込まれる）
import { buildCatalog, type DeckDef, type FactionFile } from '../../engine/src';

const factionModules = import.meta.glob<FactionFile>('../../data/cards/*.json', { eager: true, import: 'default' });
const deckModules = import.meta.glob<DeckDef>('../../data/decks/*.json', { eager: true, import: 'default' });

export const factions = Object.keys(factionModules)
  .sort()
  .map((k) => factionModules[k]);
export const cat = buildCatalog(factions);
export const decks: DeckDef[] = Object.values(deckModules).sort((a, b) => a.id.localeCompare(b.id));

export function deckById(id: string): DeckDef | undefined {
  return decks.find((d) => d.id === id);
}
