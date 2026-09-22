# 参考資料

[設計書一覧](README.md)

確認日：2026-09-22。外部技術の性質について参照した一次資料を示す。これらの参照は、特定の実装・バージョン・サービスの採用や、検索成功の保証を意味しない。実装時には利用する版と提供状況を再確認する。

<a id="s1"></a>
## S1. Playwrightのブラウザ対応

[Browsers — Playwright](https://playwright.dev/docs/browsers)

Chromium・Firefox等の管理対象ブラウザと、通常配布版Firefoxとの違いを確認するための資料。初期ブラウザ接続部の候補であり、本プロジェクトでは検索成功の動作保証をしない。

<a id="s2"></a>
## S2. ページの再読み込み

[Page.reload — Playwright](https://playwright.dev/docs/api/class-page#page-reload)

ページ再読み込み、タイムアウト、完了条件のAPI。設計書のジョブ保存・再開までをこのAPI単独で実現できるという意味ではない。

<a id="s3"></a>
## S3. ブラウザの終了・接続

[Browser — Playwright](https://playwright.dev/docs/api/class-browser)

起動したブラウザと接続したブラウザの終了動作、コンテキスト終了、切断イベント等。管理ブラウザと利用者の通常ブラウザを区別する際の参考。

<a id="s4"></a>
## S4. ブラウザの通信

[Network — Playwright](https://playwright.dev/docs/network)

要求監視・ルーティングと、その制約の確認資料。ファイル保存間隔とブラウザのすべての通信の制御を区別する。

<a id="s5"></a>
## S5. 追加検索接続先の候補

[Search API — SearXNG](https://docs.searxng.org/dev/search_api.html)

検索APIの仕様。出力形式等はインスタンスの設定にも依存する。SearXNGは候補アダプターであり、必須依存ではない。

<a id="s6"></a>
## S6. Retry-After

[RFC 9110, Section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)

待機指定の秒数・HTTP日付の形式を確認する資料。本体の間隔設定・復旧操作と、相手側から指定された待機を併用する設計の参考。

<a id="s7"></a>
## S7. 429応答

[RFC 6585, Section 4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)

Too Many RequestsとRetry-Afterの関係を確認する資料。すべてのサイトが同じ単位でアクセス回数を数えるとは仮定しない。

<a id="s8"></a>
## S8. 操作APIの記述

[OpenAPI Specification](https://spec.openapis.org/oas/latest.html)

HTTP APIを記述する仕様。採用する版は実装時に固定する。本リポジトリのAPI一覧は現時点で草案であり、OpenAPI形式の実装済み定義ではない。

<a id="s9"></a>
## S9. 設定・入出力の検証

[JSON Schema: object](https://json-schema.org/understanding-json-schema/reference/object)

構造化設定とプラグインの入出力検証に用いる候補。設定例は説明用JSONであり、正式な検証スキーマの公開を代替しない。

<a id="s10"></a>
## S10. ローカルの管理情報保存

[Appropriate Uses For SQLite](https://www.sqlite.org/whentouse.html)

ローカルアプリ等への適用範囲と、書き込み並行性に関する資料。SQLite＋ファイル保存は実装候補であり、採用は未確定。

<a id="s11"></a>
## S11. 出典・加工履歴

[PROV-Overview — W3C](https://www.w3.org/TR/prov-overview/)

データと生成・加工の過程の来歴を表す考え方の参考。本設計でPROV全体への準拠を要求するものではない。
