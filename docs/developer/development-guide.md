# 全体開発ガイド

[開発者向けトップ](README.md) · [開発への参加](contributing.md) · [検証方法](testing.md)

## 1. 目的と開発対象

Open_scraping は、検索・取得・加工・選別・保存などの**具体処理を Core に実装せず**、交換可能な部品の呼び出しを汎用 Flow として実行する基盤です。標準構成と、利用者が独自の部品・フロー・画面を組み合わせる派生構成の両方を検証します。

- **0.x**：契約、Flow実行、Host、公開API、停止/復旧、モックの統合（進行中）
- **1.0.0 計画**：テキスト・画像・数表の収集と各種部品、一般向け商品検索フロー
- **1.1.0 計画**：動画部品と長時間処理

**main で動く部分**と未マージのPRは区別してください。現在の main は契約検証、基本 FlowRun、component worker host のテスト可能な基盤が中心で、CLI/GUI/検索・保存等の具体機能はまだありません。開発Issueの正本は [Issue #1](https://github.com/tomiya7688/Open_scraping/issues/1) と個別 Issue です。

## 2. アーキテクチャ（責務の固定境界）

```text
                CLI / GUI （公開APIクライアントだけ）
                               │
                     Public API（開発予定）
                               │
       ┌───────────────────────┴─────────────────────┐
       │                                             │
       ▼                                             ▼
 contracts: schema / manifest / Flow検証       Host: registry
       │                                             │
       ▼                                             ├── worker管理・権限・RPC
 Core: execution plan / FlowRun                       │
       │                                             ▼
       └────── FlowInvoker抽象 ──────────── Component（任意言語）
                                                   │
                                      検索・取得・処理・保存など
```

これは**責務図**であり、公開HTTP APIが実装済みという意味ではありません。現在は契約、Core、Hostのコードを追えます。正式な依存図は [ADR-0001](adr/0001-initial-technology-stack.md)、境界の要件は [design.md](design.md) を参照してください。

| ディレクトリ | 所有するもの / 主なレビュー対象 | 持ち込まないもの |
| --- | --- | --- |
| [packages/contracts](../../packages/contracts/) | 公開wire型、JSON Schema、契約・参照・能力検証 | サイト固有の処理、特定実装優遇 |
| [packages/core](../../packages/core/) | plan、依存解決、run状態・停止、参照配送 | HTTP/ブラウザ/LLM/データセットSQL |
| [packages/host](../../packages/host/) | registry、binding固定、worker/protocol、権限、取消 | Core に固有データ処理を持ち込むこと |
| [packages/api-client](../../packages/api-client/) | APIクライアント（現時点では stub） | componentを直接実行するコード |
| [apps/cli](../../apps/cli/) / [apps/gui](../../apps/gui/) | APIを経由した操作UI（現時点では stub） | browser SDK、保存・検索の実装 |
| [components](../../components/) | 将来の外部処理部品 | 特定部品のCore特例 |
| [flows](../../flows/) / [distributions](../../distributions/) | 標準/派生の構成例と配布定義（枠のみ） | Coreへの処理の焼き込み |
| [prototypes](../../prototypes/) | ADRの技術試作 | 製品APIとしての保証 |
| [scripts](../../scripts/) | CI境界・docs等の検証 | 実サービスへの依存 |

## 3. 技術スタックとセットアップ

[ADR-0001](adr/0001-initial-technology-stack.md) で採用した初期基準は Node.js 24 LTS、TypeScript 7.x、ESM、npm workspaces です。Node.js の CI 固定版は **24.21.0**、npmは **11系**。Windows 11 x64 を主対象、Ubuntu 24.04 x64 を CI 対象とします。macOS等は検証前提ではありません。

```bash
git clone https://github.com/tomiya7688/Open_scraping.git
cd Open_scraping
npm install
npm run verify
```

`npm run verify` は型・境界・ドキュメント・モックの検証です。**実Web収集、ブラウザ、グローバルOS入力監視の完了証明ではありません。**

## 4. 変更対象の見つけ方

| やりたい変更 | 最初のファイルとテスト |
| --- | --- |
| FlowConfig/Manifest/DataRefの追加・修正 | [contracts/src/types.ts](../../packages/contracts/src/types.ts)、[schemas.ts](../../packages/contracts/src/schemas.ts)、[validator.ts](../../packages/contracts/src/validator.ts)、contracts tests |
| node順序・停止・参照配送 | [core/src/execution.ts](../../packages/core/src/execution.ts)、core tests |
| 実装版固定・binding | [host/src/registry.ts](../../packages/host/src/registry.ts)、registry tests |
| stdio通信・ワーカー/権限/取消 | [host/src/protocol.ts](../../packages/host/src/protocol.ts)、[component-host.ts](../../packages/host/src/component-host.ts)、host tests |
| 独自部品の接続・派生版 | [customization.md](customization.md)、[components.md](components.md)、[contracts.md](contracts.md) |
| 公開API・UI（未実装） | [api.md](api.md)、[ADR-0001](adr/0001-initial-technology-stack.md) と対応 Issue |

上記のパスは main を基準にしています。モジュール分割中の PR がある場合は、レビュー対象ブランチの package README を優先してください。

## 5. 守るべき契約

1. **Core は処理内容を知らない。** 標準の search / browser / download / filter / dataset や具体SDKをCoreへ追加しない。
2. **部品の入替を可能にする。** 同名でも版・契約・能力の照合を行い、不足を明示する。暗黙に別実装へ切り替えない。
3. **停止と実行結果を正しく区別する。** `accepted` は完了ではない。`failed`、`cancelled`、`termination_unknown` を成功に置き換えない。
4. **DataRef と実体データを分ける。** 大きな画像/動画を Core の状態へ詰め込まず、保存と出典の管理は部品に委譲する。
5. **Core唯一の安全機能は人間によるグローバル非常停止。** Esc/物理マウス操作によるフォーカス非依存の非常停止は必須のランタイム不変条件で、部品・Flowから解除できない。**ただし現行 main では OS 実装が未完成**（[Issue #42](https://github.com/tomiya7688/Open_scraping/issues/42)）。
6. **未実装の機能は未実装と記載する。** 概念設計・Mock test と本番動作試験を混ぜない。

## 6. 設計の変更と分業

- 機能変更は対応 Issue に目的・影響する契約/層・受入条件・依存Issueを明示し、小さいPRで進めます。
- API/FlowConfigの変更は互換性と版管理を同時にレビューし、必要なら [ADR](adr/0001-initial-technology-stack.md) を追加します。既存ADRを無言で書き換えて決定履歴を消しません。
- UI とComponentは互いの内部に依存せず、契約/公開APIの準備が整ってから個別に開発します。未実装APIを動く前提にしません。
- 他の未マージPRを前提にするときは、基点ブランチ・依存PR・必要なマージ順を明記し、同じファイルへの競合を避けます。
- 利用者が見る挙動を変える変更は [利用者向けドキュメント](../user/README.md) も更新してください。
- 実装に向けた検証は [testing.md](testing.md)、レビューは [code-review.md](code-review.md) を参照してください。
