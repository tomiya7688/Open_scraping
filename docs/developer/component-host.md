# 部品ホストとローカルワーカー

[設計書一覧](README.md)

Issue #7 の初期実装は、ADR-0001で決めた Content-Length framed JSON-RPC 2.0 over stdio を使う。

## 所有単位

0.x初期版では、各operationが自分専用のworker processを所有する。
応答不能operationを期限付きで終了しても、別operation・別runのworkerは終了しない。

将来worker poolを追加してもよいが、取消と障害の所有境界を弱めてはならない。

## 状態

hostがrequestをworkerへ配送できる状態になった時点で `accepted` eventを出す。
これは処理完了ではない。

workerの最終応答は次のいずれか。

- succeeded
- failed
- cancelled
- termination_unknown

進捗は `operation-progress` として別イベントにする。
progress後にworkerが落ちた場合、そのprogressを成功扱いせず `termination_unknown` で終える。

## 再送

`idempotency_key` はrun host内で記録する。

- 同じkey・同じ内容: 同じPromise/最終結果を返し、再実行しない
- 同じkey・異なる内容: `IDEMPOTENCY_CONFLICT`

これはhostからworkerへの重複実行抑制であり、workerが外部サービスへ行った副作用の exactly-once を保証しない。

## 取消と期限

取消要求は `component.cancel` として配送する。
manifestの `cancellation.grace_ms` 内にoperationが終わらなければ、そのoperation所有workerをhostが終了する。
終了結果を確認できない場合は `termination_unknown`。

deadlineも同じ取消経路を使う。
取消後の遅延応答や重複応答は、既に完了したoperationの状態を上書きしない。

## binding subcall

workerは登録済みbindingに限り `host.invoke_binding` を要求できる。
hostはrun snapshotから明示bindingを解決し、親operationと同じ以下のscopeを子へ継承する。

- run_id
- deadline
- cancellation_scope_id
- budget_scope_id

binding名から公式部品を推測したり、自動インストールしたりしない。

## 権限と隔離の限界

manifestの `permissions` が空でないcomponentは、hostのpermission resolverが明示許可しなければ起動しない。
secret等を渡す場合はresolverが作るopaque grantを使い、host eventやstderr diagnosticへgrant値を出さない。

workerへ継承する環境変数は PATH / OS実行用の最小項目だけで、親processの環境を丸ごと渡さない。
stderr本文も通常eventへ転記せず、byte数だけを診断する。

**これはOS sandboxではない。**
別processであるだけでファイル・ネットワーク・他processへのアクセスを完全隔離できるとは表示しない。
強い隔離が必要な配布では、container / OS sandbox / 権限分離adapterをhost層へ追加する。
