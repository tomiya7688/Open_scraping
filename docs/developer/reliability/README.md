# 品質・取得量・利用者セキュリティ：横断設計

**状態：設計案／実装・受入未完了（2026-11-04）**。本ディレクトリは既存の [基本設計](../../design.md)、[ランタイム](../../runtime.md)、[データ契約](../../data.md)、[非常停止](../../emergency-stop.md)を置き換えるのではなく、複数パッケージと部品にまたがる検証可能な判断を追加する。PRのマージは機能実装完了を意味しない。

## 優先順位と破れない条件

1. **セキュリティ：実行・通信・保存・出力・配布の必須条件を満たさなければ開始／公開しない。** 取得精度や件数のために安全の根拠を削除しない。
2. **精度と根拠：取得したデータ・意味判断・出典を分離し、未知や矛盾を成功に変換しない。** ユーザーは利用用途に応じてprecision優先・recall優先を選べる。
3. **量：権限、取得先、予算、バックプレッシャー、停止を守った範囲で、コミット済みの一意な取得量を最大化する。** 成功していない試行を件数に数えない。

セキュリティは単に「禁止サイト」の一覧を作ることではない。**どの対象・方法で取得するかはユーザーが選び、どのOS権限・秘密・通信先・容量にアクセスするかをHost等が明示的に認可する。** コアは内容を分類する安全フィルターを追加せず、設計済みの唯一の非着脱安全プリミティブとして[グローバル非常停止](../../emergency-stop.md)を保持する。セキュリティの実効制御はHost、OS隔離、通信adapter、保存／出力境界に置く。

## ここから読む

| 対象 | 仕様案 | 主な関連Issue |
| --- | --- | --- |
| 誤抽出・来歴・漏れ・評価セット | [精度と網羅度](accuracy-coverage.md) | [#15](https://github.com/tomiya7688/Open_scraping/issues/15)、[#54](https://github.com/tomiya7688/Open_scraping/issues/54)、[#84](https://github.com/tomiya7688/Open_scraping/issues/84) |
| 大量データ・流量・予算・復旧 | [高取得量のランタイム](volume-runtime.md) | [#9](https://github.com/tomiya7688/Open_scraping/issues/9)、[#10](https://github.com/tomiya7688/Open_scraping/issues/10)、[#85](https://github.com/tomiya7688/Open_scraping/issues/85) |
| 脅威・認可・隔離・秘密・出力 | [セキュリティ脅威モデル](security-threat-model.md) | [#42](https://github.com/tomiya7688/Open_scraping/issues/42)、[#78](https://github.com/tomiya7688/Open_scraping/issues/78)、[#82](https://github.com/tomiya7688/Open_scraping/issues/82)、[#83](https://github.com/tomiya7688/Open_scraping/issues/83)、[#86](https://github.com/tomiya7688/Open_scraping/issues/86) |
| 受入・合否・根拠の追跡 | [受入・公開ゲート](acceptance.md) · [機械可読ゲート一覧](acceptance-gates.json) | [#86](https://github.com/tomiya7688/Open_scraping/issues/86)、[#37](https://github.com/tomiya7688/Open_scraping/issues/37) |

## 決定と未決定

**既存の確定境界**：交換可能部品、Coreへの具体処理不導入、明示binding、DataRef、本体と出典の分離、OSグローバル非常停止、停止・キャンセルを成功扱いしないこと。

**本PRで提案する追加設計**：信頼境界、通信先の接続時評価、品質レポートのカウンター体系、全段bounded queue、敵対的fixture付きセキュリティゲート。PRレビュー・対応Issueで合意後に採用扱いとする。

**測定前に固定しない数値**：最低precision/recall、サイト別throughput、既定の通信間隔、CPU/メモリ/ディスク容量、OS別停止遅延の合格閾値。固定fixture・OS・マシン仕様を明示し、基準測定を行い、結果を見る前に合格ラインを決める。**閾値未決定は合格済みを意味しない。**

## リリース可否

- `0.x`：契約・mock試験の完了を、実サイト／OS入力／本番セキュリティの合格として扱わない。
- `1.0.0` の一般向け取得機能：精度・網羅・資源試験に加え、関連するセキュリティ必須ゲートを **OSと権限構成ごと** に満たす。未対応経路を成功可能と表示しない。
- 新規配布物：**署名／attestationによる真正性検証がない場合は公開不可**（[#78](https://github.com/tomiya7688/Open_scraping/issues/78)）。署名があっても動作上の隔離や秘密保護を証明したことにはならない。

同一のベンチマーク条件で3軸の数字を並べ、**セキュリティが不合格なら、高い精度や取得量で相殺しない**。
