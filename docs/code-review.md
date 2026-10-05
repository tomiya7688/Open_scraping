# コードレビューガイド

この文書は「設計文書を全部読まないとレビューできない」状態を避けるための入口です。

## 1. まず把握すること

現在レビュー対象として実装があるのは主に次の3層です。

```text
contracts  →  core  →  host
    ↑                    │
    └──── 共通wire型 ────┘
```

実ブラウザ、検索、保存、フィルター、GUI、CLIはまだレビュー対象となる完成実装ではありません。

## 2. 30分で全体を見る順番

### Step 1 — contractの形（5分）

1. [../packages/contracts/src/types.ts](../packages/contracts/src/types.ts)
2. [../packages/contracts/src/schemas.ts](../packages/contracts/src/schemas.ts)
3. [../packages/contracts/test/fixtures/valid/local-processing.json](../packages/contracts/test/fixtures/valid/local-processing.json)

ここで「FlowConfigが何を持つか」「componentが何を宣言するか」を確認します。

### Step 2 — coreのstate machine（10分）

1. [../packages/core/src/execution.ts](../packages/core/src/execution.ts)
2. [../packages/core/test/execution.test.mjs](../packages/core/test/execution.test.mjs)

見る場所：

- `createExecutionPlan`
- `FlowRun.start / stop`
- node launch
- dependency blocked
- result処理
- flow output解決

### Step 3 — hostの境界（15分）

1. [../packages/host/src/registry.ts](../packages/host/src/registry.ts)
2. [../packages/host/src/protocol.ts](../packages/host/src/protocol.ts)
3. [../packages/host/src/component-host.ts](../packages/host/src/component-host.ts)
4. 対応するtest

ここではcomponent version固定、worker ownership、permission、cancel raceを中心に見ます。

---

## 3. PRの種類ごとのレビュー範囲

### contract変更

必須：

- types.ts
- schemas.ts
- validator.ts
- fixtures
- contracts tests

確認：

- 既存FlowConfigが壊れるならversionをどう扱うか
- schemaとruntime validationが二重に違う意味を持っていないか
- unknown component contractを不必要に禁止していないか

### core変更

必須：

- core/src/execution.ts
- core tests
- check-boundaries

確認：

- 具体的な処理をcoreに入れていないか
- failure / cancel / stopのstate transition
- 並列node間で状態raceがないか
- invokerをmockに差し替え可能か

### host registry変更

必須：

- registry.ts
- registry tests
- contracts validatorのbinding関連

確認：

- version pinning
- manifest digest
- capability
- explicit binding
- remove while in use

### worker protocol変更

必須：

- protocol.ts
- component-host.ts
- mock-worker fixture
- component-host tests

確認：

- framing size limit
- malformed input
- process exit
- deadline timer
- cancel race
- late result
- permission
- child ownership

### GUI / CLI変更

現時点ではstubです。実装開始後もレビュー原則は：

- `@open-scraping/api-client` 以外から実処理をimportしない
- browser/model/dbを直接操作しない
- 表示上の成功とoperationの実完了を混同しない

---

## 4. アーキテクチャ不変条件

PRレビューで最優先する項目です。

### Core

- 具体的なbrowser/search/download/filter/store/modelを知らない
- component contract IDをswitchしない
- child processをspawnしない
- DBやデータ本体を直接保存しない
- 大きな結果はDataRefへ逃がす

### Host

- explicitなimplementation/versionを固定する
- 暗黙fallbackしない
- permissionはdefault deny
- hostが所有していないprocessをkillしない
- terminal resultをlate responseで上書きしない

### Contracts

- 外部入力はschema検証する
- TypeScript型だけをsecurity boundaryにしない
- dangling ref / type mismatch / missing capabilityを実行前に落とす
- 将来の独自contractを不必要に閉じない

### GUI / CLI

- APIを呼ぶだけ
- core / host / componentを直接importしない

---

## 5. 現在のテストが見ていること

| package | 主なテスト |
| --- | --- |
| contracts | schema、dangling ref、node cycle、type mismatch、capability、unsupported構文 |
| core | node依存、並列、failure policy、stop、cycle、inline output上限 |
| host registry | register、manifest差替拒否、availability、binding固定、暗黙fallback禁止、in-use remove |
| host worker | accepted/progress/completed、idempotency、cancel grace、crash、invalid message、late response、permission、binding subcall |

`npm run verify` で全体を通してください。

---

## 6. CIでは見つからないこと

次は人間レビューが必要です。

- コードは汎用に見えるが、実質的に標準componentだけを想定していないか
- エラー状態を減らすために情報を潰していないか
- cancellation raceで副作用が二重実行されないか
- ログやdiagnosticへ秘密情報を流していないか
- timeout / deadlineの意味が複数層で矛盾していないか
- 将来componentを交換すると壊れる内部前提がないか

---

## 7. 変更前後に実行するコマンド

```bash
npm run verify

# 問題を絞る
npm test --workspace @open-scraping/contracts
npm test --workspace @open-scraping/core
npm test --workspace @open-scraping/host
npm run check:boundaries
```

## 8. 設計まで確認したい場合

レビュー論点に応じて必要なものだけ読みます。

- contract：[contracts.md](contracts.md)
- core境界：[design.md](design.md)
- worker host：[component-host.md](component-host.md)
- stop / recovery：[runtime.md](runtime.md)
- emergency stop：[emergency-stop.md](emergency-stop.md)
- 技術選定：[adr/0001-initial-technology-stack.md](adr/0001-initial-technology-stack.md)
