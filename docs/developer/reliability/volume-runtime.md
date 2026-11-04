# 高取得量：バックプレッシャー・予算・復旧の設計

[横断設計](README.md) · [精度・来歴](accuracy-coverage.md) · [セキュリティ](security-threat-model.md)

**状態：提案中／性能を実測したものではない。** 「大量取得」は無制限並列や全サイト網羅ではなく、**ユーザーが選択した通信先・方法・制限の中で、確定した一意な取得物の量を増やす**ことを意味する。Coreは個別サイトを知らず、汎用資源schedulerとキャンセル・状態を扱う（[#9](https://github.com/tomiya7688/Open_scraping/issues/9)）。ブラウザ、ダウンロード、保存、出力の実処理は各Componentに置く。

## 1. 負荷を制御する処理経路

```text
選択された検索先・FlowConfig
  │
  ▼
Discovery / source adapters ── bounded candidate queue ──► Fetch
                                                          │
                       backpressure ◄──── bounded payload queue
                                                          ▼
                                                      Store/Commit
                                                          │
                                  bounded DataRef queue ─┘
                                                          ▼
                                                Process (optional)
                                                          │
                                                 Selection (optional)
                                                          │
                                                  Export / Manifest

全段: 共有資源許可 + Deadline + Stop + 予算 + checkpoint
```

各キューに、**要素数と概算バイト数の両方の高水位**、待機・取消・確定時の振る舞いを持たせる。下流が遅いときは上流を止め、見つかった候補を無限にメモリに追加しない。メモリを減らすための退避はHostのrun journalや保存部品による状態とし、Coreへ巨大なraw payloadを入れない。

キューに保持するのは可能な限りID、DataRef、small metadata。画像／PDF／動画の生バイトはストリームで扱う。保存済みでない本体・暗黙に再取得可能と扱うデータは、永続参照と混同しない。

## 2. 共有スケジューラー：実要求単位で制御

既存の[ランタイム設計](../../runtime.md)と [#9](https://github.com/tomiya7688/Open_scraping/issues/9)の原則を継承する。

- `resource_key`の例：ネットワーク接続先(origin/host)、provider、ブラウザセッション、ディスクIO、CPU、モデル、特定外部API。通信内容の意味でCoreを分岐させない。
- 一つの実要求が必要とする複数資源の予約を**原子的に**扱う（host全体の同時数 + source別間隔など）。親Componentが予算を取ったまま子Componentが同じ資源を二重予約し、停止することがないようにする。
- `not_before = max(user policy next_start, provider Retry-After, global pause, run pause, backoff)` の意味で、相手から指定された最短待機期限をユーザーの短い間隔設定で上書きしない。
- 間隔は「ダウンロード保存を開始した時刻」ではなく、**実際にネットワーク送信した要求の時刻**を基準とする。ブラウザ先読み・XHR・サブリソース等で検出できない通信は未制御と表示する。
- fairness：複数run／source間で一方が永遠に待たないよう公平な投入順序と優先度を定義する。優先度が同じものには説明可能な順序を使い、ユーザー選択済みでない検索先を自動追加しない。
- 一時的な429、5xx、ネットワーク切断は原因と`retryable`・`not_before`を区別する。認証切れ、challenge、手動操作要求、端末権限拒否は無限再試行しない。別取得方式へのfallbackもユーザーが選択した順序と範囲のみ（[#69](https://github.com/tomiya7688/Open_scraping/issues/69)）。

### 予算を階層化する

| 制限 | 数えるもの | 使い切った場合 |
| --- | --- | --- |
| `max_source_queries` | providerへ実際に依頼した問い合わせ | 新規検索を停止・理由を記録 |
| `max_fetch_attempts` | redirect・retryを含む実要求 | 追加通信停止、未処理候補を残す |
| `max_download_bytes` | wire上の受信量 | 部分取得として中断・保存確定しない |
| `max_stored_bytes` | 実保存物と展開済みサイズ | 保存確定を停止し容量理由を返す |
| `max_items` | ルール版を指定した確定済みunique item数 | 追加取得停止。ただし既存のバッチ処理は一致する停止意味論に従う |
| `max_wall_time` | 実行開始からの経過時間 | 新規投入停止・中断 |
| `max_in_flight` | 実際に動いているoperation／通信 | 次の許可が出るまで待機 |
| `max_memory / cpu / workers / disk` | Host・OSが観測／強制できる資源 | 限界前にbackpressure、越えた場合は失敗/停止 |
| `max_external_cost` | 外部API課金予算（計測可能な契約のみ） | 消費済み値を記録し新規操作を停止。不明な料金を0としない |

上限の**具体的な既定値は実装の評価前にOS・部品・マシン・対象環境を踏まえて決める**。全利用者に同一の数値を強制しない。0件/空の入力/不明な上限の扱いは契約で明示し、ゼロを無制限と解釈しない。範囲拡大はユーザーによる設定変更としてrun revisionを記録する。

## 3. 停止・再開・部分成功

1. run作成時に `flow_revision`、使用Componentの実装版・digest・binding、実効予算・選択検索先・monitor arm状態を固定。
2. 各operationの開始時に `operation_id`・`idempotency_key`・`run_generation`・入力DataRefと副作用境界を記録する。受理しただけでは成功としない。
3. 部品は必要なDataRefを確定前／確定後で分ける。ネットワークが途中切断したファイルや仮保存物は `partial`／`committing` とし、正常な完成データへ昇格しない。
4. キャンセル／非常停止時は新規投入を即座に停止。待機中の資源予約を解除し、必要なコネクタへcancel。所有していない外部プロセスや他Runのデータを停止・削除しない。
5. 再開時、保存済みcheckpointに含まれる成功済み副作用・資源予算・相手指定待機期限を照合して**二重実行しない**。旧generationからの遅延結果が新しいrunの状態を上書きしない。
6. 副作用のexactly-onceが保証できない外部サービスでは `termination_unknown` や要照合状態を維持。無断で再実行して二重取得・二重課金を発生させない。
7. 転送の再開が可能でも、ETag/Last-Modified/Range等から**同じ本体と証明できない**場合は別revisionとして扱う。サイズ一致だけで断片を連結しない。

[#10](https://github.com/tomiya7688/Open_scraping/issues/10) が保管するのは汎用run journalであり、商品の一覧や画像本体をCoreのSQLite表へ入れない。[#26](https://github.com/tomiya7688/Open_scraping/issues/26) が本体と来歴を担当する。

## 4. 観測と性能レポート

成果物数は [精度仕様](accuracy-coverage.md) の定義を使い、サンプル単位の比較に限る。

| 指標 | 最低限の観測 |
| --- | --- |
| `committed_unique_items_per_minute` | 一分間に初めて確定した一意ID（選別通過数と区別） |
| `download_bytes_per_minute` | wire上の受信量。キャッシュからの読み込みを別計測 |
| `storage_bytes_per_minute` | 保存確定後のbytes、重複排除で削減したbytesを分離 |
| `p50/p95/p99_operation_latency` | operation種別・provider・試験条件別。待機と実処理を別計測 |
| `queue_depth / queue_bytes / wait_ms` | 候補・payload・DataRef・exportの段階別 |
| `memory_high_water / CPU / disk_used` | OSとcomponent、run/hostで観測できる範囲 |
| `attempt_error_rate / retry_rate` | 429、timeout、permission、parse、partialなど原因別 |
| `recovery_duplicate_rate` | 停止/再開で確定済みIDや外部副作用が重複した割合 |
| `quality_by_throughput` | 高速化・大量化の際、精度・欠損・出典整合が劣化しないか |

単純な「ページ/秒」や「ブラウザ同時数」だけで大量取得の達成を評価しない。少数の巨大ファイルと多数の小ファイルは分けて観測する。分母不明、観測不能な通信やコストは `unknown` とする。

### 負荷試験の段階

- **100件（機能）**：局所テスト環境で設定・状態・予算の契約確認、ゼロ件／一件／途中失敗。
- **1,000件（持続）**：閉じたfixture serverで長時間のキュー・メモリ高水位・公平性を確認。
- **10,000件（ストレス）**：異なるサイズ・失敗・再開・複数runを混ぜて資源枯渇と部分成功を検証。外部実サイトに同じ負荷を掛けない。

測定条件：CPU/メモリ/OS、Nodeと依存版、fixtureセット・seed、キュー深さ、間隔/同時数、権限、対象件数、通信速度、warm/cold cache、取得先の模擬遅延をレポート。**合格閾値はbaselineを測ってから、比較実行前に固定**する。最初から架空の「毎秒○件保証」を宣言しない。回帰試験は同じ条件で測る。

## 5. セキュリティと精度との優先関係

- 許可していない宛先の通信、認証scope越境、OS sandbox未対応、非常停止未armedは、**量優先設定でも許可しない**。対応する理由をユーザーへ返す。
- 多数候補を見つけても、同じ商品の重複・誤抽出・保存未確定を「取得済み件数」に合算しない。
- 性能改善時、raw source・観測・来歴の必要な情報を削除して計算量を減らした場合は、品質の後退として評価。省略することをユーザーに表示する。
- データの品質フィルターは利用者の選択する外部部品。スループットのためにCoreへ推奨・採否ロジックを追加しない。

実装・負荷検証は [#85](https://github.com/tomiya7688/Open_scraping/issues/85)。関連する scheduler[#9](https://github.com/tomiya7688/Open_scraping/issues/9)、run journal[#10](https://github.com/tomiya7688/Open_scraping/issues/10)、download[#25](https://github.com/tomiya7688/Open_scraping/issues/25)、store[#26](https://github.com/tomiya7688/Open_scraping/issues/26) に接続する。
