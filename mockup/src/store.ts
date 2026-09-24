// 状態の保持・取り消し／やり直し・自動保存
import { newGame } from './game';
import type { GameState } from './types';

const STORAGE_KEY = 'cardgame-mockup-v1';
const UNDO_LIMIT = 300;

type Listener = () => void;

export class Store {
  state: GameState;
  private undoStack: { label: string; state: string }[] = [];
  private redoStack: { label: string; state: string }[] = [];
  private listeners: Listener[] = [];

  constructor(initial: GameState) {
    this.state = initial;
  }

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
  }

  // 状態を変える操作は必ずここを通す。操作前の状態を取り消し用に保存する。
  dispatch(label: string, fn: (s: GameState) => unknown): void {
    const before = JSON.stringify(this.state);
    const result = fn(this.state);
    if (result === false) return; // 何も変わらなかった
    this.undoStack.push({ label, state: before });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.commit();
  }

  // 表示設定など、取り消しの対象にしない変更
  setQuiet(fn: (s: GameState) => void): void {
    fn(this.state);
    this.commit();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  undoLabel(): string {
    return this.undoStack[this.undoStack.length - 1]?.label ?? '';
  }
  redoLabel(): string {
    return this.redoStack[this.redoStack.length - 1]?.label ?? '';
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push({ label: prev.label, state: JSON.stringify(this.state) });
    this.state = JSON.parse(prev.state);
    this.commit();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push({ label: next.label, state: JSON.stringify(this.state) });
    this.state = JSON.parse(next.state);
    this.commit();
  }

  replace(state: GameState, keepHistory = false): void {
    if (keepHistory) this.undoStack.push({ label: '読み込み', state: JSON.stringify(this.state) });
    else this.undoStack = [];
    this.redoStack = [];
    this.state = state;
    this.commit();
  }

  private commit(): void {
    save(this.state);
    for (const l of this.listeners) l();
  }
}

export function save(state: GameState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 保存できない環境（プライベートブラウズなど）では何もしない
  }
}

export function load(): GameState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as GameState;
    return s.version === 1 ? s : null;
  } catch {
    return null;
  }
}

export function freshGame(): GameState {
  return newGame((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0);
}
