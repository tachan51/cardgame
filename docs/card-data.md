# カードデータ形式（v0.4）

> ステータス: ドラフト
> 最終更新: 2026-09-26
> 関連: [ルール仕様書](rules.md) v1.11 / [カードリスト](cards.md) v0.8 / [タスクリスト](tasks.md)（0-5）
>
> カード・リーダーを JSON で表すための形式。ルールエンジン（TypeScript 版・Godot 版）はこのデータを読み込んで動く。
> 試遊版3勢力の75枚（とトークン専用のカード）とリーダー3人を、この形式で `data/cards/` に書き起こした（7章）。
>
> | 版 | 内容 |
> |---|---|
> | v0.1 | 初版 |
> | v0.4 | カードリスト v0.8 に合わせて、処理 `repeat`・`summonRandom`、`summon` の `as`、`tutorRandom` の `highestCost`、セレクタ `randomCell`、常時効果の `cardKeywords`、カードの `token`、成長条件 `spellsCast` を追加 |
> | v0.3 | カードリスト v0.7 に合わせて、`costReduction`（試合中の回数でコストを下げる）、`gainLife`、`tutorRandom` の `distinctNames`・`as`、セレクタの `other`（自分を除く）、数値 `unitMovesThisGame`、成長条件 `unitMoved` を追加。前進の廃止に合わせて文章を直した |
> | v0.2 | 書き起こしに合わせて、マスの持ち主に `"any"` と `{ sameOwnerAs }` を追加。強化だけを持つユニットの書き方を追加。「使ったスペルの枚数」に自身を含めないことを確定 |

---

## 1. 方針

| 方針 | 内容 |
|---|---|
| 効果はデータで書く | カードごとにプログラムを書かず、決まった部品（きっかけ・対象・処理）の組み合わせで効果を表す。新しいカードの多くはデータを足すだけで作れる |
| 部品は小さく、組み合わせで表す | 「ダメージ」「移動」「強化」などの基本の処理を用意し、条件・対象・数値を指定して組み合わせる |
| 文章は別に持つ | 画面に出す日本語の効果文（`text`）はデータに含めるが、ゲームの動きは `text` ではなく構造化したデータだけで決める |
| 2つのエンジンで共通 | TypeScript 版と Godot 版が同じ JSON を読む。JSON に書けるもの（文字列・数値・真偽値・配列・オブジェクト）だけを使う |
| 表せない効果は形式を広げる | カード1枚だけのための特別扱いは作らない。どうしても必要なら、その処理を部品として追加する |

---

## 2. ファイル構成

```
data/
  cards/
    knights.json      王国騎士団（リーダー1人＋カード25枚）
    cyber.json        電脳都市
    academy.json      魔法学院
  decks/
    ai-knights-cyber.json   AI用デッキ（タスク 0-8）
    ...
```

1つの勢力ファイルの形:

```json
{
  "formatVersion": 1,
  "faction": { "id": "knights", "name": "王国騎士団" },
  "leader": { ... },
  "cards": [ { ... }, { ... } ]
}
```

---

## 3. 全体の形（TypeScript の型で表記）

JSON の形を分かりやすく示すため、TypeScript の型で書く。`?` は省略できる項目。

### 3.1 カード

```ts
type Card = {
  id: string;                 // "KN-12"。全カードで一意
  name: string;               // "城壁の守り手"
  faction: FactionId;         // "knights" | "cyber" | "academy"
  type: "unit" | "spell";
  cost: number;               // 通常マナのコスト
  attack?: number;            // ユニットのみ
  health?: number;            // ユニットのみ
  keywords?: Keyword[];       // 生まれつき持つキーワード
  targets?: TargetSpec[];     // スペルを使うときに選ぶ対象
  effects?: Effect[];         // スペルを使ったときの効果
  abilities?: Ability[];      // ユニットの誘発・常時・起動能力、手札にある間の効果
  enhance?: Enhance;          // 強化
  token?: boolean;            // 効果で出すためだけのカード。デッキには入れられない（TK-01）
  text: string;               // 画面に出す効果文（表示専用）
};

type FactionId = "knights" | "cyber" | "academy";
type Keyword = "ranged" | "pierce" | "firstStrike" | "shield" | "mobile" | "delay" | "quick";
```

