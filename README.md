# 自動収益ラボ

無料で始めるための、自動更新型アフィリエイト静的サイト生成プログラムです。

この仕組みは「商品データを集める」「比較ページを生成する」「無料ホスティングへ公開する」までを自動化します。実際に1円以上の収益を得るには、楽天アフィリエイト、A8.net、Amazonアソシエイト、Google AdSenseなどのアカウント登録と審査が必要です。

## まず作ったもの

- 楽天Web Serviceの「Rakuten Ichiba Item Search API」対応
- APIキーが未設定でも動くサンプルデータ
- 商品候補の自動スコアリング
- 広告掲載ページ、プライバシーポリシー、robots.txt、sitemap.xml
- GitHub Actionsで毎日自動更新できる設定
- 追加インストール不要のNode.js標準機能だけで実装

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

## 楽天APIで自動取得する

GitHubリポジトリの Secrets に以下を設定すると、GitHub Actionsで毎日自動更新できます。

- `RAKUTEN_APPLICATION_ID`
- `RAKUTEN_ACCESS_KEY`
- `RAKUTEN_AFFILIATE_ID`

楽天Web Service公式ドキュメントでは、2026-04-01版のIchiba Item Search APIに `applicationId` と `accessKey` が必須、`affiliateId` が任意として記載されています。検索結果には価格、レビュー、画像、アフィリエイト料率などを含められます。

## 無料で公開する候補

- GitHub Pages: public repositoryならGitHub Freeで利用可能
- Cloudflare Pages: 静的サイト公開に向く無料枠あり

まずはGitHub Pagesが簡単です。このリポジトリをGitHubへ push し、Pagesの公開元を「GitHub Actions」にすると、`.github/workflows/update-site.yml` が `site/` を自動デプロイします。

## 収益化候補

- 楽天アフィリエイト: 楽天商品と相性が良く、このプログラムのAPI連携先
- A8.net: 登録・広告利用が無料。提携後に広告リンクを追加
- Amazonアソシエイト: 審査あり。承認後に商品リンクを追加
- Google AdSense: 独自コンテンツとサイト所有権が必要。アクセスが増えてから

## 初期投資

- 必須: 0円
- 任意: 独自ドメイン 年1,000円から3,000円程度
- 任意: 有料ホスティング 月0円から1,000円程度

最初は無料のGitHub Pagesで十分です。収益が出る前に有料ツールへ寄せない方針にしています。

## 注意

完全自動で必ず稼げる保証はありません。特に、低品質な自動生成ページ、コピー記事、クリック誘導、自作自演クリック、SNSスパムは広告アカウント停止の原因になります。このプログラムは、公開データを整理し、ユーザーに役立つ比較ページを作る用途に限定しています。

## 参照した公式情報

- GitHub Pages quickstart: https://docs.github.com/en/pages/quickstart
- Rakuten Ichiba Item Search API: https://webservice.rakuten.co.jp/documentation/ichiba-item-search
- A8.net: https://www.a8.net/
- Amazonアソシエイト: https://affiliate.amazon.co.jp/
- Google AdSense資格要件: https://support.google.com/adsense/answer/9724?hl=ja
