// ルールエンジンの公開 API
export * from './types';
export * from './constants';
export { buildCatalog, validateDeck, getCard, getLeader, CatalogError } from './catalog';
export type { Catalog } from './catalog';
export { newGame, applyAction, emptyState } from './engine';
export type { NewGameOptions } from './engine';
export { legalActions, playerToAct } from './legal';
export type { LegalOptions } from './legal';
export { publicView, previewCombat } from './view';
export type { CombatPreview } from './view';
export { IllegalAction, Runner } from './runner';
export { cellIndex, cellName, parseCellName, laneOf, rowOf, opponent } from './board';
