# Open_scraping

**交換可能な部品を Flow につなぐ、拡張・派生を前提としたデータ収集基盤。**

> **開発中（0.x）**：現在の `main` は契約検証・フロー実行・部品ホストの基盤実装段階です。実際のWeb検索、ダウンロード、一般向けGUI/CLIはまだ標準実装されていません。計画中の機能を使用可能とは扱わないでください。

## ドキュメントの入口

| 読者 | 最初に読むところ | 内容 |
| --- | --- | --- |
| **利用者・試してみたい人** | **[利用者向けガイド](docs/user/README.md)** | 現在できること、準備、試せる範囲、用語 |
| **共同開発者・レビュー担当者** | **[開発者向けガイド](docs/developer/README.md)** | 全体構成、開発環境、Issue/PR、テスト、設計 |
| 初めてのコントリビューター | [CONTRIBUTING.md](CONTRIBUTING.md) | 参加方法・PRの作成 |
| 資料を横断して探したい人 | [ドキュメント目次](docs/README.md) | 利用者向け／開発者向けの索引 |

## 何を作るプロジェクトか

```text
利用者の設定 / FlowConfig
           │
           ▼
 contracts（構造・型・能力を検証）
           │
           ▼
 core（ノードの順序・並列・状態・停止）
           │ FlowInvoker
           ▼
 host（部品の選択・起動・RPC・権限）
           │
           ▼
 Components（検索・取得・保存・処理などの交換可能な部品）
```

GUI/CLIは将来、公開API経由で同じ仕組みを呼び出す設計です。Core はブラウザ/検索/DB/画像処理などの実装を含まず、外部部品の操作を特別扱いしません。

## main の実装範囲

| 領域 | 状態と役割 |
| --- | --- |
| [packages/contracts](packages/contracts/) | **実装あり・テストあり**：FlowConfig、manifest、DataRef、操作メッセージの検証 |
| [packages/core](packages/core/) | **実装あり・テストあり**：依存解決、実行順序、並列、停止、失敗状態 |
| [packages/host](packages/host/) | **実装あり・テストあり**：component registry、worker通信、取消、期限、権限 |
| [packages/api-client](packages/api-client/) | **stub**：公開APIクライアント予定 |
| [apps/cli](apps/cli/) / [apps/gui](apps/gui/) | **stub**：公開APIを呼ぶCLI/GUI予定 |
| [components](components/) / [flows](flows/) / [distributions](distributions/) | **枠のみ**：実処理部品、標準フロー、派生配布定義 |
| [prototypes](prototypes/) | **試作**：技術選定用のモック |

現時点で**未実装**の主なもの：実ブラウザ・検索サービス、実データ取得と保存/出力、商品検索/推薦、正式GUI/CLI/HTTP API、OSレベルのグローバル非常停止。特に**Escまたは物理マウス入力によるフォーカス非依存の非常停止は必須設計ですが、OS実装はまだありません**（[Issue #42](https://github.com/tomiya7688/Open_scraping/issues/42)）。

詳細は [利用者向け機能一覧](docs/user/capabilities.md) にあります。進行中の PR と main への反映は別です。

## ソースから基盤を検証する（開発者向け）

Node.js **24.21.0**、npm **11系** を使用します。

```bash
git clone https://github.com/tomiya7688/Open_scraping.git
cd Open_scraping
npm install
npm run verify
```

`npm run verify` は型チェック、依存境界、ドキュメント、モックのテストであり、**実Webサイトのスクレイピング成功テストではありません**。

実装箇所の案内は [packages/README.md](packages/README.md)、全体の開発手順は [開発ガイド](docs/developer/development-guide.md)、レビュー観点は [コードレビューガイド](docs/developer/code-review.md) を参照してください。

## 開発状況と参加

開発順序と受入条件は [管理Issue #1](https://github.com/tomiya7688/Open_scraping/issues/1) と [開発ロードマップ](docs/developer/roadmap.md) を正本とします。改善提案や不具合は [Issues](https://github.com/tomiya7688/Open_scraping/issues) に、変更は [Pull requests](https://github.com/tomiya7688/Open_scraping/pulls) に投稿してください。

参加時は [コントリビューション手順](docs/developer/contributing.md) を確認してください。**ライセンス・配布方針は [Issue #3](https://github.com/tomiya7688/Open_scraping/issues/3) で未決定**であり、公開されていること自体を再配布・再利用の許諾とは解釈しないでください。
