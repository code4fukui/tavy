# tavy（タヴィー）

会議、授業、発表などの場ごとに共有ルームを作り、固有URLをQRコードやリンクで招待者へ共有するWebサービスです。
つぶやきには何階層でも返信でき、会話全体を高密度なアウトライン表示で見渡せます。

## 主な機能

- ID / パスワードによるユーザー登録とログイン
- 登録ユーザーによる共有ルーム作成
- 推測されにくい固有URL、リンクコピー、Web Share、QRコードによる招待
- ルームごとの匿名つぶやき（最大280文字）
- つぶやきへの階層制限のない返信と高密度なアウトライン表示
- メモ、ひらめき、疑問、共感の4種類
- いいね、端末ごとの非公開ブックマーク
- いいね・ブックマーク・この端末のコメントによる表示フィルタ
- 自分の発言の編集・削除（返信は親へつなぎ直して保持）
- 各ルームの最新2,000件を表示
- 表示中のタブではWebSocketで変更を即時反映
- 同じブラウザで過去に利用したルームをトップページへ最近使用した順で表示
- 15秒ごとの自動更新、スマートフォン / PC、light / dark mode対応

初期ルームはありません。ログインした作成者がルームを作り、その固有URLを知る参加者が閲覧・投稿できます。投稿にアカウント情報は表示されません。

## ロゴと名前

`tavy`（タヴィー）は、**Take Away Value. It starts with You.** から生まれた名前です。
「今、感じたコトを、みんなの価値に。」をブランドメッセージとしています。
新しいロゴは会話の輪を表す楕円、中心の
`t`、外へ広がる2つのノードで、ひとつのつぶやきから会話が枝分かれしていく様子を表現しています。HTMLとCSSだけで描画するため軽量です。

## 技術構成

- Deno 2.x / TypeScript / `Deno.serve()`
- `node:sqlite`（WAL / foreign keys / STRICT tables）
- buildless HTML / CSS / JavaScript (ES Modules)
- 外部ランタイム依存、フレームワーク、ORMなし
- パスワードはランダムsalt付きscrypt hash、sessionはSQLiteに保存
- QRコード生成に `qrcode` を使用（SVGをサーバー側で生成）

初回DB作成時には管理者 `admin`（初期パスワード
`admin`）を作成し、パスワード変更必須として記録します。既存の管理者は上書きしません。

## 起動

```sh
deno task dev
```

ブラウザで <http://localhost:8000> を開きます。初回起動時に `data/tavy.db`
が作られ、未適用migrationが順番に実行されます。

本番ではHTTPS環境でsecure cookieを有効にしてください。

```sh
TAVY_SECURE_COOKIE=1 deno task start
```

ポートは `TAVY_PORT`、DB保存先は `TAVY_DB` で変更できます。

## Ubuntu + NGINXへデプロイ

以下は、tavyを `/opt/tavy`
に配置し、systemdで単一のDenoプロセスを起動、NGINXでHTTPSを終端する例です。 事前にDeno
2.x、NGINX、TLS証明書を用意してください。

Denoをユーザーのホームディレクトリへインストールした場合、`sudo`やsystemdからはPATHが見えません。最初に実行ファイルをsystem-wideな場所へ配置します。

```sh
command -v deno
sudo install -m 0755 "$(command -v deno)" /usr/local/bin/deno
/usr/local/bin/deno --version
```

`command -v deno`が何も返さない場合は、先にDeno 2.xをインストールしてください。

### 1. アプリケーションを配置

```sh
sudo useradd --system --home /opt/tavy --shell /usr/sbin/nologin tavy
sudo mkdir -p /opt/tavy /var/cache/tavy
sudo chown tavy:tavy /var/cache/tavy
sudo git clone https://example.com/your/tavy.git /opt/tavy
sudo mkdir -p /opt/tavy/data
sudo chown tavy:tavy /opt/tavy/data
cd /opt/tavy
sudo -u tavy env DENO_DIR=/var/cache/tavy /usr/local/bin/deno cache src/server.ts
sudo -u tavy env DENO_DIR=/var/cache/tavy /usr/local/bin/deno task check
```

