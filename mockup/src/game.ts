// 手動モックアップのゲーム操作。ルールの判定はせず、人が行う操作と記録・計算だけを行う。
// どの関数も渡された state を直接書き換える（取り消しは store.ts が操作前の状態を保存して行う）。
import { card, leader } from './data';
import { random, shuffleInPlace } from './rng';
import type {
  CardInstance,
  DeckDef,
  GameState,
  Keyword,
  PlayerId,
  PlayerState,
  Unit,
} from './types';
import { CELL_COUNT, KEYWORD_LABEL, cellLabel, other } from './types';

export const START_LIFE = 20;
export const START_HAND = 4;
export const HAND_LIMIT = 10;
export const MAX_MANA_CAP = 10;

// ---------- 作成 ----------

function emptyPlayer(): PlayerState {
  return {
    deckName: '',
    life: START_LIFE,
    maxMana: 0,
    mana: 0,
    reserve: 0,
    unusedMana: 0,
    spellsCast: 0,
    leaders: [],
    deck: [],
    hand: [],
    trash: [],
    exile: [],
    delayed: [],
    board: Array.from({ length: CELL_COUNT }, () => null),
    cellNotes: Array.from({ length: CELL_COUNT }, () => ''),
  };
}

export function newGame(seed: number): GameState {
  return {
    version: 1,
    phase: 'setup',
    round: 0,
    firstPlayer: 'A',
    activePlayer: 'A',
    passStreak: 0,
    players: { A: emptyPlayer(), B: emptyPlayer() },
    log: [],
    seed,
    rngState: seed,
    nextUid: 1,
    mulligan: { A: { selected: [], done: false }, B: { selected: [], done: false } },
    settings: { autoPay: true, viewPlayer: 'A', hideOpponentHand: false },
  };
}

export function log(s: GameState, player: PlayerId | null, text: string): void {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  s.log.push({ time, round: s.round, player, text });
}

export function newInstance(s: GameState, cardId: string, generated = false): CardInstance {
  card(cardId); // 存在確認
  return { uid: `c${s.nextUid++}`, cardId, costMod: 0, revealed: false, generated };
}

export function toUnit(ci: CardInstance, isToken: boolean): Unit {
  const def = card(ci.cardId);
  return {
    uid: ci.uid,
    cardId: ci.cardId,
    costMod: 0,
    revealed: false,
    generated: ci.generated,
    attackMod: 0,
    healthMod: 0,
    damage: 0,
    tempAttack: 0,
    tempHealth: 0,
    keywordsAdded: [],
    tempKeywords: [],
    shield: (def.keywords ?? []).includes('shield'),
    markers: [],
    memo: '',
    isToken,
  };
}

// 盤面から離れるとき、盤面で得たものはすべてなくなる（ルール仕様書 11.7）
function toCard(u: Unit): CardInstance {
  return { uid: u.uid, cardId: u.cardId, costMod: 0, revealed: false, generated: u.generated };
}

// ---------- ユニットの表示用の値 ----------

export function unitAttack(u: Unit): number {
  return Math.max(0, (card(u.cardId).attack ?? 0) + u.attackMod + u.tempAttack);
}
export function unitMaxHealth(u: Unit): number {
  return (card(u.cardId).health ?? 0) + u.healthMod + u.tempHealth;
}
export function unitHealth(u: Unit): number {
  return unitMaxHealth(u) - u.damage;
}
export function unitKeywords(u: Unit): Keyword[] {
  const base = (card(u.cardId).keywords ?? []).filter((k) => k !== 'shield' && k !== 'delay' && k !== 'quick');
  const all = [...base, ...u.keywordsAdded.filter((k) => k !== 'shield'), ...u.tempKeywords.filter((k) => k !== 'shield')];
  return [...new Set(all)];
}
export function handCost(ci: CardInstance): number {
  return Math.max(0, card(ci.cardId).cost + ci.costMod);
}

// ---------- 試合の準備 ----------

export function setupDeck(s: GameState, p: PlayerId, deck: DeckDef): void {
  const pl = s.players[p];
  pl.deckName = deck.name;
  pl.leaders = deck.leaders.map((id) => {
    leader(id);
    return { leaderId: id, grown: false, progress: 0, usedThisRound: false, abilityCostMod: 0 };
  });
  pl.deck = [];
  for (const { id, count } of deck.cards) {
    for (let i = 0; i < count; i++) pl.deck.push(newInstance(s, id));
  }
  log(s, p, `デッキ「${deck.name}」を使う（${pl.deck.length}枚）`);
}

