// 対戦画面（2-1〜2-4）。マリガン・選択・結果の表示もここで行う
import {
  cellName,
  getCard,
  getLeader,
  laneOf,
  previewCombat,
  Runner,
  type Action,
  type GameState,
  type PlayerId,
  type TargetValue,
  type Unit,
} from '../../../engine/src';
import { canonical } from '../../../engine/src/runner';
import { cat } from '../data';
import type { Game } from '../game';
import { allLegal, nextStep, type Selection, type Source, type Step } from '../select';
import { AI, cardName, cardTypeLabel, esc, HUMAN, KEYWORD_LABEL, leaderLabel, logText, richText, targetText, who } from '../text';

interface UiState {
  sel: Selection | null;
  /** 操作を選ぶメニューを開いているユニット */
  menuUnit: number | null;
  mulligan: Set<number>;
  hint: string | null;
}

const ui: UiState = { sel: null, menuUnit: null, mulligan: new Set(), hint: null };

export function resetBattleUi(): void {
  ui.sel = null;
  ui.menuUnit = null;
  ui.mulligan = new Set();
  ui.hint = null;
}

// ---------------------------------------------------------------- 描画

export function renderBattle(root: HTMLElement, game: Game, onQuit: () => void, onRematch: () => void): void {
  const m = game.match!;
  const s = m.state;
  const r = new Runner(cat, s);
  const humanTurn = game.humanToAct() && !game.aiThinking;
  const all = humanTurn && s.phase === 'action' && !s.pending ? allLegal(s) : [];
  if (ui.sel && !nextStepOk(all, ui.sel, s)) ui.sel = null;
  const step = ui.sel ? nextStep(all, ui.sel, s) : null;
  const hl = highlights(step, s);
  const preview = s.phase === 'action' && !s.result ? previewInfo(s) : null;
  const marks = delayMarks(s, r);

  root.innerHTML = `
  <div class="battle">
    <header class="topbar">
      <div class="title">第${s.round}ラウンド <span class="muted">先手: ${who(s.firstPlayer)}</span></div>
      <div class="status ${humanTurn ? 'mine' : ''}">${statusText(game, s)}</div>
      <div class="actions">
        <button data-btn="pass" class="primary" ${humanTurn && s.phase === 'action' && !s.pending ? '' : 'disabled'}>パス${s.passStreak === 1 && s.activePlayer === HUMAN ? '（戦闘へ）' : ''}</button>
        <button data-btn="quit">試合をやめる</button>
      </div>
    </header>
    <div class="layout">
      <aside class="side">
        ${playerPanel(s, r, AI, hl, preview, marks, all)}
        ${playerPanel(s, r, HUMAN, hl, preview, marks, all)}
      </aside>
      <main class="center">
        ${boardHtml(s, r, hl, preview, marks)}
        ${promptHtml(s, step, game)}
        <div class="hand-row">${handHtml(s, r, hl, all)}</div>
      </main>
      <aside class="side right">
        <div class="detail" id="detail"><div class="muted">カードにマウスを乗せると詳しく表示します</div></div>
        ${preview ? previewHtml(s, preview) : ''}
        ${delaysHtml(s, r)}
        ${recentHtml(m.state, m.logMark)}
        <div class="log" id="log">${logHtml(s, m.logMark)}</div>
      </aside>
    </div>
    ${s.phase === 'mulligan' ? mulliganHtml(s) : ''}
    ${s.pending?.player === HUMAN ? chooseHtml(s) : ''}
    ${ui.menuUnit !== null && humanTurn ? unitMenuHtml(r, ui.menuUnit, all) : ''}
    ${s.result ? resultHtml(s) : ''}
  </div>`;

  const log = root.querySelector<HTMLElement>('#log');
  if (log) log.scrollTop = log.scrollHeight;

  root.onclick = (e) => onClick(e, root, game, all, onQuit, onRematch);
  root.onmouseover = (e) => onHover(e, root, s, r);
}

function nextStepOk(all: Action[], sel: Selection, s: GameState): boolean {
  return nextStep(all, sel, s).kind !== 'none';
}

function statusText(game: Game, s: GameState): string {
  if (s.result) return '試合終了';
  if (s.phase === 'mulligan') return game.humanToAct() ? 'マリガン: 引き直すカードを選んでください' : 'AI がマリガン中…';
  if (s.pending) return s.pending.player === HUMAN ? 'カードを1枚選んでください' : 'AI が選んでいます…';
  if (game.aiThinking || s.activePlayer === AI) return 'AI が考えています…';
  return s.passStreak === 1 ? 'あなたの手番（AI はパスしました。パスすると戦闘）' : 'あなたの手番';
}

