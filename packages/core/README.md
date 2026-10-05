# @open-scraping/core

**役割：処理内容を知らないFlow runtime。**

coreは「何を処理しているか」を理解しません。FlowConfigの依存関係を解決し、component invocationへ流し、状態・停止・失敗を管理します。

## ファイル

| ファイル | 何があるか |
| --- | --- |
| [src/execution.ts](src/execution.ts) | execution plan作成、FlowRun、node実行、参照解決、stop |
| [src/index.ts](src/index.ts) | public export |
| [test/execution.test.mjs](test/execution.test.mjs) | 並列、依存、失敗、stop、cycle、inline output制限 |

## 公開面

中心となる型・関数は次です。

- `FlowInvoker` — coreが実処理を呼ぶ唯一の抽象面
- `createExecutionPlan()` — FlowConfigから依存関係を作る
- `FlowRun` — run state machine
- `createFlowRun()` — validation付きのrun生成

## 実行の流れ

```text
FlowConfig
  ↓ createExecutionPlan
ExecutionPlan
  ↓
FlowRun.start()
  ↓
ready nodeを選ぶ
  ↓
FlowInvoker.invoke(OperationRequest)
  ↓
OperationResult
  ↓
node state / flow outputを更新
```

## coreに入れてはいけないもの

- child_process
- fsによるデータセット保存
- HTTP / WebSocket client
- Playwright / Puppeteer
- SQLite等の保存処理
- LLM / vision model
- search.provider等の具体contract IDに応じた分岐

[scripts/check-boundaries.mjs](../../scripts/check-boundaries.mjs) で一部を機械検査しています。

## レビュー観点

- stop要求後に新規nodeが起動しないか
- 失敗した依存先の後続がblockされるか
- `continue_independent` と `stop` が混ざっていないか
- deadlineがrun全体で一貫しているか
- invoker例外とOperationResult上のfailedを区別しているか
- 非terminal resultを成功扱いしていないか
- 大きなinline resultをcore stateへ保持しないか
- node名やcomponent IDで具体処理を特別扱いしていないか

## テスト

```bash
npm test --workspace @open-scraping/core
```

実行設計：[../../docs/runtime.md](../../docs/runtime.md)