| キーワード | JSON | 備考 |
|---|---|---|
| 射撃 | `ranged` | |
| 貫通 | `pierce` | |
| 先制 | `firstStrike` | |
| 盾 | `shield` | |
| 遊撃 | `mobile` | |
| 遅延 | `delay` | 表示用。実際の予約は効果の中の `delay` 処理（5.2）で表す |
| 即効 | `quick` | カードを使った後、追加の手番を得る |

### 3.2 能力

```ts
type Ability =
  | { kind: "trigger"; when: TriggerType; condition?: Condition; targets?: TargetSpec[]; effects: Effect[] }
  | { kind: "static"; modifiers: StaticModifier[] }
  | { kind: "activated"; cost: number; targets?: TargetSpec[]; effects: Effect[] }
  | { kind: "inHand"; when: TriggerType; effects: Effect[] }    // 手札にある間だけ働く
  | { kind: "costReduction"; by: Value };                       // 手札にある間、コストを by だけ下げる（CY-21・AC-22）

type StaticModifier = {
  target: Selector;           // 誰に効くか
  attack?: number;            // +X/+Y
  health?: number;
  keywords?: Keyword[];       // キーワードを持たせる
  enhanceCost?: number;       // スペルの強化コストの増減（AC-16）
  spellCost?: number;         // スペルのコストの増減（AC-16）
  cardKeywords?: { cardId: string; keywords: Keyword[] }; // 自分のそのカード（手札など）にキーワードを与える（ノエル成長後: 魔力の矢に即効）
};
```

### 3.3 強化

```ts
type Enhance = {
  cost: number;               // 強化の追加コスト（予備マナ／通常マナ）
  mode: "add" | "replace";    // add: 元の効果に加える / replace: 元の効果の代わりに使う（「代わりに」）
  appliesTo?: "effects" | number;  // どの効果を強化するか。"effects"=スペルの効果、数値=abilities の番号（配置時の能力など）
  targets?: TargetSpec[];     // replace で対象の選び方も変わるとき
  effects: Effect[];
};
```

- `replace` のとき、元の効果の対象指定（`targets`）は、`enhance.targets` がなければそのまま使う。
- ユニットの強化は、配置時の能力（`when: "onPlay"`）を強化するのが基本（`appliesTo` にその能力の番号を書く）。
- 配置時の効果が強化にしかないユニット（KN-01 見習い従者、KN-14 突撃騎兵）は、効果が空の配置時の能力（`"effects": []`）を置き、それを `appliesTo` で指す。
- `mode: "add"` の効果は、元の効果の **後に** 行う。

### 3.4 リーダー

```ts
type Leader = {
  id: string;                 // "leader-alto"
  name: string;               // "アルト"
  title: string;              // "見習い騎士"
  faction: FactionId;
  ability?: LeaderAbility;    // 通常の段階
  passives?: Ability[];       // 通常の段階のパッシブ
  growth: { counter: GrowthCounter; threshold: number };
  grown: { ability?: LeaderAbility; passives?: Ability[] };   // 成長後。ability がなければ成長後は能力を使えない
  text: string;
};

type LeaderAbility = { name: string; cost: number; targets?: TargetSpec[]; effects: Effect[] };

type GrowthCounter =
  | "allyEnduredCombatDamage"  // 味方が戦闘ダメージを耐えた回数（アルト）
  | "unitMoved"                // 自分がユニット（敵味方問わず）を移動させた回数（レイ）。効果による移動と、自分の遊撃による移動
  | "leaderAbilityUsed"        // このリーダーの能力を使った回数
  | "spellsCast";              // 自分がスペルを使った回数（ノエル）。生成したスペルも数える
```

---

## 4. 対象と数値の決まり

### 4.1 いつ決まるか