// ---------------------------------------------------------------- 強調表示

interface Highlights {
  cells: Set<string>;
  lanes: Set<number>;
  players: Set<PlayerId>;
  hand: Set<number>;
  source: string | null;
}

function highlights(step: Step | null, s: GameState): Highlights {
  const h: Highlights = { cells: new Set(), lanes: new Set(), players: new Set(), hand: new Set(), source: null };
  if (ui.sel) {
    const src = ui.sel.source;
    if (src.kind === 'hand') h.source = `hand:${src.uid}`;
    if (src.kind === 'unit') h.source = `unit:${src.uid}`;
  }
  if (!step) return h;
  if (step.kind === 'cell' || step.kind === 'to') for (const i of step.cells) h.cells.add(`${HUMAN}:${i}`);
  if (step.kind === 'target') {
    for (const v of step.values) addValue(h, v, s);
  }
  return h;
}

function addValue(h: Highlights, v: TargetValue, s: GameState): void {
  switch (v.kind) {
    case 'unit':
      for (const p of ['A', 'B'] as const) {
        const i = s.players[p].board.findIndex((u) => u?.uid === v.uid);
        if (i >= 0) h.cells.add(`${p}:${i}`);
      }
      break;
    case 'cell':
      h.cells.add(`${v.p}:${v.i}`);
      break;
    case 'lane':
      h.lanes.add(v.lane);
      break;
    case 'player':
      h.players.add(v.p);
      break;
    case 'card':
      h.hand.add(v.uid);
      break;
  }
}

// ---------------------------------------------------------------- 戦闘の予測（2-3）

interface PreviewInfo {
  life: Record<PlayerId, number>;
  destroyed: Set<number>;
  damage: Map<number, number>;
}

function previewInfo(s: GameState): PreviewInfo {
  const pv = previewCombat(cat, s);
  const damage = new Map<number, number>();
  for (const p of ['A', 'B'] as const) {
    for (const u of s.players[p].board) {
      if (!u) continue;
      const after = pv.state.players[p].board.find((x) => x?.uid === u.uid);
      if (after) {
        const d = after.damage + after.tempDamage - (u.damage + u.tempDamage);
        if (d > 0) damage.set(u.uid, d);
      }
    }
  }
  return { life: pv.life, destroyed: new Set(pv.destroyed), damage };
}

function previewHtml(s: GameState, pv: PreviewInfo): string {
  const line = (p: PlayerId) => {
    const now = s.players[p].life;
    const after = pv.life[p];
    return `<div>${who(p)}: ライフ ${now}${after !== now ? ` → <b class="${after <= 0 ? 'bad' : ''}">${after}</b>` : '（変化なし）'}</div>`;
  };
  const lost = (p: PlayerId) =>
    s.players[p].board.filter((u) => u && pv.destroyed.has(u.uid)).map((u) => cardName(u!.cardId));
  const la = lost(HUMAN);
  const lb = lost(AI);
  return `<div class="box preview"><h3>このまま戦闘になったら</h3>${line(HUMAN)}${line(AI)}
    ${la.length ? `<div class="muted">あなたの破壊: ${esc(la.join('、'))}</div>` : ''}
    ${lb.length ? `<div class="muted">AI の破壊: ${esc(lb.join('、'))}</div>` : ''}
    ${s.delayed.length ? '<div class="muted small">予約中の遅延効果が発動した後の予測です</div>' : ''}</div>`;
}

// ---------------------------------------------------------------- 遅延の予告の印

interface Marks {
  cells: Map<string, string[]>;
  lanes: Map<number, string[]>;
  players: Map<PlayerId, string[]>;
}

function delayMarks(s: GameState, r: Runner): Marks {
  const m: Marks = { cells: new Map(), lanes: new Map(), players: new Map() };
  const add = <K>(map: Map<K, string[]>, k: K, label: string) => map.set(k, [...(map.get(k) ?? []), label]);
  for (const d of s.delayed) {
    const label = `${who(d.owner)}の${cardName(d.cardId)}`;
    for (const vals of Object.values(d.ctx.targets)) {
      for (const v of vals) {
        if (v.kind === 'unit') {
          const loc = r.findUnit(v.uid);
          if (loc) add(m.cells, `${loc.p}:${loc.i}`, label);
        } else if (v.kind === 'cell') add(m.cells, `${v.p}:${v.i}`, label);
        else if (v.kind === 'lane') add(m.lanes, v.lane, label);
        else if (v.kind === 'player') add(m.players, v.p, label);
      }
    }
    if (d.ctx.selfLane !== undefined && !Object.keys(d.ctx.targets).length) add(m.lanes, d.ctx.selfLane, label);
  }
  return m;
}

