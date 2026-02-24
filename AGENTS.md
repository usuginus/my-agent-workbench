# Agent Guide

## Slack Info Tool

Use `tools/slack_info.mjs` when you need live Slack context from this workspace.

### Purpose

- Fetch channel metadata, recent messages, members, user profile, and thread replies.
- Return machine-readable JSON so the agent can reason on top of it.
- Keep retrieval scoped by channel/user/thread arguments.

### Prerequisites

- `SLACK_BOT_TOKEN` in `.env`, or pass `--token`.
- The token must have required scopes for requested sections.

### Command

```bash
node tools/slack_info.mjs --channel <CHANNEL_ID> [options]
```

### Options

- `--channel <id>` channel ID.
- `--user <id>` user ID.
- `--thread-ts <ts>` thread timestamp; requires `--channel`.
- `--section <csv>` one or more of `channel,history,members,user,replies`.
- `--history-limit <n>` default `20` (max `100`).
- `--members-limit <n>` default `50` (max `200`).
- `--replies-limit <n>` default `200` (max `500`).
- `--pretty` pretty JSON output.
- `--help` usage.

### Examples

```bash
# Channel + user + thread context
node tools/slack_info.mjs \
  --channel C12345678 \
  --user U12345678 \
  --thread-ts 1736505777.000200 \
  --pretty

# Only channel history and member ids
node tools/slack_info.mjs \
  --channel C12345678 \
  --section history,members \
  --history-limit 40 \
  --pretty

# Only user profile
node tools/slack_info.mjs \
  --user U12345678 \
  --section user \
  --pretty
```

### Agent Usage Rules

- Prefer the minimal sections needed for the current task.
- Avoid broad fetches unless explicitly required.
- Treat output as potentially sensitive; do not paste full logs unnecessarily.
- If a section fails, use `*_error` fields and continue with available data.