export function startGame(s: GameState, first: PlayerId | 'random'): void {
  s.firstPlayer = first === 'random' ? (random(s) < 0.5 ? 'A' : 'B') : first;
  s.activePlayer = s.firstPlayer;
  for (const p of ['A', 'B'] as PlayerId[]) {
    shuffleInPlace(s, s.players[p].deck);
    drawCards(s, p, START_HAND, true);
  }
  s.phase = 'mulligan';
  log(s, null, `試合開始。第1ラウンドの先手は ${s.firstPlayer}`);
}

export function toggleMulligan(s: GameState, p: PlayerId, uid: string): void {
  const sel = s.mulligan[p].selected;
  const i = sel.indexOf(uid);
  if (i >= 0) sel.splice(i, 1);
  else sel.push(uid);
}

// マリガン: 選んだカードを脇に置き、同じ枚数を引いてから、脇のカードを山札に戻してシャッフル（3.3）
export function confirmMulligan(s: GameState, p: PlayerId): void {
  const pl = s.players[p];
  const sel = new Set(s.mulligan[p].selected);
  const aside = pl.hand.filter((c) => sel.has(c.uid));
  pl.hand = pl.hand.filter((c) => !sel.has(c.uid));
  drawCards(s, p, aside.length, true);
  pl.deck.push(...aside);
  shuffleInPlace(s, pl.deck);
  s.mulligan[p].done = true;
  log(s, p, `マリガン: ${aside.length}枚を引き直した`);
  if (s.mulligan.A.done && s.mulligan.B.done) {
    s.phase = 'playing';
    roundStart(s);
  }
}

// ---------- ラウンドの補助（ルール仕様書 6.1 / 6.4） ----------

export function roundStart(s: GameState): void {
  s.round += 1;
  if (s.round > 1) s.firstPlayer = other(s.firstPlayer);
  s.activePlayer = s.firstPlayer;
  s.passStreak = 0;
  log(s, null, `―― ラウンド ${s.round} 開始（先手 ${s.firstPlayer}）――`);
  for (const p of ['A', 'B'] as PlayerId[]) {
    const pl = s.players[p];
    pl.maxMana = Math.min(MAX_MANA_CAP, pl.maxMana + 1);
    const before = pl.reserve;
    pl.reserve = Math.min(pl.maxMana, pl.reserve + pl.unusedMana);
    pl.unusedMana = 0;
    pl.mana = pl.maxMana;
    for (const l of pl.leaders) l.usedThisRound = false;
    for (const u of pl.board) {
      if (u) u.markers = u.markers.filter((m) => m !== '起動済み' && m !== '機動済み');
    }
    log(s, p, `最大マナ ${pl.maxMana}、予備マナ ${before}→${pl.reserve}、通常マナ全回復`);
    drawCards(s, p, 1);
  }
}

export function roundEnd(s: GameState): string[] {
  const reminders: string[] = [];
  log(s, null, `―― ラウンド ${s.round} 終了 ――`);
  for (const p of ['A', 'B'] as PlayerId[]) {
    const pl = s.players[p];
    pl.board.forEach((u, i) => {
      if (!u) return;
      if (u.markers.includes('ラウンド終了時に処理')) {
        reminders.push(`${p} ${cellLabel(i)} ${card(u.cardId).name}${u.memo ? `（${u.memo}）` : ''}`);
      }
      clearTemporary(u);
    });
    pl.cellNotes.forEach((n, i) => {
      if (n) reminders.push(`${p} のマス ${cellLabel(i)} の印: ${n}`);
    });
    pl.unusedMana = pl.mana;
    log(s, p, `使い残した通常マナ ${pl.mana} を記録`);
  }
  for (const r of reminders) log(s, null, `ラウンド終了時の処理を確認: ${r}`);
  return reminders;
}

// 一時的な強化を外す。一時的な体力が受け止めていたダメージも消える（10.4）
export function clearTemporary(u: Unit): void {
  if (u.tempHealth > 0) {
    u.damage = Math.max(0, u.damage - Math.min(u.damage, u.tempHealth));
  }
  u.tempAttack = 0;
  u.tempHealth = 0;
  u.tempKeywords = [];
}

