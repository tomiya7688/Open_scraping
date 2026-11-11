# 横断設計の決定表と未決定事項

[設計入口](README.md) · [実装構成](implementation-blueprint.md) · [契約モデル](contract-model.md) · [強制手段](security-enforcement.md) · [試験](verification-protocol.md)

**設計段階のレビュー用**。下表の「既存確定」は既存の設計文書／契約に根拠があるもの。「提案（PRレビュー待ち）」は本PRで新たに定義した内容であり、`main` に確定済みとは主張しない。「検証待ち」はモックや文書では確かめられない。具体的なAPI名・新たなstatusは実装時に版付きで採用する。

## 1. 具体的な判断（理由と拒否する代案）

| ID | 状態 | 設計判断 | 理由と代替案を採らない理由 |
| --- | --- | --- | --- |
| D01 | 既存確定 | CoreはFlowの実行制御のみ、ブラウザ・検索・HTTP・DBはComponent/Host | 標準機能をCoreへ直書きすると利用者による部品交換ができなくなる |
| D02 | 既存確定 | Esc/人の物理マウス入力によるグローバル停止は非着脱で、未armedでは標準自動化を開始しない | 画面の停止ボタンだけでは非前面・応答不能時に奪い返せない |
| D03 | 既存確定 | Componentの実装・版・bindingをRun開始時に固定 | 暗黙fallbackや実行中の差し替えは結果の再現性と権限を壊す |
| D04 | 提案 | 「ユーザーの選択した取得対象」と「Host/OSの実通信・秘密権限」を独立に検査する | URLのallowlistやロボット向けのサイト条件だけではSSRF・秘密情報漏洩を防げない |
| D05 | 提案 | NetworkGateで実接続IPを検証し、検証したIPに固定して接続 | Hostnameの事前検査だけではDNS rebindingに弱い。redirect/proxy等の経路も別に判定 |
| D06 | 提案 | Worker起動の合格は、Hostのpermission許可**とOSの強制力あるsandbox**の両方で決める | 権限一覧を見ただけではworkerが親のHOMEやsocketへアクセスできる |
| D07 | 提案 | grantをprincipal/run/component version+digest/operation/scope/expiryに束縛 | 一度の同意を全Run・全コンポーネントへ自動転用しない |
| D08 | 提案 | セキュリティ強制不能のNetwork/Browser/OS経路は拒否または未対応表示 | 「一応つながる」を安全な運用と誤表示しない。取得量のために迂回を容認しない |
| D09 | 提案 | FlowConfig 0.3を改造せず、RunLaunchPolicyをHost sidecarで版固定 | 既存フロー例が全て拒否されないよう互換を保ちつつ権限・予算を追加できる |
| D10 | 提案 | Discovery / FetchAttempt / RawBlob / FieldObservation / Selection / Exportを別の版付き契約にする | 「見つけた」「取得した」「保存した」「正しい」を混同しない |
| D11 | 提案 | 取得物はrawを残し、抽出と選別は別revision。フィルターなしでも正式な経路 | 内容採否をデータ取得の必須条件にするとユーザーの制御を奪い、誤除外を隠す |
| D12 | 提案 | 抽出の矛盾はObservationSetとして残し、エラー/未知を0や偽のtrueへ変換しない | 見た目の件数増加で情報品質を損なわない |
| D13 | 提案 | 各pipeline段は要素数・bytesでbounded queue、下流backpressureを伝播 | 大量収集時にHostのRAMやディスクを際限なく消費しない |
| D14 | 提案 | Schedulerは**実通信ごと**に容量・間隔を計算し、再開しても予算・Retry-Afterをリセットしない | バッチ内部の隠れた大量アクセスや再実行による過負荷を防ぐ |
| D15 | 提案 | 外部副作用未確定は `termination_unknown` を維持、照合前の再投入を禁止 | 状態を楽観的に成功／失敗へ丸めると、二重通信・二重課金・データ破損が起きる |
| D16 | 提案 | 精度はfield/record/variant/出典までの指標を分け、評価集合と分母を固定 | ウェブ全体の未知の「100%網羅率」や不透明な単一scoreを根拠にしない |
| D17 | 提案 | タスクのデフォルトは予算付き・限定source・外部AI送信なし。fallbackはユーザーの明示選択のみ | 予期しない外部送信・経路切替や料金を避ける |
| D18 | 既存Issue #78 | 未署名／attestation未検証の最終artifactは新規配布不可 | checksumだけでは誰が作ったかを証明できない |
| D19 | 提案 | 安全ゲートは品質／件数の点数と合算しない（**ブロッキング**） | 高スループットで秘密漏洩や停止不能を相殺できない |
| D20 | 提案 | 本PRのゲート台帳はすべて `planned` から開始し、OS/fixture/commit証拠があるときだけstatus更新 | 文書作成・CI静的チェックをセキュリティ実証と取り違えない |

