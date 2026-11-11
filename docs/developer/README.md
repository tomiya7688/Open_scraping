# 開発者向けドキュメント

Open_scraping の**共同開発者・コードレビュー担当者・独自部品の作者**のための入口です。完成版の操作案内を探す場合は [利用者向け](../user/README.md) へ進んでください。

## まず読む順番

| 目的 | 文書 |
| --- | --- |
| 開発全体を理解し、担当領域を選ぶ | [開発ガイド（全体像）](development-guide.md) |
| Issue / PR を使って開発へ参加する | [コントリビューション手順](contributing.md) |
| テスト・CI・受入条件を確認する | [検証ガイド](testing.md) |
| 文書の置き方・更新規則を確認する | [ドキュメント運用規則](documentation.md) |
| コードを責務別に読む | [コードレビューガイド](code-review.md) |

**初参加なら** `development-guide.md` → `contributing.md` → 担当パッケージの README → 関連 Issue の順に進めます。全設計書の通読は必要ありません。

## 仕様・設計リファレンス

| テーマ | 正本 |
| --- | --- |
| 基本設計・コアと外部部品の境界 | [design.md](design.md) |
| 契約 / JSON Schema / FlowConfig / DataRef | [contracts.md](contracts.md) |
| 公開 API の計画 | [api.md](api.md) |
| 部品・レジストリ・標準配布 | [components.md](components.md) |
| stdio worker と host | [component-host.md](component-host.md) |
| stop・再開・scheduler | [runtime.md](runtime.md) |
| OS グローバル非常停止（必須仕様） | [emergency-stop.md](emergency-stop.md) |
| データ保存・出典・フィルター | [data.md](data.md) |
| 派生構成と自作部品 | [customization.md](customization.md) |
| ロードマップと受入テスト ID | [roadmap.md](roadmap.md) |
| Web データ抽出手法の比較 | [research/web-extraction-methods.md](research/web-extraction-methods.md) |
| 技術判断 ADR | [adr/0001-initial-technology-stack.md](adr/0001-initial-technology-stack.md) |
| 外部資料 | [references.md](references.md) |

契約の説明用 JSON は従来の [docs/examples](../examples/) に残し、静的検証からも参照します。以前の `docs/*.md` リンクには、新しい正本への案内を残しています。

> 設計ドキュメントには将来の仕様も含まれます。**設計済み・Issue作成済み・PR作成済み・mainで動作確認済み**は異なる状態です。現行機能の説明には [利用者向け機能一覧](../user/capabilities.md) を使用してください。
