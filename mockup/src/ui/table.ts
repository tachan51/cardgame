// 対戦画面（マリガン・対戦）。docs/mockup.md 3〜6章
import { card, catalog, factionName } from '../data';
import * as G from '../game';
import type { Counter, Loc } from '../game';
import { freshGame, type Store } from '../store';
import type { CardInstance, GameState, Keyword, PlayerId } from '../types';
import { KEYWORD_LABEL, cellLabel, other } from '../types';
import { cardDetailHtml, handCardHtml, leaderDetailHtml, leaderHtml, statsText, unitHtml } from './cards';
import {
  askNumber,
  askStats,
  closeMenu,
  closeModal,
  download,
  esc,
  pickFile,
  showMenu,
  showModal,
  type MenuItem,
} from './common';

// 画面だけの状態（取り消しの対象外）
let pendingSummon: { p: PlayerId; cardId: string } | null = null;
let catalogFaction = 'knights';

export function cancelPending(): boolean {
  if (!pendingSummon) return false;
  pendingSummon = null;
  return true;
}

// ---------- マリガン ----------

export function renderMulligan(root: HTMLElement, store: Store): void {
  const s = store.state;
  const col = (p: PlayerId) => {
    const m = s.mulligan[p];
    const cards = s.players[p].hand
      .map((c) => {
        const sel = m.selected.includes(c.uid);
        return `<div class="mull-card${sel ? ' selected' : ''}" data-mull="${p}" data-uid="${c.uid}" data-card-id="${c.cardId}">${handCardHtml(c, '', false)}${sel ? '<div class="mull-mark">戻す</div>' : ''}</div>`;
      })
      .join('');
    return `<section class="setup-col"><h2>プレイヤー ${p}${m.done ? '（確定済み）' : ''}</h2>
      <p class="muted">${esc(s.players[p].deckName)}</p>
      <div class="mull-hand">${cards}</div>
      <button class="primary" data-mull-ok="${p}" ${m.done ? 'disabled' : ''}>${m.selected.length}枚を戻して確定</button></section>`;
  };
  root.innerHTML = `<div class="setup"><h1>マリガン</h1>
    <p class="muted">戻したいカードをクリックして選び、確定してください。同じ枚数を引いた後、戻したカードを山札に入れてシャッフルします。先手は ${s.firstPlayer}。</p>
    <div class="setup-cols">${col('A')}${col('B')}</div>
    <div id="detail" class="detail">カードにマウスを乗せると詳細を表示</div></div>`;
  root.querySelectorAll<HTMLElement>('[data-mull]').forEach((el) => {
    el.addEventListener('click', () => {
      const p = el.dataset.mull as PlayerId;
      if (s.mulligan[p].done) return;
      store.dispatch('マリガンの選択', (st) => G.toggleMulligan(st, p, el.dataset.uid!));
    });
  });
  root.querySelectorAll<HTMLElement>('[data-mull-ok]').forEach((b) => {
    b.addEventListener('click', () => {
      const p = b.dataset.mullOk as PlayerId;
      store.dispatch('マリガンの確定', (st) => G.confirmMulligan(st, p));
    });
  });
  bindDetail(root);
}

// ---------- 対戦画面 ----------

