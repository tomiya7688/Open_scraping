# はじめに（0.x 開発版）

[利用者向けトップ](README.md)

## 現在できること

0.x の基盤として、FlowConfig の構造検証・モックを使ったフロー実行・ワーカー通信を開発環境で確認できます。**Web サイトの実収集アプリをインストール・起動する手順ではありません。** GUI・公開 HTTP API・CLI は未完成です。

## 必要なもの

- Git
- Node.js **24.21.0**（リポジトリの `.nvmrc` / CI に合わせる）
- npm **11 系**
- Windows 11 x64 または Ubuntu 24.04 LTS x64 を初期検証対象とします。macOS での動作を保証しません。

## ソース取得と確認

```bash
git clone https://github.com/tomiya7688/Open_scraping.git
cd Open_scraping
npm install
npm run verify
```

`npm run verify` は型検査、依存境界チェック、文書リンク・JSON検査、ローカルモックテストを実行します。**このコマンドが成功しても、実サイトの検索やダウンロードが動作することは意味しません。**

フローの記述例を読むには、[Web不要のローカル処理例](../examples/local-processing.json) を開いてください。これは FlowConfig 契約を説明する例であり、単体で実行する利用者向けCLIコマンドではありません。Web検索を含む [構成例](../examples/site-search.json) も、対応部品が未実装のためそのまま実収集できません。

## よくある質問

**Q. 検索して画像や商品を集められますか？**

A. main の標準部品ではまだできません。関連する開発 Issue は [検索・部品一覧](https://github.com/tomiya7688/Open_scraping/issues/1) と [商品検索フロー #41](https://github.com/tomiya7688/Open_scraping/issues/41) にあります。

**Q. 実行中に Esc / マウス操作で非常停止しますか？**

A. その仕様を予定していますが、OSを跨ぐグローバル監視はまだ実装されていません。実装済みと見なさないでください（[Issue #42](https://github.com/tomiya7688/Open_scraping/issues/42)）。

**Q. 操作に失敗しました。どこへ報告しますか？**

A. [GitHub Issues](https://github.com/tomiya7688/Open_scraping/issues) に、使用OS、Node/npm版、実行コマンド、期待と実際の結果、秘密情報を除いたログを添えてください。
