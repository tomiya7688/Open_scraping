# @open-scraping/contracts

**役割：Open_scrapingの共通wire contractと静的検証。**

ここには検索・画像・ブラウザ等の具体処理はありません。

## ファイル

| ファイル | 何があるか |
| --- | --- |
| [src/types.ts](src/types.ts) | TypeScript上の共通型。FlowConfig、manifest、DataRef、operation message |
| [src/schemas.ts](src/schemas.ts) | JSON Schema。外部入力の構造を検証するsource of truth |
| [src/validator.ts](src/validator.ts) | public APIの再export入口 |
| [src/validation-schema.ts](src/validation-schema.ts) | wire JSON Schemaとinline schema検証 |
| [src/validation-manifest.ts](src/validation-manifest.ts) | manifestの重複検査・settings schema |
| [src/validation-bindings.ts](src/validation-bindings.ts) | component実装・能力・bindingの解決と循環 |
| [src/validation-flow.ts](src/validation-flow.ts) | nodeと入出力、参照型、依存グラフの検証 |
| [src/validation-common.ts](src/validation-common.ts) | 共通のcycle diagnostic |
| [src/index.ts](src/index.ts) | public exports |
| [test/contracts.test.mjs](test/contracts.test.mjs) | 契約の正常系・異常系 |
| [test/fixtures/](test/fixtures/) | reviewしやすいFlowConfig例 |

## 主な契約

- `FlowConfig 0.3`
- `ComponentManifest 0.1`
- `DataRef 0.1`
- `OperationRequest / Progress / Result / Cancel 0.1`

## レビュー観点

- schemaとTypeScript型が食い違っていないか
- unknown fieldを黙って受け入れていないか
- dangling ref / cycle / type mismatchを検出できるか
- capability不足を実行前に検出できるか
- 特定の検索・ブラウザ・フィルター実装をcontract側で特権化していないか
- 将来の未知のcontract IDをcore変更なしで扱えるか

## テスト

```bash
npm test --workspace @open-scraping/contracts
```

設計仕様：[../../docs/contracts.md](../../docs/contracts.md)