export function renderTable(root: HTMLElement, store: Store): void {
  const s = store.state;
  const bottom = s.settings.viewPlayer;
  const top = other(bottom);
  root.innerHTML = `<div class="table">
    ${topBar(store)}
    ${pendingSummon ? `<div class="banner">「${esc(card(pendingSummon.cardId).name)}」を出す ${pendingSummon.p} の空きマスをクリック（Esc で中止）</div>` : ''}
    <div class="main">
      <aside class="side">${playerPanel(s, top)}${playerPanel(s, bottom)}</aside>
      <section class="center">
        ${handRow(s, top, true)}
        ${boardHalf(s, top, true)}
        <div class="frontline"><span>戦線</span></div>
        ${boardHalf(s, bottom, false)}
        ${handRow(s, bottom, false)}
      </section>
      <aside class="side right">${piles(s, top)}${piles(s, bottom)}${logPanel(s)}</aside>
    </div>
    <div id="detail" class="detail">カードにマウスを乗せると詳細を表示。カードは右クリック（またはクリック）でメニュー、ドラッグで移動。</div>
  </div>`;
  bind(root, store);
  const logEl = root.querySelector('.log-list');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

function topBar(store: Store): string {
  const s = store.state;
  return `<header class="topbar">
    <span class="round">ラウンド <b>${s.round}</b></span>
    <span>先手 <b class="p-${s.firstPlayer}">${s.firstPlayer}</b></span>
    <span>行動権 <b class="p-${s.activePlayer}">${s.activePlayer}</b>${s.passStreak ? `（直前にパス）` : ''}</span>
    <span class="group">
      <button data-act="endTurn" title="行動権を相手に移す">手番を終える</button>
      <button data-act="pass" title="パスとして記録して行動権を移す">パス</button>
    </span>
    <span class="group">
      <button data-act="roundEnd" title="このラウンド中の効果を外し、使い残した通常マナを記録">ラウンド終了</button>
      <button data-act="roundStart" title="最大マナ+1、予備マナの加算、全回復、ドロー、先手の交代">次のラウンド開始</button>
    </span>
    <span class="group">
      <button data-act="undo" ${store.canUndo() ? '' : 'disabled'} title="Ctrl+Z: ${esc(store.undoLabel())}">↶ 取り消し</button>
      <button data-act="redo" ${store.canRedo() ? '' : 'disabled'} title="Ctrl+Y: ${esc(store.redoLabel())}">↷ やり直し</button>
    </span>
    <span class="group">
      <button data-act="catalog">カード一覧</button>
      <button data-act="swapView">視点を入れ替え</button>
      <label><input type="checkbox" data-set="hideOpponentHand" ${s.settings.hideOpponentHand ? 'checked' : ''}>相手の手札を隠す</label>
      <label title="手札からカードを出したとき、通常マナからコストを引く"><input type="checkbox" data-set="autoPay" ${s.settings.autoPay ? 'checked' : ''}>コストを自動で払う</label>
    </span>
    <span class="group right">
      <button data-act="saveGame">試合を保存</button>
      <button data-act="loadGame">読み込み</button>
      <button data-act="newGame">新しい試合</button>
    </span>
  </header>`;
}

const COUNTERS: Counter[] = ['life', 'mana', 'maxMana', 'reserve', 'unusedMana', 'spellsCast'];

function playerPanel(s: GameState, p: PlayerId): string {
  const pl = s.players[p];
  const rows = COUNTERS.map((c) => {
    const warn = c === 'reserve' && pl.reserve > pl.maxMana ? ' warn-val' : c === 'life' && pl.life <= 0 ? ' warn-val' : '';
    return `<div class="counter"><span class="c-label">${G.COUNTER_LABEL[c]}</span>
      <button data-act="counter" data-args='["${p}","${c}",-1]'>−</button><span class="num${warn}">${pl[c]}</span><button data-act="counter" data-args='["${p}","${c}",1]'>＋</button>
      <button class="small" data-act="counterSet" data-args='["${p}","${c}"]' title="数値を入力">✎</button></div>`;
  }).join('');
  const leaders = pl.leaders.map((ls, i) => leaderHtml(ls, p, i, G.leaderAbilityCost(s, p, i))).join('');
  return `<div class="panel p-${p}${s.activePlayer === p ? ' active' : ''}">
    <div class="panel-head">プレイヤー ${p}${s.activePlayer === p ? ' <span class="tag">行動権</span>' : ''}<div class="muted small">${esc(pl.deckName)}</div></div>
    ${rows}
    <div class="leaders">${leaders}</div>
  </div>`;
}

function handRow(s: GameState, p: PlayerId, isTop: boolean): string {
  const pl = s.players[p];
  const hidden = isTop && s.settings.hideOpponentHand;
  const cards = pl.hand
    .map((c) => handCardHtml(c, JSON.stringify({ p, zone: 'hand', uid: c.uid }), hidden && !c.revealed))
    .join('');
  return `<div class="hand-row ${isTop ? 'top' : 'bottom'}">
    <div class="hand p-${p}" data-drop='${JSON.stringify({ p, zone: 'hand' })}'>
      <span class="zone-label">${p} 手札 ${pl.hand.length}/${G.HAND_LIMIT}</span>${cards}
    </div>
    <div class="use-zones">
      <div class="use-zone" data-drop='${JSON.stringify({ p, zone: 'useSpell' })}'>スペルを使う<br><span class="muted small">（トラッシュへ）</span></div>
      <div class="use-zone delay" data-drop='${JSON.stringify({ p, zone: 'reserveDelay' })}'>遅延を予約<br><span class="muted small">（遅延ゾーンへ）</span></div>
    </div>
  </div>`;
}

function boardHalf(s: GameState, p: PlayerId, isTop: boolean): string {
  const pl = s.players[p];
  const row = (r: 'front' | 'back') => {
    const cells = [0, 1, 2, 3]
      .map((lane) => {
        const i = lane * 2 + (r === 'front' ? 0 : 1);
        const u = pl.board[i];
        const note = pl.cellNotes[i];
        const summonable = pendingSummon?.p === p && !u;
        return `<div class="cell${summonable ? ' summonable' : ''}" data-drop='${JSON.stringify({ p, zone: 'board', index: i })}' data-cell="${p}:${i}">
          <span class="cell-label">${cellLabel(i)}</span>
          ${note ? `<span class="cell-note" title="${esc(note)}">⚑ ${esc(note)}</span>` : ''}
          ${u ? unitHtml(u, JSON.stringify({ p, zone: 'board', index: i })) : ''}
        </div>`;
      })
      .join('');
    return `<div class="board-row"><span class="row-label">${p} ${r === 'front' ? '前列' : '後列'}</span>${cells}</div>`;
  };
  return `<div class="board p-${p}">${isTop ? row('back') + row('front') : row('front') + row('back')}</div>`;
}

function piles(s: GameState, p: PlayerId): string {
  const pl = s.players[p];
  const delayed = pl.delayed
    .map(
      (d) => `<div class="delayed-entry" data-card-id="${d.cardId}"><b>${esc(card(d.cardId).name)}</b> <span class="muted small">R${d.round}</span>
        ${d.note ? `<div class="small">${esc(d.note)}</div>` : ''}<button class="small" data-act="resolveDelay" data-args='["${p}","${d.uid}"]'>発動した</button></div>`,
    )
    .join('');
  return `<div class="piles p-${p}">
    <div class="pile-head">プレイヤー ${p}</div>
    <div class="pile-row">
      <div class="pile" data-pile="deck" data-p="${p}" data-drop='${JSON.stringify({ p, zone: 'deckTop' })}'>山札<b>${pl.deck.length}</b></div>
      <div class="pile" data-pile="trash" data-p="${p}" data-drop='${JSON.stringify({ p, zone: 'trash' })}'>トラッシュ<b>${pl.trash.length}</b></div>
      <div class="pile" data-pile="exile" data-p="${p}" data-drop='${JSON.stringify({ p, zone: 'exile' })}'>除外<b>${pl.exile.length}</b></div>
    </div>
    <div class="delay-zone"><div class="small muted">遅延ゾーン（予約順）</div>${delayed || '<div class="small muted">なし</div>'}</div>
  </div>`;
}

function logPanel(s: GameState): string {
  const entries = s.log
    .slice(-300)
    .map((e) => `<div class="log-entry${e.player ? ` p-${e.player}` : ' sys'}"><span class="muted small">R${e.round}</span> ${e.player ? `<b>${e.player}</b> ` : ''}${esc(e.text)}</div>`)
    .join('');
  return `<div class="log">
    <div class="pile-head">ログ <button class="small" data-act="exportLog">書き出し</button></div>
    <div class="log-list">${entries}</div>
    <form class="memo-form"><input name="memo" placeholder="メモを追加（Enter）" autocomplete="off"></form>
  </div>`;
}

// ---------- 詳細パネル ----------

function bindDetail(root: HTMLElement): void {
  const detail = root.querySelector('#detail') as HTMLElement | null;
  if (!detail) return;
  root.addEventListener('mouseover', (e) => {
    const t = e.target as HTMLElement;
    const c = t.closest<HTMLElement>('[data-card-id]');
    if (c) {
      detail.innerHTML = cardDetailHtml(c.dataset.cardId!);
      return;
    }
    const l = t.closest<HTMLElement>('[data-leader-id]');
    if (l) detail.innerHTML = leaderDetailHtml(l.dataset.leaderId!);
  });
}

// ---------- イベント ----------

function bind(root: HTMLElement, store: Store): void {
  const d = (label: string, fn: (s: GameState) => unknown) => store.dispatch(label, fn);
  const s = store.state;

  const actions: Record<string, (...a: never[]) => void> = {
    endTurn: () => d('手番を終える', (st) => G.endTurn(st, false)),
    pass: () => d('パス', (st) => G.endTurn(st, true)),
    roundEnd: () => {
      let reminders: string[] = [];
      d('ラウンド終了', (st) => {
        reminders = G.roundEnd(st);
      });
      if (reminders.length) {
        showModal(
          'ラウンド終了時の処理を確認',
          `<p>次の目印・印が付いています。必要な処理を手で行ってください。</p><ul>${reminders.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`,
        );
      }
    },
    roundStart: () => d('ラウンド開始', (st) => G.roundStart(st)),
    undo: () => store.undo(),
    redo: () => store.redo(),
    catalog: () => openCatalog(store),
    swapView: () => store.setQuiet((st) => (st.settings.viewPlayer = other(st.settings.viewPlayer))),
    saveGame: () => download(`cardgame-R${s.round}-${Date.now()}.json`, JSON.stringify(s, null, 1), 'application/json'),
    loadGame: async () => {
      const text = await pickFile('.json,application/json');
      if (!text) return;
      try {
        const st = JSON.parse(text);
        if (st.version !== 1 || !st.players) throw new Error('試合のファイルではありません');
        store.replace(st, true);
      } catch (e) {
        window.alert(`読み込めませんでした: ${(e as Error).message}`);
      }
    },
    newGame: () => {
      if (!window.confirm('今の試合を終えて、新しい試合の準備画面に戻りますか？（今の試合は「試合を保存」で残せます）')) return;
      const settings = s.settings;
      const g = freshGame();
      g.settings = { ...settings };
      store.replace(g);
    },
    exportLog: () => {
      const text = s.log.map((e) => `${e.time}\tR${e.round}\t${e.player ?? '-'}\t${e.text}`).join('\n');
      download(`cardgame-log-${Date.now()}.txt`, text);
    },
    counter: (p: PlayerId, c: Counter, delta: number) => d(`${G.COUNTER_LABEL[c]}`, (st) => G.adjustCounter(st, p, c, delta)),
    counterSet: (p: PlayerId, c: Counter) => {
      const n = askNumber(`${p} の${G.COUNTER_LABEL[c]}を入力`, String(s.players[p][c]));
      if (n === null) return;
      d(`${G.COUNTER_LABEL[c]}`, (st) => G.adjustCounter(st, p, c, n - st.players[p][c]));
    },
    leaderAdj: (p: PlayerId, i: number, f: 'progress' | 'abilityCostMod', delta: number) =>
      d('リーダー', (st) => G.adjustLeader(st, p, i, f, delta)),
    leaderToggle: (p: PlayerId, i: number, f: 'grown' | 'usedThisRound') => d('リーダー', (st) => G.toggleLeader(st, p, i, f)),
    leaderUse: (p: PlayerId, i: number) => d('リーダー能力', (st) => G.useLeaderAbility(st, p, i)),
    resolveDelay: (p: PlayerId, uid: string) => d('遅延の発動', (st) => G.resolveDelay(st, p, uid)),
  };

  root.querySelectorAll<HTMLElement>('[data-act]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const fn = actions[el.dataset.act!];
      const args = el.dataset.args ? (JSON.parse(el.dataset.args) as never[]) : [];
      fn?.(...args);
    });
  });
  root.querySelectorAll<HTMLInputElement>('[data-set]').forEach((el) => {
    el.addEventListener('change', () => {
      const key = el.dataset.set as 'hideOpponentHand' | 'autoPay';
      store.setQuiet((st) => (st.settings[key] = el.checked));
    });
  });
  root.querySelector<HTMLFormElement>('.memo-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = (e.target as HTMLFormElement).elements.namedItem('memo') as HTMLInputElement;
    const text = input.value.trim();
    if (text) d('メモ', (st) => G.addMemo(st, text));
  });

  // ドラッグ＆ドロップ
  root.querySelectorAll<HTMLElement>('[draggable="true"]').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer!.setData('text/plain', el.dataset.drag!);
      e.dataTransfer!.effectAllowed = 'move';
      closeMenu();
    });
  });
  root.querySelectorAll<HTMLElement>('[data-drop]').forEach((el) => {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const raw = e.dataTransfer!.getData('text/plain');
      if (!raw) return;
      handleDrop(store, JSON.parse(raw) as Loc, JSON.parse(el.dataset.drop!) as { p: PlayerId; zone: string; index?: number });
    });
  });

  // 盤面のマス: クリックでユニットのメニュー、または効果で出す先の選択
  root.querySelectorAll<HTMLElement>('[data-cell]').forEach((el) => {
    const [p, idx] = el.dataset.cell!.split(':') as [PlayerId, string];
    const i = parseInt(idx, 10);
    const open = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (pendingSummon) {
        if (pendingSummon.p === p && !store.state.players[p].board[i]) {
          const { cardId } = pendingSummon;
          pendingSummon = null;
          d('効果で出す', (st) => G.summonToken(st, p, cardId, i));
        }
        return;
      }
      if (store.state.players[p].board[i]) unitMenu(store, p, i, e.clientX, e.clientY);
      else cellMenu(store, p, i, e.clientX, e.clientY);
    };
    el.addEventListener('click', open);
    el.addEventListener('contextmenu', open);
  });

  // 手札のカード
  root.querySelectorAll<HTMLElement>('.hand [data-hand-uid]').forEach((el) => {
    const hand = el.closest<HTMLElement>('.hand')!;
    const p = (JSON.parse(hand.dataset.drop!) as { p: PlayerId }).p;
    const open = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handMenu(store, p, el.dataset.handUid!, e.clientX, e.clientY);
    };
    el.addEventListener('click', open);
    el.addEventListener('contextmenu', open);
  });

  // 山札・トラッシュ・除外
  root.querySelectorAll<HTMLElement>('[data-pile]').forEach((el) => {
    const p = el.dataset.p as PlayerId;
    el.addEventListener('click', (e) => {
      e.stopPropagation(); // document のクリックでメニューが閉じないように
      const kind = el.dataset.pile!;
      if (kind === 'deck') deckMenu(store, p, e.clientX, e.clientY);
      else openZoneList(store, p, kind as 'trash' | 'exile');
    });
  });

  bindDetail(root);
}

