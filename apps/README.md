# apps/ — UI / CLI entry points

現時点では両方とも **stub** です。コードレビューで実処理を探す場所ではありません。

| app | 状態 | 将来の責務 |
| --- | --- | --- |
| [cli](cli/) | stub | `@open-scraping/api-client` 経由で公開APIを呼ぶ |
| [gui](gui/) | stub | `@open-scraping/api-client` 経由で公開APIを呼ぶ |

## 境界

appsに次の実装を置かない方針です。

- browser SDK
- search implementation
- downloader
- DB
- model
- filter / selection logic
- component workerの直接spawn

実処理はcomponent、実行はcore/host、UIはAPI呼び出しだけにします。

レビュー入口：[../docs/code-review.md](../docs/code-review.md)
