# 契約・データモデルの詳細案（0.x→1.0.0）

[統合設計](implementation-blueprint.md) · [精度と網羅度](accuracy-coverage.md) · [保存設計](../../data.md) · [現行契約](../../contracts.md)

**この文書のTypeScript/JSONは設計例であり、まだ実行可能なAPIでも現行FlowConfig 0.3のJSON Schemaでもない。** 現行 `packages/contracts/src/types.ts`、`packages/host/src/registry.ts` の用語に合わせ、追加フィールドと既存フィールドを区別する。新しいデータ型は `packages/contracts` で個別に版管理する。Coreへ商品・画像・サイト等のenumを追加しない。

## 1. 契約の層と版

| 層 | 現行状態 | 次の仕様案 |
| --- | --- | --- |
| FlowConfig | `schema_version = "0.3"`、DAG・binding・TypedValue | 変更せず、取得用のポート/部品/設定とRun sidecarで拡張。DSL制御構文の追加は将来版でのみ行う |
| ComponentManifest | `schema_version = "0.1"`、permissions・cancellation・runtime | capabilityにnetwork enforcement/worker sandboxの対応を**別バージョンで**宣言する。現行manifestに未定義フィールドを黙って挿入しない |
| OperationRequest/Result | `schema_version = "0.1"`、status・error・checkpoint | statusは維持。新しい失敗理由はまず `error.code` に割当、互換性を確認 |
| DataRef | `schema_version = "0.1"`、provider/ref/revision/lifetime/persistence/access | 既存アクセス定義の意味を維持しつつ、実効ACLはHost側に保存。公開refへ資格情報を埋め込まない |
| 標準部品間データ | #15で未定義／未実装 | `open-scraping.discovery/v1`、`fetch-attempt/v1`、`observation/v1`等を独立したschemaとして追加 |
| Run security/quality policy | FlowConfig 0.3のトップレベルに存在しない | Hostの **RunLaunchPolicy v0.1（提案）**。ユーザー選択・scope・予算・正確さモードを版固定 |

これにより、古いFlowConfig 0.3の動作を勝手に意味変更しない。互換性のあるConsumerが新しい `type` を認識しない場合は `unsupported_type` とし、既存データを破壊的に再解釈しない。

## 2. RunLaunchPolicy（Host sidecar案）

```ts
interface RunLaunchPolicyV01 {
  schema_version: "0.1";
  kind: "run-launch-policy";
  flow_id: string;
  flow_revision: string;             // フロー定義の固定版
  selected_sources: Array<{
    provider_binding: string;        // FlowConfig.componentsにあるlocal name
    scope_id: string;                // ユーザーに表示したサイト/検索先の識別子
    allowed_methods: string[];       // この部品が対応すると宣言した方法だけ
  }>;
  fallback: {
    mode: "off" | "ordered";
    allowed_component_bindings: string[];  // 明示した順序のみ
    max_steps: number;              // 0は追加fallbackなし
  };
  privacy: {
    credential_grant_ids: string[];  // 実秘密ではない
    model_egress_grant_ids: string[];
    export_scope_id: string;
  };
  quality_mode: "raw" | "precision" | "recall";
  resource_limits: {
    source_queries: number;
    fetch_attempts: number;
    download_bytes: number;
    stored_bytes: number;
    committed_unique_items: number;
    wall_time_ms: number;
  };
  expected_capability_revision: string;
}
```

**検証規則**：すべて整数・非負・有限、空/0/省略に異なる意味を与えない。必須限度が無ければ作成を拒否し `budget_missing` を返す。`selected_sources` のbindingがFlowConfigになければ失敗。`fallback.allowed_component_bindings` は選択・許可されたbindingの部分集合で、暗黙の代替プロバイダーを追加しない。

保存時に `plan_sha256`、`component_manifest_digests`、`security_policy_revision`、`granted_capabilities` を固定し、資格情報の値はsidecarに保存しない。正しいtokenを持つだけで追加の秘密使用・LAN接続・外部AI送信が許可されたとは扱わない。

**版変更**：設定を変更したときは新しいpolicy revisionを作り、未開始Operationへ適用する。既に完了した通信や使用済み予算は巻き戻さない。Runの実際のversionが増えたら、後から再検証できるよう記録する。

## 3. 取得されたデータの正規形

以下はTypeScript風の形の提案である。Statusごとに必須フィールドを異ならせ、実行時にschema検証する。

