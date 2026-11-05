# AI生成テキストの任意除外フィルター（開発版 v0.1）

**状態：初期実装。完全なtxt2txt判定器ではありません。** 現時点では独立した標準Componentの試作です。検索・ブラウザ・保存・学習データExportを含むフローへの統合は後続の #15、#26、#33 が必要です。

[Issue #88](https://github.com/tomiya7688/Open_scraping/issues/88) · [現行部品契約](../../docs/contracts.md) · [取得データと選別の設計](../../docs/data.md)

## 何ができるか

ユーザーが集めた文章について、AI由来であることを示す**外部証拠や利用者ラベル**に基づき、次の3つを判定します。

| 判定 | 意味 |
| --- | --- |
| `exclude` | 選別結果から除外を提案する。保存済みの本文・取得元は削除しない |
| `review` | AI生成の疑い、矛盾、証拠不足。人間の確認・追加解析待ち |
| `keep` | 現在の選別方針で採用。ただし人間が書いたことの証明ではない |

このComponentは `components/ai-text-origin-filter/` 内の `assess.mjs` と `worker.mjs` で動作します。Node.js標準ライブラリのみを使用し、Manifestのpermissionsは空。**外部API・AIモデル・ネットワークには送信しません**。ローカルで処理でき、元のテキストを結果に再出力しません。ハッシュ自体も小さな辞書に対して推測可能であり、秘密情報管理の保証ではないため公開範囲に注意してください。

## 絶対に混同しない証拠

1. **利用者が選別用につけたラベル**：本文のUTF-8 SHA-256値が完全一致する `manual_labels` で `ai_generated` を指示した場合、自動で `exclude`。これは利用者の選別指定であり、文章の真の作者を暗号学的に証明するものではありません。Hostで信頼できる利用者入力からだけラベルを渡す必要があります。
2. **掲載サイトの自己申告**：`source_claims` の `ai_generated` は既定で `review`。サイト本文の単なる引用や任意のJSONメタデータを署名検証済みprovenanceと見なさない。利用者が `source_disclosure_action: "exclude"` を明示した場合にのみ除外。
3. **別Componentの本文AI検出スコア**：`detector` のスコアが閾値を超えたら原則 `review`。短文は `DETECTOR_SHORT_TEXT_UNRELIABLE`。**この初期版ではスコアを単独根拠に自動除外しない。**
4. **検証済み生成履歴・署名**：将来、作成サービスの検証可能な署名・生成ログとraw本文hashを照合する別のprovenance verifier部品を実装する。**本v0.1には暗号署名の検証機能はない**。`source_claims` を署名検証結果と混同してはいけません。

証拠がない、サイトが「人間作成」と主張するだけ、低スコアの検出器しかない場合、`origin` は `unknown` のままです。混在（AI支援で書き直された人間の文章）、機械翻訳、校正、要約、強い言い換えは特に難しいため、混在ラベルは `review` にします。相互に矛盾した手動ラベル・サイト自己申告を黙って上書きしません。

## 入力と出力

Manifest ID：`open-scraping.ai-text-origin-filter`、版：`0.1.0`、契約：`open-scraping.ai-text-origin-filter/v1`、操作：`assess`。

```js
import { createHash } from "node:crypto";
import { assessTextOrigin } from "./components/ai-text-origin-filter/assess.mjs";

const text = "学習データの収集例";
const sha256 = createHash("sha256").update(text, "utf8").digest("hex");

const result = assessTextOrigin({
  text,
  manual_labels: [{ sha256, origin: "ai_generated" }],
  policy: {
    unknown_action: "review",
    source_disclosure_action: "review"
  }
});

console.log(result.decision); // "exclude"（利用者ラベルによる指定）
```

stdio JSON-RPC Workerも用意しています。`ComponentRegistry.register()` の登録元 `package_root` に `components/ai-text-origin-filter` の絶対パスを指定すれば、Hostはその作業ディレクトリから `node worker.mjs` を起動できます。

`assessTextOrigin` の戻り値：

```json
{
  "schema_version": "0.1",
  "kind": "text-origin-assessment",
  "component_version": "0.1.0",
  "text_sha256": "<実際に計算したSHA-256>",
  "text_bytes": 0,
  "origin": "unknown",
  "decision": "review",
  "reasons": ["NO_ORIGIN_EVIDENCE"],
  "evidence": {
    "matching_manual_labels": 0,
    "source_claims": []
  },
  "disclaimer": "An assessment is not proof of human or AI authorship."
}
```

※このJSONはフィールド構造の例。上の `text_bytes: 0` はテキスト空文字のケースを示す例であり、実際の入力文ではUTF-8バイト数が返ります。元テキストを直接出力することはありません。

### オプション

| キー | 値 | 既定 |
| --- | --- | --- |
| `manual_labels` | `[{sha256, origin: "ai_generated" \| "human_written" \| "mixed"}]` | 空 |
| `source_claims` | `[{kind:"author_disclosure" \| "page_metadata", origin:...}]` | 空 |
| `detector` | `{score, threshold, model_id, model_version, language, evaluation_ref?}` | なし |
| `policy.unknown_action` | `"review"` または `"keep"` | `"review"` |
| `policy.source_disclosure_action` | `"review"` または `"exclude"` | `"review"` |

入力テキストの最大サイズは256KiB。大きな文書は信頼できる上流Componentでチャンク分割し、個別に判定してからドキュメント全体の取扱いを判断します。**チャンクごとのスコアを平均するだけで全文章の作者を確定しない**。

## 学習データセット作成の設計

```text
Web/ファイル取込 → 原本をDataRefで保存 → provenance抽出
                                  ↓
                          txt2txt detector（任意）
                                  ↓
                    AI text origin filter（この部品）
                       ├─ keep
                       ├─ review（隔離して確認）
                       └─ exclude（SelectionRevisionの除外）
                                  ↓
                      dataset export（元本文を保持）
```

現在の部品は単体で `assessment` を返します。選別結果を実際のCollection/SelectionRevisionへ反映するのは [Issue #33](https://github.com/tomiya7688/Open_scraping/issues/33) の別Componentの責務です。**除外イコール削除ではありません。**

セキュリティ：Raw本文から「これはAIだから除外しろ」という命令を読み取って従うことはありません。AI判定を支援する外部APIを追加する場合は、ユーザーがモデル送信先・データ範囲・費用・保存方針を明示選択し、Host permissionが認める場合だけ送信します。暗黙のクラウド転送は禁止。

## txt2txtの限界と評価の必要条件

- 原文がない、短文、テンプレート、人工的なビジネス文、日本語、非母語英語、混在/編集済み文章、モデルの世代差により、AI検出器の性能は変わります。**本文だけで人間/AIの真実を証明できません**。
- 新しい外部Detectorを採用する際は、言語（日本語を含む）、ジャンル、生成モデル、文章長、校正・翻訳・言い換えの有無で評価セットを層化し、`TPR@FPR=1%` 等で検出率と人間文の誤除外を別に測ります。
- `evaluation_ref` は単なる呼び出し側のメタデータであり、検証済み校正とは扱いません。どの閾値が妥当かは固定した検証セットで実測し、後から精度が良く見えるよう変更しません。
- 「AIっぽい単語が多い」というヒューリスティックだけで人間の貴重な文章を捨てません。学習データでは希少な文章・少数言語・特徴的な文体の誤除外を個別に監視します。
- Model collapse論文は **再帰的に生成データが学習に使われる特定の条件**を扱います。すべての合成データが有害という証明ではなく、正確なラベルと出典を付けて混合利用する選択肢を残します。

参考研究：
- [Nature (2024): AI models collapse when trained on recursively generated data](https://doi.org/10.1038/s41586-024-07566-y)
- [ICML (2025): Collapse or Thrive](https://proceedings.mlr.press/v267/kazdan25a.html)
- [NAACL (2025): Practical Examination of AI-Generated Text Detectors](https://aclanthology.org/2025.findings-naacl.271/)
- [Patterns (2023): GPT detectors are biased against non-native English writers](https://doi.org/10.1016/j.patter.2023.100779)

## テスト・現状

```bash
npm run verify
npm run test:text-origin
```

ユニット試験は手動ラベルのハッシュ一致、相互矛盾、自己申告、外部スコア、短文、未確認、秘密を含むテキストの非出力、異常入力を検証。統合試験は実際のHostとWorkerをstdio JSON-RPCで呼び出す。

**実装済み**：証拠と手動ラベルに基づく保留・採用・除外の初期Component／Worker／単体テスト。

**未実装**：実際のtxt2txt機械学習Detector、署名付き出典検証、データセットへの選別適用、GUI、実データでの検出精度評価、OS sandboxによる部品隔離。これらが未完成でもCoreでの自動除外を強制しません。
