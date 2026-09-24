// カードデータの形（docs/card-data.md 3〜5章）と、ゲームの状態・アクションの型

// ---------------------------------------------------------------- カードデータ

export type FactionId = 'knights' | 'cyber' | 'academy';
export type Keyword = 'ranged' | 'pierce' | 'firstStrike' | 'shield' | 'mobile' | 'delay' | 'quick';
export const KEYWORDS: readonly Keyword[] = ['ranged', 'pierce', 'firstStrike', 'shield', 'mobile', 'delay', 'quick'];

export type Side = 'ally' | 'enemy' | 'any';
export type Row = 'front' | 'back';

export type TriggerType =
  | 'onPlay'
  | 'onDestroyed'
  | 'onMove'
  | 'onEnemyMove'
  | 'onAnyUnitMove'
  | 'onSpellCast'
  | 'onAllyEndureCombatDamage'
  | 'roundStart'
  | 'roundEnd'
  | 'combatStart'
  | 'combatEnd';

export type Condition =
  | { empty: boolean }
  | { row: Row }
  | { type: 'unit' | 'spell' }
  | { attackAtMost: number }
  | { healthAtMost: number }
  | { hasKeyword: Keyword }
  | { all: Condition[] }
  | { any: Condition[] };

export type CellOwnerSpec = 'ally' | 'enemy' | 'any' | { ownerOf: string } | { sameOwnerAs: string };

export interface TargetSpec {
  id: string;
  kind: 'unit' | 'cell' | 'lane' | 'unitOrPlayer' | 'cardInHand';
  side?: Side;
  count?: number;
  where?: Condition;
  cellOwner?: CellOwnerSpec;
  optional?: boolean;
}

export type LaneRef = number | { ref: string } | { laneOf: Selector } | 'all';

export type Selector =
  | { ref: string }
  | 'self'
  | 'eventUnit'
  | {
      units: {
        side?: Side;
        relative?: 'leftRight' | 'sameLaneOther';
        lane?: LaneRef;
        row?: Row;
        cardId?: string;
        where?: Condition;
        random?: number;
      };
    }
  | { cell: { owner: 'ally' | 'enemy'; lane: LaneRef; row: Row } }
  | { cellsRelative: 'leftRight' }
  | 'enemyPlayer'
  | 'allyPlayer';

export type Value =
  | number
  | { attackOf: Selector; ifGone?: number }
  | { count: 'spellsCastThisGame' }
  | { max: Value; cap: number };

export type Duration = 'permanent' | 'thisRound';

export type Effect =
  | { op: 'damage'; target: Selector; amount: Value; times?: number }
  | { op: 'destroy'; target: Selector }
  | { op: 'exile'; target: Selector }
  | { op: 'heal'; target: Selector; amount: Value }
  | { op: 'buff'; target: Selector; attack?: Value; health?: Value; duration: Duration }
  | { op: 'grantKeyword'; target: Selector; keywords: Keyword[]; duration: Duration }
  | { op: 'move'; target: Selector; to: Selector }
  | { op: 'moveToOtherRow'; target: Selector }
  | { op: 'swapCells'; a: Selector; b: Selector }
  | { op: 'returnToHand'; target: Selector }
  | { op: 'summon'; cardId: string; at: Selector }
  | { op: 'draw'; count: Value }
  | { op: 'drawUntil'; handSize: number }
  | { op: 'lookAtTopPickOne'; look: number }
  | { op: 'tutorRandom'; where: Condition; count: number }
  | { op: 'generate'; cardId: string; count?: number }
  | { op: 'generateFromCastSpells'; count: number; distinctNames: boolean }
  | { op: 'gainReserve'; amount: Value }
  | { op: 'refillMana' }
  | { op: 'fight'; a: Selector; b: Selector }
  | { op: 'resolveCombat'; lanes: LaneRef }
  | { op: 'modifyCost'; target: Selector; amount: number }
  | { op: 'modifyLeaderAbilityCost'; amount: number }
  | { op: 'reveal'; target: Selector }
  | { op: 'delay'; effects: Effect[] }
  | { op: 'atRoundEnd'; effects: Effect[] }
  | { op: 'if'; condition: Condition; subject: Selector; then: Effect[]; else?: Effect[] }
  | { op: 'forEach'; targets: Selector; effects: Effect[] };

