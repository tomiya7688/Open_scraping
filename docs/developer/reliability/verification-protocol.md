# 検証プロトコル：精度・量・安全を再現可能に測る

[統合設計](implementation-blueprint.md) · [セキュリティ強制](security-enforcement.md) · [受入ゲート](acceptance.md) · [ゲートJSON](acceptance-gates.json)

**設計案／未実装。** 本書の数値はテストケースのサイズまたは初期の安全上の合格条件であり、製品の実測性能やモデル精度ではない。プロダクションの安全性・精度・速度は各OS/配布構成の実行結果でのみ主張する。

## 1. 検証の階層とCI

| Tier | 何を検証するか | 実行場所 | 合格できる範囲 |
| --- | --- | --- | --- |
| T0 | JSON schema、契約互換、構成ルール、静的データの期待値 | Nodeテスト・CI | Wire形式と純関数の契約のみ |
| T1 | mock component、Host、resource scheduling、journal、HTTP/workerプロトコル | Windows/Ubuntu CI | モック化された実行境界 |
| T2 | ローカルHTTP/DNS/ファイル等の敵対的fixture（外部サイト不要） | 隔離したテスト実行環境 | 指定した条件の拒否・検出挙動 |
| T3 | OS-level sandbox/実キーボード・物理マウス/managed browser接続 | 専用Windows/Ubuntu実機 | そのOS・セッション・権限構成での実証 |
| T4 | 多段階の大量取得・復旧ベンチマーク | 固定マシン/closed fixture server | 測定環境に限定したスループットと品質の比較 |
| T5 | 最終ZIP/installer/binaryの署名・attestation、起動・表示 | Release pipeline + 実機 | その最終artifactの真正性と配布可能性 |

**T0/T1/T2の成功でT3/T5を合格にしてはいけない**。headless runnerのWindowsプロセスがGUIの入力監視を満たすとは限らない。実サイトでの大量アクセスをCIの必須条件にしない。

実装時、各tierのテストスイートは独立コマンドにし、上位tierの未実施を `not_run` と表示。実行不能な環境では「成功」ではなく未実施理由を残す。

## 2. Fixture：仕様が何をどの程度知っているか

### 精度のfixture仕様

最低限の人工データとして、次のカテゴリを用意する。**ここに示す件数はFixtureの設計目標**であり、実装済みテスト件数ではない。

| ID | 主な内容 | 期待される判定 |
| --- | --- | --- |
| F-Q01 | 同一商品を表すHTML+JSON-LD、全項目が一致 | 双方のevidenceを残し、正しく抽出 |
| F-Q02 | 表示価格とJSON-LD価格が異なる、時刻も異なる | `conflict` と原観測2件を維持 |
| F-Q03 | 型番同じ、色/容量/販売者の異なる商品variant | 別Itemとして保全、duplicate false mergeに数える |
| F-Q04 | 記載のない在庫、実装が0を埋めやすい商品 | `missing`/ `unknown` と0の区別 |
| F-Q05 | 結合セル、日本語単位/大字・小数・期間付き表 | 単位、原値、正規化値、根拠を一致 |
| F-Q06 | script hydration、late images、iframe、Shadow DOM | 観測経路と未観測を正しく分離 |
| F-Q07 | DOM mutation: selector broken、wrapper追加・欠損 | wrapper failureと推定修復の区別 |
| F-Q08 | partial HTTP body、HTTP429、認証必須、MFA | 内容不一致と通信・権限失敗の区別 |
| F-Q09 | CSV式/HTMLタグ/secret含むURL | Raw dataと表示・出力の安全な形式変換 |
| F-Q10 | 重複RawBlobだが別の掲載URL・取得時刻 | Blob dedupeは可、来歴は複数残す |
| F-Q11 | 日英・全角/半角・異なる通貨・日時・ロケール | 別の観測を無断で同値としない |
| F-Q12 | 不明なfield type／未来のcomponent version | `unsupported` として明示、落ちない |

提供する場合は各fixtureに **`dataset_id`、`version`、`sha256`、ライセンス、正解ファイル、評価条件、seed** を記録。公開物を無断再配布せず、CIでは手作り/利用条件を確認した小さなfixtureのみ利用。

### 大量取得のfixture

- 100件の通常ケース：ページ送り、duplicate 5件、partial 2件、源別フィールド欠損を混ぜる（比率は生成器で固定）。
- 1,000件の持続ケース：閉じたHTTP server、一定/ジッタ遅延、429/Retry-After、1箇所のworker crash、複数run、slow diskを設定できるようにする。
- 10,000件のストレスケース：大小のBlob、長いcursor、部分ダウンロード、disk full、OS停止、異なるselected_source、各段のhigh-waterを混ぜる。

