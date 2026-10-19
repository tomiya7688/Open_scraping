# Webデータ抽出の既存研究・手法をどう使うか

改訂日：2026-10-07

Open_scrapingでは、自然言語モデルやブラウザ自動化だけに依存せず、Webデータ抽出で蓄積されてきた既存研究を交換可能な `data.process` / `candidate.filter` / `search.provider` 等の部品として利用する。

**コアへアルゴリズムを組み込まない。** どの抽出器を使うか、どの順番で使うか、複数結果をどう統合するかはFlowConfigと外部部品で表現する。

## 1. 基本方針：安い・確実な方法から段階的に使う

推奨する標準フローは次のcascade。

```text
取得済みページ
  │
  ├─ 1. 埋め込み構造化データ
  │      JSON-LD / Microdata / RDFa / Microformats
  │
  ├─ 2. HTMLの明示構造
  │      table / list / semantic HTML / repeated records
  │
  ├─ 3. DOM構造ベース
  │      wrapper induction / tree matching / partial tree alignment
  │
  ├─ 4. 軽量本文・boilerplate抽出
  │      link density / tag ratio / block features
  │
  ├─ 5. 学習型DOM抽出
  │      SimpDOM / MarkupLM / DOM-LM 系
  │
  └─ 6. 視覚・マルチモーダル抽出
         VIPS / CoVA / MUSTIE 系
```

先に軽い方法で十分な結果が得られれば、重いモデルは呼ばない。複数の方法を同時に実行する構成も可能にする。

各抽出器は「採用済みの真実」ではなく、**候補値 + 根拠 + 元DOM/URL + 使用手法 + confidence/diagnostic** を返す。競合する結果の採否は別の融合・選別部品が行う。

## 2. 埋め込み構造化データを最優先する

JSON-LD、Microdata、RDFa、Microformatsを最初に読む。

Web Data CommonsはCommon Crawlからこれらを大規模抽出しており、October 2024 corpusでは約24億HTMLページのうち約12.5億ページ（51.25%）でstructured dataを検出している。

商品、Offer、Review、JobPosting、Event等は特に有用。DOMを推測して価格を探す前に、schema.org/ProductやOfferがあれば候補として使う。

### 実装方針

`data.process/v1` の部品として以下を分離可能にする。

- JSON-LD extractor
- Microdata extractor
- RDFa extractor
- Microformats extractor
- schema.org normalizer

DOM表示値とstructured dataが食い違う場合は片方を黙って捨てず、両方を出典付きで残す。

参考：
- Web Data Commons Structured Data: https://webdatacommons.org/structureddata/
- WDC Extraction Framework: https://www.webdatacommons.org/framework/index.html

## 3. 一覧ページ：繰り返しレコード検出

商品一覧、検索結果、求人一覧等では、同型のDOM部分木が繰り返される。

### MDR

Liu, Grossman, Zhai (KDD 2003) の Mining Data Records in Web Pages は、ページ内の規則的なdata recordsを自動発見する問題を扱う。

Open_scrapingでは「カード一覧の境界候補を見つける軽量部品」の設計参考にする。

### DEPTA / Partial Tree Alignment

Zhai & Liu (WWW 2005) は、data recordsを見つけた後にDOM treeをpartial alignmentしてfieldを揃える。確信できない要素を無理に揃えない考え方が重要。

商品カードごとに価格、タイトル、リンク、画像等のDOM位置が微妙に違う場合に使える。

参考：
- https://doi.org/10.1145/956750.956826
- https://doi.org/10.1145/1060745.1060761

## 4. 複数ページからwrapperを推定する

### RoadRunner

Crescenzi, Mecca, Merialdo (VLDB 2001) は、同じtemplate由来の複数HTMLページの共通部分と差分からwrapperを自動生成する。

Open_scrapingでは：
- 同一サイトの複数商品ページ
- 同一カテゴリの複数記事
- 一覧→詳細で得られた複数サンプル

から「このsite/templateのfield候補」を作る部品の参考にする。

