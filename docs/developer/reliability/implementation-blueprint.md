# 実装可能な統合設計：精度 × 大量取得 × 利用者セキュリティ

[設計入口](README.md) · [契約案](contract-model.md) · [通信と隔離](security-enforcement.md) · [検証プロトコル](verification-protocol.md)

- **文書状態**：実装に向けた設計提案。既存の確定契約と、本設計で新たに提案する拡張を区別する。
- **対象**：Open_scraping 0.x の実行基盤を 1.0.0 の外部検索／収集／保存・処理部品に接続するための横断設計。
- **重要**：この文書は仕様を定義するものであり、ブラウザ・大規模取得・OS-level隔離・非常停止の実機動作を達成済みとは言わない。
- **優先順位**：不正な権限・失われた停止経路は実行拒否、未知の精度は未知のまま表示、許可された予算の中で確定済み成果物を最大化。

## 1. 設計決定と依存の固定

### 確定済みの境界を維持

現在の [FlowConfig 0.3](../../contracts.md) は `components` に implementation/version/contract/config/bindings、`nodes` に処理の依存関係を持つ。現在の [OperationRequest 0.1](../../../packages/contracts/src/types.ts) は `operation_id`、`component`、`operation`、`inputs`、`idempotency_key`、任意の `run_id`、`node_id`、`deadline_at` を持つ。結果statusは `accepted | running | succeeded | failed | cancelled | termination_unknown`。これらは**既存実装の形**であり、以下の拡張案を既に受理するという意味ではない。

| 層 | 持つ責務 | 持たない責務 |
| --- | --- | --- |
| `packages/contracts` | 版付きWire schema、検証、汎用ポート、DataRefの最低共通形式 | サイト固有selector、検索順位アルゴリズム、モデル |
| `packages/core` | DAG実行、汎用依存、リソース予約、状態、非常停止の非着脱なRun制御 | HTTP送信、ブラウザ制御、DBアクセス、特定データ種別の解釈 |
| `packages/host` | 実装／binding固定、worker起動、権限の承認・強制との橋渡し、Run/Operation journalとの接続、API輸送の認証、キャンセル配送 | 商品の正解判定、画像選別、外部Web検索順位 |
| `components/`（予定） | browser/network/download/search/parse/store/select/exportの実処理と種類別契約 | Core実行規則の上書き、グローバル非常停止の無効化 |
| `packages/api-client`、`apps/` | 公開APIのみの操作と表示、明示許可UI、実測結果の提示 | Hostへの直接アクセス、秘密の独自保管、ブラウザSDK直利用 |
| `distributions/`（予定） | 必要なComponent選択と、OS対応・リリース検証結果の宣言 | 未検証機能を標準搭載済みと表現すること |

本設計の `SecurityBroker`、`NetworkGate`、`SecretBroker`、`SandboxLauncher`、`RunCoordinator` は**設計上のインターフェース名**であり、現行 `main` のクラス/APIではない。契約を追加する際は新しい schema/contract version と移行試験を設け、FlowConfig 0.3 に未知フィールドを無理に追加しない。

### 物理的な境界

```text
   GUI / CLI (API client only)
              │ Bearer + Origin/Host + per-action authorization
              ▼
       Public loopback API ──► RunCoordinator ──────────┐
              │              │                        │
              │       SecurityBroker                   │
              │         │ grants                       ▼
              │         ├─ SecretBroker         Core: generic
              │         ├─ SandboxLauncher      flow/run/scheduler
              │         ├─ NetworkGate               │
              │         └─ Stop monitor status       │ invoke/cancel
              │                                     ▼
              └──────────► Host / registry ──────► Worker processes
                                                ├─ search/browser
                                                ├─ fetch/network
                                                ├─ parse/selection
                                                └─ store/export
                                                       │
                                      DataRef + immutable provenance
                                                       ▼
                                                Dataset storage
```

API、Worker、Network、Storageの**信頼境界は別々**に試験する。例えばmanifestのpermission resolverが `allowed: true` を返しただけでは、workerがOSから他ファイルを読めないと保証できない。`attached` ブラウザはユーザー所有プロセスなので、管理ブラウザと同じ停止・sandbox・通信制御ができると主張しない。

## 2. Run作成から確定出力までのシーケンス

