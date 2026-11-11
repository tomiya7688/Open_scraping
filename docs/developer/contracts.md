# 正式契約 0.x

[設計書一覧](README.md)

Issue #4 で固定する最初の機械可読契約。実装は `packages/contracts`。
この文書は処理部品の種類を固定するものではなく、部品を接続・検証する共通部分だけを定義する。

## 1. FlowConfig 0.3

`schema_version: "0.3"`、`kind: "flow"` を正式版とする。

フロー入力は型付き値で宣言する。

```json
{
  "inputs": {
    "text": {
      "type": "example.text/v1",
      "value": "open scraping"
    }
  }
}
```

ノード入力は型付きリテラル、または次のどちらかの参照だけを受理する。

- `flow.inputs.<name>`
- `nodes.<node-id>.outputs.<port>`

0.3では参照先オブジェクト内部へのパス、式評価、JSON Schemaの `$ref` としての解釈は行わない。

### 型互換

型IDは `namespace.name/vN` 形式とする。
入力ポートは主型 `type` と、明示的な代替型 `accepts` を宣言できる。

互換とみなすのは次だけ。

1. 型IDが完全一致する。
2. 実型が入力ポートの `accepts` に明示されている。

JSON Schemaが似ている、フィールド名が同じ、版番号が近い、という理由で意味的互換を推測しない。
静的値に対してポートが `schema` を持つ場合は、そのJSON Schemaにも適合する必要がある。

### DAG、分岐、ページ送り、失敗

0.3は非循環DAGだけを受理する。ノード配列の記述順ではなく参照依存から順序を決める。

0.3では次の制御構文を提供しない。

- branch / switch
- repeat / while / for_each
- pagination / subflow loop

スキーマは未知フィールドを許可しないため、これらを追加した設定は明示的に検証エラーになる。
有限のページ送りやバッチ処理は、0.3では部品操作の設定に上限を持たせ、その一回の操作として実行する。
将来コア制御として導入する場合は schema_version を上げて契約を追加する。

失敗時方針は全体 `execution.on_node_failure` とノード `policy.on_failure` の
`stop` / `continue_independent` のみ。
失敗したノードの出力を成功値として補完しない。

### ノードを外すとき

任意部品を外したとき、コアや編集器は前後のノードを暗黙に再接続しない。
削除したノードを参照する箇所は `DANGLING_REF` となるため、利用者またはフロー生成部品が明示的に接続を直す。

## 2. Component Manifest 0.1

全ての標準・内製・第三者部品に同じマニフェストを要求する。

主な項目:

- 実装IDと実装版
- component RPC protocol版
- 提供する契約ID
- 契約ごとの操作、入力・出力ポート
- 任意能力 `capabilities`
- 設定用JSON Schema
- 他部品への依存binding
- permissions
- 中断方式
- stdio workerのruntime情報

FlowConfigの `implementation` と `implementation_version` はマニフェストに一致し、
選択した `contract`、操作、能力、binding を検証できなければ実行前に失敗する。
標準部品IDへのfallbackはしない。

新しい処理は新しい契約ID・操作・型をマニフェストへ追加する。
coreの処理カテゴリ一覧を変更する必要はない。

## 3. DataRef 0.1

DataRefは大きなデータ本体ではなく参照を運ぶ。

必須情報:

- `type`: データ型ID
- `provider`: 参照を所有する部品
- `ref`, `revision`
- `access`: host-mediated / binding の読み取り方法
- `lifetime.scope`: operation / run / ttl / persistent
- `persistence.state`: ephemeral / committing / committed
- `dispose_required`

`ttl` は `expires_at` 必須。
期限切れ、operation/run終了後の参照、未commit参照を永続参照として扱わない。
参照切れ時に無断でWebへ再取得せず、必要なら別の明示操作を要求する。

`persistent` という寿命指定だけでは永続化完了を意味しない。
永続化完了を保証できるのは `persistence.state: "committed"` を返した時点。
部品間でローカルファイルパスを共有できるとは仮定しない。

## 4. 共通操作メッセージ 0.1

共通schemaは次を持つ。

- `operation-request`
- `operation-progress`
- `operation-result`
- `operation-cancel`

操作状態は次に限定する。

- accepted
- running
- succeeded
- failed
- cancelled
- termination_unknown

処理内容上の「採用／除外」等はこの状態に混ぜず、部品固有出力として返す。
中断要求が送れたことと実処理の終了確認を分け、確認できない場合は `termination_unknown` を使う。

## 5. 検証器

`@open-scraping/contracts` は次を公開する。

- `validateFlowStructure`
- `validateFlowConfig`
- `validateComponentManifest`
- `validateDataRef`
- `validateOperationMessage`

FlowConfigの完全検証は、利用可能なマニフェスト集合と合わせて行い、少なくとも次を検出する。

- schema不一致、未対応構文
- 参照先不存在
- ノードID重複
- ノード依存循環
- component binding循環
- 実装版・契約・操作の不存在
- 必須binding・能力不足
- ポート型不一致
- 部品設定schema不一致

任意のJSON Schema同士が意味的に互換かどうかは判定しない。

## 6. 0.3で意図的にしないこと

- ブラウザ、検索、画像、保存等の処理カテゴリをcoreへ定義しない
- 実装がない契約を標準部品へ自動置換しない
- 循環や無限ループを受理しない
- 削除した任意ノードをダミー処理へ置換しない
- 期限切れDataRefを再取得で自動修復しない