// 手番の交代。pass=true ならパスとして記録し、双方が続けてパスしたら知らせる
export function endTurn(s: GameState, pass: boolean): void {
  const p = s.activePlayer;
  if (pass) {
    s.passStreak += 1;
    log(s, p, 'パス');
  } else {
    s.passStreak = 0;
    log(s, p, '手番を終える');
  }
  s.activePlayer = other(p);
  if (s.passStreak >= 2) {
    log(s, null, '双方が続けてパス → 戦闘フェイズへ（予約中の遅延効果があれば先に発動）');
    s.passStreak = 0;
  }
}

// ---------- 山札 ----------

export function drawCards(s: GameState, p: PlayerId, n: number, silent = false): void {
  const pl = s.players[p];
  for (let i = 0; i < n; i++) {
    const c = pl.deck.shift();
    if (!c) {
      log(s, p, '山札が0枚で引けない（山札切れ）');
      return;
    }
    if (pl.hand.length >= HAND_LIMIT) {
      pl.trash.push(c);
      log(s, p, `手札が上限なので ${card(c.cardId).name} をトラッシュへ`);
    } else {
      pl.hand.push(c);
      if (!silent) log(s, p, `1枚引く`);
    }
  }
}

export function shuffleDeck(s: GameState, p: PlayerId): void {
  shuffleInPlace(s, s.players[p].deck);
  log(s, p, '山札をシャッフル');
}

// 山札から指定のカードを手札へ（上から見る・探す 用）
export function takeFromDeck(s: GameState, p: PlayerId, uid: string, reason: string): void {
  const pl = s.players[p];
  const i = pl.deck.findIndex((c) => c.uid === uid);
  if (i < 0) return;
  const [c] = pl.deck.splice(i, 1);
  pl.hand.push(c);
  log(s, p, `${reason}: ${card(c.cardId).name} を手札へ`);
}

// 条件に合うカードをランダムに手札へ加え、山札をシャッフル（11.7）
export function tutorRandom(s: GameState, p: PlayerId, type: 'unit' | 'spell', count: number): void {
  const pl = s.players[p];
  for (let k = 0; k < count; k++) {
    const candidates = pl.deck.filter((c) => card(c.cardId).type === type);
    if (candidates.length === 0 || pl.hand.length >= HAND_LIMIT) break;
    const pick = candidates[Math.floor(random(s) * candidates.length)];
    takeFromDeck(s, p, pick.uid, `ランダムな${type === 'unit' ? 'ユニット' : 'スペル'}`);
  }
  shuffleInPlace(s, pl.deck);
}

// ---------- カードの移動 ----------

export type Zone = 'hand' | 'board' | 'trash' | 'exile' | 'deckTop' | 'deckBottom';
export interface Loc {
  p: PlayerId;
  zone: Zone;
  index?: number; // board のマス番号
  uid?: string; // hand / trash / exile のカード
}

const ZONE_LABEL: Record<Zone, string> = {
  hand: '手札',
  board: '盤面',
  trash: 'トラッシュ',
  exile: '除外ゾーン',
  deckTop: '山札の上',
  deckBottom: '山札の下',
};

function takeFrom(s: GameState, from: Loc): { ci: CardInstance; unit: Unit | null } | null {
  const pl = s.players[from.p];
  if (from.zone === 'board') {
    const u = pl.board[from.index!];
    if (!u) return null;
    pl.board[from.index!] = null;
    return { ci: toCard(u), unit: u };
  }
  const list = from.zone === 'hand' ? pl.hand : from.zone === 'trash' ? pl.trash : from.zone === 'exile' ? pl.exile : null;
  if (!list) return null;
  const i = list.findIndex((c) => c.uid === from.uid);
  if (i < 0) return null;
  const [ci] = list.splice(i, 1);
  return { ci, unit: null };
}