| 順序 | 主担当 | 成功するための条件・失敗時 |
| ---: | --- | --- |
| 1 | API | 認証とOrigin/Host、Request schema、操作主体の権限。失敗時はRunを作らない |
| 2 | Host + Contracts | FlowConfig 0.3構造、manifest/操作/型/binding、component版・digestとpolicyの検証。不足は明示エラー |
| 3 | RunCoordinator | ユーザーが選んだsource、fallback順序、privacy/secret scope、budget、quality modeを**実効計画**として固定しRevision化 |
| 4 | SecurityBroker | component実装ごとのネットワーク・ファイル・プロセス・credential権限を固定。未許可は `permission_denied` |
| 5 | OS monitor | グローバルEsc**と物理マウス入力の両方**をarm、monitorのヘルス・権限を確認。未対応なら標準自動化を開始しない |
| 6 | Host / Core | Run journalにgeneration・変更不能なbindings・権限scope・budget初期値を登録。予約を通してnodeを投入 |
| 7 | Search/Fetch component | 実リクエストごとに権限と資源を取得し、接続先IP、redirect、資格情報scopeを接続時に検証。取得試行を記録 |
| 8 | Store component | raw byteのハッシュ・サイズ・provenanceを付け、一時領域からatomic commit。成功前は一意Itemに数えない |
| 9 | Process/Select component | 必要な場合に限り抽出／任意の選別。元Blobは不変、競合する値と観測不能を保持 |
| 10 | Export component | 選択した出力scope、DataRef ACL、危険な形式のescape/quoteと出力Manifestのhashを検証。成功した成果物だけ計上 |
| 11 | Host | terminal eventにsuccess/partial/failure/unknownと予算、件数、checkpointを記録。停止・failureをsucceededへ昇格しない |

**Run制御と取得内容の分離**：Nodeは単一のOperationを呼ぶ。QueryPlan／候補生成／抽出cascadeの意味判断は部品側で、Coreはポート名（price、image、site等）を特別扱いしない。バッチ内のサブリクエストもHostで共有権限と資源予約を継承する。

### 必ず満たす順序関係

- `validate` と `authorize` を通過する前にworkerをspawnしない。権限決定はUIの可視チェックマークのみで完了とはしない。
- ネットワークについて、`authorize destination` → `reserve budget` → `connect approved address` → `record attempt` の順序を定義する。接続先が変われば再認可する。
- 停止／非常停止の発火は、予約待ち・通信中・取得後処理・export中の各段へ同一run generationで配送。停止が確定したあと古い結果でcommitしない。
- 保存commit完了前に「取得済み」カウンターやExportManifestを確定しない。CPUが止まってもraw/partialの出典情報は失わない。
- 取得済みデータへの**内容フィルターは任意**。ユーザーが指定したsource制限、Host権限とOS隔離は任意フィルターではない。

## 3. 標準的なFlowの形（例：商品比較）

```text
query plan (ユーザー選択済みsite A / site B)
       │
   discovery ─────► candidate filter（任意）
       │                   │
       └───────────────────┘  ※ filterなしでは直接fetchへ
                     ▼
                 fetch batch
                     │ Raw DataRef + FetchAttempt
                     ▼
                  store raw
                     │ committed DataRef + provenance
                     ├─────────────────────────────┐
                     ▼                             │
               product extraction                  │
                     │ FieldObservation           │
                     ▼                             │
             normalize/reconcile                  │
                     │ competing values retained  │
                     ▼                             │
             selection / ranking（任意）           │
                     │                             │
                     ▼                             ▼
                export selection              export raw
```

**2つの正式経路**：raw直接保存／出力と、抽出・比較・選別付き出力。どちらか一方を使うことをCoreが強制しない。検索サイトA・Bの追加、検索結果の再取得、商品variationの分離は交換可能な部品の契約で行う。

## 4. 量と精度の競合を解決するアルゴリズム

- **スケジューリングの目的関数**：`committed_unique_items`（保存確定した一意なデータ）を、権限・ユーザー選択source・通信間隔・時間・容量・OS CPU/IO・実行停止の**ハード制約内**で増やす。単なる通信開始数・候補数を最大化しない。
- **正確さの方針**：抽出器のスコアに依存する一つの不透明な「正解率」を採用しない。エビデンスのある `observed`、未確定 `unknown`、矛盾 `conflict` を分離し、precision/recallの判断は評価集合の中だけで行う。
- **候補予算と取得予算の区分**：計画のsource探索枠・candidate数・実通信attempt数・完成Blob数・unique Item数を別々に管理。選別による除外で既に消費した通信予算を戻さない。
- **fallbackは宣言された経路だけ**：structured data → DOM → learned/visualなどの採用条件と最大段数・コストを部品に明示。外部AIへの送信許可がない場合は、精度のためでもモデル利用へ自動切り替えしない。
- **バックプレッシャーの伝播**：Storeが遅いときはfetch開始を抑え、Fetchが詰まればDiscoveryを一時停止。予算消費は予約と実消費を区別し、失敗・停止・再開でも二重計上しない。
- **ユーザーの可視性**：ダッシュボードにsource別の試行・取得・保存・不明・失敗・期間・予算・スループットを別表示。これらの合計が一致しないことを不具合として隠さない。

