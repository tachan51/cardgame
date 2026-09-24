// 手動モックアップの型定義（docs/mockup.md 9.1）
// ルールエンジンの状態とは別物で、手で動かすための最小限の情報だけを持つ。

export type PlayerId = 'A' | 'B';
export type Keyword = 'ranged' | 'pierce' | 'firstStrike' | 'shield' | 'mobile' | 'delay' | 'quick';

export const KEYWORD_LABEL: Record<Keyword, string> = {
  ranged: '射撃',
  pierce: '貫通',
  firstStrike: '先制',
  shield: '盾',
  mobile: '遊撃',
  delay: '遅延',
  quick: '即効',
};

// カードデータ（data/cards/*.json）のうち、モックアップで使う項目だけ
export interface CardDef {
  id: string;
  name: string;
  faction: string;
  type: 'unit' | 'spell';
  cost: number;
  attack?: number;
  health?: number;
  keywords?: Keyword[];
  text: string;
}

export interface LeaderAbilityDef {
  name: string;
  cost: number;
}

export interface LeaderDef {
  id: string;
  name: string;
  title: string;
  faction: string;
  ability?: LeaderAbilityDef;
  grown: { ability?: LeaderAbilityDef };
  growth: { counter: string; threshold: number };
  text: string;
}

export interface FactionFile {
  formatVersion: number;
  faction: { id: string; name: string };
  leader: LeaderDef;
  cards: CardDef[];
}

export interface DeckDef {
  formatVersion?: number;
  id: string;
  name: string;
  description?: string;
  leaders: string[];
  cards: { id: string; count: number }[];
}

export interface CardInstance {
  uid: string;
  cardId: string;
  costMod: number; // 手札にある間のコスト変化
  revealed: boolean; // 公開中
  generated: boolean; // 生成したカード
}

export interface Unit extends CardInstance {
  attackMod: number; // 永続の攻撃力の増減
  healthMod: number; // 永続の体力の増減
  damage: number; // 受けているダメージ
  tempAttack: number; // このラウンド中の攻撃力の増減
  tempHealth: number; // このラウンド中の体力の増減
  keywordsAdded: Keyword[]; // 付与されたキーワード（永続）
  tempKeywords: Keyword[]; // このラウンド中のキーワード
  shield: boolean; // 盾を持っているか
  markers: string[];
  memo: string;
  isToken: boolean; // 効果で出したユニット
}

export interface LeaderState {
  leaderId: string;
  grown: boolean;
  progress: number;
  usedThisRound: boolean;
  abilityCostMod: number;
}

export interface DelayedEntry {
  uid: string;
  cardId: string;
  note: string;
  round: number;
  card: CardInstance | null; // スペルなら発動後にトラッシュへ送るカード
}

export interface PlayerState {
  deckName: string;
  life: number;
  maxMana: number;
  mana: number;
  reserve: number;
  unusedMana: number;
  spellsCast: number;
  leaders: LeaderState[];
  deck: CardInstance[]; // 先頭が山札の一番上
  hand: CardInstance[];
  trash: CardInstance[];
  exile: CardInstance[];
  delayed: DelayedEntry[];
  board: (Unit | null)[]; // 8マス。盤面の順番: 1前, 1後, 2前, 2後, ...
  cellNotes: string[]; // マスに付ける予告の印
}

export interface LogEntry {
  time: string;
  round: number;
  player: PlayerId | null;
  text: string;
}

export interface Settings {
  autoPay: boolean; // 手札からカードを出したとき、通常マナから自動でコストを引く
  viewPlayer: PlayerId; // 画面の下側に表示するプレイヤー
  hideOpponentHand: boolean;
}

export interface GameState {
  version: 1;
  phase: 'setup' | 'mulligan' | 'playing';
  round: number;
  firstPlayer: PlayerId;
  activePlayer: PlayerId;
  passStreak: number;
  players: Record<PlayerId, PlayerState>;
  log: LogEntry[];
  seed: number;
  rngState: number;
  nextUid: number;
  mulligan: Record<PlayerId, { selected: string[]; done: boolean }>;
  settings: Settings;
}

// 盤面のマス番号（0〜7）とレーン・列の対応
export const CELL_COUNT = 8;
export function cellIndex(lane: number, row: 'front' | 'back'): number {
  return lane * 2 + (row === 'front' ? 0 : 1);
}
export function cellLabel(index: number): string {
  const lane = Math.floor(index / 2) + 1;
  return `${lane}${index % 2 === 0 ? '前' : '後'}`;
}
export function other(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}
