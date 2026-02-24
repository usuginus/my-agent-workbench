#!/usr/bin/env node
import "dotenv/config";
import { WebClient } from "@slack/web-api";

const HELP_TEXT = `
Slack information fetch tool (JSON output)

Usage:
  node tools/slack_info.mjs --channel C12345678 [options]
  node tools/slack_info.mjs --user U12345678 --section user [options]

Options:
  --token <token>                Slack bot token (fallback: SLACK_BOT_TOKEN)
  --channel <id>                 Slack channel ID
  --user <id>                    Slack user ID
  --thread-ts <ts>               Thread root timestamp (requires --channel)
  --section <csv>                One or more of: channel,history,members,user,replies
  --history-limit <n>            Max history messages (default: 20, max: 100)
  --members-limit <n>            Max channel members (default: 50, max: 200)
  --replies-limit <n>            Max thread replies (default: 200, max: 500)
  --pretty                       Pretty-print JSON
  --help                         Show this help

Examples:
  node tools/slack_info.mjs --channel C123 --user U123 --thread-ts 1736505777.000200 --pretty
  node tools/slack_info.mjs --channel C123 --section history,members --history-limit 40
  node tools/slack_info.mjs --user U123 --section user --pretty
`.trim();

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) {
      continue;
    }
    const name = key.slice(2);
    if (name === "pretty" || name === "help") {
      args[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    args[name] = value;
    i += 1;
  }
  return args;
}

function parsePositiveInt(raw, fallback, max) {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function slimMessages(messages, limit = null) {
  const list = Array.isArray(messages) ? messages : [];
  const sliced = limit == null ? list : list.slice(0, limit);
  return sliced.map((m) => ({
    user: m.user || m.bot_id || "unknown",
    text: m.text || "",
    ts: m.ts || "",
    thread_ts: m.thread_ts || "",
  }));
}

function slimUser(user) {
  const profile = user?.profile || {};
  return {
    id: user?.id || "",
    name: user?.name,
    real_name: profile.real_name,
    display_name: profile.display_name,
    title: profile.title,
    is_bot: Boolean(user?.is_bot),
    tz: user?.tz,
  };
}

function parseSections(raw, channelId, userId, threadTs) {
  if (raw) {
    return new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  const sections = new Set();
  if (channelId) {
    sections.add("channel");
    sections.add("history");
    sections.add("members");
  }
  if (userId) {
    sections.add("user");
  }
  if (channelId && threadTs) {
    sections.add("replies");
  }
  return sections;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  }

  if (args.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  const token = args.token || process.env.SLACK_BOT_TOKEN;
  const channelId = args.channel;
  const userId = args.user;
  const threadTs = args["thread-ts"];
  const historyLimit = parsePositiveInt(args["history-limit"], 20, 100);
  const membersLimit = parsePositiveInt(args["members-limit"], 50, 200);
  const repliesLimit = parsePositiveInt(args["replies-limit"], 200, 500);

  if (!token) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error:
            "Slack token is required. Set SLACK_BOT_TOKEN or pass --token.",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  if (!channelId && !userId) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error:
            "At least one of --channel or --user is required. Use --help for usage.",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  if (threadTs && !channelId) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: "--thread-ts requires --channel.",
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  const sections = parseSections(args.section, channelId, userId, threadTs);
  const allowed = new Set(["channel", "history", "members", "user", "replies"]);
  for (const section of sections) {
    if (!allowed.has(section)) {
      console.error(
        JSON.stringify(
          {
            ok: false,
            error: `Unknown section "${section}". Allowed: channel,history,members,user,replies`,
          },
          null,
          2,
        ),
      );
      process.exit(1);
    }
  }

  const client = new WebClient(token);
  const result = {
    ok: true,
    requested: {
      channel_id: channelId || null,
      user_id: userId || null,
      thread_ts: threadTs || null,
      sections: Array.from(sections),
      history_limit: historyLimit,
      members_limit: membersLimit,
      replies_limit: repliesLimit,
    },
  };

  if (channelId && sections.has("channel")) {
    try {
      const res = await client.conversations.info({ channel: channelId });
      result.channel = {
        id: res.channel?.id || channelId,
        name: res.channel?.name,
        is_private: Boolean(res.channel?.is_private),
        is_archived: Boolean(res.channel?.is_archived),
        num_members: res.channel?.num_members,
      };
    } catch (err) {
      result.channel_error = err?.data?.error || err?.message || String(err);
    }
  }

  if (channelId && sections.has("history")) {
    try {
      const res = await client.conversations.history({
        channel: channelId,
        limit: historyLimit,
      });
      result.history = slimMessages(res.messages, historyLimit);
    } catch (err) {
      result.history_error = err?.data?.error || err?.message || String(err);
    }
  }

  if (channelId && sections.has("members")) {
    try {
      const res = await client.conversations.members({
        channel: channelId,
        limit: membersLimit,
      });
      result.members = (res.members || []).slice(0, membersLimit);
    } catch (err) {
      result.members_error = err?.data?.error || err?.message || String(err);
    }
  }

  if (userId && sections.has("user")) {
    try {
      const res = await client.users.info({ user: userId });
      result.user = slimUser(res.user);
    } catch (err) {
      result.user_error = err?.data?.error || err?.message || String(err);
    }
  }

  if (channelId && threadTs && sections.has("replies")) {
    try {
      const allReplies = [];
      let cursor = undefined;
      do {
        const res = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 100,
          cursor,
        });
        if (res.messages?.length) {
          allReplies.push(...res.messages);
        }
        cursor = res.response_metadata?.next_cursor || undefined;
        if (allReplies.length >= repliesLimit) break;
      } while (cursor);
      result.replies = slimMessages(allReplies, repliesLimit);
    } catch (err) {
      result.replies_error = err?.data?.error || err?.message || String(err);
    }
  }

  const output = args.pretty
    ? JSON.stringify(result, null, 2)
    : JSON.stringify(result);
  console.log(output);
}

await main();
