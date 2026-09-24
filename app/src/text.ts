// 画面に出す文字（ログの文章、キーワード名など）
import { getCard, getLeader, type Keyword, type LogEntry, type PlayerId, type TargetValue, cellName } from '../../engine/src';
import { cat } from './data';

export const HUMAN: PlayerId = 'A';
export const AI: PlayerId = 'B';

export const KEYWORD_LABEL: Record<Keyword, string> = {
  ranged: '射撃',
  pierce: '貫通',
  firstStrike: '先制',
  shield: '盾',
  mobile: '遊撃',
  delay: '遅延',
  quick: '即効',
};

export function who(p: unknown): string {
  return p === HUMAN ? 'あなた' : p === AI ? 'AI' : '?';
}

export function cardName(id: unknown): string {
  const c = cat.cards.get(String(id));
  if (c) return c.name;
  const l = cat.leaders.get(String(id));
  return l ? l.name : String(id);
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** 効果文の **強調** を太字にする */
export function richText(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
}

export function targetText(v: TargetValue, units: Map<number, { cardId: string; p: PlayerId; i: number }>): string {
  switch (v.kind) {
    case 'unit': {
      const u = units.get(v.uid);
      return u ? `${who(u.p)}の${cardName(u.cardId)}` : 'ユニット';
    }
    case 'cell':
      return `${who(v.p)}の${cellName(v.i)}`;
    case 'lane':
      return `レーン${v.lane}`;
    case 'player':
      return `${who(v.p)}の本体`;
    case 'card':
      return '手札のカード';
  }
}

const STEP = { firstStrike: '先制ステップ', normal: '通常ステップ' } as Record<string, string>;
const REASON = { life: 'ライフ', deckOut: '山札切れ', draw: '引き分け' } as Record<string, string>;

/** ログの1行を文章にする。表示しないものは null */
export function logText(e: LogEntry): string | null {
  const c = (k = 'card') => cardName(e[k]);
  const p = who(e.player);
  switch (e.type) {
    case 'gameStart':
      return `試合開始。第1ラウンドの先手は${who(e.firstPlayer)}`;
    case 'roundStart':
      return `── 第${e.round}ラウンド開始 ──`;
    case 'mulligan':
      return `${p}はマリガンで${e.count}枚引き直した`;
    case 'playUnit':
      return `${p}が${c()}を${e.cell}に配置${e.enhanced ? '（強化）' : ''}`;
    case 'castSpell':
      return `${p}が${c()}を使用${e.enhanced ? '（強化）' : ''}`;
    case 'mobile':
      return `${p}の${c()}が遊撃で移動`;
    case 'move':
      return `${who(e.player)}の${c()}が${e.from}→${e.to}へ移動`;
    case 'activate':
      return `${p}が${c()}の起動能力を使用`;
    case 'leaderAbility':
      return `${p}がリーダー能力「${e.name}」を使用`;
    case 'pass':
      return `${p}はパス`;
    case 'quickTurn':
      return `即効: ${p}が続けて行動する`;
    case 'delayReserve':
      return `${p}が${c()}の遅延効果を予約`;
    case 'delayResolve':
      return `${p}の${c()}の遅延効果が発動`;
    case 'combatStart':
      return '── 戦闘 ──';
    case 'combatStep':
      return `${STEP[String(e.step)] ?? ''}${(e.lanes as number[]).length < 4 ? `（レーン${(e.lanes as number[]).join('・')}）` : ''}`;
    case 'damage':
      return `${c()}に${e.amount}ダメージ`;
    case 'lifeDamage':
      return `${who(e.player)}の本体に${e.amount}ダメージ（ライフ${e.life}）`;
    case 'shieldBlock':
      return `${c()}の盾がダメージを防いだ`;
    case 'destroy':
      return `${who(e.player)}の${c()}が破壊された`;
    case 'exile':
      return `${who(e.player)}の${c()}が除外された`;
    case 'heal':
      return `${c()}が${e.amount}回復`;
    case 'buff': {
      const sign = (n: unknown) => (Number(n) >= 0 ? `+${n}` : String(n));
      return `${c()}が${e.duration === 'thisRound' ? 'このラウンド中' : ''}${sign(e.attack)}/${sign(e.health)}`;
    }
    case 'grantKeyword':
      return `${c()}が${(e.keywords as Keyword[]).map((k) => KEYWORD_LABEL[k]).join('・')}を得た`;
    case 'summon':
      return `${who(e.player)}の${e.cell}に${c()}が出た`;
    case 'generate':
      return `${p}の手札に${c()}を生成`;
    case 'returnToHand':
      return `${who(e.player)}の${c()}が手札に戻った`;
    case 'handFull':
      return `${p}の手札が上限のため、カードがトラッシュへ`;
    case 'tutor':
      return `${p}が山札からカードを${e.count}枚手札に加えた`;
    case 'pick':
      return `${p}が山札の上から見て1枚手札に加えた`;
    case 'gainReserve':
      return `${p}の予備マナが${e.reserve}に`;
    case 'gainLife':
      return `${p}のライフが${e.amount}回復（ライフ${e.life}）`;
    case 'refillMana':
      return `${p}の通常マナが全回復`;
    case 'reveal':
      return `${p}が手札の${c()}を公開`;
    case 'endure':
      return null;
    case 'grow':
      return `★ ${p}のリーダー ${cardName(e.leader)} が成長した`;
    case 'roundEnd':
      return null;
    case 'gameOver':
      return e.winner ? `試合終了: ${who(e.winner)}の勝ち（${REASON[String(e.reason)]}）` : '試合終了: 引き分け';
    default:
      return null;
  }
}

export function leaderLabel(id: string): string {
  const l = getLeader(cat, id);
  return `${l.title} ${l.name}`;
}

export function cardTypeLabel(id: string): string {
  return getCard(cat, id).type === 'unit' ? 'ユニット' : 'スペル';
}