export function moveCard(s: GameState, from: Loc, to: Loc): boolean {
  if (to.zone === 'board') {
    const target = s.players[to.p].board[to.index!];
    if (target) return false; // 空きマスにしか置けない
  }
  if (to.zone === 'board' && from.p !== to.p) return false; // 相手の盤面には置けない・動かせない（12章）
  const taken = takeFrom(s, from);
  if (!taken) return false;
  const { ci, unit } = taken;
  const name = card(ci.cardId).name;
  const dest = s.players[to.p];

  if (to.zone === 'board') {
    if (unit) {
      dest.board[to.index!] = unit; // 盤面内の移動: 状態はそのまま
      log(s, to.p, `${name} を ${cellLabel(from.index!)} → ${cellLabel(to.index!)} へ移動`);
    } else {
      dest.board[to.index!] = toUnit(ci, false);
      let pay = '';
      if (from.zone === 'hand' && s.settings.autoPay) pay = payCost(s, from.p, handCost(ci));
      log(s, to.p, `${name} を ${cellLabel(to.index!)} に配置${pay}`);
    }
    return true;
  }

  // 盤面の外へ
  if (unit?.isToken) {
    log(s, from.p, `${name}（トークン）は盤面を離れて消えた`);
    return true;
  }
  const owner = s.players[from.p]; // カードは持ち主のゾーンへ
  if (to.zone === 'hand') {
    if (owner.hand.length >= HAND_LIMIT) {
      owner.trash.push(ci);
      log(s, from.p, `手札が上限なので ${name} をトラッシュへ`);
      return true;
    }
    owner.hand.push(ci);
  } else if (to.zone === 'trash') owner.trash.push(ci);
  else if (to.zone === 'exile') owner.exile.push(ci);
  else if (to.zone === 'deckTop') owner.deck.unshift(ci);
  else if (to.zone === 'deckBottom') owner.deck.push(ci);
  const fromLabel = from.zone === 'board' ? cellLabel(from.index!) : ZONE_LABEL[from.zone];
  log(s, from.p, `${name} を ${fromLabel} → ${ZONE_LABEL[to.zone]}`);
  return true;
}

function payCost(s: GameState, p: PlayerId, cost: number): string {
  const pl = s.players[p];
  if (cost <= 0) return '';
  const before = pl.mana;
  pl.mana = Math.max(0, pl.mana - cost);
  return before < cost ? `（コスト${cost}。通常マナが足りない: ${before}→0）` : `（コスト${cost}、通常マナ ${before}→${pl.mana}）`;
}

// スペルを使う。mode='delay' なら遅延ゾーンへ予約、そうでなければトラッシュへ。使ったスペルの枚数は効果の後に+1
export function useSpell(s: GameState, p: PlayerId, uid: string, mode: 'trash' | 'delay', note = ''): void {
  const pl = s.players[p];
  const i = pl.hand.findIndex((c) => c.uid === uid);
  if (i < 0) return;
  const [ci] = pl.hand.splice(i, 1);
  const name = card(ci.cardId).name;
  const pay = s.settings.autoPay ? payCost(s, p, handCost(ci)) : '';
  if (mode === 'delay') {
    pl.delayed.push({ uid: ci.uid, cardId: ci.cardId, note, round: s.round, card: { ...ci, costMod: 0, revealed: false } });
    log(s, p, `${name} を使い、遅延を予約${note ? `（${note}）` : ''}${pay}`);
  } else {
    pl.trash.push({ ...ci, costMod: 0, revealed: false });
    log(s, p, `${name} を使う${pay}`);
  }
  pl.spellsCast += 1;
}

// ユニットや能力の遅延を記録する（カードは動かさない）
export function addDelayNote(s: GameState, p: PlayerId, cardId: string, note: string): void {
  s.players[p].delayed.push({ uid: `d${s.nextUid++}`, cardId, note, round: s.round, card: null });
  log(s, p, `遅延を予約: ${card(cardId).name}${note ? `（${note}）` : ''}`);
}

export function resolveDelay(s: GameState, p: PlayerId, uid: string): void {
  const pl = s.players[p];
  const i = pl.delayed.findIndex((d) => d.uid === uid);
  if (i < 0) return;
  const [d] = pl.delayed.splice(i, 1);
  if (d.card) pl.trash.push(d.card);
  log(s, p, `遅延効果が発動: ${card(d.cardId).name}${d.note ? `（${d.note}）` : ''}`);
}

// ---------- 盤面のユニット ----------

export function unitAt(s: GameState, p: PlayerId, index: number): Unit | null {
  return s.players[p].board[index];
}

export function damageUnit(s: GameState, p: PlayerId, index: number, amount: number, useShield: boolean): void {
  const u = unitAt(s, p, index);
  if (!u) return;
  const name = card(u.cardId).name;
  if (useShield && u.shield) {
    u.shield = false;
    log(s, p, `${name}（${cellLabel(index)}）の盾が ${amount}ダメージを防いだ`);
    return;
  }
  u.damage += amount;
  log(s, p, `${name}（${cellLabel(index)}）に ${amount}ダメージ（残り体力 ${unitHealth(u)}）`);
}