予算例：`max_fetch_attempts=1250`、`max_download_bytes=128 MiB`、`max_in_flight=4` 等をfixture manifestに置く。**これらは例であり全ユーザーの既定値にはしない。** すべてのRunで消費したトークン/bytes/attemptとcheckpointを照合できることが合格条件。

## 3. 精度計算の厳密な定義

### Field extraction

正解集合 (G) と、システムが「観測でき、正しい」と主張する結果集合 (P) を、**item_idとfield名、正規化ルール版**で照合する。定義した評価用対応関数で一致を判断し、値だけを比べて別Itemの同名項目を正解にしない。

- `TP`：正解フィールドと正しい値で対応した数。
- `FP`：正しいと主張したが、値/Item対応が誤った数。推測やunsupportedを無断でobservedにした場合もFP。
- `FN`：正解集合に存在する必須フィールドを正しく主張できなかった数。
- `precision=TP/(TP+FP)`、`recall=TP/(TP+FN)`、`F1=2PR/(P+R)`。分母0は0にせず `not_evaluable` と数/原因を表示。

**重要**：Fieldを保留した `unknown` はFalse Positiveを防ぐが、正解が存在する場合にはFNになる。分母を既に抽出できたフィールドだけに絞ってrecallを100%にすることを禁止する。

### Record・duplicate・来歴

- `record_recall`：正解record ID集合のうち、正しい対応関係をもって発見したrecord数/正解record数。選別後の結果だけで測らない。
- `false_merge_rate`：別variantの真に別Itemを同一と誤って統合したペア数/正解で異なるItemペア数。すべてのペアを列挙しない場合は評価サンプルの取り方・分母を明示。
- `dedupe_recall`：真に同じItemのペアのうち同一集合へ統合した比率。別の方法で測るときは定義を保存。
- `provenance_integrity`：`observed` と主張したFieldで、checksumが一致するRawBlobとlocator、抽出器版・時刻まで辿れるもの/評価対象observed Field全数。
- `conflict_retention`：複数の正解出典が矛盾すると固定したケースで、少なくとも2証拠と `conflict` 状態を保持した割合。
- `unknown_rate` / `partial_rate` / `source_failure_rate`：**件数の種類ごとに**分子と分母を固定。異なるメトリクスの分母に `FetchAttempt` と `Item` を混ぜない。

**受入基準（構造上の性質）**：根拠付き観測フィールドのevidenceリンク破損 **0件**、既知のconflictの黙示上書き **0件**、未観測をobservedとして出力 **0件**、保存commit前の出力確定 **0件**。統計的な最低precision/recall値は固定fixtureを使ったbaselineを作り、評価結果を見る前にIssueとADRへ記録する。

## 4. 取得量・安定性の検証方法

### 動作不変条件（数値の大小に依存しない）

- 各段のqueueの要素数とバイト数が設定済み上限を超えず、停止・crash後に所有権不明なDataRefが増えない。
- 実通信attemptと予算消費のログが一致。親・子の二重reservations **0件**、予算超過要求 **0件**、未選択sourceへの通信 **0件**。
- 完了後の `committed_unique_items` と保存済みCollection revisionを突合でき、同じcheckpointから再開しても二重に増えない。
- `Retry-After` 以前の許可されていない追加要求 **0件**、キャンセル後の新規投入 **0件**。
- 10,000件の負荷でもRunが終了/停止/失敗状態のいずれかに到達。期限超過時に際限なく待ち続けない。

### 比較時の計測

`scenario_id`、seed、CPU/メモリ/OS、Node版、fixture checksum、ブラウザ版、構成Revision、queue limit、resource policy、warm/cold cache、環境のネットワーク遅延、actual run start/end、成功/失敗/部分取得の数をすべてレポート。

- throughput：**保存確定したunique Item/秒**。候補や通信attempt/秒は別列。
- latency：discovery / scheduler wait / connect / receive / store / parse / exportを段階別にp50/p95/p99。未計測を0としない。
- resources：RSS high-water、worker別memory、CPU time、disk writes、queue item/byte high-water、file descriptor使用量。
- recovery：中断から手動復旧までの時間、復旧時のduplicate side-effects、破損DataRef、戻せなかったunknownの数。
- quality-at-scale：最初/途中/後半のバケットごとに抽出precision/recall、missing/conflict率を計測。量だけ上がっても品質低下を見逃さない。

性能の閾値は対象OSごとにbaselineと目標を先に登録してから比較。比較に使用したfixtureと環境が異なる場合、同じ実測値だと扱わない。

## 5. セキュリティの敵対的テストケース