| 種類 | 決まるとき | 例 |
|---|---|---|
| 対象（ユニット・マス・レーン・プレイヤー） | **カードや能力を使ったとき**（遅延でも予約時に決まる） | 崩落の予言のマス、審判の槌の味方とマス |
| 数値（ダメージ量など） | **その処理を行うとき** | 審判の槌の「遅延が発動した時点の味方の攻撃力」 |
| 対象の条件（体力3以下など） | その処理を行うとき | 禁呪「終焉の詠唱」 |

これはルール仕様書 14.1（遅延の対象は予約時に決める）と、審判の槌の決定（攻撃力は発動時点）に合わせたもの。

### 4.2 対象の指定（TargetSpec）

使うときにプレイヤーが選ぶ対象。`id` を付け、効果の中から `{ "ref": "id" }` で参照する。

```ts
type TargetSpec = {
  id: string;                         // 効果の中で参照する名前
  kind: "unit" | "cell" | "lane" | "unitOrPlayer" | "cardInHand";
  side?: "ally" | "enemy" | "any";    // 省略時 "any"（単に「ユニット」＝敵味方どちらでも）
  count?: number;                     // 選ぶ数（省略時 1）
  where?: Condition;                  // 選べるものの条件（例: 空きマス、前列、スペル）
  cellOwner?: "ally" | "enemy" | "any" | { ownerOf: string } | { sameOwnerAs: string };
    // マスの持ち主。省略時 "any"。{ownerOf} は「その対象ユニットの持ち主の盤面」、{sameOwnerAs} は「先に選んだマスと同じ盤面」
  optional?: boolean;                 // 選べなくても使えるか（省略時 false）
};
```

- `kind: "cell"` の `where` に `{ "empty": true }` を書くと空きマスだけを選べる。
- 必要な対象を選べないスペルは使えない（ルール仕様書 7.2）。`optional: true` なら選ばずに使える。

### 4.3 セレクタ（Selector）

プレイヤーが選ぶのではなく、決まった範囲を指すときに使う。

```ts
type Selector =
  | { ref: string }                                   // 選んだ対象、またはイベントの対象
  | "self"                                            // このユニット
  | "eventUnit"                                       // 誘発のきっかけになったユニット（移動したユニットなど）
  | { units: {
        side?: "ally" | "enemy" | "any";
        relative?: "leftRight" | "sameLaneOther";     // このユニットから見た位置
        lane?: LaneRef; row?: "front" | "back";
        cardId?: string;                              // 特定のカードのユニット（偵察ドローンなど）
        where?: Condition;
        random?: number;                              // その中からランダムに選ぶ数
        other?: boolean;                              // このユニット自身を除く（「他の味方」。KN-21）
      } }
  | { cell: { owner: "ally" | "enemy"; lane: LaneRef; row: "front" | "back" } }
  | { cellsRelative: "leftRight" }                    // このユニットの左右隣のマス
  | { randomCell: "ally" | "enemy" }                  // そのプレイヤーの8マス（空きマスを含む）からランダムに1つ。評価するたびに選び直す（AC-08）
  | "enemyPlayer" | "allyPlayer";

type LaneRef = number | { ref: string } | { laneOf: Selector } | "all";
```

### 4.4 数値（Value）

```ts
type Value =
  | number
  | { attackOf: Selector; ifGone?: number }   // そのユニットの攻撃力（いなければ ifGone、省略時 0）
  | { count: "spellsCastThisGame" }           // この試合で自分が使ったスペルの枚数
  | { count: "unitMovesThisGame" }            // この試合でユニット（敵味方問わず）が移動した回数
  | { max: Value; cap: number };              // 上限つき
```

### 4.5 条件（Condition）

```ts
type Condition =
  | { empty: boolean }                                  // マスが空きマスか
  | { row: "front" | "back" }
  | { type: "unit" | "spell" }                          // カードの種類
  | { attackAtMost: number } | { healthAtMost: number } // 攻撃力・残り体力が X 以下
  | { hasKeyword: Keyword }
  | { all: Condition[] } | { any: Condition[] };
```

---

## 5. 語彙

### 5.1 きっかけ（TriggerType）

