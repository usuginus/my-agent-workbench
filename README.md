# codex-echo-in-slack

Lightweight Slack bot powered by Codex. It replies to mentions and offers a `/nomikai` command for quick meetup suggestions.

## Features

- Mention replies (concise, Japanese)
- Progressive updates with multi-pass refinement
- `/nomikai` suggestions with 3 picks
- Slack-friendly formatting
- Optional Slack context enrichment (channel history, members, user profile, thread)

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
- `PLANNER_DEBUG=1` verbose failures

See `.env.sample` for examples.

## Slack App Setup

- Enable Socket Mode
- Slash Commands: `/nomikai`
- Event Subscriptions: `app_mention`
- Bot Token Scopes:
  - `chat:write`
  - `conversations:read`
  - `channels:history`
  - `users:read`

## Project Structure

```
src/
  app/                 # Slack entrypoint
  services/            # Business logic (hangout, mentions)
  integrations/        # Slack API + Codex CLI + sanitizers
```

## Development

```bash
npm run dev
```

## Troubleshooting

- `codex` not found: ensure Codex CLI is installed and on PATH
- timeouts: reduce prompt size or increase timeout
- slash command fails: check Slack command name matches `/nomikai`

## License

MIT
