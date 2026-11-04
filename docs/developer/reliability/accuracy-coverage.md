# 精度・網羅度・来歴の設計

[横断設計](README.md) · [高取得量](volume-runtime.md) · [受入ゲート](acceptance.md)

**状態：提案中／抽出ベンチマークの結果ではない。** 検索結果が見つかったこと、URLを開けたこと、保存が完了したこと、フィールド値が真であることは別。利用者が要求した件数を満たすために、不明な値を推測で埋めたり、データを捨てて成功率を上げたりしない。

## 1. 評価する対象と、混ぜてはならないカウンター

| 段階 | カウンター名（設計案） | 数え方／含めないもの |
| --- | --- | --- |
| 計画 | `planned_source_queries` | ユーザーが選択した検索先とクエリの組。未選択サイトは含まない |
| 発見 | `discovered_candidates` | 実際の検索結果等で発見した候補。重複URL・未確認も含む |
| 通信 | `fetch_attempts` | 実際に開始した要求。redirect・retryを同じ成功として集約しない |
| 取得 | `complete_payloads` / `partial_payloads` | 完全に取得できた本体と途中切断の本体を分ける |
| 保存 | `committed_blobs` | 保存部品がatomic commitした本体。検出しただけでは増やさない |
| データ化 | `extracted_items` | 抽出された項目・レコード。ノードが成功でもレコード数は0になり得る |
| 同一性 | `unique_items` / `possible_duplicates` | ルール版を指定した同一性判定。見た目が似るだけの候補を統合しない |
| 任意選別 | `selected_items` / `rejected_items` / `undetermined_items` | 保存済み本体を破棄しない別の選択Revision |
| 出力 | `exported_items` / `exported_bytes` | 実際に確定した成果物内のIDとバイト数。候補数ではない |

各カウンターには `run_id`、`component_impl/version`、`flow_revision`、`snapshot_id`、時点、状態（complete/partial/unknown）を持たせる。**これらの値は足し合わせられる一種類の件数ではない。**

「取得完了率」のような名前を用いるときは分子・分母を必ず表示（例：取得完了payload数/開始した取得試行数）。retriesを分母から外したり、別サイトの未観測結果をゼロにして成功率を水増ししない。

### 網羅度に必要な分母

