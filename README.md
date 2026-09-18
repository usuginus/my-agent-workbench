# codex-echo-in-slack

Codex CLI を頭脳にした Slack ボット。メンション応答・非同期リサーチ・飲み会投票・自然な雑談・夕方ニュース便・長期記憶を備える。

## 機能

| 機能 | トリガー | 概要 |
|------|---------|------|
| メンション応答 | `@bot 〜` | Block Kit カードで返信。多パス推敲の進捗を表示しながら磨き上げる |
| 調査モード | `@bot 〜調べといて` など | 即 ACK → 裏でロング調査（プラン → Web 深掘り）→ 出典付きレポート |
| 飲み会プランナー | `/nomikai [エリア 予算 人数 時間]` | 候補3件を投票カードで提示。🍺 ボタンで投票、締切で決定 |
| 雑談への自然な乱入 | 30分ごとの抽選 | 直近の話題に「草」などの短文で不規則に混ざる。既定は週4〜6回 |
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
| `CODEX_BIN` | `codex` | Codex CLI 実行ファイル。PATH上のCLIが壊れている場合は絶対パスを指定 |
| `CODEX_REASONING_EFFORT` | (codex 側の既定) | `low` などの reasoning effort |
| `CODEX_WEB_SEARCH` | 有効 | `0` で Web 検索を無効化 |
| `CODEX_REFINE` | 有効 | `0` で多パス推敲を無効化 |
| `CODEX_REFINE_MAX` | `4` | 推敲パスの最大回数 |
| `CODEX_RESEARCH_TIMEOUT_MS` | `900000` | 調査モードの深掘りパスの上限時間（15分） |
| `RESEARCH_MAX_CONCURRENT` | `2` | 調査ジョブの同時実行数（超過分は順番待ち） |
| `CHATTER_CHANNEL_ID` | (無効) | 雑談へ自然に混ざる投稿先チャンネル ID（`C…`） |
| `CHATTER_CRON` | `*/30 * * * *` | 会話を確認する間隔（Asia/Tokyo） |
| `CHATTER_WEEKLY_TARGET` | `5` | 週の基準投稿数。実際の上限は毎週 ±1 して人間っぽく揺らす |
| `CHATTER_ACTIVE_START_HOUR` | `9` | 雑談に混ざり始める時刻（JST） |
| `CHATTER_ACTIVE_END_HOUR` | `24` | 雑談に混ざる最終時刻（JST、この時刻は含まない） |
| `CHATTER_LOOKBACK_MIN` | `90` | 話題として見る直近メッセージの期間（分） |
| `CHATTER_MIN_MESSAGES` | `2` | 抽選対象にするために必要な人間の投稿数 |
| `CHATTER_COOLDOWN_MIN` | `360` | 自動投稿後の最低沈黙時間（分） |
| `CHATTER_OPPORTUNITY_RATE` | `0.35` | 30分枠のうち会話があると見込む割合。投稿頻度の微調整用 |
| `CHATTER_DEBUG` | 無効 | `1` で投稿しなかった理由を起動ログへ出す |
| `NEWS_CHANNEL_ID` | (無効) | 設定するとニュース便が有効になる。投稿先チャンネル ID（`C…`） |
| `NEWS_CRON` | `30 17 * * *` | ニュース便のスケジュール（Asia/Tokyo で評価）。平日のみなら `30 17 * * 1-5` |
| `NEWS_EXTRA_INTERESTS` | (なし) | 固定プロファイルへ追加する関心事。カンマ区切り |
| `MEMORY_DIR` | `memory` | 長期記憶の保存先ディレクトリ |
| `MEMORY_DISTILL` | 有効 | `0` で Codex による記憶蒸留を無効化（ログ等の決定的な書き込みは常に行う） |
| `PLANNER_REPO_DIR` | カレント | Codex の作業ディレクトリ（AGENTS.md や memory/ をここから読む） |
| `PLANNER_DEBUG` | 無効 | `1` で失敗時に詳細を返信に含める |

## 使い方

### メンション応答

チャンネルにボットを invite して `@bot 質問` するだけ。スレッド内でカードが「:loading: 磨き上げ中… (2/5)」→ 完成、と更新されていく。口調・人格は [AGENTS.md](AGENTS.md) で調整する。

### 調査モード（非同期リサーチ）

調査モードへの入り方は2段構え:

1. **トリガー語（速いパス)**: メンションに **調べて / 調べといて / 調査して / リサーチ / 深掘り / deep dive** が含まれると即・調査モード
2. **自己判断（賢いパス)**: トリガー語がなくても、通常応答の1パス目が「短い回答では足りない本格調査だ」と判断すると自動で調査モードに切り替わる（「思考中...」メッセージがそのままステータスカードになる）。判定用の追加 LLM 呼び出しはないので、普通の質問のレイテンシには影響しない

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

### 雑談への自然な乱入

`CHATTER_CHANNEL_ID` を設定すると、30分ごとにそのチャンネルの直近90分を確認する。人間の会話が続いている時だけ抽選し、既定では週4〜6回、9:00〜24:00の間に不規則に投稿する。

返答は説明ではなくリアクション優先。「草」「それな」だけで済む空気なら本当にそれだけ投稿する。会話に自然に混ざれないとCodexが判断した場合は投稿しない。生成時のCodexは `read-only`、承認なし、Web検索なしの一時セッションで動かす。

```bash
# 直近の会話から候補を生成するだけ（Slackには投稿しない）
npm run build && npm run chatter:once

# 候補を実際に投稿する
npm run chatter:once -- --post
```

週の投稿状況と最近の文面は `memory/chatter-state.json` に保存する。再起動しても週の上限や6時間のクールダウンは維持される。

### 夕方ニュース便

`NEWS_CHANNEL_ID` を設定すると、毎日夕方（既定 17:30 JST）に関心度の高いニュースを2〜3本、雑談ノリで自動投稿する。日本語の記事を中心に、AI、国内外の暗号資産法制・ステーブルコイン、国内エンジニアリング・プロダクト開発、制御工学・ロボティクス・XRを優先する。

固定の関心プロファイルと、過去にbot自身が投稿した公開ニュースの見出し・URLを参照する。Slackの会話本文や長期記憶はニュース検索へ渡さない。候補を関心適合度、日本語圏での注目、情報源の信頼性、鮮度、重複のなさで採点し、基準に届かなければ3本に満たなくても穴埋めしない。日経などの有料記事は論点発見に使い、投稿では確認可能な一次情報または無料ソースを優先する。

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
  news-state.json         # 過去ニュース便の公開見出し・URL（ネタ被り防止）
  chatter-state.json     # 雑談機能の週次上限・最終投稿・最近の文面
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
  app/                 # エントリポイントと news / chatter の単発実行
  services/            # mention, research, hangout, polls, chatter, news, memory
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
- **雑談が投稿されない**: `CHATTER_CHANNEL_ID`、チャンネルへの invite、`channels:history` を確認。普段は抽選で黙るため、`npm run chatter:once` で生成だけ試す
- **記憶がおかしい**: `memory/PORTAL.md` を直接編集して修正。蒸留を止めたいときは `MEMORY_DISTILL=0`

## License

MIT
