# codex-echo-in-slack

Lightweight Slack bot powered by Codex. It replies to mentions and offers a `/nomikai` command for quick meetup suggestions.

## Features

- Mention replies (concise, Japanese) rendered as Block Kit cards with progress status
- Progressive updates with multi-pass refinement
- Async research agent mode: mentions like 「〜調べといて」「〜を調査して」 get an instant
  ACK card, then a long-running Codex job (plan → deep web research) updates it with a report
- `/nomikai` suggestions with 3 picks, rendered as vote cards (🍺 button per candidate,
  one vote per person, close button decides the winner)
- Slack mrkdwn sanitization at the output boundary (no broken formatting)
- Long-term memory: portal document injected into every prompt, persisted asynchronously
- Optional Slack context enrichment (channel info, history, members, user profile, thread)

## Requirements

- Codex CLI installed and authenticated (`codex login`)

## Quick Start

```bash
npm install
cp .env.sample .env
npm run build
npm start
```

## Configuration

Required:
- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `SLACK_SIGNING_SECRET`

Optional:
- `CODEX_WEB_SEARCH=0` disable web search
- `CODEX_MODEL=gpt-5.2`
- `CODEX_REASONING_EFFORT=low`
- `CODEX_REFINE=1` enable multi-pass refinement
- `CODEX_REFINE_MAX=4` max additional passes
- `MEMORY_DIR=memory` where long-term memory lives
- `MEMORY_DISTILL=0` disable async memory distillation (deterministic logs are always written)
- `CODEX_RESEARCH_TIMEOUT_MS=900000` max duration of the deep research pass (default 15 min)
- `RESEARCH_MAX_CONCURRENT=2` max concurrent research jobs (others wait in queue)
- `PLANNER_DEBUG=1` verbose failures

See `.env.sample` for examples.

## Long-term Memory

The bot maintains a file-based long-term memory under `memory/` (gitignored):

```
memory/
  PORTAL.md              # distilled knowledge, injected into every prompt
  people/<user_id>.json  # per-user profile, last seen, recent topics
  channels/<id>.json     # per-channel info, members, recent topics
  log/YYYY-MM.jsonl      # full interaction log
```

- `PORTAL.md` is the portal document: every reply prompt embeds it, so the agent always "reads" its memory.
- After each reply, persistence runs asynchronously (fire-and-forget, serialized queue):
  deterministic JSON/JSONL writes first, then a Codex pass distills durable facts into `PORTAL.md`.
- Set `MEMORY_DISTILL=0` to skip the Codex distillation pass.

## Research Agent Mode

Mentions containing 調べて / 調べといて / 調査して / リサーチ / 深掘り / deep dive are
handled asynchronously:

1. The bot immediately posts a status card (queued → planning → researching) in the thread.
2. A planning pass builds a short research plan, shown on the card.
3. A deep pass runs with an extended timeout (`CODEX_RESEARCH_TIMEOUT_MS`) and heavy web
   search, then the card is replaced with the final report (summary → details → sources).

Concurrency is limited by `RESEARCH_MAX_CONCURRENT`; excess requests show their queue position.

## Slack App Setup

- Enable Socket Mode
- Enable Interactivity (required for `/nomikai` vote buttons; with Socket Mode no URL is needed)
- Slash Commands: `/nomikai`
- Event Subscriptions: `app_mention`
- Bot Token Scopes:
  - `chat:write`
  - `channels:read`
  - `channels:history`
  - `users:read`

## Project Structure

```
src/
  app/                 # Slack entrypoint
  services/            # Business logic (hangout, mentions, research, polls, memory)
  integrations/        # Slack API + Block Kit builders + Codex CLI + mrkdwn sanitizer
memory/                # Long-term memory (gitignored)
tools/                 # slack_info.mjs CLI for agents
```

## Development

```bash
npm run dev
```

## Troubleshooting

- `codex` not found: ensure Codex CLI is installed and on PATH
- timeouts: reduce prompt size or increase the timeout
- slash command fails: check Slack command name matches `/nomikai`
- channel info missing: grant `channels:read` (and `groups:read` for private channels)
- vote buttons reply "データが消えちゃってる": poll state is in-memory and lost on restart;
  run `/nomikai` again

## License

MIT
