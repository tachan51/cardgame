import './style.css';
import { Game } from './game';
import { renderBattle, resetBattleUi } from './ui/battle';
import { renderSetup } from './ui/setup';

const app = document.getElementById('app')!;
const game = new Game();

function hasSave(): boolean {
  try {
    return !!localStorage.getItem('cardgame-play-v1');
  } catch {
    return false;
  }
}

function render(): void {
  if (!game.match) {
    app.onclick = null;
    app.onmouseover = null;
    return renderSetup(app, game, hasSave());
  }
  renderBattle(
    app,
    game,
    () => {
      resetBattleUi();
      game.quit();
    },
    () => {
      const d = game.match!.decks;
      resetBattleUi();
      game.start(d.human, d.ai, 'random');
    },
  );
}

game.subscribe(render);
render();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    resetBattleUi();
    render();
  }
});

// 動作確認用（ブラウザの開発者ツールから試合の状態を見られるように）
(window as unknown as { __game: Game }).__game = game;
