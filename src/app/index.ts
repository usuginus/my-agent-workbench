import "dotenv/config";
import { App } from "@slack/bolt";
import {
  sanitizeForSlack,
  stripBotMention,
} from "../integrations/slack_formatters.js";
import { planHangout, formatSearchConditions } from "../services/hangout.js";
import { respondMention } from "../services/mention.js";
import { buildSlackContext } from "../integrations/slack_api.js";
import { loadMemoryContext, recordInteraction } from "../services/memory.js";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

const WORKDIR =
  process.env.PLANNER_REPO_DIR || process.env.CODEX_WORKDIR || process.cwd();

app.command("/nomikai", async ({ command, ack, say }) => {
  await ack();

  const cond = formatSearchConditions(command.text || "");
  await say(`🤔 <@${command.user_id}> 候補を考え中...\n${cond}`);

  const [slackContext, memory] = await Promise.all([
    buildSlackContext({
      token: process.env.SLACK_BOT_TOKEN,
      channelId: command.channel_id,
      userId: command.user_id,
    }),
    loadMemoryContext({
      channelId: command.channel_id,
      userId: command.user_id,
    }),
  ]);

  const result = await planHangout({
    slackText: command.text || "",
    workdir: WORKDIR,
    slackContext,
    memory,
  });

  await say(result.text);

  if (result.ok) {
    recordInteraction(
      {
        kind: "nomikai",
        channel_id: command.channel_id,
        user_id: command.user_id,
        question: command.text || "",
        answer: result.text,
        at: new Date().toISOString(),
      },
      slackContext,
    );
  }
});

app.event("app_mention", async ({ event, say, client }) => {
  if (event.bot_id) return;

  const cleaned = stripBotMention(event.text);
  if (!cleaned) {
    await say({
      text: `<@${event.user}> 何かお手伝いしましょうか？`,
      thread_ts: event.thread_ts || event.ts,
    });
    return;
  }

  const [slackContext, memory] = await Promise.all([
    buildSlackContext({
      token: process.env.SLACK_BOT_TOKEN,
      channelId: event.channel,
      userId: event.user,
      threadTs: event.thread_ts,
    }),
    loadMemoryContext({ channelId: event.channel, userId: event.user }),
  ]);

  const threadTs = event.thread_ts || event.ts;
  const thinking = await say({
    text: `<@${event.user}> 思考中... :loading:`,
    thread_ts: threadTs,
  });
  const thinkingTs = thinking?.ts;

  const mentionAliases = [
    slackContext?.request_user?.display_name,
    slackContext?.request_user?.real_name,
    slackContext?.request_user?.name,
  ].filter((v): v is string => Boolean(v && v.trim()));

  const escapeRegExp = (value: string) =>
    value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const stripLeadingSelfMention = (text: string) => {
    let out = (text || "").trimStart();
    const patterns = [
      new RegExp(`^<@${escapeRegExp(event.user)}>[,:、]?(?:\\s|　)*`),
      ...mentionAliases.map(
        (alias) => new RegExp(`^@${escapeRegExp(alias)}[,:、]?(?:\\s|　)*`),
      ),
    ];
    let changed = true;
    while (changed) {
      changed = false;
      for (const pattern of patterns) {
        if (pattern.test(out)) {
          out = out.replace(pattern, "");
          out = out.replace(/^(?:\s|　)+/, "");
          changed = true;
        }
      }
    }
    return out;
  };

  const formatReply = (text: string, pending: boolean) => {
    const body = sanitizeForSlack(stripLeadingSelfMention(text));
    const prefix = pending
      ? `<@${event.user}> 思考中... :loading:`
      : `<@${event.user}>`;
    return `${prefix}\n${body}`.trim();
  };

  const updateMessage = async (text: string, pending = false) => {
    if (thinkingTs) {
      await client.chat.update({
        channel: event.channel,
        ts: thinkingTs,
        text: formatReply(text, pending),
      });
    } else {
      await say({ text: formatReply(text, pending), thread_ts: threadTs });
    }
  };

  const result = await respondMention({
    slackText: cleaned,
    workdir: WORKDIR,
    slackContext,
    memory,
    onProgress: async ({ stage, text, pending }) => {
      if (stage === "draft" || stage === "refined") {
        await updateMessage(text, pending);
      }
    },
  });

  // refine が途中で失敗しても「思考中...」プレフィックスを残さないよう、最終状態で必ず上書きする
  await updateMessage(result.text, false);

  if (result.ok) {
    recordInteraction(
      {
        kind: "mention",
        channel_id: event.channel,
        user_id: event.user,
        question: cleaned,
        answer: result.text,
        at: new Date().toISOString(),
      },
      slackContext,
    );
  }
});

await app.start();
console.log("⚡️ slack bot is running (Socket Mode)");
