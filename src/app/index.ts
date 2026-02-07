import "dotenv/config";
import { App } from "@slack/bolt";
import { stripBotMention } from "../integrations/slack_formatters.js";
import { planHangout, formatSearchConditions } from "../services/hangout.js";
import { respondMention } from "../services/mention.js";
import { buildSlackContext } from "../integrations/slack_api.js";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

const WORKDIR = process.env.CODEX_WORKDIR || process.cwd();

app.command("/nomikai", async ({ command, ack, say }) => {
  await ack();

  const cond = formatSearchConditions(command.text || "");
  await say(`🤔 <@${command.user_id}> 候補を考え中...\n${cond}`);

  const slackContext = await buildSlackContext({
    token: process.env.SLACK_BOT_TOKEN,
    channelId: command.channel_id,
    userId: command.user_id,
  });

  const result = await planHangout({
    slackText: command.text || "",
    workdir: process.env.PLANNER_REPO_DIR || process.cwd(),
    slackContext,
  });

  await say(result.text);
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

  const slackContext = await buildSlackContext({
    token: process.env.SLACK_BOT_TOKEN,
    channelId: event.channel,
    userId: event.user,
    threadTs: event.thread_ts,
  });

  const threadTs = event.thread_ts || event.ts;
  const thinking = await say({
    text: `<@${event.user}> 思考中... :loading:`,
    thread_ts: threadTs,
  });
  const thinkingTs = thinking?.ts;

  const formatReply = (text: string, pending: boolean) => {
    const prefix = pending
      ? `<@${event.user}> 思考中... :loading:`
      : `<@${event.user}>`;
    return `${prefix} ${text}`.trim();
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
    workdir: process.env.PLANNER_REPO_DIR || process.cwd(),
    slackContext,
    onProgress: async ({ stage, text, pending }) => {
      if (stage === "draft") {
        await updateMessage(text, pending);
      }
      if (stage === "refined") {
        await updateMessage(text, pending);
      }
    },
  });

  if (!result.ok) {
    await updateMessage(result.text, false);
  }
});

await app.start();
console.log("⚡️ slack bot is running (Socket Mode)");
