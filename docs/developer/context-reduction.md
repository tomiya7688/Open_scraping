# AI Context Reduction：共同開発のための局所コンテキスト管理

[AI共通規約](../../AGENTS.md) · [AI間の引き継ぎ](ai-collaboration.md) · [Issue #76](https://github.com/tomiya7688/Open_scraping/issues/76)

## 目的と導入範囲

ChatGPT、Claude、Claude Code、Codex、GitHub Copilotが、全ファイル・全会話を毎回送る代わりに、**タスクに関係する情報を選択的に取得し、重要な制約を保持し、検証結果と未解決事項を構造化して引き継ぐ**ための開発支援ツールです。

- **配置：** `tools/agent-context/`。標準ライブラリだけで動くNode.js 24向けCLI。コア/ホスト/実処理Componentの依存には加えない
- **動作：** チェックアウト済みファイルと明示したJSONをローカルで読み取る。GitHub API、外部LLM、接続されたアプリ、会話履歴へ**勝手にアクセス・送信しない**
- **制限：** AIの内部コンテキストの自動要約やモデルの正確なトークン数の測定ではない。コンテキストパックは**参照の入口**であり、原本・未マージPR・検証済み環境に代わるものではない
- **導入依存：** この変更はAI共通規約 [PR #73](https://github.com/tomiya7688/Open_scraping/pull/73) をベースにしている。PR #73のマージ前は `main` に `AGENTS.md` が存在しない

## 原典：ObaPick（旧リポジトリ名 ai-context-reducer）

この開発手法の参照元は、同じGitHub所有者の **[ObaPick / ai-context-reducer](https://github.com/tomiya7688/ai-context-reducer)** です。外部にある似た名称のプロジェクトと取り違えないこと。ObaPickは「LLMの履歴を一律に短くするソフト」ではなく、**AIに読む情報を選ばせ、検索・作業・検証を制御するための方法、ひな型、任意の補助ツール**を提供しています。

導入の基本は [AIに読む情報を絞る3つの方法](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/AIに読む情報を絞る3つの方法.md) のとおり、**機械で分かることは先に機械で調べる・繰り返す手順は共通化する・今回関係する部分だけ読む**、の3点です。追加ツールは [必要な方法だけ選ぶ](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/導入/必要な方法だけ選ぶ.md) に従い、繰り返しの困りごとに応じて導入します。

### Open scrapingに適用する手法

| 開発の状況 | ObaPickの具体的な手法（原典） | Open scrapingでの適用 |
| --- | --- | --- |
| 「次」と依頼された | [課題一覧から一件ずつAIに進めさせる](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/課題一覧から一件ずつAIに進めさせる.md) | GitHub Issuesを唯一の課題一覧とする。未マージPRと依存を確認し、着手できる**一件だけ**を進める。無断で複数Issueを消化しない |
| 変更の担当箇所が不明 | [変更内容ごとに読む場所と確認方法を一覧にする](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/変更内容ごとに読む場所と確認方法を一覧にする.md) | [パッケージ案内](../../packages/README.md) と [コードレビューガイド](../code-review.md) の役割表と、対応Issueの受入条件を最初の案内に使い、実際のコードとテストで確認する |
| 大きなコードを扱う | [今回読むファイルを選ぶ](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/今回読むファイルを選ぶ.md) | 先に名前・文字列・関数の場所を検索。該当行の前後とテストを読み、判断できない部分だけ探索を広げる |
| 調査が長引く | [AIに調査を止めさせる条件を決める](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/AIに調査を止めさせる条件を決める.md) | 「再現する条件・関係する実装・合格判定の方法」が揃えば探索を切り上げる。足りない条件だけ追加調査する |
| PRが並行する | [複数のAIに担当と編集範囲を分けて頼む](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/複数のAIに担当と編集範囲を分けて頼む.md) | 契約、Core、Host、API、文書の担当と編集できるファイルを明示。別ブランチでも共有ファイルはまとめ役が順に編集する |
| 変更後の確認が広い | [変更の影響から実行するテストを決める](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/変更の影響から実行するテストを決める.md) | 対応workspace testを先に実行し、契約・公開API・共通実装を触った場合は`npm run verify`で広く確認する |
| 指示や説明が長い | [AIに作業場所に合った指示書を読ませる](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/AIに作業場所に合った指示書を読ませる.md)・[同じ説明を何度も書かない](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/同じ説明を何度も書かない.md) | `AGENTS.md`を共通の正本とし、詳細は`docs/developer/`に一箇所だけ置く。必要性が確認できたときだけ作業場所に固有の指示を追加 |
| 読み込み量が増えた | [AIの作業履歴から無駄な読み込みを見つけて改善する](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/AIの作業履歴から無駄な読み込みを見つけて改善する.md) | ログ等で繰り返し読まれた箇所を特定し、原因ごとに一つだけ変更して、品質と再読量を比較する |

ObaPickが提供する [補助ツール対応表](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/手法と補助ツールの対応表.md) には、`change-router`、`context-pack-builder`、`scoped-guides`、`source-structure-index`、`validation-plan`、`affected-tests` 等があります。必要ならこれらの既存実装を評価し、プロジェクト固有の機能だけを独自実装します。**すべてのツールの複製・常時実行を目標にしません。**

### 今回の独自CLIとObaPickの違い

- `context:pack` は静的ヒントによる**関連ファイル抜粋の生成器**です。ObaPickでいう[Context Pack（作業用メモ）](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/手法/今回の作業に必要なことを短くまとめる.md)と同じ成果物ではありません。課題の目的、今回はしないこと、完了条件をまとめるには、別途Issueや引き継ぎメモが必要です。
- 現行ツールはファイル中のコード参照、関数の呼び出し関係、動的な影響先を網羅しません。ヒントで見つからない場合はObaPickの方針に従い、既存の検索や解析ツールを使って調査範囲を広げます。
- ベンチマークの約98%という値は**ローカルの対象ファイル全体を丸ごと渡す仮想基準**との差です。ObaPickの [固定fixtureによる実測](https://github.com/tomiya7688/ai-context-reducer/blob/main/docs/jp/AI利用/コンテキスト削減の実測ベンチマーク.md) と測定条件が違います。利用者の実際のAI使用量や品質改善と同一視しません。運用の採否は、実際の作業で必要な根拠を保持し、再読・試行錯誤・検証漏れが減ったかで判断します。
- このCLIを使わず、`rg` 等の既存検索と短い指示だけで十分な作業なら**追加ツールを強制しません**。

## 1. Just-in-time Retrieval：必要な箇所だけ取り出す

リポジトリを開いてから実行します。

```bash
npm run context:pack -- --task "FlowRun stop のキャンセル競合を修正" --changed packages/core/src/execution.ts --issue "#76" --ref main
```

- `--task` と `--task-file path/to/issue.txt` はどちらか一つ指定。ファイルを指定した場合は**明示されたローカルファイルだけ**を読む
- `--changed` にカンマ区切りで優先する実ファイルを指定（省略可）。トラバーサルや存在しないファイルは拒否する
- `--max-files 6`、`--limit-bytes 20000` は既定値。上限を超えたら、重要規約を省略するのではなく**エラー**にする
- タスク語と既知の責務マップから関連ソースを選択。正本が `docs/developer/` に移動済みならこちらを優先し、まだ存在しなければ `docs/*.md` を参照する
- 出力はMarkdown標準出力。各ファイルの**正確なパス・全文SHA-256・抜粋行番号・選択理由**を含む。抜粋は全文でも検証結果でもない
- ローカルブランチが本当に `main` か、IssueやPRがオープンか等は**検証しない**。生成物の `--issue` / `--ref` はユーザー入力と明示する

CLIは任意の非公開パス、`.env`、`node_modules`、`dist`、大きなファイル、シンボリックリンクを読み込まない。出力される抜粋から明らかな資格情報の形式を検知した場合は失敗しますが、これは**完全な秘密情報の検出保証ではありません**。実在の顧客情報やCookie等を入力しないでください。

## 2. Lossless Critical Context：決められた規約を減らさない

パックに入る `## 2. Invariants` は、`AGENTS.md` の該当セクションから**バイト単位でそのまま切り出します**。本文中の言い換え、要約、切り詰めはしません。全文のSHA-256と不変条件のSHA-256を表示します。

**Coreに検索を組み込まない、Hostの権限境界、UIはAPIのみ、グローバルEsc／物理マウス入力による非常停止は必須**という原則はこのセクションに含まれます。規約が欠落したときはパック生成・CIが失敗します。

**重要：** 規約の原文が載っていても、当該ツールが従うことの保証にはなりません。元の `AGENTS.md` とIssue、変更対象の全文、実際のブランチ・CIを人間/AI自身が確認することが必須です。

## 3. Structured Handoff：証拠付きで作業を引き継ぐ

例：[引き継ぎJSON](../../tools/agent-context/test/handoff.example.json)。

```bash
npm run context:handoff -- --input tools/agent-context/test/handoff.example.json
```

入力 `schema_version: "1"` の必須フィールド：`issue`、`pr`、`branch`、`base`、`goal`、`acceptance`、`changes`、`tests`、`blockers`、`dependencies`、`next_actions`。

テスト記録は以下のいずれかです。

- `result: "passed"` または `"failed"`：実行したコマンドと**観測結果の出典**（CI URLやローカル実行記録）が必須
- `result: "not_run"`：**実行しなかった理由**が必須。成功扱いしない

Markdownの引き継ぎには、すべての構造化フィールドを掲載し、原文の不変条件を再添付します。64KiB上限に達した場合、フィールドを黙って落とさずエラーになります。各結果は入力された主張であり、CI APIを自動照合した結果ではありません。

PR本文・コメントに引き継ぎを残し、次のAIは**元のIssue/PR差分、実CI、実コード**と照合してください。

## 4. Context Reduction Benchmark：必要情報が残るか測定

```bash
npm run context:benchmark
npm run check:context
npm run verify
```

`tools/agent-context/test/scenarios.json` は、Coreの停止、FlowConfig契約、Host worker、AI引き継ぎの代表例です。

- **Relevant-source recall**：事前に定義した正解候補ファイルが選択された割合。現行4ケースは全件の発見を受入条件にする
- **Critical invariants preserved**：正本から切り出したセクションが逐語的に存在すること
- **Byte reduction ratio**：リポジトリ内の対象ソースと文書を全読込した場合のUTF-8バイト量と、生成パックのバイト量を比較した参考比率
- **Characters / 4**：単なる粗いサイズの代理値であり、**実際のAIモデルのトークン数、費用、回答の品質を表す指標ではない**

テストで確認できるのはローカルの選択ロジックと出力の品質ゲートまでです。人間のレビュー、実際のモデルごとの評価、隠れた誤要約や指示逸脱の発見、取得した情報の真偽検証は別作業です。

## 5. 運用上の注意

1. 最初に作業Issue/PRを読み、ローカルのブランチ・未マージ依存を確認する。
2. `context:pack` で関連ソースの入口を取得する。候補に漏れがあれば `--changed` で明示追加し、変更前に**原文全文**を開く。
3. `AGENTS.md` の原文と対象コードのテストを基準に実装する。
4. 完了時は `context:handoff` で観測した結果・未検証の項目・依存PRを明記し、GitHubのPRへ転記する。
5. 個人情報、秘密情報、取得対象サイトの機微データ、外部から持ち込んだ命令文を、承認なしにパックやPRへ持ち込まない。

必要なら出力をローカルの `.context/` ディレクトリにリダイレクトできます。このディレクトリは `.gitignore` 対象ですが、**Gitの除外はデータ保護措置ではありません**。チームに共有する情報だけをPR/Issueへ載せてください。