function handleDrop(store: Store, from: Loc, to: { p: PlayerId; zone: string; index?: number }): void {
  const s = store.state;
  if (to.zone === 'useSpell' || to.zone === 'reserveDelay') {
    if (from.zone !== 'hand' || from.p !== to.p) return;
    const ci = s.players[from.p].hand.find((c) => c.uid === from.uid);
    if (!ci) return;
    if (card(ci.cardId).type !== 'spell') {
      window.alert('スペルではありません。ユニットは盤面のマスにドラッグしてください。');
      return;
    }
    if (to.zone === 'reserveDelay') {
      const note = window.prompt('遅延の対象などのメモ（例: 相手の 2前）', '');
      if (note === null) return;
      store.dispatch('遅延を予約', (st) => G.useSpell(st, from.p, ci.uid, 'delay', note));
    } else {
      store.dispatch('スペルを使う', (st) => G.useSpell(st, from.p, ci.uid, 'trash'));
    }
    return;
  }
  if (from.zone === 'hand' && to.zone === 'board') {
    const ci = s.players[from.p].hand.find((c) => c.uid === from.uid);
    if (ci && card(ci.cardId).type === 'spell') {
      window.alert('スペルは「スペルを使う」か「遅延を予約」にドラッグしてください。');
      return;
    }
  }
  if (to.zone === 'board' && from.p !== to.p) {
    window.alert('相手の盤面には置けません。');
    return;
  }
  const target: Loc = { p: to.p, zone: to.zone as Loc['zone'], index: to.index };
  store.dispatch('カードの移動', (st) => G.moveCard(st, from, target));
}