function delaysHtml(s: GameState, r: Runner): string {
  if (!s.delayed.length) return '';
  const units = unitIndex(s);
  const items = s.delayed.map((d) => {
    const ts = Object.values(d.ctx.targets)
      .flat()
      .map((v) => targetText(v, units))
      .join('、');
    const lane = d.ctx.selfLane !== undefined && !ts ? `レーン${d.ctx.selfLane}` : '';
    return `<li><b>${who(d.owner)}</b>: ${esc(cardName(d.cardId))}${d.enhanced ? '（強化）' : ''}${ts || lane ? ` → ${esc(ts || lane)}` : ''}</li>`;
  });
  void r;
  return `<div class="box delays"><h3>⏳ 予約中の遅延効果</h3><ul>${items.join('')}</ul><div class="muted small">予約した人の次の手番の始めに発動します</div></div>`;
}

function unitIndex(s: GameState) {
  const map = new Map<number, { cardId: string; p: PlayerId; i: number }>();
  for (const p of ['A', 'B'] as const) s.players[p].board.forEach((u, i) => u && map.set(u.uid, { cardId: u.cardId, p, i }));
  return map;
}

// ---------------------------------------------------------------- プレイヤー・リーダー

function playerPanel(s: GameState, r: Runner, p: PlayerId, hl: Highlights, pv: PreviewInfo | null, marks: Marks, all: Action[]): string {
  const st = s.players[p];
  const mark = marks.players.get(p);
  const lifeAfter = pv && pv.life[p] !== st.life ? `<span class="after">→${pv.life[p]}</span>` : '';
  const leaders = st.leaders
    .map((l, idx) => {
      const def = getLeader(cat, l.id);
      const ab = r.leaderAbility(p, idx);
      const usable = p === HUMAN && all.some((a) => a.type === 'leaderAbility' && a.leader === idx);
      return `<div class="leader ${l.grown ? 'grown' : ''} fac-${def.faction}" data-leader-id="${def.id}">
        <div class="lname">${esc(leaderLabel(l.id))}${l.grown ? ' <span class="tag">成長</span>' : ''}</div>
        <div class="small">${l.grown ? '成長済み' : `成長まで ${Math.min(l.progress, def.growth.threshold)}/${def.growth.threshold}`}</div>
        <div class="small">${ab ? `${esc(ab.name)}（${r.leaderCost(p, idx)}）${l.usedThisRound ? ' <span class="muted">使用済み</span>' : ''}` : '<span class="muted">能力なし（パッシブのみ）</span>'}</div>
        ${p === HUMAN && ab ? `<button data-leader-use="${idx}" ${usable ? '' : 'disabled'}>使う</button>` : ''}
      </div>`;
    })
    .join('');
  return `<section class="player ${p === HUMAN ? 'me' : 'ai'}">
    <h2>${who(p)}${s.activePlayer === p && s.phase === 'action' && !s.result ? ' <span class="turn">手番</span>' : ''}</h2>
    <div class="life ${hl.players.has(p) ? 'hl' : ''}" data-player="${p}">❤ ${st.life}${lifeAfter}${mark ? `<span class="dmark" title="${esc(mark.join('、'))}">⏳</span>` : ''}</div>
    <div class="mana"><span class="normal" title="通常マナ（カードに使う）">◆ ${st.mana}/${st.maxMana}</span> <span class="reserve" title="予備マナ（リーダー能力・強化・起動に使う）">◇ ${st.reserve}</span></div>
    <div class="zones small">手札 ${st.hand.length}　山札 ${st.deck.length}　トラッシュ ${st.trash.length}${st.exile.length ? `　除外 ${st.exile.length}` : ''}　使ったスペル ${st.spellsCast}</div>
    ${p === AI && st.hand.some((c) => c.revealed) ? `<div class="small">公開: ${st.hand.filter((c) => c.revealed).map((c) => `<span data-card-id="${c.cardId}" class="link">${esc(cardName(c.cardId))}</span>`).join('、')}</div>` : ''}
    <div class="leaders">${leaders}</div>
  </section>`;
}

// ---------------------------------------------------------------- 盤面