```ts
type ObservationState =
  | "observed" | "missing" | "not_observed"
  | "unknown" | "conflict" | "parse_error";

interface SourceLocatorV1 {
  source_id: string;                 // 保存されたRawBlob/DOM snapshotのID
  kind: "json_pointer" | "dom_path" | "text_range" | "region";
  pointer: string;                   // kindごとに個別schemaで検証
  retrieved_at: string;              // ISO timestamp
  source_sha256: string;             // immutable snapshotのchecksum
}

interface FieldObservationV1 {
  schema_version: "1";
  item_id: string;
  field: string;                     // 例 price / unit / title。Coreは意味を知らない
  state: ObservationState;
  raw_value?: string;                // observedなら必須（推定と分ける）
  normalized_value?: unknown;        // type別schemaで検証。unknownなら原則なし
  evidence: SourceLocatorV1[];      // observedなら1件以上
  extraction: {
    implementation: string;
    version: string;
    config_revision: string;
    method: string;                  // structured/DOM/learnedなどの観測
  };
  observed_at: string;
  competing_observation_ids?: string[]; // conflict時に必須
}
```

**条件**：
- `observed` は `raw_value` と1件以上の検証可能な `evidence` が必須。正規化に失敗してもrawは保持し、`normalized_value` を推測で足さない。
- `missing` は実際の対象資料・領域を検査した根拠（coverage locatorと検査方法）が必要。検索していないページをmissingと呼ばず `not_observed` にする。
- `conflict` は相反する複数の観測参照を持ち、元の観測レコードを残す。1件の選択済み値を上書きする方式は禁止。
- `parse_error` はどの形式/範囲を読めなかったかと原因コードを持ち、空文字や0へ変換しない。
- 抽出器による推定や信頼度は別の `derived_assertion` として記録する。真値そのものを保証する `confidence:1` のような意味にはしない。
- `source_id` はURLそのものではない。同じURLの再取得はtimestampとrevisionが違うため、別RawBlobとして保存可能。

### DiscoveryとFetchAttempt

```ts
interface DiscoveryV1 {
  schema_version: "1";
  discovery_id: string;
  query_id: string;
  provider_binding: string;
  requested_scope_id: string;
  request_time: string;
  candidates: Array<{
    candidate_id: string;
    url: string;                    // 秘密部分は公開出力でredact
    listing_source_id: string;
    rank?: number;                  // 不明なら省略、0を仮値にしない
  }>;
  page_cursor?: string;              // 非公開・短命の場合はDataRef側へ
  completeness: "complete" | "partial" | "unknown";
}

interface FetchAttemptV1 {
  schema_version: "1";
  attempt_id: string;
  candidate_id?: string;
  request_time: string;
  transport_kind: string;            // 部品の責務。Coreにenumを固定しない
  initial_url: string;
  redirect_chain: Array<{
    from_url: string;
    to_url: string;
    status_code: number;
  }>;
  final_url?: string;
  result: "complete" | "partial" | "failed" | "denied";
  received_bytes: number;
  raw_data_ref?: string;             // 完全/部分でcommit状態を明確に区別
  error_code?: string;
  provenance_ref: string;
}
```

**事前・事後両方の検証**：
- URLやUser-Agentの値は未信頼。秘密を含むURLは内部保管と公開用記録を分離する。
- `received_bytes` はwire計測値。完全なBodyとverifiedな出典がなければ `complete` にしない。
- redirectの各hopはネットワーク権限の再判定が必要。認証scopeはhopをまたいで暗黙継承しない。
- `raw_data_ref` が存在するだけでは `persistence.state: committed` とは限らない。仮保存・期限切れ・取消・byte checksum不一致を区別する。

## 4. Item・Collection・選別・出力

```ts
interface CollectionRevisionV1 {
  schema_version: "1";
  collection_id: string;
  revision: string;
  committed_raw_refs: string[];
  observations: string[];
  identity_rule_revision: string;
  unique_item_ids: string[];
  possible_duplicate_groups: string[][];
  partial_item_ids: string[];
  created_at: string;
}

interface SelectionRevisionV1 {
  schema_version: "1";
  collection_revision: string;
  rule_implementation: string;       // 未使用ならこのレコードを作らない
  rule_version: string;
  selected_item_ids: string[];
  rejected_item_ids: string[];
  undetermined_item_ids: string[];
  explanations_ref?: string;
}

interface ExportManifestV1 {
  schema_version: "1";
  source_collection_revision: string;
  optional_selection_revision?: string;
  exported_item_ids: string[];
  output_data_refs: string[];
  output_sha256: string[];
  export_format: string;
  committed_at: string;
  evidence_policy_revision: string;
}
```

