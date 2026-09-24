# 手動モックアップ

ルールの判定をしない、手で動かして遊ぶ卓です。設計は [docs/mockup.md](../docs/mockup.md)。

## 動かし方

```sh
cd mockup
npm install
npm run dev      # http://localhost:5173 を開く
```

- `npm test` … 単体テスト（vitest）
- `npm run build` … 型チェックと `dist/` への書き出し

カードは `data/cards/*.json`、見本デッキは `data/decks/*.json` から読み込みます。

## 操作の要点

- 手札のカードは盤面のマスへドラッグして配置（「コストを自動で払う」がオンなら通常マナから払う）。スペルは「スペルを使う」「遅延を予約」の欄へドラッグ。
- ユニット・マス・手札・山札・リーダーはクリックするとメニューが出る。
- 取り消し Ctrl+Z、やり直し Ctrl+Y、メニューや配置の取りやめ Esc。
- 試合はブラウザに自動保存される。「試合を保存」で JSON に書き出せる。
