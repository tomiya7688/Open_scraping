# 開発・CI・受入テストガイド

[開発者向けトップ](README.md) · [共同開発手順](contributing.md)

## 1. 標準検証（main の0.x基盤）

```bash
npm install
npm run verify
```

`verify` は `typecheck` と `npm test` を組み合わせ、`npm test` は依存境界、文書、stdio prototype、各 workspace test を実行します。

| コマンド | 何を確認するか |
| --- | --- |
| `npm run build` | 各 workspace の TypeScript ビルド |
| `npm run typecheck` | 各 workspace の型・コンパイル検証 |
| `npm run check:boundaries` | Core・GUI/CLI の依存禁止事項 |
| `npm run check:docs` | 文書リンクと JSON サンプルの構文 |
| `npm run test:prototype` | stdio コンポーネント試作の呼び出し |
| `npm test` | 境界、docs、prototype、workspace tests |
| `npm run verify` | 型検査と全ローカル検証 |

### 特定領域を調べる

```bash
npm test --workspace @open-scraping/contracts
npm test --workspace @open-scraping/core
npm test --workspace @open-scraping/host
```

CI は [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) の Ubuntu 24.04 / Windows 2025 ランナーで Node.js 24.21.0 を使い `npm run verify` を実行します。Windows 2025ランナーが存在することはOS一般のグローバル入力監視の実装・保証を意味しません。

## 2. レイヤーごとの追加テスト

| 変更対象 | 必要なテスト |
| --- | --- |
| contracts | 正常/異常schema fixture、型不一致、不足能力、参照切れ、版・binding |
| core | 依存順序、並列数、独立分岐、失敗/取消/停止、非terminal結果、DataRef |
| host | 不正フレーム、クラッシュ、遅延応答、deadline、冪等性、権限拒否、子操作と取消 |
| API client / CLI / GUI（実装後） | 公開契約との一致、HTTP認証、結果状態、表示/実行の分離 |
| component（実装後） | モック境界、データ形式、失敗・中断・進捗、ソースや設定ごとの能力差 |
| 非常停止（実装後） | フォーカス外Esc/物理マウス、arm失敗、合成入力、停止レース、所有プロセス限定 |

既存テスト一覧の詳細は [コードレビューガイド](code-review.md) を参照してください。

## 3. 試験種別を混同しない

- **型・静的チェック成功**: ソースと契約の静的な整合性
- **モック成功**: 独立した部品と汎用フローの呼び出し/状態遷移
- **OS統合成功**: 権限・プロセス・グローバル入力など実OSの観測
- **実サイト成功**: 対象サイト、ブラウザ、操作・データ形式の具体的検証
- **利用者向け受入成功**: 配布/操作/保存/出力までを通した期待動作

CIを通っただけで、実サイトに対する対応率、検索漏れの無さ、非常停止のOS実装が保証されるわけではありません。モックでは未確認の事項をPRとリリースノートに明記してください。

## 4. 受入条件と変更の対応

[roadmap.md](roadmap.md) の `A01`〜`A60` の受入テストは**計画**を含みます。作業PRでは該当するID、実際に走るテスト、未実装条件を明記します。受入条件が複数レイヤーに跨る場合は統合テストも必要です。

不安定なテストは再現データ/時刻/環境を固定し、単にスキップして成功としません。ブラウザ等の大きな依存を標準の契約/コアCIへ強制せず、部品単位の統合試験へ分離します。
