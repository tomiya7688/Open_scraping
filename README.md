# Open_scraping

組み替え可能なフロー基盤と交換可能な外部部品で構成するスクレイピング／データ処理基盤です。

現時点の実装対象は 0.x の基盤です。ブラウザ、検索、保存、フィルター等の具体処理は core に組み込みません。

## Development requirements

- Node.js 24.21.0（24 LTS 系）
- npm 11 系

## Setup

```bash
npm install
npm run verify
```

`verify` は TypeScript の型検査、依存境界チェック、docs のローカルリンク／JSON 構文チェック、
ADR-0001 の stdio component prototype を実行します。

ブラウザ、モデル、外部検索サービスの認証情報は 0.x 基盤の検証に不要です。

## Workspace

- `packages/contracts`: 共通の機械可読契約と検証器
- `packages/core`: 処理内容を知らないフロー実行コア
- `packages/host`: state store / component worker / transport 等のホスト実装
- `packages/api-client`: GUI/CLI が利用する公開 API クライアント
- `apps/cli`: 公開 API だけを呼ぶ CLI
- `apps/gui`: 公開 API だけを呼ぶ GUI
- `components/`: 交換可能な外部部品
- `flows/`: FlowConfig / preset
- `distributions/`: 標準・派生配布定義

設計の基準は `docs/`、初期技術構成は `docs/adr/0001-initial-technology-stack.md` を参照してください。