| JSON | ルール上の名前 | 補足 |
|---|---|---|
| `onPlay` | 配置時 | 効果で出したユニットでは起きない |
| `onDestroyed` | 破壊時 | |
| `onMove` | 移動時（このユニット） | 遊撃を含む |
| `onEnemyMove` | 敵ユニットが移動したとき | `eventUnit` が移動したユニット |
| `onAnyUnitMove` | ユニット（敵味方問わず）が移動したとき | |
| `onSpellCast` | スペル使用時（自分がスペルを使ったとき） | |
| `onAllyEndureCombatDamage` | 味方が戦闘ダメージを耐えたとき | 誓いの聖騎士（KN-16） |
| `roundStart` / `roundEnd` | ラウンド開始時 / ラウンド終了時 | |
| `combatStart` / `combatEnd` | 戦闘開始時 / 戦闘終了時 | 効果で行う戦闘では起きない |

### 5.2 処理（Effect）

すべて `{ "op": "処理名", ...引数 }` の形。

| op | 引数 | 意味 | 使うカードの例 |
|---|---|---|---|
| `damage` | `target`, `amount`, `times?` | ダメージを与える（`times` 回に分けて） | KN-25, CY-17 |
| `destroy` | `target` | 破壊する | AC-14 |
| `exile` | `target` | 除外する | AC-24 |
| `heal` | `target`, `amount` | 回復する | KN-05, AC-13 |
| `buff` | `target`, `attack?`, `health?`, `duration` | 能力値を増減する。`duration` は `"permanent"`（永続）か `"thisRound"` | KN-11, CY-05 |
| `grantKeyword` | `target`, `keywords`, `duration` | キーワードを与える（盾を与える＝`["shield"]`） | KN-02, KN-12 |
| `move` | `target`, `to` | ユニットを指定のマスへ移動させる（空きマスでなければ何もしない） | AC-06, CY-15 |
| `moveToOtherRow` | `target` | 同じレーンのもう一方の列へ移動させる（空きマスの場合のみ） | CY-13, CY-23 |
| `swapCells` | `a`, `b` | 同じプレイヤーの2マスの中身を入れ替える（空きマスも可） | レイ成長後 |
| `returnToHand` | `target` | 手札に戻す | CY-02 |
| `summon` | `cardId`, `at`, `as?` | カードのユニットを効果で出す（トークン扱い。空きマスでなければ出さない）。`as` で出したユニットに名前を付ける | CY-16, AC-15, AC-11 |
| `summonRandom` | `cardIds`, `at`, `distinctNames?` | 候補からランダムに選んだユニットを、マスごとに出す。`distinctNames` なら名前が重ならないように選ぶ | AC-09 |
| `draw` | `count` | カードを引く | CY-10, AC-20 |
| `drawUntil` | `handSize` | 手札が指定枚数になるまで引く | — |
| `lookAtTopPickOne` | `look` | 山札の上から見て1枚を手札に、残りは元の順番で戻す | CY-06 |
| `tutorRandom` | `where`, `count`, `distinctNames?`, `highestCost?`, `as?` | 山札から条件に合うカードをランダムに手札に加え、シャッフル。`distinctNames` なら名前の異なるカードだけ。`highestCost` ならコスト（カードに書かれた値）が最大のものの中から選ぶ。`as` で加えたカードに名前を付ける | KN-18, AC-20, AC-25 |
| `generate` | `cardId`, `count?` | カードを手札に生成する | AC-05, CY-20 |
| `generateFromCastSpells` | `count`, `distinctNames` | 使ったスペルからランダムに選んで手札に生成する | AC-18 |
| `gainReserve` | `amount` | 予備マナを得る | AC-07 |
| `gainLife` | `amount` | 自分のライフを回復する（上限なし） | AC-05, AC-23 |
| `refillMana` | — | 通常マナを最大まで回復する | — |
| `fight` | `a`, `b` | 2体が互いに攻撃力と同じダメージを与え合う（どちらかがいなければ何もしない） | KN-07 |
| `resolveCombat` | `lanes` | 指定レーンで戦闘を行う（ルール仕様書 11.7） | KN-17, KN-22 |
| `modifyCost` | `target`, `amount` | 手札のカードのコストを増減する | AC-25 |
| `modifyLeaderAbilityCost` | `amount` | このリーダーの能力のコストを増減する（試合を通して累積） | — |
| `reveal` | `target` | 手札のカードを公開する | AC-25 |
| `delay` | `effects` | 中の効果を予約し、自分の次の手番の始めに発動する（ルール仕様書 14.1） | KN-15, AC-01 |
| `atRoundEnd` | `effects` | 中の効果を、このラウンドの終了時に行う | CY-07, AC-14 |
| `if` | `condition`, `subject`, `then`, `else?` | 条件を満たすときだけ行う | — |
| `forEach` | `targets`, `effects` | 範囲の中の1体ずつに効果を行う（中では `eventUnit` がその1体） | — |
| `repeat` | `times`, `effects` | 中の効果を `times` 回くり返す | AC-08 |

