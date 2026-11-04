# 品質・セキュリティ・大量取得の受入・公開ゲート

[横断設計](README.md) · [精度](accuracy-coverage.md) · [量](volume-runtime.md) · [安全](security-threat-model.md) · [JSONゲート台帳](acceptance-gates.json)

**状態：受入基準案／2026-11-04。** 受入テストの仕様と合格済みの実測を混同しない。[ロードマップ A01–A60](../../roadmap.md) の補助であり置換ではない。必要なテストを実装したら、そのIssue/PRの「実施した環境・版・試験入力・観測結果・ログ」を付けてゲート状態を更新する。

## 1. ステータスの意味

| `status` | 意味 |
| --- | --- |
| `planned` | 設計・試験条件だけ。まだ実装／試験は完了していない |
| `implemented_unverified` | コードの存在は確認されたが、所定の受入試験の証拠がない |
| `verified` | 対象OS・環境・fixture・試験実行への追跡可能な証拠がある |
| `failed` | 試験で条件を満たさなかった |
| `not_applicable` | 機能が配布・構成に含まれないため対象外。理由と適用範囲の証拠が必要 |

ゲートに `verified` や `not_applicable` を付けるには、**具体的な証拠の参照**をJSONの `evidence` に保存する。Issueの存在、PR提出、静的テスト成功だけで実機試験を `verified` にしない。現在の台帳はすべて `planned` であり、アプリが安全に動作するとの保証ではない。

## 2. 優先度・失敗時の扱い

- **security-blocking**：重大な資産（利用者の秘密、端末、外部通信先、未署名配布、グローバル非常停止）の安全条件。関連する機能を開始／公開できない。高いprecisionやthroughputで代替しない。
- **quality-required**：採用した標準フローのデータ精度・来歴の確からしさを示すための条件。採点の閾値は評価データから後出しせず、事前の基準とfixtureバージョンを記録する。欠落する機能は「対応済み」と公表しない。
- **scale-required**：定義されたOS/マシン/資源・件数における継続取得、停止・再開、予算・backpressureの要件。負荷試験の未実施を速度保証に読み替えない。

ゲートが対象外になるのは、たとえばVideo機能を搭載しない配布構成など、**機能を実際に含まない場合だけ**。使いたい機能に対して単に「試験できなかった」を `not_applicable` として隠さない。

## 3. 版ごとの判定と責任

| 判定タイミング | 必要な証拠 | 許されない表現 |
| --- | --- | --- |
| 0.x Core/Host mock | 契約／状態遷移／権限拒否の再現可能なテスト。未試験のOSやブラウザは明記 | 「全サイト対応」「実機非常停止に対応」「安全な取得アプリ完成」 |
| 0.x 自動化runを有効化する前 | [#42](https://github.com/tomiya7688/Open_scraping/issues/42) の両トリガーをOSでarm、停止経路が独立、所有workerだけを終了できる | Escだけを理由に「マウス含め全機能対応」と記載 |
| 1.0.0 標準取得の一般提供 | 使用するtransport/OS/componentのsecurity-blocking gates、部品別品質・量の根拠、契約と来歴・保存/出力の試験 | 「全サイトで100%取得」「網羅率100%」等の分母のない断定 |
| 最終artifactの新規公開 | [#78](https://github.com/tomiya7688/Open_scraping/issues/78) の最終成果物自体の署名・attestation検証と利用者向け確認手順 | 「SHA-256だけあるので配布物の真正性を保証」 |

**情報の経路が増えるほど、安全の検証対象も増える。** 新たなbrowser/CDP/Proxy/WebSocket/download等を追加したら、既存のHost側ゲートがその経路にも強制されるか検証し、未検証ならcapabilityに記載する。

## 4. テスト証拠の共通書式（提案）

実装PRまたはベンチマークの結果は、少なくとも以下を記録する。

```text
gate_id:
issue / pr / commit:
status:
target_os / architecture / runtime_version:
component_impl / component_version / manifest_digest:
fixture_id / fixture_revision / fixture_sha256 / seed:
config_revision / allowed_sources / permissions:
test_command:
expected_result:
observed_result:
input_count / denominator_definition:
latency_p50_p95_p99 / memory_peak / bytes / unique_items:
security_rejection_code / stop_arm_state:
known_limitations:
evidence_url_or_file:
```

機能ごとに不適切な項目は `not_applicable` と明示し、未測定は `unknown`。数値0で代用しない。実サイト試験の場合、個人情報・cookie・署名URL・取得したraw HTMLをGitHub Issue/PRにそのまま貼らない。

## 5. 受入テストの最低構成

- **契約・基盤**：FlowConfig/manifest/DataRef、dangling ref、版固定、権限拒否、worker crash、cancel、retry race、partial outputは決して成功へ変換しない。
- **正解付きfixture**：structured data / DOM / SPA / Japanese text / ECのvariant / HTML table / duplicate / broken selector。precision/recallとfield evidenceを検証。
- **負荷fixture**：100件・1,000件・10,000件を段階化し、キューが上限を越えない、完了済みIDや予算がreopenで増減しない、429の待機を守ることを確認。
- **敵対的fixture**：localhost redirect、DNS rebinding、private IP接続、悪意あるworker、ZIP bomb、path traversal、prompt injection、log secret、CSV formula、別RunのDataRef、監視故障。
- **OS統合**：Windows 11 x64とUbuntu 24.04 x64を初期検証対象とするが、OSのグローバルマウス・Esc監視は通常のheadless CIだけで済ませない。macOSは対応試験が揃うまで未検証。
- **配布**：実際に利用者がダウンロードするZIP/installer等の最終ファイルを検証（[#78](https://github.com/tomiya7688/Open_scraping/issues/78)）。

セキュリティの反例試験に成功したから未知の脆弱性が存在しないことにはならない。判定対象をOS・接続経路・バージョン・権限・実際の試験セットに限定する。

## 6. 台帳のルール

[acceptance-gates.json](acceptance-gates.json) に各ゲートのID、次元、ブロック種別、Issue、試験タイプ、status、evidenceを管理。設計のレビュー中は台帳に `verified` を追加しない。

追加ゲートが必要になった場合は、**既存ゲートに全く同じ意味を重複させず**、関連する実装Issueと試験条件を先に決める。CIには `scripts/check-reliability-design.mjs` による台帳形式・根拠必須の検査を組み込み、試験完了していないゲートを無条件で成功済みとする変更を検出する。

関連：[#86](https://github.com/tomiya7688/Open_scraping/issues/86)（security QA）、[#84](https://github.com/tomiya7688/Open_scraping/issues/84)（品質統合）、[#85](https://github.com/tomiya7688/Open_scraping/issues/85)（大量取得統合）。製品の動作・品質を示すベンチマークはそれらの受入試験で実測する。