function boardHtml(s: GameState, r: Runner, hl: Highlights, pv: PreviewInfo | null, marks: Marks): string {
  const lanes = [1, 2, 3, 4];
  const header = `<div class="lane-row">${lanes
    .map((l) => {
      const mk = marks.lanes.get(l);
      return `<div class="lane-head ${hl.lanes.has(l) ? 'hl' : ''}" data-lane="${l}">レーン${l}${mk ? ` <span class="dmark" title="${esc(mk.join('、'))}">⏳</span>` : ''}</div>`;
    })
    .join('')}</div>`;
  const row = (p: PlayerId, rowName: 'front' | 'back') =>
    `<div class="board-row ${p === HUMAN ? 'mine' : 'theirs'}">
      <div class="row-label">${who(p)} ${rowName === 'front' ? '前列' : '後列'}</div>
      ${lanes.map((l) => cellHtml(s, r, p, (l - 1) * 2 + (rowName === 'front' ? 0 : 1), hl, pv, marks)).join('')}
    </div>`;
  return `<div class="board">${header}${row(AI, 'back')}${row(AI, 'front')}<div class="frontline">戦線</div>${row(HUMAN, 'front')}${row(HUMAN, 'back')}</div>`;
}

function cellHtml(s: GameState, r: Runner, p: PlayerId, i: number, hl: Highlights, pv: PreviewInfo | null, marks: Marks): string {
  const u = s.players[p].board[i];
  const key = `${p}:${i}`;
  const mk = marks.cells.get(key);
  const cls = ['cell', hl.cells.has(key) ? 'hl' : '', u && hl.source === `unit:${u.uid}` ? 'selected' : '', mk ? 'marked' : ''].join(' ');
  return `<div class="${cls}" data-cell="${key}" title="${cellName(i)}">
    ${u ? unitHtml(r, u, pv) : `<span class="cell-name">${cellName(i)}</span>`}
    ${mk ? `<div class="dmark-cell" title="${esc(mk.join('、'))}">⏳ ${esc(mk.join('、'))}</div>` : ''}
  </div>`;
}