- `target` にはセレクタ（4.3）を書く。範囲（`units`）を書けば、その全員に効果を行う。
- 数値の引数にはすべて Value（4.4）を書ける。

---

## 6. 記述例

### 6.1 シンプルなユニット

```json
{
  "id": "KN-09", "name": "盾持ちの衛兵", "faction": "knights",
  "type": "unit", "cost": 3, "attack": 3, "health": 3,
  "keywords": ["shield"],
  "text": ""
}
```

### 6.2 常時効果（左右隣の強化）

```json
{
  "id": "KN-08", "name": "槍兵隊長", "faction": "knights",
  "type": "unit", "cost": 3, "attack": 2, "health": 4,
  "abilities": [
    { "kind": "static", "modifiers": [
      { "target": { "units": { "side": "ally", "relative": "leftRight" } }, "attack": 1, "health": 1 }
    ] }
  ],
  "text": "左右隣の味方は+1/+1"
}
```

### 6.3 強化（「代わりに」）と遅延を持つスペル

```json
{
  "id": "CY-11", "name": "EMPグレネード", "faction": "cyber",
  "type": "spell", "cost": 4, "keywords": ["delay"],
  "targets": [ { "id": "lane", "kind": "lane" } ],
  "effects": [
    { "op": "delay", "effects": [
      { "op": "damage", "target": { "units": { "side": "enemy", "lane": { "ref": "lane" } } }, "amount": 2 }
    ] }
  ],
  "enhance": {
    "cost": 2, "mode": "replace", "appliesTo": "effects",
    "effects": [
      { "op": "delay", "effects": [
        { "op": "damage", "target": { "units": { "side": "enemy", "lane": { "ref": "lane" } } }, "amount": 3 }
      ] }
    ]
  },
  "text": "レーンを1つ指定する。遅延: そのレーンの敵ユニットすべてに2ダメージ。強化（2）: 代わりに3ダメージ"
}
```

### 6.4 数値を発動時に決める（審判の槌）

```json
{
  "id": "KN-15", "name": "審判の槌", "faction": "knights",
  "type": "spell", "cost": 4, "keywords": ["delay"],
  "targets": [
    { "id": "ally", "kind": "unit", "side": "ally" },
    { "id": "cell", "kind": "cell", "cellOwner": "enemy" }
  ],
  "effects": [
    { "op": "delay", "effects": [
      { "op": "damage", "target": { "ref": "cell" }, "amount": { "attackOf": { "ref": "ally" }, "ifGone": 0 } }
    ] }
  ],
  "enhance": {
    "cost": 2, "mode": "add", "appliesTo": "effects",
    "effects": [ { "op": "buff", "target": { "ref": "ally" }, "attack": 2, "duration": "thisRound" } ]
  },
  "text": "味方ユニット1体と、相手の盤面のマス1つを指定する。強化（2）: その味方を、このラウンド中+2/+0。遅延: 指定したマスにいるユニットに、遅延が発動した時点のその味方の攻撃力と同じダメージ（その味方が破壊されていればダメージは0）"
}
```

- 強化の効果（+2/+0）は遅延の外にあるので、使ったときにすぐ発動する。
- マス（`cell`）を対象にしたダメージは、発動時にそのマスにいるユニットに与える。

### 6.5 起動能力で遅延の戦闘を起こす

