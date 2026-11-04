# @open-scraping/host

**役割：component実装の登録・binding固定・worker lifecycle・stdio JSON-RPC。**

coreが「呼ぶ」だけなのに対し、hostは「どの実装を、どう起動して、どう止めるか」を担当します。

## ファイル

レビューはこの順番が分かりやすいです。

| 順番 | ファイル | 責務 |
| ---: | --- | --- |
| 1 | [src/registry.ts](src/registry.ts) | component登録、manifest digest、capability確認、binding解決、run使用中の取り外し防止 |
| 2 | [src/protocol.ts](src/protocol.ts) | Content-Length framing、JSON-RPC peer、late response、worker exit |
| 3 | [src/component-host.ts](src/component-host.ts) | worker spawn、permission、idempotency、deadline、progress、cancel、binding subcall |
| 4 | [test/registry.test.mjs](test/registry.test.mjs) | registry / binding契約 |
| 5 | [test/component-host.test.mjs](test/component-host.test.mjs) | worker lifecycle / cancel / crash / permission / subcall |

## 大まかな呼び出し

```text
ComponentRegistry.register()
      ↓
resolveFlowBindings()
      ↓ ComponentBindingSnapshot
ComponentWorkerHost.createRunInvoker()
      ↓
RunComponentInvoker.invoke()
      ↓
spawn manifest.runtime.command
      ↓
JsonRpcPeer
      ↓
component worker
```

## 重要な境界

- manifestに指定された実装を別providerへ黙ってfallbackしない
- run開始時のimplementation/version/config/bindingをsnapshotへ固定する
- permissionはhost側が明示grantする
- worker stderrの内容を無条件にログへ露出しない
- cancel grace後に終了するのはhostが所有するworkerだけ
- late responseでterminal resultを書き換えない
- child process処理をcoreへ移さない

## レビュー観点

### registry.ts

- 同じid+versionの別manifestを上書きしないか
- required capabilityの照合
- explicit bindingの固定
- in-use componentのremoveを拒否するか

### protocol.ts

- frame size / header sizeの上限
- partial frame / multiple frame
- invalid JSON / malformed header
- unknown / late response
- child exit時にpending requestを残さないか

### component-host.ts

- idempotency key衝突
- deadlineのarm/cleanup
- cancelとworker resultのrace
- permission default deny
- binding subcallのrun/deadline/cancellation/budget継承
- shutdownが他runのworkerを巻き込まないこと

## テスト

```bash
npm test --workspace @open-scraping/host
```

プロトコル設計：[../../docs/component-host.md](../../docs/component-host.md)
