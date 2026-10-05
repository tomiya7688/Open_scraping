# packages/ — 実装パッケージ案内

コードレビューでは、まずこの順に見てください。

```text
contracts
   ↓
core
   ↓
host
   ↓
api-client
   ↓
apps/cli, apps/gui
```

現在、実装が入っているのは **contracts / core / host** です。

| package | 状態 | 依存してよいworkspace |
| --- | --- | --- |
| [contracts](contracts/) | 実装済み | なし |
| [core](core/) | 実装済み | contracts |
| [host](host/) | 実装済み | contracts, core |
| [api-client](api-client/) | stub | contracts |

依存方向は [../scripts/check-boundaries.mjs](../scripts/check-boundaries.mjs) が検査します。

## レビューの順番

### 1. contracts

「何をwireに流してよいか」を決める層です。

- [contracts/src/types.ts](contracts/src/types.ts)
- [contracts/src/schemas.ts](contracts/src/schemas.ts)
- [contracts/src/validator.ts](contracts/src/validator.ts)
- [contracts/test/contracts.test.mjs](contracts/test/contracts.test.mjs)

### 2. core

「どう流すか」だけを扱います。

- [core/src/execution.ts](core/src/execution.ts)
- [core/test/execution.test.mjs](core/test/execution.test.mjs)

coreにHTTP、child_process、Playwright、DB、モデル等が入ったら設計違反です。

### 3. host

「どの実装を使うか」「workerをどう起動・止めるか」を扱います。

- [host/src/registry.ts](host/src/registry.ts)
- [host/src/protocol.ts](host/src/protocol.ts)
- [host/src/component-host.ts](host/src/component-host.ts)
- [host/test/registry.test.mjs](host/test/registry.test.mjs)
- [host/test/component-host.test.mjs](host/test/component-host.test.mjs)

## 詳細

- [contracts/README.md](contracts/README.md)
- [core/README.md](core/README.md)
- [host/README.md](host/README.md)
- [../docs/code-review.md](../docs/code-review.md)