選別のないraw出力では `SelectionRevision` 自体を生成しない。出力先の権限・CSV formula escape・HTML表示制御は、データの内容判定とは別のセキュリティ境界。利用者が望むrawと安全な可視化を別物として保持する。ハッシュはファイル本体を確定した後に算出し、manifestから再計算で検証可能にする。

## 5. Operationと失敗理由：既存型への落とし込み

既存 `OperationResult` のstatusは増やさず、追加状況を `error.code` と必要な `outputs` の版付き型として扱う。

| 状況 | Statusと補助情報 | 再試行条件 |
| --- | --- | --- |
| 接続先が権限外 | `failed`, `DESTINATION_DENIED`, retryable=false | ユーザーが別の宛先／許可を明示した場合のみ |
| サンドボックス起動不可 | `failed`, `SANDBOX_UNAVAILABLE`, retryable=false | 対応backendの実装/権限復旧後のみ |
| Run monitor arm失敗 | Runの開始拒否（Run API） | OS権限・監視backendを復旧後、明示操作 |
| provider指定の待機 | `failed`か保留状態 + `NOT_BEFORE`（将来契約案） | Run期限内かつ同一budgetで有限回 |
| 部分転送 | `failed` または `termination_unknown`; 部分DataRefの詳細は専用型 | レンジ整合性と同一本体の証拠がある場合のみ |
| フィールドの矛盾 | **Operationはsucceededでも可**、出力FieldObservation.state=conflict | 内容矛盾はOperation失敗とは別 |
| 停止・キャンセル | `cancelled`、未確定結果は `termination_unknown` | 自動再開禁止、復旧計画から明示 |
| 外部副作用未確認 | `termination_unknown` | 観測・reconcile後に限る |

エラーメッセージへCookieやCredential等を含めない。UIには不明・部分成功・操作失敗を区別して表示する。既存statusの意味を変える変更や新しいtop-level fieldは**別schema version** が必要。

## 6. 識別子と冪等性の範囲

- `run_id` はrunを一意に表す。再開時に新しい `generation` を持ち、古いworkerからの遅延応答を破棄／監査記録へ分離する。
- `operation_id` はそのgenerationの試行を表す。再送の `idempotency_key` はscope (run, component implementation/version, operation, request hash) と一緒に保存し、同一キー・異なるpayloadを `IDEMPOTENCY_CONFLICT` とする。
- 既に成功した外部副作用は再開後に無断で実行しない。既存のcommit ref／checkpointを照合する。APIがexactly-onceを保証しない場合 `termination_unknown` を保持する。
- データの同一性とbyte重複は別。hash一致でBlobを共有してもDiscovery・FetchAttempt・掲載元の複数来歴を維持する。商品variantを同一視するルールはComponentのrevisionごとに定義する。

## 7. 互換性確認と契約テスト

1. **Schema fixture**：正常・不足・未知フィールド・値範囲・巨大payload・誤ったstatus・DataRefの期限切れを個別に拒否できる。
2. **Version fixture**：FlowConfig 0.3だけの既存例が変化なく検証される。新しい部品データ型を認識しないConsumerは明示unsupportedとする。
3. **Provenance fixture**：同一URLから別時点、同一blobの複数出典、矛盾するJSON-LDと表示価格、欠損と0、途中転送を別状態で保持できる。
4. **Permission fixture**：別RunのDataRef使用、失効したgrant、実接続先変更、無断モデル送信が拒否される。
5. **Recovery fixture**：旧generation到着、同一キー再送、外部副作用未確定、期限超過、checkpointからの部分復旧。
6. **Exporter fixture**：Selectionなしraw出力、CSV式注入、filename traversal、出力済みバイトとManifest hash不一致が検知できる。

**未決定でレビューが必要な点**：schema IDの正式命名とnamespace、`unknown` のWire representation、RunLaunchPolicyの保管位置と公開API、秘密のgrant型、DataRef revocation、量の予算の型。実装前に各Issueで決定し、同じ設計を二つの契約へ二重記載しない。
