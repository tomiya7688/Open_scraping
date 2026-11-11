# セキュリティ脅威モデルと実行境界

[横断設計トップ](README.md) · [受入ゲート](acceptance.md) · [非常停止](../../emergency-stop.md)

**状態：設計案／実装済みではない。** 性能・収集範囲のために利用者端末の機密性、完全性、可用性を犠牲にしない。Coreが保持する唯一の安全上の非着脱機能は、フォーカス非依存のEsc／ユーザーの物理マウス入力による非常停止（[#42](https://github.com/tomiya7688/Open_scraping/issues/42)）。下記の認証・通信・sandbox等は、コアのコンテンツ規制ではなく**実行・権限の境界**としてHost・OS・外部部品側で強制する。

## 1. 保護対象と信頼境界

| 境界／資産 | 信頼しない入力 | 必要な制御／責任層 |
| --- | --- | --- |
| GUI/CLI → loopback HTTP API | WebページからのJavaScript、別ローカルプロセス、偽Host/Origin | Host API輸送：loopback bind、起動時ランダムBearer token、Origin/Host照合、認証済みでも操作ごとに認可 |
| Host → worker | 第三者／内製Componentも破損・悪意を持ち得る | Host：登録manifest・digest・版固定・実権限の強制、所有プロセス管理、OS sandbox・deadline |
| Host → 通信先 | URL、DNS応答、redirect、proxy、SPAやbrowserによるサブリソース | Network境界：実接続宛先の審査、通信許可、TLS、監査、全経路の観測 |
| Host → secret broker | Cookies、Bearer token、認証済みbrowser profile、署名URL | Host秘密管理：最小権限、site/operation/runスコープ、寿命、log/export除外 |
| 取得したデータ → parser/model/画面 | HTML/DOM、画像、表計算、PDF、ZIP、script、prompt injection | 外部processing部品：隔離実行、形式検証、展開上限、データと命令の分離、画面側の出力エスケープ |
| DataRef → 保存/出力 | 期限切れ参照、他Run参照、不正path、重複blob | Hostの参照認可＋保存／出力部品：scope、atomic commit、path confinement、機微情報の選択 |
| release → 利用者端末 | 改ざん済みinstaller、依存パッケージ、偽更新 | 配布CI：最終artifact署名/attestationと検証（[#78](https://github.com/tomiya7688/Open_scraping/issues/78)） |
| 人間 → OS非常停止 → Host/Core | アプリが非前面、worker hung、監視停止、synthetic input | OS別monitorとHost/Core停止経路：監視arm必須、即座の投入停止、所有workerのみ終了 |

ブラウザのContent-Security-Policyやユーザーの通信対象設定は、Host権限境界を代替しない。アプリがローカルで動いていても悪意あるサイト経由のSSRF、認証情報窃取、権限昇格は起こり得る。

## 2. 認証・権限を「対象を選べること」と分ける

- **ユーザーによる対象選択**：サイト、検索エンジン、認証済みセッション、通信方式、件数、保存先、出力形式。標準部品は独自のサイト禁止リストをCoreに追加しない。
- **利用者環境の保護**：部品が実際に読むファイル・送る通信・利用する秘密・起動するプロセス・消費する資源。Hostは**許可されていない権限を構成によって勝手に追加しない**。
- **許可の単位**：principal（操作主体）／run／component implementation+version+digest／operation／対象scope／有効期限。別Run・別コンポーネントへ権限を暗黙伝播しない。
- **同意表示**：取得先URLの許可と「ローカルLANに接続」「既存Chrome profileを読む」「特定保存フォルダへ書く」「外部モデルへ送る」は独立。広い権限は範囲・期限・可能な漏洩先を明示して再確認する。ユーザーが明示許可してもアプリ自身の秘密や他Runの情報を譲渡してはならない。
- **権限実装**：Manifestの `permissions` を比較するだけで、OS-level isolationが成立したとは判断しない。Hostの判断に加え、WindowsとUbuntuの対応OSごとに実際のファイル/ネットワーク/プロセス隔離を確認する。未対応backendではsandbox済みと表示しない。[#83](https://github.com/tomiya7688/Open_scraping/issues/83)

## 3. Web通信・SSRF・DNS rebinding

[#82](https://github.com/tomiya7688/Open_scraping/issues/82) の実装条件。これは検索結果の初期ドメイン絞り込み（#24）とは別のセキュリティ境界。

1. scheme/authority/port/hostを規範的パーサで検証。ユーザー情報埋込、encoded host、IDNA、IPv4の省略・8進・16進風表記、IPv4-mapped IPv6、IPv6 zone識別子を見落とさない。DNS名だけを通してIPリテラルを逃がす実装にしない。
2. DNS A/AAAAを解決し、**実際に接続するIP** が権限対象かを確認。検証後に未検証の再DNSで別IPへつなぐTOCTOUを防止し、ソケットの接続先・TLS SNI・Hostヘッダー・証明書を一貫させる。複数IPの一部だけが危険な場合も未検証側を使用しない。
3. loopback、link-local、RFC1918/private、unique-local IPv6、metadata、OS固有の特権宛先を**既定のWeb取得権限**から外す。ユーザーがローカルネットワークを使う場合は明示したネットワーク/用途/有効期限だけを許可。localhost API tokenや他Runの秘密への権限付与ではない。
4. redirect、retry、proxy、browser prefetch、iframe、XHR/fetch、WebSocket、WebRTC、service worker、browser download等の実通信を同じ境界で再検査する。経路を観測・制御できない場合、対応済みと装わず `network_policy_unenforced` 等で止める。
5. 認証ヘッダー、Cookie、Client certificateを**許可したOrigin・認証scope** 以外へ転送しない。別hostへのredirect時に上流秘密をコピーしない。
6. `file:`、`data:`、`blob:` 等は通常の外部HTTPアクセスと同義でない。対応するComponentのcapabilityとセッション/生成元を確認し、任意ファイル読取権限へ変換しない。

検証：制御可能なHTTP/DNS test serverを用い、異常なURL表記、DNS rebind、302→127.0.0.1、private↔public redirect、IPv6、CNAMEと複数IP、proxy経由、他Originへの資格情報流出を再現。**サイト全体の取得可否を制限するためのURLフィルターではなく、PCや秘密を守る通信権限**である。

参考：[OWASP SSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)。

## 4. Worker sandboxと取得ファイル

- 初期案はworkerをHostが所有する別プロセスとして起動するが、単に別PIDにしただけではファイル、環境変数、ネットワークが隔離されたとは言えない。Windowsでの制限付き実行／Job Object等、Linuxでのnamespaces/seccomp等は**検証すべき実装候補**であり、この文書だけで採用済みとはしない。
- workerには必要な操作・ファイルroot・接続先・予算だけを与える。親の `process.env`、ホームフォルダ、SSH鍵、クラウド資格情報、アプリ自身のAPI tokenを渡さない。親プロセスの実権限が大きい環境ではHostの権限表だけで隔離を代用しない。
- 未信頼のHTML/画像/PDF/ZIP等はコードではなく**不透明な入力データ**。Scriptやマクロを勝手に実行しない。必要な解釈器は隔離された、形式と資源を限定した部品に置く。
- アーカイブは展開前・展開途中のバイト数、ファイル数、深さ、展開比、CPU/時間を監視。パストラバーサル、絶対path、symlink/hardlinkによるroot外書込み、重複ファイル名と衝突を拒否。取得量は爆発的な展開済みデータ量を含めて計算する。
- ファイル名は外部からのsuggestionとして扱い、保存先内の安全な名前へ変換。MIMEや拡張子だけで安全と認定しない。CSV式、HTML/Markdown描画、ZIP出力の各format固有の脆弱性を安全に表示・出力する一方、rawの観測値を破壊的に書き換えない。
- 制御不能なworker、memory/CPU/IO増大、disk fullは実行を停止／失敗として記録し、所有外プロセスを終了させない。隔離できないOSで「安全なsandbox実行」を選べるようにしない。

参考：[OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)。部品の真正性を検証しても、未知の脆弱性がなくなるわけではない。

## 5. 認証情報・来歴・ログと外部AI

- Cookie jar、access/refresh token、署名付きURL、profileの情報は**機密の参照**とし、取得結果やDataRefの公開メタデータに生値を埋め込まない。保存/出力は明示的な公開範囲に従い、閲覧・更新・削除の権限を分ける（#62、#26）。
- 認証付きページを別サイトへredirectした場合や、外部モデル/APIへ送る場合、送信先とデータ範囲に対するユーザー選択を別途確認。APIキーを提示するだけで全データ送信が許されたと解釈しない。
- ログにはevent ID、scope、許可／拒否理由コード、処理量、timestampを残す。生のtoken、Cookie、Password、queryに埋め込まれたsecret、個人情報、無加工のHTML/response bodyを既定ログに書かない。ログの件数／保持／アクセス制御を定義する。
- サイトのHTML、prompt、コメント等は、AIエージェントにとって**外部の引用データ**。Hostの権限変更、ツール呼び出し、ルール上書きの指示として実行しない。AI支援による抽出器は引用データとtrusted instructionsを分離する。
- 不具合報告、学習データ、telemetry、外部サービスへ自動送信しない。ユーザーが選んだscopeと保存期限だけ記録し、削除操作は共有本体参照を確認して完了を伝える。

参考：[OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)。

## 6. 人間の非常停止・配布の真正性

- **Arm状態が不完全**（フォーカス外Escまたは物理マウス監視不足、権限未付与、monitorが落ちた等）なら標準自動化runを開始しない。自動復旧で解除・再開しない。停止の発火は新規node/run/subcallより優先し、Hostの所有workerとmanaged browserのみ有限猶予後に終了。詳細は[#42](https://github.com/tomiya7688/Open_scraping/issues/42)。
- 監視が動作するという自己申告だけでは不十分。OS別の非前面、合成入力、GUI停止、複数run、worker hang、monitor crash、再開raceを試験する。許可済みのユーザー操作を奪わない。
- 新しい一般向け配布物は最終アーカイブ/実行ファイルのSHA-256と署名・provenance/attestationを検証できる必要がある。[Issue #78](https://github.com/tomiya7688/Open_scraping/issues/78) は**P0 Stop the line**。GitHubの[Artifact Attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations)等を利用できるが、署名済み≠実行時に安全、という区別を保つ。

## 7. 脅威ID・合否の対応

| ID | 再現する攻撃／失敗 | 拒否・検出する境界 | Issue |
| --- | --- | --- | --- |
| S01 | 偽Host／Origin、トークンなしのlocal API | API認証・Origin/Host | #11、#86 |
| S02 | 302によるlocalhost到達 | 実通信接続先のIP検証 | #82 |
| S03 | DNS rebind、IPv6、proxyによる保護回避 | Network adapter + OS egress | #82 |
| S04 | 認証sessionの別Origin流出 | Secret broker + network | #62、#82 |
| S05 | 外部workerが親の秘密/ファイルを読取 | OS sandbox + Host permission | #83 |
| S06 | ZIP slip、symlink、展開bomb | processing/store boundary | #83 |
| S07 | HTML内の命令をagentが実行 | 構造化データ／trusted指示分離 | #83、#86 |
| S08 | stdout/stderr、診断、エクスポートにsecretが混入 | log redaction + export scope | #83、#86 |
| S09 | 偽manifest・差替・未署名配布 | registry digest + attestation | #6、#78 |
| S10 | stop monitorがunarmedでも自動run開始 | OS watcher + Host run gate | #42 |
| S11 | 停止後に旧worker応答で復旧・再送 | generation / idempotency / owner | #10、#42 |
| S12 | 他RunのDataRef・保存場所を不正読取 | scoped access + store | #15、#26、#83 |
| S13 | 通信・記録・CPU・ディスク枯渇 | scheduler/backpressure/budgets | #9、#85 |
| S14 | 未署名ZIP/installerを公開 | CI release gate | #78 |
| S15 | CSV式／HTML等で利用者画面に動的実行 | export escaping / view sandbox | #27、#83 |
| S16 | 監視不能なbrowser通信経路を安全対応と誤表示 | capabilities + runtime deny | #16、#69、#82 |

**この表は脅威の列挙であって検証済み一覧ではない。** 受入基準と実証の区別は [acceptance.md](acceptance.md)。連動する実装課題：[#82](https://github.com/tomiya7688/Open_scraping/issues/82)、[#83](https://github.com/tomiya7688/Open_scraping/issues/83)、[#86](https://github.com/tomiya7688/Open_scraping/issues/86)。 