- **fixture coverage**：既知の正解レコード集合を事前に固定し、その中で発見・抽出した割合を測る。これは測定可能。
- **ユーザー選択範囲のcoverage**：対象サイト、クエリ、時刻、深さ、ページ数、API制限を明示し、実際に訪問・失敗した範囲を説明する。未知の全件数を勝手に分母にしない。
- **Web全体のcoverage**：未知。サイトの完全な全件数や「取りこぼしゼロ」は保証しない。
- **観測漏れ**：発見できなかったデータ、取得失敗、DOMに現れない情報、認証・JavaScript状態が必要な情報を個別に報告。機械的に `not_exposed` と断定しない（[#69](https://github.com/tomiya7688/Open_scraping/issues/69)）。

## 2. DataRefを越えても維持する証拠

検索・取得・処理・保存・出力は外部Componentであり、以下の**標準部品間契約案**は [#15](https://github.com/tomiya7688/Open_scraping/issues/15) の対象。Coreはそれらのフィールド値を判断しない。

- `Discovery`：入力クエリ・検索先・実問い合わせ先、発見ページ、候補URL、発見時刻、一覧内での表示順位、提供された検索メタデータ
- `FetchAttempt`：リクエスト/redirectの連鎖、到達先、時刻、HTTP等の応答情報、content-typeの観測、バイト数、完了／部分完了／失敗理由
- `RawBlob`：ファイルのハッシュ（計算方式込み）、サイズ、保存済みDataRef、取得時のmedia type・encoding推定、変換前の本体への参照
- `FieldObservation`：原文（例：`¥1,980`）、正規化値、型・通貨・単位、証拠となるraw資料IDとlocator（selector / JSON path / text range / screenshot region）、観測時刻、抽出器ID+版、状態
- `Item`：観測値の集合と、候補が同じものか判定したルール版。商品なら型番・カラー・容量・数量・販売者・日時等の**variant属性を失わない**
- `SelectionRevision`：誰が何の条件で選んだか、採用・除外・保留の理由。元Blob・観測値は変更しない
- `ExportManifest`：実出力ID集合、出力hash、出典、使用した変換・選別版、確定時刻

### 値の状態

`observed`（実際に観測）、`missing`（対象に項目の記載が無いと確認）、`not_observed`（未訪問/未取得等で観測していない）、`unknown`（判断できない）、`conflict`（複数証拠が矛盾）、`parse_error`（読めない/型が不正）を分ける。

**不明の価格は0円ではない。** 不明の在庫は在庫なしではない。記載されたメーカー名は実世界の製造者や権利者を保証しない。原文の値と派生した推定値を必ず区別する。

## 3. 抽出の段階・fuse・fallback

既存の [Web抽出手法研究](../../research/web-extraction-methods.md) を踏まえ、**低コストで根拠を示せる方式から始める**。

1. Structured data（JSON-LD/Microdata/RDFa、APIが公開する構造化出力）
2. DOM/セマンティクス（article/table/repeating records、CSS/XPath、MDR/DEPTA）
3. Wrapper保守（fingerprint/tree alignment、同じ意味の候補を複数検出）
4. 学習型DOM処理（必要な場合のみ、モデル版・スコア・使用環境を記録）
5. 視覚型／multimodal（DOM・画像位置を照合できないときの明示的な補助）

**後段を使用する条件**：前段がunsupported/失敗、必要フィールド欠落、競合、ユーザーがrecall優先を選択、または事前評価したquality budgetの閾値未満。後段の推測が前段の原文を無条件に置換しない。コスト、秘密データの外部送信権限、接続先の選択を勝手に拡張しない。

複数出典の統合は、同一性（商品版・型番等）、フィールド単位、時刻、源の種類を持つ **ObservationSet** を返す方針。採用する値の優先規則はComponent/ユーザー設定で版固定し、相反する値と選択理由を保持する。同一URL・類似画像・タイトル類似だけで商品や人物を同一視しない。

## 4. 精度の測定と設計上の制約

| 指標 | 定義／合格方法 |
| --- | --- |
| `field_precision = TP / (TP + FP)` | 値が正しいと主張して出力したフィールドの正しさ。FPとFNは後段で混同しない |
| `field_recall = TP / (TP + FN)` | fixtureで正解が既知の必須フィールドについて、正しく取得した割合 |
| `field_F1` | precisionとrecallの調和平均。未観測・unknownを自動正解にしない |
| `record_detection_precision/recall` | 候補が実際のレコードかと、全正解レコードのうち発見できた割合 |
| `value_exact_match` | 金額・型番・数量など原文の厳密性を評価。小数点／単位／通貨の正規化は別検証 |
| `provenance_integrity` | 元資料へのリンク、証拠位置、抽出器版、時刻を追える割合。不明・期限切れは欠損 |
| `duplicate_precision/recall` | 異なるvariantの誤統合と、真の重複の残存を別計測 |
| `unknown/partial/conflict rate` | unknown等の比率。精度だけでなく観測不能/衝突が増えていないか可視化 |
| `search_source_balance` | 選択されたサイト群への探索配分と、実際に得た件数の差。検索先ごとに比較 |
| `accuracy_by_volume_bucket` | 初期・中盤・大量取得時のサンプル別精度、時間経過での劣化を確認 |

分母0は `null` / `not_evaluable` と表示。結果を良く見せるために分母を変更しない。信頼区間やテスト集合の標本サイズも保存する。ランダムサンプリングをする場合はseedと選択法を保存し、珍しいサイト・失敗経路も層化抽出する。

### 初期の正解データと試験

- WDC/SWDE/PLAtE/CleanEval/WebTables系の公開条件が許すデータと、独自の小さなHTML・画像・CSV・表・日本語サイトfixture（[#54](https://github.com/tomiya7688/Open_scraping/issues/54)）
- JS描画、iframe、table colspan/rowspan、遅延画像、EC商品の色・容量違い、価格の掲載時刻、同名の別商品、APIと画面の矛盾
- HTMLの構造変更、selector破損、部分転送、権限拒否、同一データの複数取得元、検索結果なし、重複・未知のデータ型
- **各手法の採用判定は評価データを見る前に** precision/recall・遅延・メモリ・費用・秘密送信・対象OSを設定して実行する。後から悪かったセットを除外して合格にしない
- テストデータにはライセンス・出典・利用可能範囲を添える。第三者サイトの実データを無断でCIへ取り込まない

### User quality mode

- **precision優先**：確証のない値は保留。未知・衝突を隠さない。取得済みの原本は残す。
- **recall優先**：追加経路・追加の抽出を提案。対象サイト・予算・モデル送信許可はユーザー設定の範囲に限定する。
- **raw取得**：選別Componentが無くても有効なフロー。精度の未評価は「取得成功」を取り消す理由にしない。ただし「内容が正しい」とは表示しない。
- **比較・おすすめ**：価格・送料・在庫・変動時刻・variant・ユーザー条件を根拠付きで扱い、取得できない属性を作らない。提示するランキングは収集結果とは分離する（[#41](https://github.com/tomiya7688/Open_scraping/issues/41)）。

## 5. 品質ゲートと未決定事項

**契約レベルで必須**：失敗を成功へ変換しない／部分成功を完全成功と呼ばない／出典・版を追える／異なる観測を黙って破棄しない／フィルター未接続を正式に許す／初期リンク条件を全通信の権限と混同しない。

**評価ベースライン後に確定**：フィールドごとの最低precision/recall、主観的選別の誤除外許容、速度と精度のtradeoff、評価セットのOS/ブラウザ別範囲。これらを実行結果を見て都合良く変更せず、fixture版とベースラインを先に固定する。

実装Issue：[#84](https://github.com/tomiya7688/Open_scraping/issues/84)。関連するComponentとテストは[#15](https://github.com/tomiya7688/Open_scraping/issues/15)、[#54](https://github.com/tomiya7688/Open_scraping/issues/54)、[#69](https://github.com/tomiya7688/Open_scraping/issues/69)で管理。