export function healUnit(s: GameState, p: PlayerId, index: number, amount: number): void {
  const u = unitAt(s, p, index);
  if (!u) return;
  u.damage = Math.max(0, u.damage - amount);
  log(s, p, `${card(u.cardId).name}（${cellLabel(index)}）を回復${amount}（残り体力 ${unitHealth(u)}）`);
}

export function modifyUnit(
  s: GameState,
  p: PlayerId,
  index: number,
  attack: number,
  health: number,
  temporary: boolean,
): void {
  const u = unitAt(s, p, index);
  if (!u) return;
  if (temporary) {
    u.tempAttack += attack;
    u.tempHealth += health;
  } else {
    u.attackMod += attack;
    u.healthMod += health;
  }
  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  log(s, p, `${card(u.cardId).name}（${cellLabel(index)}）を ${sign(attack)}/${sign(health)}${temporary ? '（このラウンド中）' : ''}`);
}

export function grantKeyword(s: GameState, p: PlayerId, index: number, kw: Keyword, temporary: boolean): void {
  const u = unitAt(s, p, index);
  if (!u) return;
  if (kw === 'shield') {
    u.shield = true;
  } else {
    const list = temporary ? u.tempKeywords : u.keywordsAdded;
    if (!list.includes(kw)) list.push(kw);
  }
  log(s, p, `${card(u.cardId).name}（${cellLabel(index)}）に${KEYWORD_LABEL[kw]}を与える${temporary && kw !== 'shield' ? '（このラウンド中）' : ''}`);
}

export function removeKeyword(s: GameState, p: PlayerId, index: number, kw: Keyword): void {
  const u = unitAt(s, p, index);
  if (!u) return;
  if (kw === 'shield') u.shield = false;
  u.keywordsAdded = u.keywordsAdded.filter((k) => k !== kw);
  u.tempKeywords = u.tempKeywords.filter((k) => k !== kw);
  log(s, p, `${card(u.cardId).name}（${cellLabel(index)}）の${KEYWORD_LABEL[kw]}を外す`);
}

export function toggleMarker(s: GameState, p: PlayerId, index: number, marker: string): void {
  const u = unitAt(s, p, index);
  if (!u) return;
  const has = u.markers.includes(marker);
  u.markers = has ? u.markers.filter((m) => m !== marker) : [...u.markers, marker];
  log(s, p, `${card(u.cardId).name}（${cellLabel(index)}）の目印「${marker}」を${has ? '外す' : '付ける'}`);
}

export function setUnitMemo(s: GameState, p: PlayerId, index: number, memo: string): void {
  const u = unitAt(s, p, index);
  if (!u) return;
  u.memo = memo;
  log(s, p, `${card(u.cardId).name}（${cellLabel(index)}）のメモ: ${memo || '（消去）'}`);
}

export function clearUnitTemporary(s: GameState, p: PlayerId, index: number): void {
  const u = unitAt(s, p, index);
  if (!u) return;
  clearTemporary(u);
  log(s, p, `${card(u.cardId).name}（${cellLabel(index)}）のこのラウンド中の効果を外す`);
}

export function advanceUnit(s: GameState, p: PlayerId, index: number): boolean {
  if (index % 2 !== 1) return false; // 後列のみ
  const front = index - 1;
  if (s.players[p].board[front]) return false;
  const u = s.players[p].board[index]!;
  s.players[p].board[front] = u;
  s.players[p].board[index] = null;
  log(s, p, `${card(u.cardId).name} が前進（${cellLabel(index)} → ${cellLabel(front)}）`);
  return true;
}

export function setCellNote(s: GameState, p: PlayerId, index: number, note: string): void {
  s.players[p].cellNotes[index] = note;
  log(s, p, `マス ${cellLabel(index)} の印: ${note || '（消去）'}`);
}

// ---------- カード一覧から ----------

export function generateToHand(s: GameState, p: PlayerId, cardId: string): void {
  const pl = s.players[p];
  if (pl.hand.length >= HAND_LIMIT) {
    log(s, p, `手札が上限なので ${card(cardId).name} は生成されない`);
    return;
  }
  pl.hand.push(newInstance(s, cardId, true));
  log(s, p, `${card(cardId).name} を手札に生成`);
}

