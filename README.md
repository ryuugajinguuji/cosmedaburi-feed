# コスメダブり 新色ニュースフィード（配信リポジトリ）

このフォルダをそのまま**公開 GitHub リポジトリ**（例: `cosmedaburi-feed`）にし、**GitHub Pages を有効化**するとアプリの配信元になります。

- 配信URL: `https://<ユーザー名>.github.io/<リポジトリ名>` → アプリの `EXPO_PUBLIC_NEWS_BASE` にこのURLを設定（末尾スラッシュなし）。
- アプリは `{BASE}/v1/manifest.json` と `{BASE}/v1/news.json` を取得します（spec06 §3）。

## 更新手順（週1〜2回・spec14 §1.1の3段パイプライン）
1. **収集（半自動）**: PR TIMES ビューティー/新色RSS等を見る（見出し・本文は転載しない）。
2. **選別・執筆（人手）**: `v1/news.json` の `items` に追記/入替。
   - 載せてよいのは**事実データのみ**: brand / product_line / color_code / color_name / hex / released_at / source_url（一次ソース必須）。
   - `note` は**色・質感の客観描写1〜2文を自分の言葉で**（メディア見出しの言い換え・要約は禁止＝翻案回避）。
   - `hex_origin`: 公式に色値があるときだけ `official`、目視推定は `estimated`（アプリ側で「参考△」表示になり％断定しません）。
   - 画像URLは**入れない**（スキーマに存在しない＝構造的に禁止）。
3. **配信**: `news.json` と `manifest.json` の **`version` を +1**・`generated_at` を現在時刻に更新 → push。
   - アプリは manifest の version が上がったときだけ本体を再取得します（更新を忘れると配信されません）。

## 検証
push後にブラウザで `{BASE}/v1/manifest.json` が開ければOK。アプリ側は前面化 or ニュース画面のPull-to-refreshで反映。

## 運用の畳みライン（spec14 §1.7）
週0.5〜1時間を超え、かつ計装でニュース閲覧/照合の寄与が見えなければ機能ごと畳む。

---

## 自動収集の仕組み（spec23 §2 Phase B）

`.github/workflows/collect.yml` が **毎日JST 9:00/12:30/18:00 の3回** に `scripts/collect.mjs` を実行し、`sources.yml` に定義されたRSSから新着をフィードに自動追加します。

### 自動収集で書かれる情報（事実のみ）
| フィールド | 内容 |
|---|---|
| `brand` | タイトルから機械的に抽出 |
| `released_at` | pubDate → YYYY-MM-DD |
| `source_url` | RSS の link（一次ソース） |
| `category` | `sources.yml` の `category_rules` キーワード判定 |
| `ogp_image_url` | リンク先の `og:image`（httpsのみ・失敗は無視） |
| `price_jpy` / `price_label` | タイトルの「¥N,NNN / N,NNN円」正規表現（>=1のみ） |
| `hex` (estimated) | `color_dict.yml` の色語ヒット時のみ（多色語は付与しない） |
| `note` | **常に空文字**（手動で追記してください） |

**見出し・本文・要約の自動転載は行いません。** `note` が空でなければ CI が fail します（spec23 §8）。

### 手動修正のセルフチェック表
手動で `note` を追記・`hex` を修正する際は以下を確認してください:

| # | チェック項目 |
|---|---|
| ① | 見出し転載なし（メディア見出しの言い換え・要約禁止） |
| ② | `note` は自分の言葉で書いた1文（色・質感の客観描写） |
| ③ | `source_url` は一次ソース（公式/PR TIMES等） |
| ④ | `hex` は目安でOK（`hex_origin: "estimated"` を付ける） |

---

## sources.yml 追加手順

1. `sources.yml` に新しいエントリを追加（スキーマは既存エントリを参照）。
2. `category_rules` のキーワードと `fallback_category` を設定する。
3. push後 **1週間は出力を目視確認**（誤分類・不要コンテンツの混入チェック）。
4. 問題なければ通常運用に移行。

```yaml
# sources.yml 追加例
- name: ブランド公式RSS
  rss_url: https://example-brand.com/feed.rdf
  category_rules:
    lip: [リップ, 口紅]
    eye: [アイシャドウ]
  fallback_category: info
```

---

## ID 規則（spec23 §2 DR2 P2-B）

```
{released_at}-{brand_slug}-{title_hash8}
```

- `released_at`: RSS の pubDate から取得した `YYYY-MM-DD`
- `brand_slug`: ブランド名を小文字英数字とハイフンに正規化（最大20文字）
- `title_hash8`: タイトルの SHA-256 先頭8文字（同日同ブランド複数色を区別）

例: `2026-06-12-nars-a1b2c3d4`

IDは決定論的（同じ入力から同じIDが生成される）。重複IDは自動スキップ。

---

## 削除要請 48時間手順（spec23 §9）

OGP画像やアイテム情報に関して削除要請があった場合:

1. 窓口: プライバシーポリシー記載の連絡先メール宛に受領確認を返信。
2. **受領後48時間以内**に `v1/news.json` から該当アイテムを削除（`ogp_image_url` 含む）。
3. `version` を +1・`generated_at` を更新して push（端末側は次回取得で自動反映）。
4. 履歴にも残さない運用（git履歴から消す場合は `git rebase -i` で該当コミットを squash）。


## ソース運用セルフチェック表（週次・spec25 §1.2）

毎週1回、以下を確認して表に1行追記する。

- **新着の健全性**: 直近7日、Actions実行一覧の各run Summaryに `+N件追加`（N≥1）が毎日あるか（commitメッセージに件数は出ない・プルーンのみでもcommitされる点に注意）。48時間 N=0 の場合は Actions ログの `[collect] source=<name> fetched=<n> adopted=<m>` 行で全ソースを確認（全ソース失敗でもworkflowは緑のまま＝Summary/ログでしか分からない）
- **ソース別採用**: 直近14日で adopted が全run 0 のソースは削除候補（sources.yml からエントリ削除のみ・過去採用分はフィードに残る）
- **新ソース追加時**: sources.yml のキーは `name`/`rss_url`/`require_match`/`admission_info_keywords`/`category_rules`/`fallback_category`/`user_agent`（任意・bot UAが403のサイト用）。手動確認は workflow_dispatch の dry_run=true で（フィードを書き換えずログだけ確認できる）

| 日付 | 直近7日の新着 | ソース別メモ | 削除候補 |
|---|---|---|---|
| 2026-07-03 | 運用開始（6ソース） | WWDJAPAN=UA対応で採用3件・他は品質バーで0件（正常） | なし |
