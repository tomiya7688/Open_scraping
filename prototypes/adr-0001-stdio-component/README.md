# ADR-0001 stdio component prototype

Issue #2 の技術選定用最小試作です。

ブラウザ、検索、保存、GUI、外部パッケージは使いません。
host が所有する子プロセスへ JSON-RPC 2.0 を Content-Length framing した stdio で送り、
処理の意味を host 側へ持ち込まず `operation=transform` を呼べることだけを確認します。

## Run

Node.js 24:

```bash
node prototypes/adr-0001-stdio-component/host.mjs
```

成功時:

```text
progress 1/1
stdio component prototype: ok
```

この試作の protocol 名や method 集合をそのまま正式仕様とみなさないでください。
正式な共通メッセージ、取消、期限、DataRef、manifest handshake は #4 / #7 で定義します。