```json
{
  "id": "KN-17", "name": "王国の軍師", "faction": "knights",
  "type": "unit", "cost": 5, "attack": 4, "health": 5,
  "abilities": [
    { "kind": "activated", "cost": 3, "effects": [
      { "op": "delay", "effects": [ { "op": "resolveCombat", "lanes": { "laneOf": "self" } } ] }
    ] }
  ],
  "text": "起動（3）: 遅延: このユニットがいるレーンで戦闘を行う"
}
```

- `{ "laneOf": "self" }` は対象の一種なので、起動したとき（予約時）のレーンに決まる。発動前に軍師が移動・破壊されても、そのレーンで戦闘が起きる。

### 6.6 きっかけとカードの生成（ドローンエンジニア）

```json
{
  "id": "CY-20", "name": "ドローンエンジニア", "faction": "cyber",
  "type": "unit", "cost": 6, "attack": 5, "health": 6,
  "abilities": [
    { "kind": "static", "modifiers": [
      { "target": { "units": { "side": "ally", "cardId": "CY-01" } }, "keywords": ["ranged"] }
    ] },
    { "kind": "trigger", "when": "onPlay", "effects": [ { "op": "generate", "cardId": "CY-01" } ] },
    { "kind": "trigger", "when": "roundStart", "effects": [ { "op": "generate", "cardId": "CY-01" } ] }
  ],
  "text": "味方の偵察ドローンすべては射撃を持つ。配置時とラウンド開始時: 偵察ドローン（CY-01）1枚を手札に生成する"
}
```

### 6.7 試合中の回数でコストが下がる（重装ガンシップ）

```json
{
  "id": "CY-21", "name": "重装ガンシップ", "faction": "cyber",
  "type": "unit", "cost": 10, "attack": 5, "health": 6,
  "keywords": ["ranged", "pierce"],
  "abilities": [
    { "kind": "costReduction", "by": { "count": "unitMovesThisGame" } }
  ],
  "text": "この試合中にユニット（敵味方問わず）が移動した回数、このカードのコストを−1"
}
```

- `costReduction` は手札にある間のコストを `by` だけ下げる（0未満にはならない）。手札に来る前の回数も数える。

### 6.8 山札から加えたカードを後の効果で使う（天空の大魔導師）

```json
{ "kind": "trigger", "when": "onPlay", "effects": [
  { "op": "tutorRandom", "where": { "type": "spell" }, "count": 3, "distinctNames": true, "as": "spells" },
  { "op": "reveal", "target": { "ref": "spells" } },
  { "op": "modifyCost", "target": { "ref": "spells" }, "amount": -9 }
] }
```

- `tutorRandom` の `as` に名前を付けると、加えたカードを同じ能力の後の効果から `{ "ref": "spells" }` で参照できる。
- `summon` の `as` も同じ。強化の `add` は元の効果の後に処理するので、元の効果で付けた名前を強化の効果から参照できる（AC-11 氷像の召喚: 出した動く氷像を強化で+0/+3）。

### 6.9 リーダー（ノエル）

```json
{
  "id": "leader-noel", "name": "ノエル", "title": "落ちこぼれ魔法使い", "faction": "academy",
  "ability": { "name": "基本魔法", "cost": 1, "effects": [ { "op": "generate", "cardId": "AC-01" } ] },
  "growth": { "counter": "spellsCast", "threshold": 8 },
  "grown": {
    "ability": { "name": "基本魔法", "cost": 0, "effects": [ { "op": "generate", "cardId": "AC-01" } ] },
    "passives": [
      { "kind": "static", "modifiers": [ { "target": "allyPlayer", "cardKeywords": { "cardId": "AC-01", "keywords": ["quick"] } } ] }
    ]
  },
  "text": "**基本魔法**（1）: 魔力の矢(AC-01)1枚を自分の手札に生成する。成長条件: スペルを8回使う。成長後: …"
}
```

- `cardKeywords` で与えたキーワードは、カードを使う時点で判定する（即効なら追加の手番を得る）。魔力の矢は遅延も持つので、ルール仕様書 14.2 のとおり追加の手番の始めにすぐ発動する。

