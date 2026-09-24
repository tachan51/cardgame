// テスト用: data/ からカードとデッキを読み込む
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog } from '../src/catalog';
import type { DeckDef, FactionFile } from '../src/types';

const DATA = join(import.meta.dirname, '..', '..', 'data');

export function loadFactions(): FactionFile[] {
  const dir = join(DATA, 'cards');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as FactionFile);
}

export function loadDecks(): DeckDef[] {
  const dir = join(DATA, 'decks');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as DeckDef);
}

export const cat = buildCatalog(loadFactions());
export const decks = loadDecks();
export function deck(id: string): DeckDef {
  const d = decks.find((x) => x.id === id);
  if (!d) throw new Error(id);
  return d;
}
