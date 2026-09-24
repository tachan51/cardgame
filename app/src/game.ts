// 試合の進行: 人間（A）の操作を適用し、AI（B）の番なら少し待ってから AI の手を1手ずつ適用する
import { applyAction, chooseAction, newGame, playerToAct, type Action, type AiLevel, type DeckDef, type GameState } from '../../engine/src';
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
  /** AI の強さ */
  level: AiLevel;
}

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
  private waiting: { id: number; match: Match; state: GameState } | null = null;
  error: string | null = null;

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  start(human: DeckDef, ai: DeckDef, first: 'A' | 'B' | 'random', level: AiLevel = 'normal'): void {
    this.stopTimer();
    const seed = Math.floor(Math.random() * 2 ** 31);
    const state = newGame(cat, { A: human, B: ai }, { seed, firstPlayer: first === 'random' ? undefined : first });
    this.match = { state, decks: { human, ai }, lastAi: null, logMark: 0, level };
    this.afterChange();
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
    return !!this.match && playerToAct(this.match.state).includes(HUMAN);
  }

  private afterChange(): void {
    this.save();
    this.emit();
    this.scheduleAi();
  }

  private scheduleAi(): void {
    const m = this.match;
    if (!m || this.timer !== null || this.thinking || m.state.result) return;
    if (!playerToAct(m.state).includes(AI)) return;
    // マリガンは人間と同時に行うので待たない。行動フェイズは1手ずつ間をあけて見せる（2-4）
    const wait = m.state.phase === 'mulligan' ? 0 : AI_DELAY_MS;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.aiStep();
    }, wait);
    this.emit();
  }

  private aiStep(): void {
    const m = this.match;
    if (!m || m.state.result || !playerToAct(m.state).includes(AI)) return;
    const worker = this.getWorker();
    if (!worker) return this.applyAi(m, chooseAction(cat, m.state, AI, { level: m.level ?? 'normal' }).action);
    // 思考はワーカーで行い、返事が来たら適用する（その間に試合が変わっていたら捨てる）
    const id = ++this.requestId;
    this.waiting = { id, match: m, state: m.state };
    this.thinking = true;
    this.emit();
    worker.postMessage({ id, state: m.state, player: AI, level: m.level ?? 'normal' });
  }

  private onWorker(data: { id: number; action?: Action; error?: string }): void {
    const w = this.waiting;
    if (!w || w.id !== data.id) return;
    this.waiting = null;
    this.thinking = false;
    const m = w.match;
    if (this.match !== m || m.state !== w.state) return this.emit();
    // ワーカーで失敗したら、この場で考える
    this.applyAi(m, data.action ?? chooseAction(cat, m.state, AI, { level: m.level ?? 'normal' }).action);
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
