# Open_scraping

> **現在は 0.x のフロー実行基盤を実装中です。実際のブラウザ検索・ダウンロード・フィルター等はまだ標準実装されていません。**

Open_scraping は「完成したスクレイパー」ではなく、**交換可能な部品をつないで自分の収集ソフトを作るための基盤**です。

## 最初に見る場所

目的別に、ここから読んでください。

| やりたいこと | 最初に見るファイル |
| --- | --- |
| **コードレビューしたい** | [docs/code-review.md](docs/code-review.md) |
| **今どこまで実装済みか知りたい** | このREADMEの「実装状況」 |
| **コードの置き場所を知りたい** | [packages/README.md](packages/README.md) |
| フロー形式・部品契約を確認したい | [docs/contracts.md](docs/contracts.md) |
| コアの責務を確認したい | [docs/design.md](docs/design.md) |
| component host / stdio RPCを確認したい | [docs/component-host.md](docs/component-host.md) |
| 全設計文書の索引 | [docs/README.md](docs/README.md) |
| 実装計画・Issue一覧 | [Issue #1](https://github.com/tomiya7688/Open_scraping/issues/1) |

**レビューだけなら、最初から `docs/design.md` を全部読む必要はありません。**
現在の実装は `contracts → core → host` の3パッケージを追えば把握できます。

---

## 実装状況

| 場所 | 状態 | 役割 |
| --- | --- | --- |
| [packages/contracts](packages/contracts/) | **実装済み・テストあり** | FlowConfig、component manifest、DataRef、operation message、検証 |
| [packages/core](packages/core/) | **実装済み・テストあり** | 処理内容を知らないフロー実行、依存解決、停止、状態遷移 |
| [packages/host](packages/host/) | **実装済み・テストあり** | component登録、binding固定、stdio JSON-RPC worker、取消・deadline・permission |
| [packages/api-client](packages/api-client/) | **stub** | 公開APIクライアント予定 |
| [apps/cli](apps/cli/) | **stub** | 公開APIだけを呼ぶCLI予定 |
| [apps/gui](apps/gui/) | **stub** | 公開APIだけを呼ぶGUI予定 |
| [components](components/) | **枠だけ** | ブラウザ、検索、取得、保存、フィルター等の実処理部品 |
| [flows](flows/) | **枠だけ** | 標準FlowConfig / preset |
| [distributions](distributions/) | **枠だけ** | 標準・派生配布定義 |
| [prototypes](prototypes/) | **試作** | ADRで技術判断に使った小さな検証コード |

### まだ無いもの

現時点では、次は実装済みと考えないでください。

- Chromium / Firefox の標準ブラウザ部品
- Google / DuckDuckGo / Bing / Yahoo / サイト内検索部品
- ダウンロード・保存・出力部品
- テキスト・画像・数表の実処理
- 自然言語解釈、類似度、重複等の標準フィルター
- HTTP公開API、実GUI、実CLI
- グローバル非常停止のOS実装（設計：[docs/emergency-stop.md](docs/emergency-stop.md)、Issue #42）

---

## 現在のコードの流れ

今レビューできる主要経路はこれです。

```text
FlowConfig
   │
   ├─ contracts
   │    ├─ JSON Schema
   │    ├─ 構造・型・参照検証
   │    └─ component manifest / operation message
   │
   ├─ host: ComponentRegistry
   │    └─ component実装・版・bindingを固定した snapshot を作る
   │
   ├─ core: FlowRun
   │    ├─ node依存関係を解決
   │    ├─ 並列数・失敗方針・stopを管理
   │    └─ FlowInvoker を呼ぶ
   │
   └─ host: RunComponentInvoker
        ├─ workerをspawn
        ├─ stdio JSON-RPC
        ├─ permission / deadline / idempotency
        ├─ cancel
        └─ 必要なら所有workerを終了
```

重要なのは、**core は child_process / HTTP / Playwright / DB / モデルを直接使わない**ことです。
この境界は [scripts/check-boundaries.mjs](scripts/check-boundaries.mjs) でCI検査しています。

---

## コードレビューの最短ルート

初見レビューはこの順番を推奨します。

1. [packages/contracts/src/types.ts](packages/contracts/src/types.ts) — 共通データ型
2. [packages/contracts/src/schemas.ts](packages/contracts/src/schemas.ts) — wire format
3. [packages/contracts/src/validator.ts](packages/contracts/src/validator.ts) — 契約検証
4. [packages/core/src/execution.ts](packages/core/src/execution.ts) — フロー実行本体
5. [packages/host/src/registry.ts](packages/host/src/registry.ts) — component登録・binding解決
6. [packages/host/src/protocol.ts](packages/host/src/protocol.ts) — stdio JSON-RPC framing
7. [packages/host/src/component-host.ts](packages/host/src/component-host.ts) — worker lifecycle / invoke / cancel
8. 対応する `test/*.test.mjs`
9. [scripts/check-boundaries.mjs](scripts/check-boundaries.mjs) — アーキテクチャ違反検出

論点別のチェックリストと「どのテストが何を保証するか」は
**[docs/code-review.md](docs/code-review.md)** にまとめています。

---

## リポジトリ構成

```text
.
├─ packages/
│  ├─ contracts/     # 共通契約・schema・validator
│  ├─ core/          # 汎用Flow runtime
│  ├─ host/          # component registry / worker host / protocol
│  └─ api-client/    # stub
├─ apps/
│  ├─ cli/           # stub
│  └─ gui/           # stub
├─ components/       # 今後の実処理部品
├─ flows/            # 今後の標準FlowConfig / preset
├─ distributions/    # 今後の配布構成
├─ prototypes/       # 技術試作
├─ scripts/          # CI用の境界・docs検査
├─ docs/             # 設計・ADR・レビューガイド
└─ .github/workflows/ci.yml
```

各packageの詳しい責務は [packages/README.md](packages/README.md) から辿れます。

---

## 開発・検証

### 必要環境

- Node.js 24.21.0（24 LTS系）
- npm 11系

### セットアップ

```bash
npm install
npm run verify
```

### よく使うコマンド

```bash
npm run build
npm run typecheck
npm test
npm run check:boundaries
npm run check:docs

# package単体
npm test --workspace @open-scraping/contracts
npm test --workspace @open-scraping/core
npm test --workspace @open-scraping/host
```

`npm run verify` は、型検査、依存境界、docsリンク／JSON、prototype、各workspace testをまとめて実行します。

0.x基盤の検証にはブラウザ・モデル・検索サービスのAPI keyは不要です。

---

## レビュー時に守る境界

このプロジェクトで最も重要なレビュー観点です。

- **core に具体処理を入れない**
  - browser / search / HTTP / filesystem dataset / DB / model 等
- **標準部品を特別扱いしない**
  - 固定component IDによる分岐を作らない
- **GUI / CLI に実処理を入れない**
  - 公開APIクライアントだけを使う
- **未対応を成功扱いしない**
  - unsupported / failed / cancelled / termination_unknown を潰さない
- **大きなデータ本体をcoreへ流し込まない**
  - DataRefを使う
- **componentの版とbindingを実行時に固定する**
  - 暗黙fallbackをしない

自動検査だけでは判断できない項目もあるため、詳細は [docs/code-review.md](docs/code-review.md) を参照してください。

---

## 設計思想を読む場合

実装を追った後で必要な文書だけ読んでください。

- [docs/design.md](docs/design.md) — コアと外部部品の境界
- [docs/contracts.md](docs/contracts.md) — 現行contract仕様
- [docs/runtime.md](docs/runtime.md) — stop / recovery / scheduling
- [docs/customization.md](docs/customization.md) — 改変して別ソフトを作る方針
- [docs/emergency-stop.md](docs/emergency-stop.md) — コア唯一の安全機能
- [docs/roadmap.md](docs/roadmap.md) — 受入条件
