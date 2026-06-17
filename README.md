# くらし道具ノート

季節の買い物候補を、価格とレビューで整理する静的サイトです。

水・お茶、米・保存食、季節ギフトなど、暮らしの中で比較されやすい商品を楽天市場の商品検索データから取得し、レビュー件数、平均評価、価格、商品画像をもとに一覧化します。

## 方針

- 表向きは商品比較・買い物候補の整理サイトとして運用する
- 「おすすめ」と断言しすぎず、比較・候補・確認という表現を使う
- 健康、医療、美容効果、金融など、表現リスクが高い領域は初期テーマから外す
- 価格、在庫、送料、ポイント条件は販売ページでの確認を促す
- 広告リンクが含まれることを明示する

## 主な機能

- 楽天Web ServiceのRakuten Ichiba Item Search APIに対応
- APIキーがない状態でもサンプルデータで表示確認できる
- 商品候補をレビュー件数、平均評価、価格帯でスコアリング
- 季節イベントに合わせたキーワード表示
- 広告掲載ページ、プライバシーポリシー、robots.txt、sitemap.xmlを生成
- GitHub ActionsでGitHub Pagesへデプロイ

## ローカル実行

Codex同梱Nodeを使う場合:

```powershell
.\scripts\build-offline.ps1
.\scripts\serve.ps1
```

通常のNode.jsが入っている環境では:

```bash
npm run build:offline
npm run serve
```

ブラウザで `http://localhost:4173` を開きます。

## 楽天APIで更新する

GitHubリポジトリの Secrets に以下を設定すると、GitHub Actionsでページ生成時に楽天APIを使います。

- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`
- `RAKUTEN_AFFILIATE_ID`

Secretsの値は公開リポジトリやチャットに貼らず、GitHubの秘密設定にだけ保存してください。

## 公開

GitHub Pagesの公開元を「GitHub Actions」に設定すると、`.github/workflows/update-site.yml` が `site/` をデプロイします。

公開URL:

```text
https://xmasaaki4310x-wq.github.io/auto-revenue-lab/
```

独自ドメインへ移行する場合は、先にドメイン購入とDNS設定を行い、楽天 Developers 側の許可ドメインを更新してから `src/config.json` の `baseUrl` を変更します。手順は [docs/custom-domain-setup.md](docs/custom-domain-setup.md) を参照してください。

## 参照

- GitHub Pages quickstart: https://docs.github.com/en/pages/quickstart
- Rakuten Ichiba Item Search API: https://webservice.rakuten.co.jp/documentation/ichiba-item-search
- 楽天アフィリエイト: https://affiliate.rakuten.co.jp/
