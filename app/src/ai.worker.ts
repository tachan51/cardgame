// AI の思考を画面と別のスレッドで行う（思考中も画面が固まらないように。タスク 4-2）
import { chooseAction, type AiLevel, type GameState, type PlayerId } from '../../engine/src';
import { cat } from './data';

export interface AiRequest {
  id: number;
  state: GameState;
  player: PlayerId;
  level: AiLevel;
}

self.onmessage = (e: MessageEvent<AiRequest>) => {
  const { id, state, player, level } = e.data;
  try {
    const d = chooseAction(cat, state, player, { level, timeLimitMs: 1500 });
    self.postMessage({ id, action: d.action });
  } catch (err) {
    self.postMessage({ id, error: String((err as Error).message) });
  }
};