## 5. 失敗・停止・復旧の決定表

| 事象 | 分類 | 再試行/継続 | 永続化とユーザー表示 |
| --- | --- | --- | --- |
| 構造・型不整合 | `contract_invalid` | **開始不可** | 症状とpath、どのbindingが不足かを表示 |
| 許可のない秘密／OS資源 | `permission_denied` | 自動的に権限を増やさない | 操作の開始拒否、承認が必要なscopeを表示（秘密値は伏せる） |
| private IPへの無許可接続 | `destination_denied` | 自動fallbackしない | 正規化済み宛先の分類と拒否理由のみ記録 |
| サイト側429/Retry-After | `throttled` | 有限回、待機期限と予算内のみ | 待機時刻・消費attempt数を保存 |
| 認証切れ/MFA/CAPTCHA | `user_action_required` | ユーザー操作に引き継ぐ | 自動復旧ループを停止、再開は明示 |
| 途中切断・タイムアウト | `partial` / `failed` | 部品がreconcileできる範囲のみ | 仮DataRef・受信済みバイト数・resume validatorを記録 |
| 抽出値が衝突 | `conflict` | 取得成功は維持、属性のみ未確定 | ObservationSetで両証拠を提示 |
| Disk full/queue上限 | `resource_exhausted` | 新規投入を停止 | 中途成果物をcommit済みとしない |
| Worker応答不明 | `termination_unknown` | 照合前に副作用を再投入しない | run/operation generationと未確定状態を保持 |
| グローバルEsc/マウス | `emergency_stopped`（将来の追加状態案） | **自動再開禁止** | 新規投入拒否、所有workerのみ停止。確定済みデータは保持 |
| arm後monitor故障 | `stop_monitor_lost` | 全active runに停止を発火 | 未対応状態として記録、手動再armが必要 |

`destination_denied` 等の名称は **新しいreason code候補**。現行 `OperationResult` は共通のstatusと `error.code` を持つため、まずHost/部品のerror codeとして扱い、必要時に版付きで能力表へ展開する。

## 6. 対応OS・非対応の表現

- **現在**：Windows/Ubuntu向けにNode.jsコードのテストを行う基盤と、契約・Core・Hostのモック実装が存在する。Headless CIでテストが通ってもOSレベルの非前面Esc/物理マウスを実証したことにならない。
- **対応開始条件**：OS monitorが実際にarm、SandboxLauncherが権限を強制、NetworkGateが使用する全通信経路を制御、API認証が有効、データ保存権限が設定されていること。満たさない場合はそのOS/経路を `unsupported` / `unverified` と表示。
- **ユーザーの責任で選ぶ範囲**：検索対象、必要なブラウザ、ユーザー所有プロフィールの利用、容量・速度・費用上限、データ保持期間、フィルター／モデル利用。**利用者の設定だけでHostのセキュリティ違反を正当化しない**。
- **配布条件**：最終artifactの署名・attestationと検証は別ゲート（[#78](https://github.com/tomiya7688/Open_scraping/issues/78)）。開発版と一般向けリリースを同じ意味の「使える」にしない。

## 7. 既存実装への接続と実装順序

| ステップ | 変更対象の候補 | 終了条件 |
| --- | --- | --- |
| 1. 部品間契約 | `packages/contracts` の**別の版付きschema** と契約テスト | FieldObservation, FetchAttempt, DataRef参照に不足・不正の反例がある |
| 2. Hostの実権限 | `packages/host` 内のNetworkGate/SecretBroker/OS SandboxLauncher adapter | permission拒否/不正入力/プロセス境界をモックとOS統合で再現 |
| 3. 非常停止のarmと配送 | Coreの抽象的run stop primitive + Host/OS monitorの実装 | フォーカス外Esc/実マウス、monitor crash、owned workerのみkillで合格 |
| 4. Resource scheduler / journal | #9 / #10 のPRを確認して統合、競合時は依存を明示 | 予約・待機・予算、generation、重複副作用を再開テストで検証 |
| 5. 各種Component | search/browser/network/download/store/parse/exportを独立契約として接続 | 使う経路と権限を宣言し、明示fallbackだけを許す |
| 6. 標準Flow・GUI | 公開APIクライアント、Flow preset、確認画面 | 不足権限／失敗／未知／精度／量を操作可能な形で表示 |
| 7. 完成判定 | [検証プロトコル](verification-protocol.md) と [受入ゲート](acceptance.md) | セキュリティ必須ゲートの対象OSでの証拠と、固定fixtureの精度・量の比較結果 |

これは実装ガイドであり、#9 / #10 / #11 / #42 / #78の既存Issueや未マージPRを勝手に完了済みへ変更しない。テスト開始前に実装時の判断が必要な点は [決定記録](decisions.md) に明示する。
