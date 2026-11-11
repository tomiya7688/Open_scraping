# ADR-0001: 初期技術構成とプロセス境界

- 状態: Accepted
- 決定日: 2026-09-24
- 対応Issue: #2
- 対象版: 0.x

## Context

Open_scraping のコアは、ブラウザ・検索・取得・保存・解析・選別・出力などの具体処理を持たない。
GUI/CLI も具体処理 SDK を直接呼ばず、公開 API を通じてフローと部品を操作する。

初期実装では、次の条件を同時に満たす必要がある。

- フロー実行、参照、順序・分岐・並列・待機・中断・実行状態を型付きで実装できる。
- 標準部品も第三者部品も同じ境界で扱える。
- Python、Rust 等の異言語部品を後から追加できる。
- GUI/CLI が処理実装へ直接依存しない。
- Windows と Linux でローカル実行できる。
- 実行ジャーナルとデータセット保存を分離できる。
- ブラウザ、モデル、外部検索サービスなしでも基盤を試験できる。

## Decision

### 1. コア／ホスト／CLIの初期言語

**Node.js 24 LTS + TypeScript 7.x + ESM** を採用する。

初期のパッケージ管理は Node.js 同梱の npm workspaces を使う。追加のパッケージマネージャを基盤要件にしない。

理由:

- FlowConfig、マニフェスト、DataRef、公開 API の JSON 契約と相性がよい。
- GUI 側と型・検証ロジックを共有しやすい。
- 子プロセス、標準入出力、HTTP、SSE を標準ライブラリで扱える。
- ブラウザ・検索等の具体 SDK をコアへ入れず、ホスト／外部部品へ限定できる。
- JSON Schema / OpenAPI の既存ツールを利用できる。
- 異言語部品をプロセス境界に置けば、部品実装言語を TypeScript に強制しない。

Node.js の具体パッチは CI で固定する。0.x の初期基準は Node.js 24 系とし、Current 系への追随は自動で行わない。

### 2. 最初に検証するOS

- **Primary**: Windows 11 x64
- **CI reference**: Ubuntu 24.04 LTS x64
- **Future candidate**: macOS Apple Silicon

0.x では Windows 11 x64 と Ubuntu 24.04 LTS x64 を継続試験対象にする。
macOS は設計上排除しないが、CI と配布検証を追加するまで動作保証しない。

OS 固有のプロセス終了、シグナル、パス、権限差は host 層に閉じ込める。

### 3. ローカル部品呼び出し

**JSON-RPC 2.0 を Content-Length framing した stdio 通信**を初期方式にする。

各部品ワーカーはホストが所有する子プロセスとして起動し、stdin/stdout を RPC に使う。
stderr は診断ログ専用とする。

共通メソッド名は少数に保ち、処理カテゴリをメソッド名へ埋め込まない。

- `component.initialize`
- `component.invoke`
- `component.cancel`
- `component.shutdown`

`component.invoke` の `operation` と入出力の意味はマニフェスト契約で決める。
検索、ブラウザ、保存、フィルター等を RPC 層の特別メソッドにしない。

進捗、チェックポイント、診断は JSON-RPC notification として流せるようにする。

#### stdio を選ぶ理由

- TCP ポート割当やローカルサービス管理が不要。
- ホストが所有ワーカーの生存期間を管理しやすい。
- 任意言語から実装可能。
- 同一プロセスのプラグイン ABI と違い、部品の依存関係をコアへ持ち込まない。
- 後から remote transport adapter を追加しても、コアの FlowConfig を変えなくてよい。

#### 採用しない初期案

- Node.js の直接 `import()`: 異言語部品と依存隔離を壊すため不採用。
- 部品ごとの localhost HTTP server: 初期段階ではポート・認証・生存管理が増えるため不採用。
- gRPC: 契約生成とバイナリ依存を初期基盤へ増やす必要がないため見送り。

### 4. GUI／CLIが使う公開操作API

**loopback HTTP JSON + Server-Sent Events (SSE)** を採用する。

- REST/JSON: フロー、run、component、operation の要求と照会
- SSE: run/operation の順序付きイベント配信
- bind: 初期値 `127.0.0.1` のみ
- auth: 起動時に発行するローカルトークンを必須とする
- OpenAPI: 公開 HTTP 契約の機械可読定義に使う

CLI も GUI と同じ HTTP API を使う。
「CLI だから core を直接 import する」という特例は設けない。