// ---------- メニュー ----------

function unitMenu(store: Store, p: PlayerId, i: number, x: number, y: number): void {
  const s = store.state;
  const u = s.players[p].board[i]!;
  const name = card(u.cardId).name;
  const d = (label: string, fn: (st: GameState) => unknown) => store.dispatch(label, fn);
  const from: Loc = { p, zone: 'board', index: i };
  const items: MenuItem[] = [
    {
      label: 'ダメージ…',
      action: () => {
        const n = askNumber(`${name} に与えるダメージ`, '1');
        if (n === null || n <= 0) return;
        const useShield = u.shield && window.confirm('盾を持っています。盾でこのダメージを防ぎますか？');
        d('ダメージ', (st) => G.damageUnit(st, p, i, n, useShield));
        const after = store.state.players[p].board[i];
        if (after && G.unitHealth(after) <= 0 && window.confirm(`${name} の残り体力が0以下です。破壊してトラッシュに置きますか？`)) {
          d('破壊', (st) => G.moveCard(st, from, { p, zone: 'trash' }));
        }
      },
    },
    {
      label: '回復…',
      action: () => {
        const n = askNumber(`${name} を回復する量`, '1');
        if (n !== null && n > 0) d('回復', (st) => G.healUnit(st, p, i, n));
      },
    },
    {
      label: '能力値を変える（永続）…',
      action: () => {
        const v = askStats(`${name} の攻撃力/体力の変化（例: +2/+1、-1/0）`);
        if (v) d('能力値', (st) => G.modifyUnit(st, p, i, v[0], v[1], false));
      },
    },
    {
      label: '能力値を変える（このラウンド中）…',
      action: () => {
        const v = askStats(`${name} のこのラウンド中の攻撃力/体力の変化（例: +2/0）`);
        if (v) d('能力値', (st) => G.modifyUnit(st, p, i, v[0], v[1], true));
      },
    },
    { label: 'キーワード・盾…', action: () => keywordModal(store, p, i) },
    { separator: true, label: '' },
    ...['起動済み', '機動済み', 'ラウンド終了時に処理'].map((m) => ({
      label: `${u.markers.includes(m) ? '✓ ' : ''}目印: ${m}`,
      action: () => d('目印', (st) => G.toggleMarker(st, p, i, m)),
    })),
    {
      label: 'メモ…',
      action: () => {
        const m = window.prompt(`${name} のメモ（空にすると消去）`, u.memo);
        if (m !== null) d('メモ', (st) => G.setUnitMemo(st, p, i, m));
      },
    },
    {
      label: '遅延を記録…（起動能力など）',
      action: () => {
        const note = window.prompt(`${name} の遅延効果のメモ（例: 2レーンで戦闘）`, '');
        if (note !== null) d('遅延を記録', (st) => G.addDelayNote(st, p, u.cardId, note));
      },
    },
    {
      label: 'このラウンド中の効果を外す',
      disabled: !(u.tempAttack || u.tempHealth || u.tempKeywords.length),
      action: () => d('一時的な効果を外す', (st) => G.clearUnitTemporary(st, p, i)),
    },
    { separator: true, label: '' },
    {
      label: '前進',
      disabled: i % 2 !== 1 || !!s.players[p].board[i - 1],
      action: () => d('前進', (st) => G.advanceUnit(st, p, i)),
    },
    { label: '破壊（トラッシュへ）', action: () => d('破壊', (st) => G.moveCard(st, from, { p, zone: 'trash' })) },
    { label: '手札に戻す', action: () => d('手札に戻す', (st) => G.moveCard(st, from, { p, zone: 'hand' })) },
    { label: '除外', action: () => d('除外', (st) => G.moveCard(st, from, { p, zone: 'exile' })) },
    { label: '山札の上へ', action: () => d('山札へ', (st) => G.moveCard(st, from, { p, zone: 'deckTop' })) },
    { label: '山札の下へ', action: () => d('山札へ', (st) => G.moveCard(st, from, { p, zone: 'deckBottom' })) },
    { label: 'マスの印…', action: () => editCellNote(store, p, i) },
  ];
  showMenu(x, y, `${p} ${cellLabel(i)} ${name}`, items);
}