ここに「提案」と書いた項目の方針を実装Issueで変更するときは、**理由、代替案、影響するゲート、既存contractとの互換性**を記録する。選択したOS backendやデータ形式の内部実装は、後続ADRで決定できる。

## 2. 明示して未決定とする事項

| ID | 決定が必要な事項 | 決めるための証拠 | 暫定の取扱い |
| --- | --- | --- | --- |
| O01 | Windows 11/Ubuntuに採用する実Sandbox backend | 実機でfile/network/env/processを強制遮断できるか、配布・権限・更新の負担 | **強制力未検証のworkerはsandbox済みと表示しない** |
| O02 | OSグローバルEsc・物理マウス監視backend | 非前面/合成入力/別プロセス/Wayland等の実測 | **未armでは自動化run拒否** |
| O03 | Managed browserの全通信制御、Proxy/HTTP3/WebRTCの対応範囲 | 各schemeの通信・IP・TLS・secret leakの実接続検証 | 未制御経路は保証外／標準保護付きRunでは利用不可 |
| O04 | NetworkGrantの公開Schema IDとLAN許可UI | 既存permission API・Windows/Ubuntuユーザー体験と別Run権限テスト | 明示grantなしのprivate宛先拒否 |
| O05 | 資源上限と公平性の既定値 | 固定fixtureでのOOM回避・公平性・スループットの測定 | **無制限にはせず**、設定が無ければ自動化開始を拒否または限定デフォルト |
| O06 | フィールド精度の製品版合格閾値 | 固定gold set・母数・サイトカテゴリ別baseline、サンプリング戦略 | precision/recallを実測せず「高精度」と宣伝しない |
| O07 | RawBlob/Observationの永続Schema・migration方式 | DataRef 0.1と、既存run journal #10・store #26の分離・復旧テスト | 新versionで実装、既存0.3/0.1を暗黙に変更しない |
| O08 | 長時間の非HTTP通信/ブラウザでのEgress強制方法 | WebSocket/SSE/ServiceWorker/HTTP3等の実機テスト | 監視不能なmethodには対応済み表示をしない |
| O09 | 動的な品質モードの計画・再抽出ルール | 同じraw fixtureに対するcost/latency/recall比較 | precision/recall選択はComponent側、Coreは意味解釈しない |
| O10 | ライセンスと標準／派生配布の正式方針 | [Issue #3](https://github.com/tomiya7688/Open_scraping/issues/3)の所有者判断、部品OSSのライセンスと配布物署名 | 正式配布の許諾・対応を勝手に宣言しない |

**未決定であること自体は設計の欠陥ではない**。しかし「未決定のまま実装したらどうなるか」を明示してある。安全上の初期挙動は原則拒否、利用者には何が未対応かを示す。品質閾値は評価方法を固定したうえで測定後・本評価前に決定する。

## 3. 実装着手の判定

1. Run起動前のセキュリティ条件が識別可能（どのscopeのgrant、どのOS backend、どのmonitor状態を検査するか）。
2. 各契約のstatusと作成／確定／破棄の意味が定義済み。partialやunknownを成功へ変換しない。
3. 正常・異常・競合のfixtureと、**何をもって合格するか**が同じPRにある。
4. API / Core / Host / Component / storageの担当境界を混ぜない。既存未マージPRとの差分と依存関係を確認する。
5. OS実機・ネットワーク・負荷計測が必要なものをMock CIと区別している。
6. 対応ゲートがまだ `planned` なら、実装PRで証拠を付けるまでは仕様上の対応のみ。機能として安全と公表しない。

## 4. コードレビューで確認する根拠

- 現行型：[`packages/contracts/src/types.ts`](../../../packages/contracts/src/types.ts)
- 現行Host：[`packages/host/src/component-host.ts`](../../../packages/host/src/component-host.ts)
- 現行Core：[`packages/core/src/execution.ts`](../../../packages/core/src/execution.ts)
- グローバル非常停止：[設計](../../emergency-stop.md)／[Issue #42](https://github.com/tomiya7688/Open_scraping/issues/42)
- 既存研究：[Webデータ抽出](../../research/web-extraction-methods.md)／[Issue #54](https://github.com/tomiya7688/Open_scraping/issues/54)
- 実装の安全：[#82](https://github.com/tomiya7688/Open_scraping/issues/82)、[#83](https://github.com/tomiya7688/Open_scraping/issues/83)、[#86](https://github.com/tomiya7688/Open_scraping/issues/86)
- 実装の品質と量：[#84](https://github.com/tomiya7688/Open_scraping/issues/84)、[#85](https://github.com/tomiya7688/Open_scraping/issues/85)

この文書は**決定の記録であり、実装の完了記録ではない**。以後設計変更時にはdecision IDを差分で説明し、後続ADRが確定したら当該行からリンクする。