将来 remote deployment を追加する場合は、TLS、認証、Origin、権限を transport/host 側で追加する。

### 5. GUI

初期 GUI は **React + Vite のローカル Web UI** とする。

GUI は次だけを行う。

- 公開 API への入力
- スキーマからの設定フォーム描画
- run / operation / event の表示
- FlowConfig 編集
- 部品不足・契約不一致の表示

GUI から browser SDK、HTTP downloader、model SDK、SQLite driver、component package を直接 import しない。

0.x ではデスクトップシェルを必須にしない。
Tauri / Electron 等は後から UI shell として追加できるが、public API client より内側へ入れない。

### 6. 実行ジャーナル

core は `RunStateStore` 等の抽象ポートだけに依存する。

初期 adapter は **SQLite** とし、host package に置く。
Node.js 24 系の `node:sqlite` を最初の実装候補とするが、RC API であるため adapter の外へ型や SQL を漏らさない。
必要なら同じ port の別 driver へ交換できる。

データセット保存は別部品の責務であり、実行ジャーナルの SQLite schema に Image / SearchResult / Selection 等を追加しない。

### 7. 依存方向

```text
GUI ─┐
     ├─> Public HTTP API client ─> Host / API transport ─> Core
CLI ─┘                                      │              │
                                            │              └─> abstract ports only
                                            │
                                            ├─> StateStore adapter (SQLite)
                                            └─> ComponentHost
                                                   │
                                                   └─ JSON-RPC 2.0 / stdio
                                                            │
                               ┌────────────────────────────┼─────────────────────┐
                               ▼                            ▼                     ▼
                         browser component            search component       custom component
                         (any language)               (any language)        (any language)
```

禁止する依存:

- core -> browser/search/model/storage implementation SDK
- core -> dataset SQL/schema
- GUI/CLI -> concrete processing SDK
- standard component ID を見た core の特別分岐
- component -> 未宣言 dependency の直接起動

### 8. 最小のヘッドレス構成

ブラウザや GUI がなくても次を成立させる。

```text
HTTP API (optional)
      │
      ▼
Host ─> Core ─> ComponentHost ─> mock text-transform worker
```

テストでは mock component が文字列を受け取り、大文字化した値を返す。
これは処理カテゴリの意味を core が知らずに invoke できることを確認する。

`prototypes/adr-0001-stdio-component/` に、Node.js 標準ライブラリだけで動く最小試作を置く。

### 9. 版管理

少なくとも次を別々に扱う。

- product version
- public API version
- FlowConfig schema version
- component manifest schema version
- component contract version
- component implementation version
- stored run journal schema version

transport protocol の互換性も manifest/handshake で明示する。
「実装版が新しいから契約互換」とは推測しない。

## Alternatives considered

| 候補 | 長所 | 見送る理由 |
| --- | --- | --- |
| Python 3.x | 試作が速くデータ処理資産が多い | GUI/契約の型共有が弱く、基盤本体にデータ処理都合を持ち込みやすい |
| Rust | 配布・性能・型安全性が高い | 0.x の契約反復と UI/API 試作に対し実装コストが高い |
| Electron desktop first | UI と Node の統合が容易 | GUI が host/core へ近づきすぎる。desktop shell を基盤要件にしたくない |
| Tauri desktop first | 小型配布が可能 | Rust/toolchain を 0.x の必須条件に増やす |
| in-process plugin | 呼び出しが単純 | 依存隔離、異言語対応、worker kill の境界が弱い |

## Consequences

- #5 は npm workspaces の packages 構成を作る。
- #4 の検証器は TypeScript + JSON Schema 2020-12 を使用できる。
- #7 は stdio JSON-RPC worker を正式 host adapter へ発展させる。
- #10 は StateStore port と SQLite adapter を分ける。
- #11 は loopback HTTP + SSE + OpenAPI を実装する。
- #13 は React/Vite GUI を public API client のみへ依存させる。
- Python/Rust component は同じ manifest と stdio protocol を実装すれば追加できる。

## References

- Node.js releases: https://nodejs.org/en/about/previous-releases
- TypeScript 7.0: https://www.typescriptlang.org/docs/handbook/release-notes/typescript-7-0.html
- JSON-RPC 2.0: https://www.jsonrpc.org/specification
- Node.js SQLite: https://nodejs.org/api/sqlite.html