function cellMenu(store: Store, p: PlayerId, i: number, x: number, y: number): void {
  showMenu(x, y, `${p} のマス ${cellLabel(i)}（空き）`, [
    { label: 'マスの印…（遅延の予告など）', action: () => editCellNote(store, p, i) },
    {
      label: 'カード一覧から出す…',
      action: () => openCatalog(store),
    },
  ]);
}

function editCellNote(store: Store, p: PlayerId, i: number): void {
  const note = window.prompt(`${p} のマス ${cellLabel(i)} の印（空にすると消去）`, store.state.players[p].cellNotes[i]);
  if (note !== null) store.dispatch('マスの印', (st) => G.setCellNote(st, p, i, note));
}

function keywordModal(store: Store, p: PlayerId, i: number): void {
  const kws: Keyword[] = ['shield', 'ranged', 'pierce', 'firstStrike', 'mobile'];
  const body = `<table class="kw-table">${kws
    .map(
      (k) => `<tr><th>${KEYWORD_LABEL[k]}</th>
      <td><button data-k="${k}" data-mode="perm">${k === 'shield' ? '与える' : '与える（永続）'}</button></td>
      <td>${k === 'shield' ? '' : `<button data-k="${k}" data-mode="temp">このラウンド中</button>`}</td>
      <td><button data-k="${k}" data-mode="remove">外す</button></td></tr>`,
    )
    .join('')}</table><p class="muted small">盾は1回ダメージを防ぐと外れます（ダメージの入力時に確認します）。</p>`;
  showModal(`キーワード・盾（${card(store.state.players[p].board[i]!.cardId).name}）`, body, (el) => {
    el.querySelectorAll<HTMLButtonElement>('button[data-k]').forEach((b) => {
      b.addEventListener('click', () => {
        const k = b.dataset.k as Keyword;
        const mode = b.dataset.mode!;
        closeModal();
        if (mode === 'remove') store.dispatch('キーワード', (st) => G.removeKeyword(st, p, i, k));
        else store.dispatch('キーワード', (st) => G.grantKeyword(st, p, i, k, mode === 'temp'));
      });
    });
  });
}