wrapperは保存可能だが、永続的に正しいとは扱わない。template変更時には再学習・比較が必要。

参考：
- https://www.vldb.org/conf/2001/P109.pdf
- https://iris.unibas.it/handle/11563/9626

## 5. 壊れにくいwrapper / selector

単一XPath/CSS selectorだけに依存するとサイト変更で壊れる。

既存研究ではtree edit distanceやDOM tree similarityを使ってwrapper maintenanceを行う手法がある。例えばminimum cost script edit modelではinsert/delete/substituteを考慮して構造変化後の対応要素を探す。

Open_scrapingではselectorを1本だけ保存せず、以下を候補fingerprintとして持つ設計を検討する。

- tag / attributes
- stable class/id token
- relative DOM path
- ancestor/descendant context
- sibling pattern
- nearby label text
- repeated-record内のrelative position
- visual box relation（利用可能な場合）

参考：
- Robust Web Extraction Based on Minimum Cost Script Edit Model, 2012
  https://doi.org/10.1016/j.proeng.2012.01.098

## 6. 本文抽出・boilerplate除去

記事本文を取る用途では「全textContent」ではなく、navigation、footer、related links等を落とす必要がある。

### CleanEval

Web page cleaningの評価shared task。本文抽出の評価データ・指標設計に使う。

- https://aclanthology.org/L08-1369/

### CETR

行ごとのtag ratioを使い、本文領域と非本文領域を分ける。軽量なclassical fallbackとして有用。

- Weninger, Hsu, Han, WWW 2010
- https://www2009.eprints.org/82/ （書誌確認時は正式版を使用）

### jusText系

paragraph長、stopword密度、link density等を使うheuristic boilerplate removal。実装候補を比較する。

- https://github.com/miso-belica/justext

### NeuScraper

ACL 2024のneural primary-content extractor。DOMをtextual sequenceへ変換してmain content nodeを判定する。rule-based scraperに対する重いfallback候補。

- Paper: https://aclanthology.org/2024.acl-short.72/
- Code: https://github.com/OpenMatch/NeuScraper

## 7. HTML table / 統計データ

### WebTables

Cafarella et al. (VLDB 2008) は大量のHTML tableからrelational tableを分類・抽出する研究。

Open_scrapingの数表処理では、単に`<table>`をCSV化するだけでなく：
- layout tableかdata tableか
- headerはどこか
- row/column span
- repeated labels
- unit / period / source
- nested table

を区別する。

参考：
- https://vldb.org/archives/website/2008/papers.html
- https://turing.cs.washington.edu/papers/webtables_vldb08.pdf

## 8. DOM理解の学習型fallback

古典的手法だけで取れない場合に使う。全ページに最初からGPUモデルをかける設計にはしない。

### SimpDOM

DOM treeから各nodeの有用なcontextを取り出し、少数例・別verticalへのtransferを狙うattribute extraction。

- https://arxiv.org/abs/2101.02415

### MarkupLM

textとmarkup構造を共同でpretrainしたモデル。SWDE等のWeb extraction benchmarkでも評価されている。

- https://aclanthology.org/2022.acl-long.420/
- https://github.com/microsoft/unilm/tree/master/markuplm

### DOM-LM

textとDOM tree structureをTransformerでencodeし、attribute extraction / OpenIE / QAに適用。

- https://arxiv.org/abs/2201.10608

### ReXMiner

DOM上のrelative XML pathを関係抽出のsignalとして利用。key-value関係やlabel/value proximityの特徴設計に参考になる。

- https://aclanthology.org/2023.findings-emnlp.281/

## 9. 視覚・マルチモーダル

HTML treeと画面上のレイアウトが大きく違うサイトではvisual情報が有効。

### VIPS

DOM tag treeだけに依存せず、視覚的境界からページをblock分割する古典的手法。

- https://www.microsoft.com/en-us/research/publication/vips-a-vision-based-page-segmentation-algorithm/

### CoVA

