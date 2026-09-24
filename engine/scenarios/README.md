# テストシナリオの形式

「初期状態 ＋ 操作 → 期待する状態」を JSON で書いたもの（タスク 1-13）。
TypeScript 版のエンジンは `npm test` ですべて実行する（`test/scenarios.test.ts`）。Godot 版に移植するときも同じファイルを使う。

1ファイルの形:

```json
{
  "description": "このファイルの説明",
  "scenarios": [ { "name": "...", "refs": ["8.4", "KN-23"], "setup": { ... }, "steps": [ ... ], "expect": { ... } } ]
}
```

## setup（初期状態）

行動フェイズの途中から始まる。マリガンは済んでいる。

| 項目 | 省略時 | 意味 |
|---|---|---|
| `seed` | 1 | 乱数のシード |
| `round` | 1 | ラウンド数 |
| `firstPlayer` | `"A"` | 先手トークンを持つプレイヤー |
| `activePlayer` | 先手 | 行動権を持つプレイヤー |
| `passStreak` | 0 | 続けてパスした回数 |
| `A` / `B` | | 各プレイヤー（下の表） |

| プレイヤーの項目 | 省略時 | 意味 |
|---|---|---|
| `life` | 20 | |
| `maxMana` | `mana`、なければ `round` | |
| `mana` | `maxMana` | 通常マナ |
| `reserve` | 0 | 予備マナ |
| `unusedMana` | 0 | 前のラウンドの使い残し |
| `castSpells` | `[]` | この試合で使ったスペルのID。`spellsCast` を省略するとこの枚数になる |
| `spellsCast` | | 使ったスペルの枚数 |
| `leaders` | A: アルト＋レイ、B: レイ＋ノエル | `"leader-alto"` または `{ "id", "grown", "progress", "used", "costMod" }` |
| `hand` | `[]` | 手札。`"KN-09"` または `{ "card": "KN-09", "costMod": -1 }` |
| `deck` | `KN-03` を10枚 | 山札。先頭が一番上 |
| `trash` | `[]` | |
| `board` | `{}` | `{ "2前": "KN-09" }` または `{ "2前": { "card", "damage", "attack", "health", "tempAttack", "tempHealth", "keywords", "tempKeywords", "shield", "token", "mobileUsed" } }` |

- 盤面のユニットの `attack` / `health` は永続の強化、`tempAttack` / `tempHealth` はこのラウンド中の強化。
- `keywords` に `shield` を書くと盾を持つ。カードが元から盾を持つ場合は、`"shield": false` で外せる。

## steps（操作）

上から順に行う。

### アクション

`{ "type": ..., "player": "A", ... }`。`"illegal": true` を付けると「行えないこと」を確かめる（状態は変わらない）。

| type | 項目 |
|---|---|
| `playUnit` | `card`（手札のカードID）, `cell`（`"2前"`）, `enhance?`, `targets?` |
| `castSpell` | `card`, `enhance?`, `targets?` |
| `mobileMove` | `unit`（自分のマス）, `to` |
| `activate` | `unit`（自分のマス）, `ability?`（abilities の番号。省略時は最初の起動能力）, `targets?` |
| `leaderAbility` | `leader`（0 か 1）, `targets?` |
| `pass` | |
| `choose` | `card`（選択肢のカードID。山札の上から見て選ぶときなど） |

`targets` は対象の名前（カードデータの `targets[].id`）ごとに、次のどれか（複数なら配列）:

| 書き方 | 意味 |
|---|---|
| `{ "unit": "B:2前" }` | そのマスにいるユニット |
| `{ "cell": "A:1後" }` | マス |
| `{ "lane": 3 }` | レーン |
| `{ "player": "B" }` | プレイヤー本体 |
| `{ "card": "AC-02" }` | 自分の手札のカード |

強化・起動・リーダー能力のコストは、予備マナから必ず先に払う（16.2）。

### 手順を飛ばす

| 書き方 | 意味 |
|---|---|
| `{ "do": "combat" }` | 戦闘フェイズを行う（戦闘開始時・戦闘終了時の効果を含む） |
| `{ "do": "roundEnd" }` | 終了フェイズを行う |
| `{ "do": "startRound" }` | 次のラウンドの開始フェイズを行う |
| `{ "do": "endRound" }` | 終了フェイズと次のラウンドの開始フェイズを行う |

双方がパスして戦闘に進む流れを確かめたいときは、`pass` のアクションを書く。

### 途中の確認

`{ "expect": { ... } }` で、その時点の状態を確かめる。

## expect（期待する状態）

書いた項目だけを比べる。

| 項目 | 意味 |
|---|---|
| `round`, `activePlayer`, `firstPlayer`, `passStreak` | |
| `result` | `null`（試合中）、または `{ "winner": "A" / "B" / null, "reason"?: "life" / "deckOut" / "draw" }` |
| `pending` | 選択を待っているか |
| `A` / `B` | 下の表 |

| プレイヤーの項目 | 意味 |
|---|---|
| `life`, `mana`, `maxMana`, `reserve`, `unusedMana`, `spellsCast` | |
| `hand` | 手札のカードID（順不同） |
| `handCount`, `deckCount` | 枚数 |
| `handCosts` | `{ "AC-22": 7 }` 手札のそのカードの今のコスト |
| `revealed` | 公開されている手札のカードID |
| `deckTop` | 山札の上から順のカードID（書いた枚数だけ比べる） |
| `trash`, `exile` | カードID（順不同） |
| `delayed` | 予約中の遅延効果のカードID（予約した順） |
| `leaders` | `[{ "grown", "progress", "used", "cost" }]`（`cost` は今のリーダー能力のコスト） |
| `board` | `{ "2前": null }`（空きマス）または `{ "2前": { "card", "attack", "health", "maxHealth", "damage", "shield", "keywords", "noKeywords", "token" } }` |

- ユニットの `attack` は今の攻撃力（常時効果・一時的な強化を含む）、`health` は残り体力、`damage` は受けているダメージ。
- `keywords` はそのキーワードをすべて持っていること、`noKeywords` はどれも持っていないことを確かめる。