function handMenu(store: Store, p: PlayerId, uid: string, x: number, y: number): void {
  const s = store.state;
  const ci = s.players[p].hand.find((c) => c.uid === uid);
  if (!ci) return;
  const def = card(ci.cardId);
  const d = (label: string, fn: (st: GameState) => unknown) => store.dispatch(label, fn);
  const from: Loc = { p, zone: 'hand', uid };
  const items: MenuItem[] = [];
  if (def.type === 'spell') {
    items.push(
      { label: 'スペルを使う（トラッシュへ）', action: () => d('スペルを使う', (st) => G.useSpell(st, p, uid, 'trash')) },
      {
        label: '遅延を予約…',
        action: () => {
          const note = window.prompt('遅延の対象などのメモ（例: 相手の 2前）', '');
          if (note !== null) d('遅延を予約', (st) => G.useSpell(st, p, uid, 'delay', note));
        },
      },
    );
  } else {
    items.push({ label: '配置するには盤面のマスへドラッグ', disabled: true });
  }
  items.push(
    { separator: true, label: '' },
    { label: 'コスト −1', action: () => d('コスト', (st) => G.adjustHandCost(st, p, uid, -1)) },
    { label: 'コスト ＋1', action: () => d('コスト', (st) => G.adjustHandCost(st, p, uid, 1)) },
    { label: ci.revealed ? '公開をやめる' : '公開する', action: () => d('公開', (st) => G.toggleReveal(st, p, uid)) },
    { separator: true, label: '' },
    { label: 'トラッシュへ', action: () => d('トラッシュへ', (st) => G.moveCard(st, from, { p, zone: 'trash' })) },
    { label: '除外', action: () => d('除外', (st) => G.moveCard(st, from, { p, zone: 'exile' })) },
    { label: '山札の上へ', action: () => d('山札へ', (st) => G.moveCard(st, from, { p, zone: 'deckTop' })) },
    { label: '山札の下へ', action: () => d('山札へ', (st) => G.moveCard(st, from, { p, zone: 'deckBottom' })) },
  );
  showMenu(x, y, `${p} 手札: ${def.name}（${G.handCost(ci)}）`, items);
}