export type EffectOp = Effect['op'];

export interface StaticModifier {
  target: Selector;
  attack?: number;
  health?: number;
  keywords?: Keyword[];
  enhanceCost?: number;
  spellCost?: number;
}

export type Ability =
  | { kind: 'trigger'; when: TriggerType; condition?: Condition; targets?: TargetSpec[]; effects: Effect[] }
  | { kind: 'static'; modifiers: StaticModifier[] }
  | { kind: 'activated'; cost: number; targets?: TargetSpec[]; effects: Effect[] }
  | { kind: 'inHand'; when: TriggerType; effects: Effect[] };

export interface Enhance {
  cost: number;
  mode: 'add' | 'replace';
  appliesTo?: 'effects' | number;
  targets?: TargetSpec[];
  effects: Effect[];
}

export interface CardDef {
  id: string;
  name: string;
  faction: FactionId;
  type: 'unit' | 'spell';
  cost: number;
  attack?: number;
  health?: number;
  keywords?: Keyword[];
  targets?: TargetSpec[];
  effects?: Effect[];
  abilities?: Ability[];
  enhance?: Enhance;
  text: string;
}

export interface LeaderAbility {
  name: string;
  cost: number;
  targets?: TargetSpec[];
  effects: Effect[];
}

export type GrowthCounter = 'allyEnduredCombatDamage' | 'enemyMoved' | 'leaderAbilityUsed';

export interface LeaderDef {
  id: string;
  name: string;
  title: string;
  faction: FactionId;
  ability?: LeaderAbility;
  passives?: Ability[];
  growth: { counter: GrowthCounter; threshold: number };
  grown: { ability?: LeaderAbility; passives?: Ability[] };
  text: string;
}