DOMのsyntactic contextとrendered appearanceを組み合わせ、e-commerce pageのproduct title / price / image等を検出する。

- https://aclanthology.org/2022.ecnlp-1.11/

### MUSTIE

HTML structure、text、image等を組み合わせるmultimodal structural Transformer。

- https://aclanthology.org/2023.acl-long.135/

視覚モデルはrender costが大きいため、DOM/structured dataで十分な場合には使わない。

## 10. 商品検索・比較への直接適用

### PLAtE

2023 ACL Industryのlist page web extraction dataset。

- 6,694 pages
- 52,898 products
- 156,014 attributes
- product segmentation + attribute extraction

商品おすすめフローの評価にかなり近い。

- https://aclanthology.org/2023.acl-industry.27/

### SWDE

structured web data extractionの代表benchmark。

- 約124,000 pages
- 80 websites
- 8 verticals

商品詳細・属性抽出の一般化評価に利用する。

元論文：
- From One Tree to a Forest: a Unified Solution for Structured Web Data Extraction, SIGIR 2011
- https://doi.org/10.1145/2009916.2010020

## 11. 標準抽出フロー案

### 商品一覧

```text
HTML
 ├ structured-data extractor
 ├ repeated-record detector (MDR/DEPTA-inspired)
 ├ table/list detector
 └ learned DOM fallback
       ↓
candidate records
       ↓
field alignment / attribute extractor
       ↓
provenance-preserving merge
       ↓
保存
```

### 記事

```text
HTML
 ├ semantic article hints
 ├ structured data
 ├ CETR/jusText-like lightweight cleaner
 └ NeuScraper-like fallback
       ↓
本文候補 + block provenance
```

### 数表

```text
HTML
 ├ structured data
 ├ table classifier
 ├ header / span normalization
 └ DOM / visual fallback
       ↓
raw cells + normalized table + provenance
```

## 12. 結果融合の原則

複数抽出器を使うなら、値を上書きするのではなくcandidateを残す。

例：

```json
{
  "field": "price",
  "candidates": [
    {
      "value": "19800",
      "source": "jsonld",
      "page_url": "...",
      "evidence": "Offer.price"
    },
    {
      "value": "19,800円",
      "source": "dom-repeated-record",
      "node_ref": "..."
    }
  ]
}
```

一致すればconfidenceを上げられる。競合すればuser/recommendation部品へ残す。

## 13. ベンチマーク

最低限、以下をCIとは別のbenchmark suiteで持つ。

| 用途 | benchmark |
| --- | --- |
| single-item attribute extraction | SWDE |
| list/product extraction | PLAtE |
| article cleaning | CleanEval |
| HTML tables | WebTables由来fixture + 自前fixture |
| structured metadata | WDC / schema.org fixture |
| template change / wrapper repair | 同一fixtureのDOM mutation suite |

外部datasetのライセンス・再配布条件を確認し、リポジトリへ直接入れられないものはdownload script + checksum + small hand-made fixtureにする。

## 14. 採用判断

論文に書かれているからそのまま採用するのではない。

各部品について：
1. original paper
2. available implementation
3. license
4. maintenance state
5. CPU/GPU cost
6. Japanese pagesでの精度
7. current Web（SPA、hydration、CSS layout等）での精度
8. benchmark
9. failure mode
10. provenanceを保持できるか

を比較する。

古典的アルゴリズムの再実装が短い場合は、論文の考え方を参考にOpen_scraping向け部品として実装する。既存OSSを使う場合は上流版とlicenseを固定する。

## 15. 参考になるsurvey

Ferrara et al., *Web Data Extraction, Applications and Techniques: A Survey*, Knowledge-Based Systems 70 (2014) はWeb extractionをtree matching系とmachine learning系に整理し、wrapper generation / maintenanceまで扱っている。最初の文献地図として使う。

- DOI: https://doi.org/10.1016/j.knosys.2014.07.007
- arXiv: https://arxiv.org/abs/1207.0246