### 6.10 リーダー（アルト）

```json
{
  "id": "leader-alto", "name": "アルト", "title": "見習い騎士", "faction": "knights",
  "ability": {
    "name": "盾の誓い", "cost": 4,
    "targets": [ { "id": "ally", "kind": "unit", "side": "ally" } ],
    "effects": [ { "op": "grantKeyword", "target": { "ref": "ally" }, "keywords": ["shield"], "duration": "permanent" } ]
  },
  "growth": { "counter": "allyEnduredCombatDamage", "threshold": 6 },
  "grown": {
    "ability": {
      "name": "盾の誓い", "cost": 3,
      "targets": [ { "id": "ally", "kind": "unit", "side": "ally" } ],
      "effects": [ { "op": "grantKeyword", "target": { "ref": "ally" }, "keywords": ["shield"], "duration": "permanent" } ]
    },
    "passives": [
      { "kind": "static", "modifiers": [
        { "target": { "units": { "side": "ally", "where": { "hasKeyword": "shield" } } }, "attack": 2 }
      ] }
    ]
  },
  "text": "盾の誓い（4）: 味方ユニット1体に盾を与える。成長条件: 味方が戦闘ダメージを合計6回耐える。成長後: 盾の誓い（3）。（パッシブ）盾を持つ味方ユニットすべては+2/+0"
}
```

---

## 7. 75枚の対応確認

試遊版3勢力の全カード（とトークン専用のカード）とリーダーを `data/cards/knights.json`・`cyber.json`・`academy.json` に書き起こし、8章の検証をすべて通ることを確認した。特殊な表し方をするものは次のとおり。

| カード | 表し方 |
|---|---|
| KN-07 騎士の決闘 | 強化で前列の味方を+0/+2（遅延の外）、遅延の中で `fight`（相手の前列のユニットと自分の前列のユニット。どちらかがいなければ何もしない） |
| KN-16 誓いの聖騎士 | `trigger` の `onAllyEndureCombatDamage` で自分を+2/+0 |
| KN-21 老将ガラハド | 配置時の `buff` の対象に `{ "units": { "side": "ally", "other": true } }`（自分を除く） |
| KN-22 聖堂騎士長 | 起動 → `delay` → `resolveCombat`（`lanes: "all"`） |
| CY-07 オーバークロック | `buff`（このラウンド中+4/+0）と `atRoundEnd` の中の `damage` |
| CY-14 攻性防壁 / CY-23 オラクル | `trigger` の `onEnemyMove` で `eventUnit` に効果 |
| CY-16 ドローン管制官 | `summon` の `at` に `{ "cellsRelative": "leftRight" }`（空きマスでなければ出さない） |
| CY-25 衛星兵器「ラグナロク」 | 強化（add）で味方すべてに盾（遅延の外）、遅延の中で全ユニットに8ダメージ |
| AC-02 ホーミング魔弾 | 対象の `kind: "unitOrPlayer"`（敵ユニットまたは相手プレイヤー） |
| AC-08 数打ちゃ当たる | `repeat`（`times` に `spellsCastThisGame`）の中で、`damage` の対象に `{ "randomCell": "enemy" }`（空きマスなら外れ） |
| AC-09 召喚ガチャ | `summonRandom`。強化（replace）で対象を2マス（`count: 2`）にし、`distinctNames` |
| AC-10 魔法の剣 | `buff` の `attack`・`health` に `{ "count": "spellsCastThisGame" }`（永続） |
| AC-11 氷像の召喚 / TK-01 動く氷像 | `summon`（`cardId: "TK-01"`、`as: "statue"`）と、強化（add）で `{ "ref": "statue" }` を+0/+3。TK-01 は `token: true` |
| AC-17 雷鳴の詠唱 | 遅延の中で敵ユニットすべてに `damage`。強化（replace）で `times: 2` |
| AC-20 学院長代理 | 配置時に `tutorRandom`（`highestCost`・`as: "spell"`）→ `reveal`。強化（add、`appliesTo: 0`）で `modifyCost`（−6） |
| AC-22 魔導ゴーレム / CY-21 重装ガンシップ | `costReduction` の `by` に `spellsCastThisGame` / `unitMovesThisGame` |
| AC-14 崩落の予言 | `atRoundEnd` の中の `destroy`（遅延ではない） |
| AC-16 首席の少女 | `static` の `spellCost: -1`（対象は `allyPlayer`） |
| AC-24 禁呪「終焉の詠唱」 | 遅延の中で `exile`。対象は `units` の `where: { healthAtMost: 3 }`（発動時に判定） |
| AC-25 天空の大魔導師 | 配置時に `tutorRandom`（`distinctNames`・`as: "spells"`）→ `reveal` → `modifyCost`（−9）（6.8） |
| CY-09 転送遅延 | ユニットとその持ち主の空きマスを選び、遅延の中で `move`（発動時に空きマスでなければ動かない） |
| レイ 成長後 | 能力は成長前と同じ `move`（コスト4）。パッシブは `trigger` の `onEnemyMove` で `eventUnit` を−2/−0 |
| ノエル | 6.9 |
| CY-15 スワップ | `swapCells`。1つ目は自分のユニットがいるマス（`where: { "empty": false }`）、2つ目は自分の任意のマス（空きマスも可） |
| KN-01, KN-14 | 空の配置時の能力を置き、強化の `appliesTo: 0` で指す |