export interface FactionFile {
  formatVersion: number;
  faction: { id: FactionId; name: string };
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

// ---------------------------------------------------------------- ゲームの状態

export type PlayerId = 'A' | 'B';
export const PLAYERS: readonly PlayerId[] = ['A', 'B'];

/** 手札・山札・トラッシュ・除外ゾーンにあるカード */
export interface CardInstance {
  uid: number;
  cardId: string;
  /** 手札にある間のコストの増減（累積。手札を離れると 0 に戻す） */
  costMod: number;
  /** 手札で公開されているか */
  revealed: boolean;
  /** 効果で生成したカードか（記録用） */
  generated: boolean;
}

/** 盤面のユニット */
export interface Unit {
  uid: number;
  cardId: string;
  owner: PlayerId;
  /** 効果で出したユニット（盤面を離れると消える） */
  isToken: boolean;
  generated: boolean;
  /** 受けているダメージのうち、永続の体力が受け止めた分 */
  damage: number;
  /** 一時的な体力（このラウンド中の強化）が受け止めたダメージ。ラウンドの終わりに消える（10.4） */
  tempDamage: number;
  attackPerm: number;
  healthPerm: number;
  attackTemp: number;
  healthTemp: number;
  keywordsPerm: Keyword[];
  keywordsTemp: Keyword[];
  shield: boolean;
  /** 機動をこのラウンドに使ったか */
  mobileUsed: boolean;
  /** このラウンドに使った起動能力の番号（abilities の添字） */
  activatedUsed: number[];
}

export interface LeaderState {
  id: string;
  grown: boolean;
  /** 成長条件の進み具合 */
  progress: number;
  usedThisRound: boolean;
  /** リーダー能力のコストの増減（試合を通して累積） */
  costMod: number;
}

/** 使うときに選んだ対象 */
export type TargetValue =
  | { kind: 'unit'; uid: number }
  | { kind: 'cell'; p: PlayerId; i: number }
  | { kind: 'lane'; lane: number }
  | { kind: 'player'; p: PlayerId }
  | { kind: 'card'; uid: number };

export type Targets = Record<string, TargetValue[]>;

/** 効果を処理するときの文脈 */
export interface EffectContext {
  controller: PlayerId;
  /** 効果の出どころ */
  source: { kind: 'card' | 'unit' | 'leader' | 'hand'; cardId: string; uid?: number; leader?: number };
  /** 「このユニット」（self） */
  selfUid?: number;
  /** 遅延を予約したときの self のレーン（laneOf self を予約時に固定する。card-data.md 6.5） */
  selfLane?: number;
  /** self のいたマス（破壊時の効果などで self がもういないとき用） */
  selfCell?: number;
  eventUid?: number;
  targets: Targets;
}

export interface DelayedEntry {
  id: number;
  owner: PlayerId;
  cardId: string;
  /** スペルのとき、遅延ゾーンに置いたカード */
  card?: CardInstance;
  sourceKind: 'spell' | 'unit' | 'activated' | 'leader';
  enhanced: boolean;
  effects: Effect[];
  ctx: EffectContext;
  /** 予約した順番 */
  order: number;
}

export interface RoundEndEntry {
  effects: Effect[];
  ctx: EffectContext;
}

export interface PlayerState {
  life: number;
  maxMana: number;
  mana: number;
  reserve: number;
  /** 前のラウンドの終了時に記録した使い残しの通常マナ（6.4） */
  unusedMana: number;
  /** この試合で使ったスペルの枚数 */
  spellsCast: number;
  /** この試合で使ったスペルのカードID（使った順） */
  castSpellIds: string[];
  leaders: LeaderState[];
  /** 山札。添字 0 が一番上 */
  deck: CardInstance[];
  hand: CardInstance[];
  trash: CardInstance[];
  exile: CardInstance[];
  /** 盤面。添字 = (レーン-1)*2 + (前列0 / 後列1)。盤面の順番（5.3）と同じ */
  board: (Unit | null)[];
  mulliganDone: boolean;
}

export type Phase = 'mulligan' | 'action' | 'gameOver';

export interface GameResult {
  winner: PlayerId | null;
  reason: 'life' | 'deckOut' | 'draw';
}

/** 効果の処理中に選択が必要になったとき（山札の上から見て1枚選ぶなど） */
export interface PendingChoice {
  player: PlayerId;
  kind: 'pickCard';
  /** 選べるカード（見たカード） */
  options: { uid: number; cardId: string }[];
  /** 選択を待っているアクション */
  action: Action;
  /** これまでの選択 */
  answers: number[];
  /** アクションを行う前の状態（選択を受けたら、ここから答えつきでやり直す） */
  before: GameState;
}

export interface LogEntry {
  round: number;
  type: string;
  [key: string]: unknown;
}

export interface GameState {
  version: 1;
  phase: Phase;
  round: number;
  /** そのラウンドの先手トークンを持つプレイヤー */
  firstPlayer: PlayerId;
  /** 行動権を持つプレイヤー */
  activePlayer: PlayerId;
  /** 続けてパスした回数 */
  passStreak: number;
  players: Record<PlayerId, PlayerState>;
  delayed: DelayedEntry[];
  roundEnd: RoundEndEntry[];
  result: GameResult | null;
  pending: PendingChoice | null;
  seed: number;
  rngState: number;
  nextUid: number;
  nextOrder: number;
  /** 行動フェイズに行ったアクションの数（このラウンド） */
  actionsThisRound: number;
  log: LogEntry[];
}

// ---------------------------------------------------------------- アクション

export type Action =
  | { type: 'mulligan'; player: PlayerId; cards: number[] }
  | {
      type: 'playUnit';
      player: PlayerId;
      card: number;
      cell: number;
      enhance?: boolean;
      /** 配置時の効果の対象 */
      targets?: Targets;
    }
  | { type: 'castSpell'; player: PlayerId; card: number; enhance?: boolean; targets?: Targets }
  | { type: 'advance'; player: PlayerId; cell: number }
  | { type: 'mobileMove'; player: PlayerId; unit: number; to: number }
  | { type: 'activate'; player: PlayerId; unit: number; ability: number; targets?: Targets }
  | { type: 'leaderAbility'; player: PlayerId; leader: number; targets?: Targets }
  | { type: 'pass'; player: PlayerId }
  | { type: 'choose'; player: PlayerId; option: number };

export type ActionType = Action['type'];
