# codex-echo-in-slack

Lightweight Slack bot powered by Codex. It replies to mentions and offers a `/nomikai` command for quick meetup suggestions.

## Features

- Mention replies (concise, Japanese)
- Progressive updates with multi-pass refinement
- `/nomikai` suggestions with 3 picks
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

## Slack App Setup

- Enable Socket Mode
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
  services/            # Business logic (hangout, mentions, memory)
  integrations/        # Slack API + Codex CLI + mrkdwn sanitizer
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

## License

MIT
