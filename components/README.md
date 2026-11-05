# Components

交換可能な実処理部品を置く領域です。

標準同梱部品も第三者部品も、同じ manifest / contract / host protocol を使います。
core からこのディレクトリを直接 import しません。

## 学習データ向けの任意部品（開発版）

- [AIテキスト出典評価・除外フィルター](ai-text-origin-filter/README.md)：原文ハッシュに一致する利用者ラベル、サイト自己申告、別の検出器スコアを分けて `keep/review/exclude` を提案。**テキスト単独の確定検出器ではない**。Hostワーカーと単体・統合テストを提供。選別統合と実機sandboxは未実装。
