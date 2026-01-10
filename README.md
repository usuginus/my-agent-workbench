# Slack Bot (Codex)

Slack でメンションやコマンドを受けると応答する bot です。Codex CLI を使って応答を生成します。

## Features

### 1) メンション応答

- チャンネル内メンションにフリーフォーマットで自然に返信
- 必要なら短く簡潔に応答

### 2) /nomikai 提案

- `/nomikai` コマンドで飲み会候補を 3 件提案
- 検索条件（エリア/予算/人数/開始時間）を最初に表示
- 各候補に食べログリンクを必ず付与

## Requirements

- Node.js 18+
- Slack App（Socket Mode）
- Codex CLI（`codex` コマンドが実行できること）

## Setup

1. 依存関係をインストール

   ```bash
   npm install
   ```

2. 環境変数を用意（`.env` を作成）

   ```bash
   SLACK_BOT_TOKEN=...
   SLACK_APP_TOKEN=...
   SLACK_SIGNING_SECRET=...
   ```

3. 起動
   ```bash
   node src/index.js
   ```

## Slack App 設定のポイント

- Socket Mode を有効化
- Slash Commands: `/nomikai`
- Event Subscriptions: `app_mention`
- Bot Token Scopes: `chat:write`
- Bot をチャンネルに追加

## Usage

```
@your-bot こんにちは
```

```
/nomikai 渋谷 5000 4 19:30
```

## Codex CLI 設定（任意）

環境変数で挙動を調整できます。

- `CODEX_WEB_SEARCH=0` : Web 検索を無効化
- `CODEX_MODEL=gpt-4.1-mini` : 使用モデルを変更
- `CODEX_REASONING_EFFORT=low` : 推論強度を変更
- `PLANNER_DEBUG=1` : 失敗時の診断メッセージを詳しく表示

## Troubleshooting

- `codex` が見つからない: PATH に `codex` が通っているか確認
- `codex exec` がタイムアウト: `timeoutMs` を延長するか、条件を短くする
- 投稿が他ユーザーに見えない: `chat:write` 権限とチャンネル追加を確認