function unitHtml(r: Runner, u: Unit, pv: PreviewInfo | null): string {
  const def = getCard(cat, u.cardId);
  const atk = r.attack(u);
  const hp = r.health(u);
  const max = r.maxHealth(u);
  const kws = [...r.keywords(u)].filter((k) => k !== 'shield');
  const base = def.attack ?? 0;
  const dmg = pv?.damage.get(u.uid);
  const dead = pv?.destroyed.has(u.uid);
  return `<div class="unit fac-${def.faction} ${u.owner === HUMAN ? 'mine' : 'theirs'}" data-card-id="${u.cardId}" data-uid="${u.uid}">
    <div class="uname">${esc(def.name)}${u.isToken ? ' <span class="tag">トークン</span>' : ''}</div>
    <div class="stats"><span class="atk ${atk > base ? 'up' : atk < base ? 'down' : ''}">⚔${atk}</span> <span class="hp ${hp < max ? 'hurt' : max > (def.health ?? 0) ? 'up' : ''}">♥${hp}${hp < max ? `/${max}` : ''}</span>${u.shield ? ' <span class="shield" title="盾">🛡</span>' : ''}</div>
    <div class="kws">${kws.map((k) => `<span class="kw">${KEYWORD_LABEL[k]}</span>`).join('')}</div>
    ${dead ? '<div class="pv dead" title="このまま戦闘になると破壊される">☠</div>' : dmg ? `<div class="pv" title="このまま戦闘になったときのダメージ">-${dmg}</div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- 手札

function handHtml(s: GameState, r: Runner, hl: Highlights, all: Action[]): string {
  const hand = s.players[HUMAN].hand;
  if (!hand.length) return '<div class="muted">手札はありません</div>';
  return hand
    .map((c) => {
      const def = getCard(cat, c.cardId);
      const cost = r.cardCost(HUMAN, c);
      const usable = all.some((a) => (a.type === 'playUnit' || a.type === 'castSpell') && a.card === c.uid);
      const cls = ['card', `fac-${def.faction}`, usable ? 'usable' : 'unusable', hl.hand.has(c.uid) ? 'hl' : '', hl.source === `hand:${c.uid}` ? 'selected' : ''].join(' ');
      return `<div class="${cls}" data-hand="${c.uid}" data-card-id="${c.cardId}">
        <div class="cost ${cost < def.cost ? 'down' : cost > def.cost ? 'up' : ''}">${cost}</div>
        <div class="cname">${esc(def.name)}</div>
        <div class="ctype small">${cardTypeLabel(c.cardId)}${def.type === 'unit' ? `　⚔${def.attack} ♥${def.health}` : ''}</div>
        <div class="kws">${(def.keywords ?? []).map((k) => `<span class="kw">${KEYWORD_LABEL[k]}</span>`).join('')}${c.revealed ? '<span class="tag">公開中</span>' : ''}</div>
        <div class="ctext">${richText(def.text)}</div>
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------- 操作の案内

function promptHtml(s: GameState, step: Step | null, game: Game): string {
  const err = game.error ? `<div class="error">${esc(game.error)}</div>` : '';
  if (!ui.sel || !step) {
    const hint = ui.hint ? `<div class="hint">${esc(ui.hint)}</div>` : '';
    const base = s.phase === 'action' && game.humanToAct() && !s.pending
      ? '手札のカードを選ぶと使えます。盤面の自分のユニットを選ぶと、前進・機動・起動ができます。'
      : '';
    return `<div class="prompt">${err}${hint}<span class="muted">${base}</span></div>`;
  }
  const cancel = '<button data-btn="cancel">やめる</button>';
  const src = sourceLabel(s, ui.sel.source);
  let body = '';
  switch (step.kind) {
    case 'enhance':
      body = `強化しますか？ ${step.options
        .map((o) => {
          const base = step.options[0].cost;
          const cost = o.enhance ? `${base}＋強化${o.cost - base}` : `${base}`;
          return `<button data-btn="enhance-${o.enhance ? 1 : 0}">${o.enhance ? '強化して使う' : 'そのまま使う'}（${cost}）</button>`;
        })
        .join(' ')} <span class="muted small">強化の分は予備マナから先に払います</span>`;
      break;
    case 'cell':
      body = 'ユニットを置くマスを選んでください（光っているマス）';
      break;
    case 'to':
      body = '移動先のマスを選んでください';
      break;
    case 'target': {
      const n = step.need > 1 ? `（${step.picked.length}/${step.need}）` : '';
      body = `${targetPrompt(step)}${n}`;
      break;
    }
    case 'confirm':
      body = `<button class="primary" data-btn="confirm">${esc(src)} を使う</button>`;
      break;
    default:
      body = '';
  }
  return `<div class="prompt active">${err}<b>${esc(src)}</b>: ${body} ${cancel}</div>`;
}

function targetPrompt(step: Extract<Step, { kind: 'target' }>): string {
  const sp = step.spec;
  const side = sp?.side === 'ally' ? '味方の' : sp?.side === 'enemy' ? '敵の' : '';
  switch (sp?.kind) {
    case 'unit':
      return `${side}ユニットを選んでください`;
    case 'cell':
      return `マスを選んでください${sp.where && 'empty' in sp.where && sp.where.empty ? '（空きマス）' : ''}`;
    case 'lane':
      return 'レーンを選んでください（盤面の上の「レーン」をクリック）';
    case 'unitOrPlayer':
      return `${side}ユニットか本体（ライフ）を選んでください`;
    case 'cardInHand':
      return '手札のカードを選んでください';
    default:
      return '対象を選んでください';
  }
}

function sourceLabel(s: GameState, src: Source): string {
  if (src.kind === 'hand') {
    const c = s.players[HUMAN].hand.find((x) => x.uid === src.uid);
    return c ? cardName(c.cardId) : '';
  }
  if (src.kind === 'leader') {
    const l = s.players[HUMAN].leaders[src.idx];
    return `${getLeader(cat, l.id).name}の能力`;
  }
  const u = s.players[HUMAN].board.find((x) => x?.uid === src.uid);
  const name = u ? cardName(u.cardId) : '';
  return src.mode === 'advance' ? `${name}の前進` : src.mode === 'mobileMove' ? `${name}の機動` : `${name}の起動能力`;
}

// ---------------------------------------------------------------- メニュー・選択・マリガン・結果

function unitMenuHtml(r: Runner, uid: number, all: Action[]): string {
  const loc = r.findUnit(uid);
  if (!loc || loc.p !== HUMAN) return '';
  const def = getCard(cat, loc.unit.cardId);
  const items: string[] = [];
  if (all.some((a) => a.type === 'advance' && a.cell === loc.i)) items.push(`<button data-unit-act="advance">前進（${cellName(loc.i)} → ${laneOf(loc.i)}前）</button>`);
  if (all.some((a) => a.type === 'mobileMove' && a.unit === uid)) items.push('<button data-unit-act="mobileMove">機動で移動</button>');
  (def.abilities ?? []).forEach((ab, idx) => {
    if (ab.kind !== 'activated') return;
    const ok = all.some((a) => a.type === 'activate' && a.unit === uid && a.ability === idx);
    items.push(`<button data-unit-act="activate:${idx}" ${ok ? '' : 'disabled'}>起動（${ab.cost}）</button>`);
  });
  const text = def.text ? `<div class="ctext">${richText(def.text)}</div>` : '';
  return `<div class="menu-pop"><div class="menu-box"><b>${esc(def.name)}</b>${text}
    <div class="menu-items">${items.length ? items.join('') : '<span class="muted">今できることはありません</span>'}</div>
    <button data-btn="close-menu">閉じる</button></div></div>`;
}

function chooseHtml(s: GameState): string {
  const opts = s.pending!.options.map((o) => {
    const def = getCard(cat, o.cardId);
    return `<div class="card usable fac-${def.faction}" data-choose="${o.uid}" data-card-id="${o.cardId}">
      <div class="cost">${def.cost}</div><div class="cname">${esc(def.name)}</div>
      <div class="ctype small">${cardTypeLabel(o.cardId)}${def.type === 'unit' ? `　⚔${def.attack} ♥${def.health}` : ''}</div>
      <div class="ctext">${richText(def.text)}</div></div>`;
  });
  return `<div class="overlay"><div class="dialog"><h2>手札に加えるカードを1枚選んでください</h2><div class="choose-row">${opts.join('')}</div><div class="muted">残りは元の順番で山札の上に戻ります</div></div></div>`;
}

function mulliganHtml(s: GameState): string {
  const st = s.players[HUMAN];
  if (st.mulliganDone) return `<div class="overlay"><div class="dialog"><h2>マリガン</h2><p>AI のマリガンを待っています…</p></div></div>`;
  const cards = st.hand.map((c) => {
    const def = getCard(cat, c.cardId);
    const back = ui.mulligan.has(c.uid);
    return `<div class="card usable fac-${def.faction} ${back ? 'returning' : ''}" data-mull="${c.uid}" data-card-id="${c.cardId}">
      <div class="cost">${def.cost}</div><div class="cname">${esc(def.name)}</div>
      <div class="ctype small">${cardTypeLabel(c.cardId)}${def.type === 'unit' ? `　⚔${def.attack} ♥${def.health}` : ''}</div>
      <div class="ctext">${richText(def.text)}</div>
      ${back ? '<div class="back-mark">戻す</div>' : ''}</div>`;
  });
  return `<div class="overlay"><div class="dialog wide"><h2>マリガン</h2>
    <p>戻したいカードをクリックしてください（0〜4枚）。戻した枚数だけ山札から引き直し、戻したカードは山札に混ぜます。</p>
    <div class="choose-row">${cards.join('')}</div>
    <div class="row"><button class="primary" data-btn="mulligan">${ui.mulligan.size ? `${ui.mulligan.size}枚引き直して始める` : 'この手札で始める'}</button></div>
    <p class="muted small">先手: ${who(s.firstPlayer)}</p></div></div>`;
}

function resultHtml(s: GameState): string {
  const res = s.result!;
  const title = res.winner === HUMAN ? '🎉 あなたの勝ち！' : res.winner === AI ? 'AI の勝ち…' : '引き分け';
  const reason = res.reason === 'deckOut' ? '山札切れ' : 'ライフ';
  return `<div class="overlay"><div class="dialog"><h2>${title}</h2>
    <p>${res.winner ? `決め手: ${reason}` : ''}　第${s.round}ラウンドで決着　ライフ あなた ${s.players[HUMAN].life} / AI ${s.players[AI].life}</p>
    <div class="row"><button class="primary" data-btn="rematch">同じデッキでもう一度</button><button data-btn="quit">デッキを選び直す</button><button data-btn="close-result">盤面を見る</button></div></div></div>`;
}

// ---------------------------------------------------------------- ログ

function recentHtml(s: GameState, mark: number): string {
  const lines = s.log
    .map((_e, i) => (i >= mark ? lineFor(s, i) : null))
    .filter((x): x is string => !!x);
  if (!lines.length) return '';
  return `<div class="box recent"><h3>直前の出来事</h3>${lines.slice(-12).map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
}

/** ログの1行の文章。前進・機動の直後の「移動」は同じことなので出さない */
function lineFor(s: GameState, i: number): string | null {
  const e = s.log[i];
  const prev = s.log[i - 1];
  if (e.type === 'move' && prev && (prev.type === 'advance' || prev.type === 'mobile')) return null;
  return logText(e);
}

function logHtml(s: GameState, mark: number): string {
  return s.log
    .map((e, i) => {
      const t = lineFor(s, i);
      return t ? `<div class="${i >= mark ? 'new' : ''} ${e.type === 'roundStart' || e.type === 'combatStart' ? 'sep' : ''}">${esc(t)}</div>` : '';
    })
    .join('');
}

// ---------------------------------------------------------------- 詳細表示

function onHover(e: MouseEvent, root: HTMLElement, s: GameState, r: Runner): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-card-id],[data-leader-id]');
  const box = root.querySelector('#detail');
  if (!el || !box) return;
  if (el.dataset.leaderId) {
    const l = getLeader(cat, el.dataset.leaderId);
    box.innerHTML = `<h3>${esc(l.title)} ${esc(l.name)}</h3><div class="ctext">${richText(l.text)}</div>`;
    return;
  }
  const def = getCard(cat, el.dataset.cardId!);
  const uid = Number(el.dataset.uid);
  const loc = el.dataset.uid ? r.findUnit(uid) : null;
  let extra = '';
  if (loc) {
    const u = loc.unit;
    extra = `<div class="small">${who(loc.p)}の${cellName(loc.i)}　⚔${r.attack(u)} ♥${r.health(u)}/${r.maxHealth(u)}${u.shield ? '　🛡盾' : ''}</div>
      <div class="small">${[...r.keywords(u)].filter((k) => k !== 'shield').map((k) => KEYWORD_LABEL[k]).join('・')}</div>
      ${u.mobileUsed ? '<div class="small muted">このラウンドは機動を使用済み</div>' : ''}`;
  }
  box.innerHTML = `<h3>${esc(def.name)} <span class="muted small">${def.id}</span></h3>
    <div class="small">${cardTypeLabel(def.id)}　コスト${def.cost}${def.type === 'unit' ? `　${def.attack}/${def.health}` : ''}　${esc(cat.factions.get(def.faction) ?? '')}</div>
    <div class="kws">${(def.keywords ?? []).map((k) => `<span class="kw">${KEYWORD_LABEL[k]}</span>`).join('')}</div>
    <div class="ctext">${richText(def.text || '（効果なし）')}</div>${extra}`;
  void s;
}

// ---------------------------------------------------------------- クリック

function onClick(e: MouseEvent, root: HTMLElement, game: Game, all: Action[], onQuit: () => void, onRematch: () => void): void {
  const t = e.target as HTMLElement;
  const m = game.match!;
  const s = m.state;
  const rerender = () => renderBattle(root, game, onQuit, onRematch);
  const btn = t.closest<HTMLElement>('[data-btn]')?.dataset.btn;
  ui.hint = null;
  game.error = null;

  if (btn === 'quit') {
    if (s.result || window.confirm('試合をやめてデッキ選びに戻りますか？')) onQuit();
    return;
  }
  if (btn === 'rematch') return onRematch();
  if (btn === 'close-result') {
    root.querySelector('.overlay')?.remove();
    return;
  }
  if (!game.humanToAct() || game.aiThinking) return;

  // マリガン
  if (s.phase === 'mulligan') {
    const mull = t.closest<HTMLElement>('[data-mull]');
    if (mull) {
      const uid = Number(mull.dataset.mull);
      if (ui.mulligan.has(uid)) ui.mulligan.delete(uid);
      else ui.mulligan.add(uid);
      return rerender();
    }
    if (btn === 'mulligan') {
      const cards = [...ui.mulligan];
      ui.mulligan = new Set();
      game.act({ type: 'mulligan', player: HUMAN, cards });
    }
    return;
  }
  // 効果の途中の選択
  if (s.pending) {
    const ch = t.closest<HTMLElement>('[data-choose]');
    if (ch) game.act({ type: 'choose', player: HUMAN, option: Number(ch.dataset.choose) });
    return;
  }

  if (btn === 'pass') {
    ui.sel = null;
    ui.menuUnit = null;
    return game.act({ type: 'pass', player: HUMAN });
  }
  if (btn === 'cancel') {
    ui.sel = null;
    return rerender();
  }
  if (btn === 'close-menu') {
    ui.menuUnit = null;
    return rerender();
  }

  // ユニットのメニュー
  const unitAct = t.closest<HTMLElement>('[data-unit-act]')?.dataset.unitAct;
  if (unitAct && ui.menuUnit !== null) {
    const [mode, ab] = unitAct.split(':');
    ui.sel = { source: { kind: 'unit', uid: ui.menuUnit, mode: mode as 'advance' | 'mobileMove' | 'activate', ability: ab ? Number(ab) : undefined }, picks: {}, confirmed: true };
    ui.menuUnit = null;
    return advanceSelection(game, all, rerender);
  }
  const leaderUse = t.closest<HTMLElement>('[data-leader-use]')?.dataset.leaderUse;
  if (leaderUse !== undefined) {
    ui.sel = { source: { kind: 'leader', idx: Number(leaderUse) }, picks: {}, confirmed: true };
    return advanceSelection(game, all, rerender);
  }

  // 選択中なら、対象・マスの選択として扱う
  if (ui.sel) {
    const step = nextStep(all, ui.sel, s);
    if (btn?.startsWith('enhance-') && step.kind === 'enhance') {
      ui.sel.enhance = btn === 'enhance-1';
      return advanceSelection(game, all, rerender);
    }
    if (btn === 'confirm' && step.kind === 'confirm') {
      ui.sel.confirmed = true;
      return advanceSelection(game, all, rerender);
    }
    const picked = pickFromClick(t, step, s);
    if (picked) return advanceSelection(game, all, rerender);
  }

  // 手札のカード
  const hand = t.closest<HTMLElement>('[data-hand]');
  if (hand) {
    const uid = Number(hand.dataset.hand);
    if (ui.sel?.source.kind === 'hand' && ui.sel.source.uid === uid) {
      ui.sel = null;
      return rerender();
    }
    if (!all.some((a) => (a.type === 'playUnit' || a.type === 'castSpell') && a.card === uid)) {
      ui.sel = null;
      ui.hint = unusableReason(s, uid);
      return rerender();
    }
    ui.sel = { source: { kind: 'hand', uid }, picks: {} };
    return advanceSelection(game, all, rerender);
  }
  // 自分のユニット
  const cell = t.closest<HTMLElement>('[data-cell]')?.dataset.cell;
  if (cell) {
    const [p, i] = cell.split(':');
    const u = s.players[p as PlayerId].board[Number(i)];
    if (p === HUMAN && u) {
      ui.sel = null;
      ui.menuUnit = u.uid;
      return rerender();
    }
  }
  if (ui.sel || ui.menuUnit !== null) {
    // 関係ないところのクリックは何もしない（選択は「やめる」で取り消す）
    return;
  }
}

/** クリックした場所を今の選択の値にする。当てはまれば true */
function pickFromClick(t: HTMLElement, step: Step, s: GameState): boolean {
  const sel = ui.sel!;
  const cell = t.closest<HTMLElement>('[data-cell]')?.dataset.cell;
  if ((step.kind === 'cell' || step.kind === 'to') && cell) {
    const [p, i] = cell.split(':');
    if (p === HUMAN && step.cells.includes(Number(i))) {
      if (step.kind === 'cell') sel.cell = Number(i);
      else sel.to = Number(i);
      return true;
    }
    return false;
  }
  if (step.kind !== 'target') return false;
  const cands: TargetValue[] = [];
  if (cell) {
    const [p, i] = cell.split(':') as [PlayerId, string];
    const u = s.players[p].board[Number(i)];
    if (u) cands.push({ kind: 'unit', uid: u.uid });
    cands.push({ kind: 'cell', p, i: Number(i) });
  }
  const lane = t.closest<HTMLElement>('[data-lane]')?.dataset.lane;
  if (lane) cands.push({ kind: 'lane', lane: Number(lane) });
  const player = t.closest<HTMLElement>('[data-player]')?.dataset.player;
  if (player) cands.push({ kind: 'player', p: player as PlayerId });
  const hand = t.closest<HTMLElement>('[data-hand]')?.dataset.hand;
  if (hand) cands.push({ kind: 'card', uid: Number(hand) });
  const keys = new Set(step.values.map((v) => canonical([v])));
  const hit = cands.find((v) => keys.has(canonical([v])));
  if (!hit) return false;
  sel.picks[step.id] = [...step.picked, hit];
  return true;
}

function advanceSelection(game: Game, all: Action[], rerender: () => void): void {
  const s = game.match!.state;
  const step = nextStep(all, ui.sel!, s);
  if (step.kind === 'ready') {
    ui.sel = null;
    return game.act(step.action);
  }
  if (step.kind === 'none') {
    ui.sel = null;
    ui.hint = '今は使えません';
  }
  rerender();
}

function unusableReason(s: GameState, uid: number): string {
  const c = s.players[HUMAN].hand.find((x) => x.uid === uid);
  if (!c) return '';
  const r = new Runner(cat, s);
  const def = getCard(cat, c.cardId);
  const cost = r.cardCost(HUMAN, c);
  if (cost > s.players[HUMAN].mana) return `${def.name}: 通常マナが足りません（コスト${cost}、通常マナ${s.players[HUMAN].mana}）`;
  if (def.type === 'unit') return `${def.name}: 置ける空きマスがありません`;
  return `${def.name}: 選べる対象がありません`;
}
