// カード・ユニット・リーダーの表示
import { card, factionName, leader } from '../data';
import { handCost, unitAttack, unitHealth, unitKeywords, unitMaxHealth } from '../game';
import type { CardDef, CardInstance, Keyword, LeaderState, Unit } from '../types';
import { KEYWORD_LABEL } from '../types';
import { esc } from './common';

function kwChips(kws: Keyword[], cls = ''): string {
  return kws.map((k) => `<span class="kw ${cls}">${KEYWORD_LABEL[k]}</span>`).join('');
}

export function statsText(def: CardDef): string {
  return def.type === 'unit' ? `${def.attack}/${def.health}` : 'スペル';
}

// 手札のカード
export function handCardHtml(ci: CardInstance, drag: string, hidden: boolean): string {
  if (hidden) {
    return `<div class="card back${ci.revealed ? ' revealed' : ''}" data-hand-uid="${ci.uid}">${ci.revealed ? cardInner(ci) : '<span class="back-mark">？</span>'}</div>`;
  }
  return `<div class="card f-${card(ci.cardId).faction}" draggable="true" data-drag='${drag}' data-card-id="${ci.cardId}" data-hand-uid="${ci.uid}">${cardInner(ci)}</div>`;
}

function cardInner(ci: CardInstance): string {
  const def = card(ci.cardId);
  const cost = handCost(ci);
  const costCls = ci.costMod < 0 ? 'down' : ci.costMod > 0 ? 'up' : '';
  const tags = [ci.revealed ? '<span class="tag">公開</span>' : '', ci.generated ? '<span class="tag">生成</span>' : ''].join('');
  return `<div class="c-top"><span class="cost ${costCls}">${cost}</span><span class="c-name">${esc(def.name)}</span></div>
    <div class="c-mid">${kwChips(def.keywords ?? [])}${tags}</div>
    <div class="c-bottom">${def.type === 'unit' ? `<b>${def.attack}</b> / <b>${def.health}</b>` : '<i>スペル</i>'}</div>`;
}

// 盤面のユニット
export function unitHtml(u: Unit, drag: string): string {
  const def = card(u.cardId);
  const atk = unitAttack(u);
  const hp = unitHealth(u);
  const maxHp = unitMaxHealth(u);
  const atkCls = atk > (def.attack ?? 0) ? 'up' : atk < (def.attack ?? 0) ? 'down' : '';
  const hpCls = u.damage > 0 || maxHp < (def.health ?? 0) ? 'down' : maxHp > (def.health ?? 0) ? 'up' : '';
  const temp = u.tempKeywords;
  const perm = unitKeywords(u).filter((k) => !temp.includes(k));
  const tempStat =
    u.tempAttack || u.tempHealth
      ? `<span class="tag temp">ﾗｳﾝﾄﾞ中 ${u.tempAttack >= 0 ? '+' : ''}${u.tempAttack}/${u.tempHealth >= 0 ? '+' : ''}${u.tempHealth}</span>`
      : '';
  const markers = u.markers.map((m) => `<span class="tag marker">${esc(m)}</span>`).join('');
  return `<div class="unit f-${def.faction}${hp <= 0 ? ' dying' : ''}" draggable="true" data-drag='${drag}' data-card-id="${u.cardId}">
    <div class="c-top"><span class="c-name">${esc(def.name)}</span>${u.isToken ? '<span class="tag">トークン</span>' : ''}</div>
    <div class="c-mid">${u.shield ? '<span class="kw shield">盾</span>' : ''}${kwChips(perm)}${kwChips(temp, 'temp')}${tempStat}${markers}</div>
    ${u.memo ? `<div class="memo">${esc(u.memo)}</div>` : ''}
    <div class="c-bottom"><span class="atk ${atkCls}">${atk}</span><span class="sep">/</span><span class="hp ${hpCls}">${hp}</span>${u.damage > 0 ? `<span class="dmg">(${maxHp}-${u.damage})</span>` : ''}</div>
  </div>`;
}

// 詳細パネル
export function cardDetailHtml(cardId: string): string {
  const def = card(cardId);
  return `<div class="detail-head f-${def.faction}"><span class="cost">${def.cost}</span><b>${esc(def.name)}</b>
    <span class="muted">${esc(def.id)}・${esc(factionName(def.faction))}・${def.type === 'unit' ? 'ユニット' : 'スペル'}</span>
    ${def.type === 'unit' ? `<span class="stats">${def.attack}/${def.health}</span>` : ''}${kwChips(def.keywords ?? [])}</div>
    <div class="detail-text">${esc(def.text || '（効果なし）')}</div>`;
}

export function leaderDetailHtml(id: string): string {
  const l = leader(id);
  return `<div class="detail-head f-${l.faction}"><b>${esc(l.title)} ${esc(l.name)}</b><span class="muted">リーダー・${esc(factionName(l.faction))}</span></div>
    <div class="detail-text">${esc(l.text)}</div>`;
}

export function leaderHtml(ls: LeaderState, p: string, i: number, cost: number | null): string {
  const l = leader(ls.leaderId);
  const ab = ls.grown ? l.grown.ability : l.ability;
  return `<div class="leader f-${l.faction}${ls.usedThisRound ? ' used' : ''}" data-leader-id="${l.id}">
    <div class="l-head"><b>${esc(l.name)}</b><span class="tag ${ls.grown ? 'grown' : ''}">${ls.grown ? '成長' : '通常'}</span>${ls.usedThisRound ? '<span class="tag">使用済み</span>' : ''}</div>
    <div class="l-ability">${ab ? `${esc(ab.name)}（${cost}）` : '<span class="muted">能力なし（パッシブのみ）</span>'}</div>
    <div class="l-row">成長 <button data-act="leaderAdj" data-args='["${p}",${i},"progress",-1]'>−</button><span class="num">${ls.progress}/${l.growth.threshold}</span><button data-act="leaderAdj" data-args='["${p}",${i},"progress",1]'>＋</button>
      <span class="spacer"></span>コスト<button data-act="leaderAdj" data-args='["${p}",${i},"abilityCostMod",-1]'>−</button><button data-act="leaderAdj" data-args='["${p}",${i},"abilityCostMod",1]'>＋</button></div>
    <div class="l-row"><button data-act="leaderUse" data-args='["${p}",${i}]' ${ab && !ls.usedThisRound ? '' : 'disabled'}>能力を使う</button>
      <button data-act="leaderToggle" data-args='["${p}",${i},"usedThisRound"]'>${ls.usedThisRound ? '未使用に' : '使用済みに'}</button>
      <button data-act="leaderToggle" data-args='["${p}",${i},"grown"]'>${ls.grown ? '通常に戻す' : '成長'}</button></div>
  </div>`;
}
