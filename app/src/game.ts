// 試合の進行: 人間（A）の操作を適用し、AI（B）の番なら少し待ってから AI の手を1手ずつ適用する。
// 観戦（AI 同士の対戦）では A も AI が操作し、一時停止・1手ずつ進める・速さの変更ができる
import { applyAction, chooseAction, newGame, playerToAct, type Action, type AiLevel, type DeckDef, type GameState, type PlayerId } from '../../engine/src';
import { cat } from './data';
import { AI, HUMAN } from './text';

const SAVE_KEY = 'cardgame-play-v1';
export const AI_DELAY_MS = 800;

export interface Match {
  state: GameState;
  decks: { human: DeckDef; ai: DeckDef };
  /** 直前に AI が行ったアクション（画面で目立たせる） */
  lastAi: Action | null;
  /** 直前の人間またはAIのアクションより前のログの長さ（新しい出来事を目立たせる） */
  logMark: number;
  /** AI の強さ（B） */
  level: AiLevel;
  /** AI 同士の対戦を観戦する（A も AI が操作する） */
  spectate?: boolean;
  /** 観戦のときの A の AI の強さ */
  levelA?: AiLevel;
}

/** 観戦の速さ（1手ごとの待ち時間） */
export const SPEEDS: { label: string; ms: number }[] = [
  { label: 'ゆっくり', ms: 2000 },
  { label: 'ふつう', ms: 800 },
  { label: '速い', ms: 250 },
  { label: 'とても速い', ms: 0 },
];

export const LEVEL_LABEL: Record<AiLevel, string> = { easy: 'やさしい', normal: 'ふつう', hard: 'つよい' };

type Listener = () => void;

export class Game {
  match: Match | null = null;
  private listeners: Listener[] = [];
  private timer: number | null = null;
  /** AI が考えている間（ワーカーの返事を待っている間）は true */
  private thinking = false;
  private worker: Worker | null = null;
  private requestId = 0;
  private waiting: { id: number; match: Match; state: GameState; player: PlayerId } | null = null;
  error: string | null = null;
  /** 観戦の1手ごとの待ち時間 */
  speedMs = AI_DELAY_MS;
  /** 観戦を一時停止しているか */
  paused = false;

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  start(human: DeckDef, ai: DeckDef, first: 'A' | 'B' | 'random', level: AiLevel = 'normal', opts: { spectate?: boolean; levelA?: AiLevel } = {}): void {
    this.stopTimer();
    this.paused = false;
    const seed = Math.floor(Math.random() * 2 ** 31);
    const state = newGame(cat, { A: human, B: ai }, { seed, firstPlayer: first === 'random' ? undefined : first });
    this.match = { state, decks: { human, ai }, lastAi: null, logMark: 0, level, spectate: !!opts.spectate, levelA: opts.levelA ?? level };
    this.afterChange();
  }

  /** AI が操作するプレイヤー */
  private aiPlayers(m: Match): PlayerId[] {
    return m.spectate ? ['A', 'B'] : [AI];
  }

  /** そのプレイヤーの AI の強さ */
  levelOf(p: PlayerId): AiLevel {
    const m = this.match!;
    return p === 'A' && m.spectate ? (m.levelA ?? m.level ?? 'normal') : (m.level ?? 'normal');
  }

  /** 今判断する AI のプレイヤー（いなければ null） */
  private aiToAct(m: Match): PlayerId | null {
    const ai = this.aiPlayers(m);
    return playerToAct(m.state).find((p) => ai.includes(p)) ?? null;
  }

  // ---------------------------------------------------------------- 観戦の操作

  setSpeed(ms: number): void {
    this.speedMs = ms;
    this.emit();
  }

  togglePause(): void {
    this.paused = !this.paused;
    if (this.paused && this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit();
    this.scheduleAi();
  }

  /** 一時停止中に1手だけ進める */
  step(): void {
    if (!this.paused || this.thinking || !this.match) return;
    this.aiStep();
  }

  quit(): void {
    this.stopTimer();
    this.match = null;
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* 保存できない環境では何もしない */
    }
    this.emit();
  }

  /** 人間の操作 */
  act(action: Action): void {
    const m = this.match;
    if (!m) return;
    try {
      const mark = m.state.log.length;
      m.state = applyAction(cat, m.state, action);
      m.lastAi = null;
      m.logMark = mark;
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.afterChange();
  }

  get aiThinking(): boolean {
    return this.timer !== null || this.thinking;
  }

  humanToAct(): boolean {
    return !!this.match && !this.match.spectate && playerToAct(this.match.state).includes(HUMAN);
  }

  private afterChange(): void {
    this.save();
    this.emit();
    this.scheduleAi();
  }

  private scheduleAi(): void {
    const m = this.match;
    if (!m || this.timer !== null || this.thinking || m.state.result) return;
    if (!this.aiToAct(m)) return;
    // 観戦の一時停止中は、マリガン以外は進めない
    if (m.spectate && this.paused && m.state.phase !== 'mulligan') return;
    // マリガンは人間と同時に行うので待たない。行動フェイズは1手ずつ間をあけて見せる（2-4）
    const wait = m.state.phase === 'mulligan' ? 0 : m.spectate ? this.speedMs : AI_DELAY_MS;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.aiStep();
    }, wait);
    this.emit();
  }

  private aiStep(): void {
    const m = this.match;
    const p = m && !m.state.result ? this.aiToAct(m) : null;
    if (!m || !p) return;
    const level = this.levelOf(p);
    const worker = this.getWorker();
    if (!worker) return this.applyAi(m, chooseAction(cat, m.state, p, { level }).action);
    // 思考はワーカーで行い、返事が来たら適用する（その間に試合が変わっていたら捨てる）
    const id = ++this.requestId;
    this.waiting = { id, match: m, state: m.state, player: p };
    this.thinking = true;
    this.emit();
    worker.postMessage({ id, state: m.state, player: p, level });
  }

  private onWorker(data: { id: number; action?: Action; error?: string }): void {
    const w = this.waiting;
    if (!w || w.id !== data.id) return;
    this.waiting = null;
    this.thinking = false;
    const m = w.match;
    if (this.match !== m || m.state !== w.state) return this.emit();
    // ワーカーで失敗したら、この場で考える
    this.applyAi(m, data.action ?? chooseAction(cat, m.state, w.player, { level: this.levelOf(w.player) }).action);
  }

  private applyAi(m: Match, action: Action): void {
    const mark = m.state.log.length;
    m.state = applyAction(cat, m.state, action);
    m.lastAi = action;
    m.logMark = mark;
    this.afterChange();
  }

  private getWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onWorker(e.data);
    } catch {
      this.worker = null;
    }
    return this.worker;
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    this.thinking = false;
    this.waiting = null;
  }

  private save(): void {
    try {
      if (this.match) localStorage.setItem(SAVE_KEY, JSON.stringify(this.match));
    } catch {
      /* 保存できない環境では何もしない */
    }
  }

  /** 保存した試合があれば読み込む */
  resume(): boolean {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const m = JSON.parse(raw) as Match;
      if (m.state?.version !== 1) return false;
      this.match = m;
      this.afterChange();
      return true;
    } catch {
      return false;
    }
  }
}
