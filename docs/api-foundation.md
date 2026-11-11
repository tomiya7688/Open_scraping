# 0.x ローカル公開API（Issue #11 の第一段階）

[公開API全体の設計](api.md) · [コードの入口](../packages/host/src/loopback-api.ts) · [機械可読OpenAPI](../packages/host/openapi-v0-foundation.json)

## このPRで実装する範囲

0.x の**開発用**loopback HTTP JSON APIです。リモート公開や一般向け GUI の完成を意味しません。

| 操作 | 現在の意味 |
| --- | --- |
| `POST /api/v0/flows/validate` | 現在登録済みの manifest を使って FlowConfig 0.3 を検証 |
| `POST /api/v0/flows` | 検証成功したフローをメモリへ登録。既存IDは 409 |
| `GET /api/v0/flows/{id}` | 登録済みフローと SHA-256 内容 revision を返す |
| `PATCH /api/v0/flows/{id}` | `If-Match: "revision"` を必須とする原子的な置き換え |
| `GET /api/v0/components` | ホストに明示登録した component ID、版、manifest digest 一覧 |
| `GET /api/v0/components/{id}/manifest?version=...` | 版を指定した component manifest の照会 |

この段階で `/api/v0/runs/*`、`/api/v0/operations/*`、部品 `/invoke` は **501 NOT_IMPLEMENTED** を返します。Run 作成・起動・停止・再開・イベントSSE・部品invokeはまだ使えません。グローバル非常停止の OS フックは [Issue #42](https://github.com/tomiya7688/Open_scraping/issues/42) に残り、実行系の有効化はその不変条件に依存します。

登録フローは **プロセス内のメモリのみ** に保持します。再起動すると消えます。これは #10 の永続ジャーナルではありません。

## ローカル認証と接続条件

- サーバーは **127.0.0.1のみ** にbind。呼び出し側が32バイト以上のランダムな秘密トークンを用意し、HTTP `Authorization: Bearer <token>` で渡します。
- 任意のOriginからのリクエストは拒否。ブラウザUIから利用する場合、ホスト起動時に許可Originを明示指定します。CLI等、通常のOriginが付かないクライアントもトークンは必須です。
- `Host` ヘッダーを loopback hostname と実際の listening port で照合します。トークンをURL・ログに載せないでください。
- POST/PATCHは `Content-Type: application/json`。サイズ上限は既定 1 MiB（設定上限 4 MiB）。失敗は構造化したエラーで返します。
- 認証済みAPIであっても、ブラウザの取得や部品実行のためのOS非常停止が実装されたことにはなりません。

### ホストライブラリからの起動例

```js
import { randomBytes } from "node:crypto";
import { ComponentRegistry, startLoopbackApi } from "@open-scraping/host";

const registry = new ComponentRegistry();
// この例では manifest を未登録。必要な実装を明示登録してください。
const token = randomBytes(32).toString("hex");

const api = await startLoopbackApi({ registry, token });
console.log("Local API listening:", api.base_url);
// 認証情報 token はログへ出力しない。
// 終了時: await api.close();
```

ブラウザ検索や実処理は開始しません。クライアントは自動的に token を推測できないため、配布方法やプロセス間の資格情報共有も後続 Issue で設計します。

## 契約の検証

`npm test --workspace @open-scraping/host` で HTTP のリクエスト・レスポンス、認証、Origin、Host、版競合、未実装応答を検証します。OpenAPIファイルに宣言した実装済み6操作の存在もテストします。OpenAPIで説明するFlowConfigの完全な意味検証は `packages/contracts` が実行します。

将来のRun/SSE/Invokeは同じAPIの別段階で実装し、利用できる操作だけをOpenAPIへ追加します。
