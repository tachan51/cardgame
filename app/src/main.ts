import './style.css';
import { Game } from './game';
import { renderBattle, resetBattleUi } from './ui/battle';
import { openBuilder, renderBuilder } from './ui/builder';
import { renderSetup, selectHumanDeck } from './ui/setup';

const app = document.getElementById('app')!;
const game = new Game();
let screen: 'setup' | 'builder' = 'setup';

function hasSave(): boolean {
  try {
    return !!localStorage.getItem('cardgame-play-v1');
  } catch {
    return false;
  }
}

function clearHandlers(): void {
  app.onclick = null;
  app.onmouseover = null;
  app.oncontextmenu = null;
}

function render(): void {
  clearHandlers();
  if (game.match) {
    return renderBattle(
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
  if (screen === 'builder') {
    return renderBuilder(app, {
      back: (deckId) => {
        if (deckId) selectHumanDeck(deckId);
        screen = 'setup';
        render();
      },
    });
  }
  renderSetup(app, game, hasSave(), (deckId) => {
    openBuilder(deckId);
    screen = 'builder';
    render();
  });
}

game.subscribe(render);
render();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && game.match) {
    resetBattleUi();
    render();
  }
});

// 動作確認用（ブラウザの開発者ツールから試合の状態を見られるように）
(window as unknown as { __game: Game }).__game = game;