function deckMenu(store: Store, p: PlayerId, x: number, y: number): void {
  const d = (label: string, fn: (st: GameState) => unknown) => store.dispatch(label, fn);
  showMenu(x, y, `${p} の山札（${store.state.players[p].deck.length}枚）`, [
    { label: '1枚引く', action: () => d('ドロー', (st) => G.drawCards(st, p, 1)) },
    {
      label: '枚数を指定して引く…',
      action: () => {
        const n = askNumber('引く枚数', '2');
        if (n !== null && n > 0) d('ドロー', (st) => G.drawCards(st, p, n));
      },
    },
    { label: 'シャッフル', action: () => d('シャッフル', (st) => G.shuffleDeck(st, p)) },
    {
      label: '上から見て1枚を手札へ…',
      action: () => {
        const n = askNumber('上から見る枚数', '2');
        if (n !== null && n > 0) openDeckPicker(store, p, n);
      },
    },
    { label: 'ランダムなユニットを手札へ（シャッフル）', action: () => d('ランダムに手札へ', (st) => G.tutorRandom(st, p, 'unit', 1)) },
    { label: 'ランダムなスペルを手札へ（シャッフル）', action: () => d('ランダムに手札へ', (st) => G.tutorRandom(st, p, 'spell', 1)) },
    { label: '山札から探す…', action: () => openDeckPicker(store, p, null) },
  ]);
}

// 山札の上から n 枚（null なら全部）を表示し、1枚を手札へ
function openDeckPicker(store: Store, p: PlayerId, n: number | null): void {
  const deck = store.state.players[p].deck;
  const list: CardInstance[] = n === null ? [...deck].sort((a, b) => card(a.cardId).cost - card(b.cardId).cost) : deck.slice(0, n);
  const body = `${n === null ? '<p class="muted">山札のすべてのカード（コスト順）。手札に加えたら、必要に応じて山札をシャッフルしてください。</p>' : '<p class="muted">上から順に表示。選ばなかったカードは元の順番のまま山札の上に残ります。</p>'}
    <div class="pick-list">${list.map((c, k) => pickRow(c, `${n === null ? '' : `${k + 1}. `}`, '手札へ')).join('')}</div>`;
  showModal(n === null ? `${p} の山札から探す` : `${p} の山札の上から${n}枚`, body, (el) => {
    el.querySelectorAll<HTMLButtonElement>('button[data-uid]').forEach((b) => {
      b.addEventListener('click', () => {
        closeModal();
        store.dispatch('山札から手札へ', (st) => G.takeFromDeck(st, p, b.dataset.uid!, n === null ? '山札から探す' : '上から見る'));
      });
    });
  }, true);
}

