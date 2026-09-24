// 試合の進行: 人間（A）の操作を適用し、AI（B）の番なら少し待ってから AI の手を1手ずつ適用する
import { applyAction, chooseAction, newGame, playerToAct, type Action, type DeckDef, type GameState } from '../../engine/src';
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
}

type Listener = () => void;

export class Game {
  match: Match | null = null;
  private listeners: Listener[] = [];
  private timer: number | null = null;
  error: string | null = null;

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  start(human: DeckDef, ai: DeckDef, first: 'A' | 'B' | 'random'): void {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const state = newGame(cat, { A: human, B: ai }, { seed, firstPlayer: first === 'random' ? undefined : first });
    this.match = { state, decks: { human, ai }, lastAi: null, logMark: 0 };
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
    return this.timer !== null;
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
    if (!m || this.timer !== null || m.state.result) return;
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
    const { action } = chooseAction(cat, m.state, AI);
    const mark = m.state.log.length;
    m.state = applyAction(cat, m.state, action);
    m.lastAi = action;
    m.logMark = mark;
    this.afterChange();
  }

  private stopTimer(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
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