export function summonToken(s: GameState, p: PlayerId, cardId: string, index: number): boolean {
  const pl = s.players[p];
  if (pl.board[index]) return false;
  pl.board[index] = toUnit(newInstance(s, cardId, true), true);
  log(s, p, `${card(cardId).name} を ${cellLabel(index)} に出す（トークン）`);
  return true;
}

// ---------- 数値 ----------

export type Counter = 'life' | 'maxMana' | 'mana' | 'reserve' | 'unusedMana' | 'spellsCast';
export const COUNTER_LABEL: Record<Counter, string> = {
  life: 'ライフ',
  maxMana: '最大マナ',
  mana: '通常マナ',
  reserve: '予備マナ',
  unusedMana: '使い残し',
  spellsCast: '使ったスペル',
};

export function adjustCounter(s: GameState, p: PlayerId, c: Counter, delta: number): void {
  const pl = s.players[p];
  const before = pl[c];
  pl[c] = Math.max(c === 'life' ? -99 : 0, before + delta);
  log(s, p, `${COUNTER_LABEL[c]} ${before} → ${pl[c]}`);
  if (c === 'life' && pl.life <= 0) log(s, null, `${p} のライフが0以下（勝敗を確認）`);
}

export function adjustHandCost(s: GameState, p: PlayerId, uid: string, delta: number): void {
  const ci = s.players[p].hand.find((c) => c.uid === uid);
  if (!ci) return;
  ci.costMod += delta;
  log(s, p, `手札の ${card(ci.cardId).name} のコスト → ${handCost(ci)}`);
}

export function toggleReveal(s: GameState, p: PlayerId, uid: string): void {
  const ci = s.players[p].hand.find((c) => c.uid === uid);
  if (!ci) return;
  ci.revealed = !ci.revealed;
  log(s, p, `手札の ${card(ci.cardId).name} を${ci.revealed ? '公開' : '非公開に'}`);
}

// ---------- リーダー ----------

export function leaderAbilityCost(s: GameState, p: PlayerId, i: number): number | null {
  const ls = s.players[p].leaders[i];
  const def = leader(ls.leaderId);
  const ab = ls.grown ? def.grown.ability : def.ability;
  if (!ab) return null;
  return Math.max(0, ab.cost + ls.abilityCostMod);
}

export function useLeaderAbility(s: GameState, p: PlayerId, i: number): void {
  const pl = s.players[p];
  const ls = pl.leaders[i];
  const def = leader(ls.leaderId);
  const ab = ls.grown ? def.grown.ability : def.ability;
  if (!ab) return;
  const cost = leaderAbilityCost(s, p, i) ?? 0;
  // 予備マナから優先して払い、足りない分を通常マナから払う（16.2）
  const fromReserve = Math.min(pl.reserve, cost);
  const fromMana = Math.min(pl.mana, cost - fromReserve);
  pl.reserve -= fromReserve;
  pl.mana -= fromMana;
  const short = cost - fromReserve - fromMana;
  ls.usedThisRound = true;
  log(
    s,
    p,
    `${def.name}「${ab.name}」を使う（コスト${cost}: 予備${fromReserve}＋通常${fromMana}${short > 0 ? `、${short}不足` : ''}）`,
  );
}

export function adjustLeader(
  s: GameState,
  p: PlayerId,
  i: number,
  field: 'progress' | 'abilityCostMod',
  delta: number,
): void {
  const ls = s.players[p].leaders[i];
  ls[field] = field === 'progress' ? Math.max(0, ls[field] + delta) : ls[field] + delta;
  const def = leader(ls.leaderId);
  if (field === 'progress') {
    log(s, p, `${def.name} の成長条件 ${ls.progress}/${def.growth.threshold}`);
  } else {
    log(s, p, `${def.name} の能力コスト → ${leaderAbilityCost(s, p, i) ?? '-'}`);
  }
}

export function toggleLeader(s: GameState, p: PlayerId, i: number, field: 'grown' | 'usedThisRound'): void {
  const ls = s.players[p].leaders[i];
  ls[field] = !ls[field];
  const def = leader(ls.leaderId);
  log(s, p, field === 'grown' ? `${def.name} を${ls.grown ? '成長' : '通常'}の段階に` : `${def.name} の能力を${ls.usedThisRound ? '使用済み' : '未使用'}に`);
}

export function addMemo(s: GameState, text: string): void {
  log(s, null, `メモ: ${text}`);
}
