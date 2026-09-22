# 公開API・プラグイン設計

[設計書一覧](README.md)

API名、設定キー、版、通信方式は実装案。改訂案の設定版を`0.2-draft`とする。実装済みAPIや正式JSON Schemaではない。

## 1. コアAPIと追加機能API

| 契約 | 責務 | 未導入時の扱い |
| --- | --- | --- |
| コアAPI | 検索・取得要求、実行制御、取得結果・出典、保存・基本出力 | 追加機能なしで利用できる |
| 検索・取得アダプターAPI | 選択されたブラウザや検索・取得方式を実装する | 必要な接続方式がなければ、その取得要求の非対応を示す |
| 追加機能API | 言語解釈、検索拡張、解析、選別、加工等を接続する | 未使用なら呼び出しも結果生成も不要 |

追加機能APIはコアの公開データ・操作契約を利用する。コアが個別フィルターやモデルを必須importする構造にしない。標準UIと追加機能ホストも、内部の特権的な選別経路を使わない。

公開APIは仕様の公開を意味する。初期案はローカルのループバックにバインドして認証し、任意のWebページから操作できないようOrigin等も検証する。外部ネットワークへの公開は別の配置設定。

HTTP APIはOpenAPI、設定・入出力はJSON Schemaを使う案とし、版は実装時に固定する。[参考 S8・S9](references.md#s8)

## 2. 設定を二つに分ける

### 2.1 CoreJobConfig

検索・取得だけを記述する。以下の項目を使う設計とし、必須・省略時値の詳細は正式スキーマで確定する。

| 項目 | 内容 |
| --- | --- |
| `schema_version`, `kind` | 設定形式の版、`core_job` |
| `input` | 入力文字列、データ種別 |
| `scope` | サイト内／サイト指定／広域、対象サイト・エンジン、初期リンク条件 |
| `sources` | サイト定義・取得方法・参照するアダプター |
| `browser` | 接続部、ブラウザ、管理方式、表示・プロファイル |
| `query` | 実行する検索語の配列、検索先固有の要求パラメーター |
| `profile`, `allocation` | 展開済みの取得プロファイル、探索枠の配分 |
| `limits` | 取得上の目標件数、要求数・容量等の上限 |
| `timing`, `recovery` | 取得間隔、同時数、復旧・停止 |
| `storage` | 保存先、保存期限、出典マニフェスト |

`query.mode`の案は`literal`と`prepared`。前者は文字列を直接使い、後者はユーザーまたは入力支援が準備した検索語を使う。コアは自然文を解釈したと仮定しない。

**`interpretation`、`search_filters`、`post_filters`、`selection`をCoreJobConfigの必須項目にしない。これらは追加機能側の設定とし、コアAPIには渡さない。**

[コアだけの設定例](examples/site-search.json)はそれらのキーを持たない。この例の数値・ドメイン・アダプターIDは説明用で、実行可能性や取得許可を示さない。

### 2.2 WorkflowConfig

追加機能ホストが読む構成。`kind: workflow`、参照するコア設定、任意の入力差分、`extensions`を持つ。

| 拡張設定 | 内容 |
| --- | --- |
| `interpretation` | 言語モデル、手動／自動優先、自動適用範囲 |
| `search_filters` | 検索語変換・候補選別等の追加処理 |
| `post_filters` | 取得後に使う解析・選別モジュール |
| `selection` | 結果の組合せ、未判定、手動訂正の扱い |

各拡張設定は省略可能。`extensions`省略または空は、参照したコア設定をそのまま実行する構成である。空の場合に標準フィルターを自動挿入しない。

`core_config_ref`はホストが解決するファイル／登録設定への参照であり、コアへ任意URLの読取を指示するものではない。説明例の`input_override`は元入力の変更であり、検索語への変換は解釈支援が行う。解釈不能ならその事実を表示する。

[追加機能を使う設定例](examples/site-search-with-extensions.json)で両者の差を示す。標準配布のプリセットはホスト側の構成であり、コアの既定依存ではない。

### 2.3 省略・未解決・移行

未指定、空、無効、エラーを別にする。空の初期リンク許可リストを全許可にしない。コアの不明キーは黙って無視せず検証で示す。

拡張を使用すると指定したのに実装がなければ、そのワークフローの依存不足として開始前に通知する。フィルターを使わないCoreJobConfigまで無効にしない。自動導入・代替判定・暗黙スキップはしない。

旧`0.1-draft`の混在設定はホスト側でコア設定と追加機能設定へ分ける移行案とし、差分を表示する。過去の自然文解釈や有効フィルターを黙って変更しない。

## 3. 優先順位・版

入力支援は`manual_first`、`auto_first`、`per_field`を持つ。モデルの自動適用可能なフィールドはユーザー設定で、モデル自身が変更しない。元入力、提案、採用値、値の出所を記録する。

ホストは解釈・検索拡張を使った場合でも、最終的なCoreJobConfigを可視化して渡す。ユーザーが指定した検索先と、実際の検索先を一致させる。

プロファイルは詳細値に展開し、差分を示す。`requested`と`effective`を分け、非対応条件を適用済みとしない。

コアの`config_revision`と`runtime_revision`、追加機能の`workflow_revision`・`selection_revision`を分離する。コアは選別版の採否を解釈しない。

## 4. コア操作APIの草案

| メソッド・パス | 処理 |
| --- | --- |
| `GET /api/v0/capabilities` | 実装済みのコア機能・データ種別・接続部の能力 |
| `GET /api/v0/sources` | サイト・エンジン定義の一覧 |
| `POST /api/v0/sources` | 検索先の追加 |
| `PATCH /api/v0/sources/{id}` | 検索先の編集 |
| `DELETE /api/v0/sources/{id}` | 今後の検索先から取り外す。履歴は残す |
| `POST /api/v0/configs/validate` | CoreJobConfigの検証 |
| `POST /api/v0/jobs` | 取得ジョブを作成。自動開始しない |
| `GET /api/v0/jobs/{id}` | 取得状態、設定版、進捗、待機理由 |
| `PATCH /api/v0/jobs/{id}/config` | 編集可能な状態で取得設定版を作成 |
| `POST /api/v0/jobs/{id}/start` | 取得を開始 |
| `POST /api/v0/jobs/{id}/stop` | 取得の停止要求 |
| `POST /api/v0/jobs/{id}/resume` | 保存記録から再開 |
| `PATCH /api/v0/jobs/{id}/runtime` | 間隔などの実行制御更新 |
| `POST /api/v0/jobs/{id}/browser/reload` | 指定ページ再読み込み |
| `POST /api/v0/jobs/{id}/browser/reopen` | 指定管理セッション開き直し |
| `GET /api/v0/jobs/{id}/events` | 順序付き取得イベント |
| `GET /api/v0/jobs/{id}/items` | 取得データ一覧。選別結果を要求しない |
| `POST /api/v0/jobs/{id}/snapshots` | 取得済み項目ID集合を固定する |
| `POST /api/v0/jobs/{id}/exports` | 取得スナップショットから直接出力する |
| `GET /api/v0/operations/{id}` | コアの長時間操作の進捗・結果 |

出力要求例：

```json
{
  "collection_snapshot_id": "snapshot-example-001",
  "format": "files-and-manifest"
}
```

**選別版ID、解析結果、フィルターの実行は不要。** スナップショットの項目は取得成功として記録されたものであり、内容の評価に合格したことを意味しない。

0.xの未実装機能は`not_implemented`等で返す。空の成功で隠さない。API版と製品版は独立に管理する。

## 5. 追加機能ホストAPIの草案

以下はコアAPIと同じ配布物に載せることもできるが、別モジュールである。未導入ならその能力を宣言せず、コアの起動要件にしない。

| メソッド・パス | 処理 |
| --- | --- |
| `GET /api/v0/extensions/capabilities` | 追加機能の能力 |
| `GET /api/v0/extensions/plugins` | 追加プラグイン一覧 |
| `POST /api/v0/extensions/plugins` | 明示的な許可による追加 |
| `PATCH /api/v0/extensions/plugins/{id}` | 有効状態等の変更 |
| `DELETE /api/v0/extensions/plugins/{id}` | 取り外し。取得データ・過去の結果は消さない |
| `POST /api/v0/extensions/interpretations` | 入力解釈・検索計画案 |
| `POST /api/v0/extensions/workflows` | WorkflowConfigを検証して作成 |
| `POST /api/v0/extensions/workflows/{id}/start` | 選択した追加処理と取得を実行 |
| `POST /api/v0/extensions/workflows/{id}/stop` | 関連する取得・拡張処理へ停止を送る |
| `GET /api/v0/extensions/workflows/{id}` | コアと追加処理それぞれの状態 |
| `POST /api/v0/extensions/selections` | 保存データへの解析・選別 |
| `POST /api/v0/extensions/selections/{id}/overrides` | 手動採用・除外・保留 |
| `POST /api/v0/extensions/exports` | 選別版を使用する出力 |
| `GET /api/v0/extensions/operations/{id}` | 拡張処理の進捗・結果 |

旧案の選別・解釈エンドポイントを、コアの必須APIから分離した。追加機能ホストは、コアの公開APIでデータとスナップショットを読む。コアの取得状態を選別の成否で上書きしない。

## 6. 長時間操作・実行制御

開始、復旧、出力等は受理時に`operation_id`を返し、完了は別通知とする。HTTP受理をブラウザ復旧成功と混同しない。

再送可能操作は`idempotency_key`を持ち、同一要求を重複実行しない。異なる内容でキーを再利用したら競合を返す。更新には期待する設定版を付ける。

`request_id`、イベントの順序番号、中断トークン、期限を共通化する。停止は復旧より優先。詳細は[runtime.md](runtime.md)を参照。

## 7. 部品の契約

| 種類 | 配置 | 契約案 |
| --- | --- | --- |
| `browser` | 検索・取得接続部 | capabilities, open, navigate, reload, close, reopen, cancel |
| `search` | 検索接続部 | validate, search, next, cancel |
| `extractor` | 取得・形式抽出接続部 | extract, checkpoint, cancel |
| `interpreter` | 追加入力支援 | interpret, expand_queries, cancel |
| `analyzer` | 追加解析 | analyze, cancel |
| `filter` | 追加選別 | evaluate, cancel |
| `exporter` | 必要に応じて追加する出力形式 | export, cancel |

基本のファイル・マニフェスト出力はフィルターなしで提供する。追加形式のexporterを導入しなくても、取得済みデータを取り出せる。

マニフェストはID、版、API互換範囲、種類、対応データ型、設定スキーマ、依存関係、必要権限、既知の限界を持つ。標準・外部の実装で同じ契約を使う。

ブラウザは再起動等の管理能力と要求間隔の制御範囲を宣言する。検索先はサイト内検索、画像結果、ページ送り、言語・期間等の対応を宣言する。フィルターは精度・未検証範囲・スコアの意味を宣言する。

入出力はシリアライズ可能とし、ブラウザの内部オブジェクトを他の実装へ直接渡さない。大きな本体データや認証情報はログのJSONに埋め込まず、限定した参照・秘密情報ハンドルで渡す。

## 8. フィルター実行時だけ生じる結果

解析は特徴・スコアを計算し、選別は条件に従う選択案を作る。`query_transform`、`candidate_filter`、`post_analysis`、`selection`等の段階を追加機能側で区別する。

```json
{
  "subject_id": "item-example-001",
  "status": "ok",
  "values": {"condition_similarity": 0.42},
  "suggestion": "exclude",
  "reason_codes": ["below_user_threshold"],
  "plugin_id": "builtin.image-relevance",
  "plugin_version": "0.1.0-draft",
  "settings_revision": 3
}
```

これは説明用で、実測値ではない。`status`の`ok`、`unknown`、`unsupported`、`error`と、`suggestion`の`keep`、`exclude`、`review`を分ける。解析失敗を内容の不一致に変えない。

未導入・未使用なら結果そのものを作らない。評価を実行したが不明だった状態と、評価していない状態を混同しない。スコアを確率として保証せず、別モデルの数値を直接同一視しない。

フィルター順序、AND／OR、未判定の扱い、手動訂正は追加機能側の設定。未判定を保留にする案も、そのフィルターを使用した場合のルールに限る。

## 9. 権限・取り外し・障害

プラグインの外部通信、保存先、モデル送信、秘密情報参照を表示する。別プロセスにする案だが、それだけでOS権限が完全に隔離されたとは言わない。具体的方式はOS選定後に決める。

対応アダプターはコアのスケジューラーを通す。任意の外部コードのすべての通信まで保証するとは表示しない。外部ページのテキストを設定命令として実行せず、モデル出力も形式と権限の範囲を検証する。

取り外し時は使用中の拡張処理の終了・停止を扱う。コアまで再インストールを要求せず、選別テーブルの存在をコア起動条件にしない。過去の結果は参照でき、同じモデルがなければ再計算できないことを示す。

追加機能が失敗してもコアの取得結果・出典・基本出力を維持する。選択済みの検索前拡張が失敗した場合は、そのワークフローで確認待ちにする。指示を黙って捨てて取得を続けることとは区別する。

## 10. エラー・互換性

コアのエラー例は`invalid_config`、`unsupported_capability`、`not_implemented`、`authentication_required`、`rate_limited`、`browser_unresponsive`、`parse_failed`、`cancelled`。拡張は`extension_missing`、`extension_failed`等を別の処理結果として扱う。

再試行可否、待機期限、影響範囲を付ける。未使用拡張の不足をコアのエラーにしない。製品、設定、API、プラグイン、モデルの版を独立に記録する。

0.xの破壊的変更は明記する。1.0.0前に互換範囲・移行・廃止予定の通知を決める。取得中の接続部と、取得に不要な後処理フィルターの取り外しを同じ扱いにしない。