| テストID | 条件 | 最低合格ライン |
| --- | --- | --- |
| A-S01 | forged Host、任意Origin、認証なしでloopback API | API操作が拒否され、tokenが返らない |
| A-S02 | 外部hostが302で127.0.0.1/metadataへredirect | 接続禁止・Cookie漏洩0 |
| A-S03 | DNS再解決でpublic→private、IPv6/IPv4-mapped | 物理的な接続先がgrant外へ変わらない |
| A-S04 | private LANを明示許可したRunが他Runのsecretにアクセス | 拒否、権限scopeが分離されている |
| A-S05 | workerが親HOME/env/socketへ直接アクセス | OSでdeny、Hostで安全動作と偽らない |
| A-S06 | ZIP slip、symlink、異常展開比 | root外書込み0、quota外の展開0 |
| A-S07 | HTML/JSON内に命令文を埋め込む | grant/Host操作/外部送信が増えない |
| A-S08 | worker stderrと例外にtoken/Cookieを含める | 公開ログ・PR証拠へ生値0 |
| A-S09 | manifest差し替え/版不一致 | 起動拒否、元Runのbindingを勝手に変更しない |
| A-S10 | 別アプリ前面でEscと物理マウス操作 | どちらでも全active runが停止方向へ進む |
| A-S11 | OS monitor crash中の新規開始/自動reopen | 新規開始0、自動再開0、所有外プロセスkill 0 |
| A-S12 | 別RunのDataRef推測・読み取り | 権限外読み取り0 |
| A-S13 | 429やディスクフルで上限を超えた再試行 | 不正通信0、上限超え0 |
| A-S14 | 最終ZIP/installerの署名・attestation不在 | 新規配布をブロック |
| A-S15 | CSV式・HTMLタグをexportして表示 | 安全な表示／出力形式でスクリプトの無断実行0 |
| A-S16 | browserが監視不能な通信を行う | 対応済みと扱わず、保護モードでは実行しない |

テストの`deny`は**実際のネットワーク接続/ファイルシステム変更/プロセス生成を観測して判断**する。APIがエラー応答しただけで、危険な副作用が起こらなかった証拠にはならない。OS watcherの実機テストは監視用記録と対象runの状態を照合する。

## 6. セキュリティ失敗時のリリース判断

1. `security-blocking`の対象機能で一つでも失敗・未検証なら、関連する標準自動化や配布を「安全に使用可能」と表示しない。利用可能な安全な別モードの存在は別の評価として説明する。
2. 非常停止 `#42` がarm不能なら自動化runを開始しない。Escだけ／マウスだけの片方成功で完全対応としない。
3. 未署名・未attestedの**最終配布artifact**を公開しない（`#78`）。checksumのみでは真正性を判定できない。
4. 機能を含まない配布構成を `not_applicable` にする場合は、コンポーネントが実際に欠けていることと実行経路が存在しないことを根拠とする。
5. 安全経路が一部だけ未検証の場合、ブラウザ設定や通信能力を減らして、**実際に制御できる縮小スコープ**を別の配布構成として検証する。UI上のラベルだけで同じ危険な経路を通さない。

## 7. エビデンス記録の書式

```json
{
  "schema_version": "1",
  "test_id": "A-S03",
  "gate_id": "S03",
  "status": "not_run",
  "repo_commit": "<actual-commit-sha>",
  "platform": { "os": "Windows", "version": "<observed>", "arch": "x64" },
  "fixture": { "id": "dns-rebind", "revision": "<actual-revision>", "sha256": "<actual-sha256>" },
  "capability": { "component": "<actual-id>", "implementation_version": "<version>", "policy_revision": "<revision>" },
  "expected": "No connection to an ungranted private address",
  "observed": null,
  "raw_log_storage": "access-controlled-local-log-reference",
  "sanitized_evidence": [],
  "limitations": ["Not yet executed against an OS network backend"]
}
```

上記は**記入前テンプレート**。仮の文字列をテスト結果や実行ログとして保存しない。測定済みなら `status` と `observed`、commit/OS/fixture/logを埋める。失敗は原因・再現条件と、実際にどの境界が通過できたかを記録。生Cookieや個人情報を外部Issueへ貼り付けない。

## 8. 開発順序と完了判定

- **まず局所的な契約を確定**：RunLaunchPolicy、NetworkGrant、FieldObservation、FetchAttempt、BudgetEvent、ExportManifestのschema。異常系fixtureを先に作成。
- **次にセキュリティの強制**：Host permissions、ネットワーク実接続先、sandbox、秘密参照、API、OS非常停止。未実装のため現在は全security gate planned。
- **その後の統合**：scheduler/journal、search/fetch/store、抽出/エクスポート。部分失敗・再開・誤抽出の定量レポートを実測。
- **公開**：対象OS/実行経路のゲートに証拠を付ける。実測していない環境は対応済みと表記しない。

既存の[受入ゲート台帳](acceptance-gates.json)のstatusを変更する際は、対応Issue・commit・証拠を添付し、所定のTierの試験が本当に実行されたか確認する。