function pickRow(c: CardInstance, prefix: string, label: string, extra = ''): string {
  const def = card(c.cardId);
  return `<div class="pick-row" data-card-id="${c.cardId}"><span class="cost">${def.cost}</span><b>${prefix}${esc(def.name)}</b>
    <span class="muted small">${statsText(def)}</span><span class="pick-text small">${esc(def.text)}</span>
    <span class="pick-buttons"><button data-uid="${c.uid}">${label}</button>${extra}</span></div>`;
}

function openZoneList(store: Store, p: PlayerId, zone: 'trash' | 'exile'): void {
  const list = store.state.players[p][zone];
  const zoneName = zone === 'trash' ? 'トラッシュ' : '除外ゾーン';
  const otherZone = zone === 'trash' ? 'exile' : 'trash';
  const body = list.length
    ? `<div class="pick-list">${[...list]
        .reverse()
        .map((c) =>
          pickRow(
            c,
            '',
            '手札へ',
            `<button data-uid="${c.uid}" data-to="deckTop">山札の上へ</button><button data-uid="${c.uid}" data-to="deckBottom">山札の下へ</button><button data-uid="${c.uid}" data-to="${otherZone}">${otherZone === 'exile' ? '除外へ' : 'トラッシュへ'}</button>`,
          ),
        )
        .join('')}</div><p class="muted small">新しいものが上。</p>`
    : '<p class="muted">カードはありません。</p>';
  showModal(`${p} の${zoneName}（${list.length}枚）`, body, (el) => {
    el.querySelectorAll<HTMLButtonElement>('button[data-uid]').forEach((b) => {
      b.addEventListener('click', () => {
        closeModal();
        const to = (b.dataset.to ?? 'hand') as Loc['zone'];
        store.dispatch('カードの移動', (st) => G.moveCard(st, { p, zone, uid: b.dataset.uid! }, { p, zone: to }));
      });
    });
  }, true);
}

function openCatalog(store: Store): void {
  const render = () => {
    const tabs = catalog.factions
      .map((f) => `<button class="tab${f.id === catalogFaction ? ' on' : ''}" data-fac="${f.id}">${esc(factionName(f.id))}</button>`)
      .join('');
    const cards = [...catalog.cards.values()].filter((c) => c.faction === catalogFaction);
    const rows = cards
      .map((def) => {
        const unitButtons =
          def.type === 'unit'
            ? `<button data-summon="A" data-id="${def.id}">Aに出す</button><button data-summon="B" data-id="${def.id}">Bに出す</button>`
            : '';
        return `<div class="pick-row" data-card-id="${def.id}"><span class="cost">${def.cost}</span><b>${esc(def.name)}</b>
          <span class="muted small">${esc(def.id)}・${statsText(def)}</span><span class="pick-text small">${esc(def.text)}</span>
          <span class="pick-buttons"><button data-gen="A" data-id="${def.id}">A手札に生成</button><button data-gen="B" data-id="${def.id}">B手札に生成</button>${unitButtons}</span></div>`;
      })
      .join('');
    return `<div class="tabs">${tabs}</div><p class="muted small">「生成」は手札にコピーを加えます。「出す」は効果でユニットを盤面に出します（トークン扱い）。出すマスはこの後クリックで選びます。</p><div class="pick-list">${rows}</div>`;
  };
  const mount = (el: HTMLElement) => {
    el.querySelectorAll<HTMLButtonElement>('[data-fac]').forEach((b) =>
      b.addEventListener('click', () => {
        catalogFaction = b.dataset.fac!;
        el.innerHTML = render();
        mount(el);
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-gen]').forEach((b) =>
      b.addEventListener('click', () => {
        const p = b.dataset.gen as PlayerId;
        store.dispatch('手札に生成', (st) => G.generateToHand(st, p, b.dataset.id!));
        b.textContent = '✓ 生成した';
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-summon]').forEach((b) =>
      b.addEventListener('click', () => {
        pendingSummon = { p: b.dataset.summon as PlayerId, cardId: b.dataset.id! };
        closeModal();
        store.setQuiet(() => {});
      }),
    );
  };
  showModal('カード一覧', render(), mount, true);
}
