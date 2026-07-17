# codex-echo-in-slack

Codex CLI を頭脳にした Slack ボット。メンション応答・非同期リサーチ・飲み会投票・夕方ニュース便・長期記憶を備える。

## 機能

| 機能 | トリガー | 概要 |
|------|---------|------|
| メンション応答 | `@bot 〜` | Block Kit カードで返信。多パス推敲の進捗を表示しながら磨き上げる |
| 調査モード | `@bot 〜調べといて` など | 即 ACK → 裏でロング調査（プラン → Web 深掘り）→ 出典付きレポート |
| 飲み会プランナー | `/nomikai [エリア 予算 人数 時間]` | 候補3件を投票カードで提示。🍺 ボタンで投票、締切で決定 |
| 夕方ニュース便 | cron（既定 17:30 JST） | 今日のニュース3本を雑談ノリで自動投稿 |
| 長期記憶 | 自動 | 人・チャンネル・やり取りを永続化し、全プロンプトに注入 |

## 必要要件

- Node.js 22+（`fetch` / top-level await を使用）
- npm
- [Codex CLI](https://github.com/openai/codex) — インストール済みで `codex login` による認証が済んでいること

```bash
# Codex CLI のインストール（どちらか）
npm install -g @openai/codex
bun install -g @openai/codex

# 認証
codex login

# 動作確認（これが通らないとボットも動かない）
codex exec --skip-git-repo-check "1+1の答えだけを出力して"
```

## セットアップ

### 1. Slack アプリを作る

[api.slack.com/apps](https://api.slack.com/apps) から Create New App → From scratch。

- **Socket Mode**: 有効化し、App-Level Token を発行（scope: `connections:write`）→ `SLACK_APP_TOKEN`（`xapp-` 始まり）
- **Interactivity & Shortcuts**: 有効化（`/nomikai` の投票ボタンに必須。Socket Mode なので Request URL は不要）
- **Slash Commands**: `/nomikai` を作成（説明・usage hint は任意）
- **Event Subscriptions**: 有効化し、Subscribe to bot events に `app_mention` を追加
- **OAuth & Permissions** → Bot Token Scopes:
  - `chat:write`（投稿・更新）
  - `channels:read`（チャンネル情報。プライベートチャンネルも使うなら `groups:read` も）
  - `channels:history`（履歴・スレッド取得。同上なら `groups:history` も）
  - `users:read`（発言者プロファイル）
  - `commands`（スラッシュコマンド）
- Install to Workspace → `SLACK_BOT_TOKEN`（`xoxb-` 始まり）を取得
- Basic Information → `SLACK_SIGNING_SECRET` を取得
- 使いたいチャンネルでボットを **invite**（`/invite @bot名`）

### 2. リポジトリの準備

```bash
git clone git@github.com:usuginus/my-agent-workbench.git
cd my-agent-workbench
npm install
cp .env.sample .env   # 下記の環境変数を埋める
```

### 3. 起動

```bash
npm run build
npm start        # ⚡️ slack bot is running (Socket Mode) と出れば OK

# 開発時（ts-node で直接実行）
npm run dev
```

## 環境変数

必須:

| 変数 | 説明 |
|------|------|
| `SLACK_BOT_TOKEN` | `xoxb-` 始まりの Bot Token |
| `SLACK_APP_TOKEN` | `xapp-` 始まりの App-Level Token（Socket Mode 用） |
| `SLACK_SIGNING_SECRET` | Basic Information の Signing Secret |

任意:

| 変数 | 既定値 | 説明 |
|------|--------|------|
| `CODEX_MODEL` | (codex 側の既定) | 使用モデル（例: `gpt-5.2`） |
| `CODEX_REASONING_EFFORT` | (codex 側の既定) | `low` などの reasoning effort |
| `CODEX_WEB_SEARCH` | 有効 | `0` で Web 検索を無効化 |
| `CODEX_REFINE` | 有効 | `0` で多パス推敲を無効化 |
| `CODEX_REFINE_MAX` | `4` | 推敲パスの最大回数 |
| `CODEX_RESEARCH_TIMEOUT_MS` | `900000` | 調査モードの深掘りパスの上限時間（15分） |
| `RESEARCH_MAX_CONCURRENT` | `2` | 調査ジョブの同時実行数（超過分は順番待ち） |
| `NEWS_CHANNEL_ID` | (無効) | 設定するとニュース便が有効になる。投稿先チャンネル ID（`C…`） |
| `NEWS_CRON` | `30 17 * * *` | ニュース便のスケジュール（Asia/Tokyo で評価）。平日のみなら `30 17 * * 1-5` |
| `MEMORY_DIR` | `memory` | 長期記憶の保存先ディレクトリ |
| `MEMORY_DISTILL` | 有効 | `0` で Codex による記憶蒸留を無効化（ログ等の決定的な書き込みは常に行う） |
| `PLANNER_REPO_DIR` | カレント | Codex の作業ディレクトリ（AGENTS.md や memory/ をここから読む） |
| `PLANNER_DEBUG` | 無効 | `1` で失敗時に詳細を返信に含める |

## 使い方

### メンション応答

チャンネルにボットを invite して `@bot 質問` するだけ。スレッド内でカードが「:loading: 磨き上げ中… (2/5)」→ 完成、と更新されていく。口調・人格は [AGENTS.md](AGENTS.md) で調整する。

### 調査モード（非同期リサーチ）

メンションに **調べて / 調べといて / 調査して / リサーチ / 深掘り / deep dive** が含まれると自動で調査モードになる。

```
@bot TypeScript 5.9 の新機能と破壊的変更、調べといて
```

1. 即座にステータスカードを返す（順番待ち → プラン立案 → 調査中）
2. 調査プランをカードに表示しつつ、最長 15 分の Web 深掘りを実行
3. 完了するとカードが「結論サマリ → 詳細 → 参考リンク」のレポートに置き換わる

### /nomikai（飲み会投票）

```
/nomikai 六本木 5000 4 19:30
```

候補3件が投票カードで出る。各候補の「🍺 これがいい」で投票（1人1票、別候補を押すと移動、同じ候補で取り消し）。「✅ 締め切って決定」で 👑 付きの決定表示になり、スレッドに決定通知が流れる。

> 投票状態はインメモリ管理のため、ボット再起動で消える。消えた投票のボタンを押すと取り直しの案内が出る。

### 夕方ニュース便

`NEWS_CHANNEL_ID` を設定すると、毎日夕方（既定 17:30 JST）に今日のニュース3本を雑談ノリで自動投稿する。トピック選定には長期記憶（チャンネルの関心事）が反映される。

```bash
# スケジュールを待たずに1回だけ投稿して試す
npm run build && npm run news:once

# Slack に投稿せず、生成される本文だけ確認する（素振り）
npm run news:once -- --dry-run
```

### 長期記憶

`memory/`（gitignore 済み）にファイルベースで永続化される。初回起動時に自動生成。

```
memory/
  PORTAL.md              # 蒸留された知識。全プロンプトに毎回注入される「記憶の入口」
  people/<user_id>.json  # 人物ごとのプロファイル・最終接触・最近の話題
  channels/<id>.json     # チャンネル情報・メンバー・最近の話題
  log/YYYY-MM.jsonl      # 全やり取りのログ
```

- 応答後に非同期（直列キュー）で永続化する。決定的な書き込み → Codex がポータルへ蒸留、の二段構え
- `PORTAL.md` は手動で編集してもよい（見出し構造は維持する）
- 変な記憶がついたら該当行を消すか、`MEMORY_DISTILL=0` で蒸留を止めて様子を見る

## プロジェクト構成

```
src/
  app/                 # エントリポイント（index.ts）と news の単発実行
  services/            # ビジネスロジック（mention, research, hangout, polls, news, memory）
  integrations/        # Slack API / Block Kit ビルダー / Codex CLI / mrkdwn サニタイザ
memory/                # 長期記憶（gitignore 済み）
tools/slack_info.mjs   # エージェント用の Slack 情報取得 CLI（AGENTS.md 参照）
```

## トラブルシューティング

- **`codex` not found / ボットが返信しない**: Codex CLI が PATH にあるか、`codex login` 済みかを確認。まず `codex exec --skip-git-repo-check "hi"` が通るかを見る
- **`spawn ... codex ENOENT`（vendor バイナリがない）**: codex のインストールが壊れている（プラットフォーム別バイナリの欠落）。再インストールで直す:
  ```bash
  bun remove -g @openai/codex && bun install -g @openai/codex
  # または
  npm uninstall -g @openai/codex && npm install -g @openai/codex
  ```
- **`Codex command failed with exit code: null`**: codex プロセスがシグナルで殺されている。上記のインストール破損、またはタイムアウト・メモリ不足を疑う
- **タイムアウトが頻発する**: `CODEX_REASONING_EFFORT=low` にする、`CODEX_REFINE_MAX` を減らす、調査モードなら `CODEX_RESEARCH_TIMEOUT_MS` を伸ばす
- **スラッシュコマンドが失敗する**: Slack アプリのコマンド名が `/nomikai` と一致しているか確認
- **投票ボタンが反応しない**: Interactivity & Shortcuts が有効か確認（Socket Mode でも有効化は必要）
- **チャンネル情報が取れない（`channel_info_error`）**: `channels:read` を付与。プライベートチャンネルは `groups:read` / `groups:history` も必要
- **ニュース便が投稿されない**: 起動ログに `🗞 news digest scheduled: ...` が出ているか、ボットが対象チャンネルに invite 済みかを確認。`npm run news:once -- --dry-run` で生成だけ試すと切り分けが早い
- **記憶がおかしい**: `memory/PORTAL.md` を直接編集して修正。蒸留を止めたいときは `MEMORY_DISTILL=0`

## License

MIT