リポジトリURLは実際のURLへ置き換えてください。ソースコードは管理者のみが更新し、`data/`だけをtavyユーザーが書き込めるようにします。

### 2. systemd service

`/etc/systemd/system/tavy.service`を作成します。

```ini
[Unit]
Description=tavy Deno server
After=network.target

[Service]
Type=simple
User=tavy
Group=tavy
WorkingDirectory=/opt/tavy
Environment=DENO_DIR=/var/cache/tavy
Environment=TAVY_PORT=8000
Environment=TAVY_DB=/opt/tavy/data/tavy.db
Environment=TAVY_SECURE_COOKIE=1
ExecStart=/usr/local/bin/deno task start
Restart=on-failure
RestartSec=2
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/tavy/data /var/cache/tavy

[Install]
WantedBy=multi-user.target
```

別のsystem-wideな場所へDenoを配置した場合は、`ExecStart`もその絶対パスへ変更してください。

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tavy
sudo systemctl status tavy
curl -I http://127.0.0.1:8000/
```

### 3. NGINX reverse proxy

`/etc/nginx/sites-available/tavy`を作成します。`tavy.example.com`と証明書のパスは実環境へ置き換えてください。

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    listen [::]:80;
    server_name tavy.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name tavy.example.com;

    ssl_certificate     /etc/letsencrypt/live/tavy.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tavy.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

設定を有効化して検証します。

```sh
sudo ln -s /etc/nginx/sites-available/tavy /etc/nginx/sites-enabled/tavy
sudo nginx -t
sudo systemctl reload nginx
```

ブラウザで`https://tavy.example.com/`を開き、ルームを2つのブラウザで表示して、一方の投稿がもう一方へ即時反映されることを確認します。

### 4. 更新

```sh
cd /opt/tavy
sudo git pull --ff-only
sudo -u tavy env DENO_DIR=/var/cache/tavy /usr/local/bin/deno cache src/server.ts
sudo -u tavy env DENO_DIR=/var/cache/tavy /usr/local/bin/deno task check
sudo systemctl restart tavy
sudo journalctl -u tavy -n 100 --no-pager
```

DB
schemaは起動時にmigrationされます。更新前に`/opt/tavy/data/tavy.db`と同ディレクトリのWAL関連ファイルを整合性のある方法でバックアップしてください。

### 運用上の注意

- WebSocketはHTTP/1.1 Upgradeが必要です。
- 現在のリアルタイム購読情報はDenoプロセス内にあるため、Denoは1プロセスで運用してください。
- 複数プロセス化する場合はRedis Pub/Sub等のプロセス間通知が必要です。
- NGINXとDeno双方のopen
  files上限が同時接続数を制限します。負荷試験を行い、必要に応じて`worker_connections`と`LimitNOFILE`を調整してください。
- SQLite DBと`data/`を公開ディレクトリへ置かないでください。

## 開発と確認

```sh
deno task check
```

## API

| Method         | Path                      | 内容                                         |
| -------------- | ------------------------- | -------------------------------------------- |
| `POST`         | `/api/register`           | `{ id, password }` で登録                    |
| `POST`         | `/api/login`              | ログイン                                     |
| `POST`         | `/api/logout`             | ログアウト                                   |
| `GET`          | `/api/me`                 | ログイン状態を取得                           |
| `GET` / `POST` | `/api/rooms`              | 自分のルーム一覧 / 作成                      |
| `GET`          | `/api/rooms/:slug`        | 共有ルーム情報を取得                         |
| `GET`          | `/api/rooms/:slug/qr`     | 共有URLのQRコード（SVG）                     |
| `GET`          | `/api/posts?room=:slug`   | ルームのつぶやきを取得                       |
| `POST`         | `/api/posts`              | `{ room_id, body, mood, parent_id? }` を投稿 |
| `PUT`          | `/api/posts/:id/like`     | いいねを切り替え                             |
| `PUT`          | `/api/posts/:id/bookmark` | ブックマークを切り替え                       |

外部入力は境界で検証し、DB操作にはprepared statementを使用しています。