---

## 8. データの検証

読み込み時に次を確かめ、違反があればエラーにする。

| 検証 | 内容 |
|---|---|
| ID | 全カードで一意。`cardId` で参照しているカードが存在する |
| トークン | `token: true` のカードはデッキに入れられない（デッキの検証） |
| 種類と能力値 | ユニットは `attack` と `health` を持つ。スペルは持たない |
| 遅延の整合 | `keywords` に `delay` があるカードは、効果のどこかに `delay` 処理を持つ（逆も同じ。ただし起動能力の中だけに遅延があるユニットは `keywords` に入れない） |
| 対象の参照 | `{ "ref": "..." }` の名前が、同じ能力（または強化）の `targets` に存在する |
| 語彙 | `op`・`when`・キーワード・条件が、この文書の一覧にあるものだけ |
| 強化 | `appliesTo` が指す能力が存在する |

---

## 9. デッキの形式

`data/decks/` に1デッキ1ファイルで置く。見本デッキ・AI用デッキ・モックアップで作ったデッキは、すべてこの形式。

```ts
type Deck = {
  formatVersion: 1;
  id: string;            // "sample-knights-cyber"
  name: string;          // "見本: 号令で押し切る（騎士団＋電脳）"
  description?: string;  // デッキの狙い
  leaders: [string, string];               // リーダーID（異なる勢力）
  cards: { id: string; count: number }[];  // 合計40枚、同名3枚まで
};
```

| 見本デッキ | リーダー | 狙い |
|---|---|---|
| `sample-knights-cyber.json` | レイ＋アルト | 軽いユニットで盤面を取り、鼓舞の号令でまとめて強化して押し切る |
| `sample-knights-academy.json` | アルト＋ノエル | 騎士団の壁で時間を稼ぎ、学院のスペルを重ねて遅延の大魔法と大型ユニットで決着 |
| `sample-cyber-academy.json` | レイ＋ノエル | 偵察ドローンと見習い魔法使いで盤面を作り、魔力の矢や数打ちゃ当たるで削る |

モックアップでのテキスト形式は [mockup.md](mockup.md) の7.3。

---

## 10. 確認事項・今後

| # | 項目 | 案 |
|---|---|---|
| 1 | 「使ったスペルの枚数」に、今まさに使っているスペル自身を含めるか | **含めない**（確定）。効果を処理し終えた時点で数える（ルール仕様書 11.7） |
| 2 | 表示用の効果文（`text`） | 当面は手で書く。将来、データから日本語の効果文を自動で作る仕組みを検討する |
| 3 | デッキの形式 | 決定（9章）。見本デッキを3つ作成済み |
| 4 | JSON Schema | 形式が固まったら、この文書の型から JSON Schema を作り、エディタで入力補完・検証できるようにする |
