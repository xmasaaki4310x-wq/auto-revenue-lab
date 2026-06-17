# 独自ドメイン移行手順

このサイトを `github.io` ではなく独自ドメインで公開するための手順です。

## 先に決めること

- 第一候補: `kurashi-dougu-note.com`
- 第二候補: `kurashi-kouho.com`

`kurashi-note.com` はDNSで既存IPに解決されるため、登録済みの可能性が高いです。

## 大事な順番

ドメイン移行では、先に `src/config.json` の `baseUrl` を変えないでください。  
この値は楽天APIへ送るRefererにも使っています。楽天 Developers 側に新ドメインを許可する前に変更すると、API取得が403になる可能性があります。

## 手順

1. ドメイン購入サイトで候補ドメインを検索する
   - `kurashi-dougu-note.com`
   - `kurashi-kouho.com`

2. 空いているドメインを購入する
   - Whois代行、Whois privacy、登録者情報非公開を必ず有効にする
   - 自動更新は有効にしておくと失効リスクを減らせる

3. GitHub Pagesに独自ドメインを登録する
   - GitHubの `auto-revenue-lab` を開く
   - `Settings` → `Pages`
   - `Custom domain` に購入したドメインを入力して保存する

4. ドメイン管理画面でDNSを設定する

   ルートドメインを使う場合:

   ```text
   A    @    185.199.108.153
   A    @    185.199.109.153
   A    @    185.199.110.153
   A    @    185.199.111.153
   ```

   `www` も使う場合:

   ```text
   CNAME    www    xmasaaki4310x-wq.github.io
   ```

5. 反映を待つ
   - DNS反映は数分から最大24時間かかる場合がある
   - GitHub Pagesの `Enforce HTTPS` が押せるようになったら有効にする

6. 楽天 Developers 側を更新する
   - アプリケーションURLを新ドメインに変更する
   - 許可されたWebサイトに新ドメインを追加する
   - 例:

   ```text
   kurashi-dougu-note.com
   www.kurashi-dougu-note.com
   xmasaaki4310x-wq.github.io
   github.com
   githubusercontent.com
   actions.githubusercontent.com
   ```

7. 最後に `src/config.json` の `baseUrl` を新ドメインへ変更する

   ```json
   "baseUrl": "https://kurashi-dougu-note.com"
   ```

8. GitHub Actionsを手動実行して確認する
   - `Actions` → `Update revenue site` → `Run workflow`
   - 成功後、`build-report.json` の `dataMode` が `live` または `mixed` になっているか確認する

## 注意

- 無料URLを大量に作るより、まず1つの独自ドメインを育てる
- 楽天APIの許可ドメインと `baseUrl` の順番を間違えない
- ドメイン購入時は個人情報を公開しない設定を必ず確認する
