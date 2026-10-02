# 商品管理システム

商品マスタ・原料／資材・レシピ原価・仕入れ・在庫棚卸・売上・人件費・予算・レジ締めを1画面で扱うWebアプリ。

- 画面：`docs/index.html`（GitHub Pages で配信）
- データ：Google Apps Script（`gas/`）経由で、持ち主のGoogleスプレッドシートに保存
- 開くときに合言葉が必要。照合はGAS側で行うため、このリポジトリにデータや合言葉は含まれない

## 構成

| 場所 | 中身 |
|---|---|
| `docs/index.html` | アプリ本体（1ファイル） |
| `gas/Code.gs` | データAPI（`load` / `put` / `meta` / `ping` / `changePass`） |
| `tools/cloud-gas.js` | `docs/index.html` に組み込んであるクラウド保存部分の原本 |
| `tools/seed.mjs` | 全データバックアップ(JSON)をスプレッドシートへ一括登録する |

## 更新のしかた

- 画面を直したら `docs/index.html` をコミットして push（数分で反映）
- GASを直したら `gas/` で `clasp push` → `clasp update-deployment <デプロイID>`（URLを変えないため新規デプロイはしない）
