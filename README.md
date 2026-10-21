# 腹ぱんぐらむ（本番版）

相互フォローの友だちとだけ、おいしいお店をシェアするサイトです。
すべて無料で動きます（GitHub Pages + Supabase 無料プラン）。

## しくみ

| 部分 | 使うもの | 費用 |
|---|---|---|
| 画面（このリポジトリ） | GitHub Pages | 無料（公開リポジトリ） |
| ログイン | Supabase Auth（ID＋パスワード、メールアドレスは使わない） | 無料（月5万人まで） |
| 投稿・フォローなど | Supabase Database | 無料（500MB まで） |
| 写真 | Supabase Storage（非公開バケット） | 無料（1GB まで） |
| 休止防止 | GitHub Actions（3日ごと） | 無料 |

「相互フォローの人だけが見られる」は、データベースのアクセス制限（RLS）でサーバー側で強制しています。
このリポジトリが公開でも、投稿や写真は見られません。

## はじめの設定（R さんがやること）

### 1. Supabase
1. https://supabase.com で無料アカウントを作ります（GitHub アカウントでログインできます）。
2. 「New project」で作成します。
   - Name: `harapangram`
   - Region: `Northeast Asia (Tokyo)`
   - Database Password: 自分だけが分かるものを入力（あとで使いません）
   - Plan: Free
3. 左メニュー「SQL Editor」を開き、[`supabase/schema.sql`](supabase/schema.sql) の中身をすべて貼り付けて「Run」を押します。
4. 左メニュー「Authentication」→「Sign In / Providers」→「Email」で **Confirm email をオフ** にして保存します。
   - ログインは「ID＋パスワード」で、メールは一切送りません。オンのままだと登録できません。
5. 「Authentication」→「URL Configuration」の Site URL に `https://ユーザー名.github.io/harapangram/` を入れます（`ユーザー名` は GitHub のユーザー名）。
6. 「Project Settings」→「API Keys」（または「API」）で次の2つをコピーします。
   - Project URL（`https://xxxx.supabase.co`）
   - anon key（または publishable key）
   - **service_role / secret key は絶対にコピーしたり貼ったりしないでください。**

### 2. GitHub
1. **公開（Public）** リポジトリ `harapangram` を作ります。
2. 「Settings」→「Pages」→ Source を「Deploy from a branch」、Branch を `main` / `(root)` にして保存します。
3. 「Settings」→「Secrets and variables」→「Actions」→「Variables」に次の2つを登録します（休止防止に使います）。
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = anon key

### 3. 設定ファイル
[`config.js`](config.js) に Project URL と anon key を書きます。

## 無料プランの上限

- データ 500MB / 写真 1GB：合計の上限で、毎月リセットされません。いっぱいになると新しい保存ができなくなりますが、消えません。
- 表示量 5GB / 月、ログイン 5万人 / 月：毎月リセットされます。
- 写真は1投稿3枚まで、1080px・約100KB に縮めて保存します。
- 7日間アクセスがないと休止しますが、GitHub Actions が3日ごとにアクセスして防ぎます。

## ログインについて

- 登録するのは「名前・ID・パスワード」だけです。名前はほかの人と同じでも大丈夫で、ID は1人1つ（変更不可）です。
- メールアドレスや電話番号は集めません。Supabase の仕組み上、ID は `ID@harapangram.invalid`（実在しない予約ドメイン）として保存されます。
- パスワードは Supabase が暗号化（ハッシュ化）して保存し、だれにも読めません。
- 登録時に「秘密のあいことば」を決めます。パスワードを忘れたら、ログイン画面の「パスワードを忘れた」から ID とあいことばで新しいパスワードにできます。
  - あいことばも暗号化（ハッシュ化）して保存し、だれにも読めません。
  - 5回まちがえると、その ID は30分間ためせなくなります（総当たり対策）。
  - 変更に成功すると、ほかの端末のログインはすべて切れます。
  - あいことばは、全角半角・大文字小文字・空白のちがいを気にしません（ひらがなとカタカナは別あつかいです）。
- ログイン中は、マイページの「パスワード変更」「あいことば変更」で変えられます（あいことばの変更には今のパスワードが必要です）。
- ID とあいことばの両方を忘れると、元にもどせません。
- 友だちには「名前」と「@ID」が表示され、「ともだち」画面で名前か ID で探せます。

## あとからできること

- スマホへのプッシュ通知（ホーム画面に追加したアプリで、iOS 16.4 以降）

## ファイル

- `index.html` … アプリ本体（`src.html` から `build.py` で作成）
- `supabase.js` … @supabase/supabase-js 2.117.2（MIT, `supabase-LICENSE.txt`）
- `supabase/schema.sql` … テーブルとアクセス制限
- `.github/workflows/keepalive.yml` … 休止防止
- 地図データ：jpn-atlas（BSD-3）、市区町村名：jp-local-gov（MIT）
