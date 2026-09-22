# 参考資料

[設計書一覧](README.md)

一次資料の参照先。特定の採用版・実装済み機能・検索成功を保証するものではない。S1・S5・S12・S13は今回の改訂時（2026-09-22）に再確認し、他は既存の設計上の参照先を維持した。採用時に実際に使用する版と利用条件を確認する。

<a id="s1"></a>
## S1. ブラウザ制御の候補

[Browsers — Playwright](https://playwright.dev/docs/browsers)

対応ブラウザ版の管理と、Firefoxが専用パッチを使うことの参考。依存するのはブラウザ部品であり、コアではない。

<a id="s2"></a>
## S2. 再読み込み

[Page.reload — Playwright](https://playwright.dev/docs/api/class-page#page-reload)

ページ操作・完了条件・タイムアウトの参考。ジョブ再開や保存整合性までこの操作単独で保証するものではない。

<a id="s3"></a>
## S3. ブラウザ終了・接続

[Browser — Playwright](https://playwright.dev/docs/api/class-browser)

ブラウザ部品が管理する終了・切断・接続の参考。通常利用の環境と本体が所有する環境を分ける。

<a id="s4"></a>
## S4. 通信制御

[Network — Playwright](https://playwright.dev/docs/network)

要求監視・ルーティングと制約。保存間隔と付随通信制御を区別するための資料。

<a id="s5"></a>
## S5. 検索部品の基盤候補

[Search API — SearXNG](https://docs.searxng.org/dev/search_api.html)

共通契約へ接続する検索API候補。出力形式はインスタンス設定にも依存する。SearXNGをコアや全配布構成の必須依存にしない。

<a id="s6"></a>
## S6. 待機指定

[RFC 9110, Section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)

Retry-Afterの秒数・HTTP日付。通信部品が共通の待機時刻に変換する設計の参考。

<a id="s7"></a>
## S7. 過剰な要求への応答

[RFC 6585, Section 4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4)

HTTP 429とRetry-After。サイトごとに要求を数える単位が同一とは仮定しない。

<a id="s8"></a>
## S8. APIの記述

[OpenAPI Specification](https://spec.openapis.org/oas/latest.html)

HTTP APIの形式候補。現在の設計書のAPI表は正式なOpenAPI定義ではない。

<a id="s9"></a>
## S9. 構造検証

[JSON Schema: object](https://json-schema.org/understanding-json-schema/reference/object)

設定・マニフェスト・入出力の検証候補。FlowConfigの値参照とJSON Schemaの参照を区別する。

<a id="s10"></a>
## S10. 保存方式候補

[Appropriate Uses For SQLite](https://www.sqlite.org/whentouse.html)

ローカル保存への適用範囲・並行性。データセット保存部品とコアの実行状態ストアは責務を分離する。

<a id="s11"></a>
## S11. 来歴

[PROV-Overview — W3C](https://www.w3.org/TR/prov-overview/)

データと生成・加工・関与主体の来歴。完全準拠するかは未決定。

<a id="s12"></a>
## S12. OSSブラウザ

[Chromium](https://www.chromium.org/Home/)

内製ブラウザ部品の基盤候補。既存エンジンをAPIで操作する実装を検討する。

<a id="s13"></a>
## S13. ライセンスの確認資料

[MPL 2.0 FAQ — Mozilla](https://www.mozilla.org/en-US/MPL/2.0/FAQ/)

利用・改変・配布を区別して確認する資料。商用／非商用だけで、すべての依存コードの条件を一括して決めない。本体ライセンスの選定や具体的な再配布許諾をこの文書で行うものではない。
