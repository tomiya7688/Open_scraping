# ドキュメント目次

Open_scraping のドキュメントは、**利用者向け** と **開発者向け** を分離しています。各内容の正本を1か所に置き、旧 `docs/*.md` のURLは移動案内として維持します。

| 読者 | 入口 | 主な内容 |
| --- | --- | --- |
| **利用者** | [docs/user/README.md](user/README.md) | 今できること、始め方、制限、用語 |
| **開発者・共同開発者** | [docs/developer/README.md](developer/README.md) | 開発全体像、参加手順、設計、テスト、レビュー |

## 利用者向け

- [はじめに](user/getting-started.md) — 開発版のソース取得と検証
- [現在の機能・制限](user/capabilities.md) — 完成したアプリと計画の区別
- [用語集](user/glossary.md) — Flow、Component、DataRef の意味

## 開発者向け

- [開発ガイド](developer/development-guide.md) — 構成・責務・依存方向と変更対象
- [共同開発手順](developer/contributing.md) — Issue/PR、レビュー、権限とライセンス
- [検証ガイド](developer/testing.md) — CI・テスト・受入条件
- [ドキュメント運用](developer/documentation.md) — 書き分け・更新の基準
- [設計リファレンス一覧](developer/README.md) — contract、API、host、実行、非常停止、研究、ADR等

## 共有の機械可読サンプル

FlowConfig を説明する JSON 例は [docs/examples](examples/) に残します。静的検証対象の例であり、ブラウザやCLIが既に動作することを意味しません。

コードと開発状況の入口は [リポジトリ README](../README.md) を参照してください。
