import "dotenv/config";
import { App } from "@slack/bolt";
import { stripBotMention, formatSearchConditions } from "./slack_formatters.js";
import { planNomikai, respondMention } from "./nomikai.js";
import { buildSlackContext } from "./slack_api.js";

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
  await say(`🤔 <@${command.user_id}> 候補を考え中…\n${cond}`);

  const slackContext = await buildSlackContext({
    token: process.env.SLACK_BOT_TOKEN,
    channelId: command.channel_id,
    userId: command.user_id,
  });

  const result = await planNomikai({
    slackText: command.text || "",
    workdir: process.env.PLANNER_REPO_DIR || process.cwd(),
    slackContext,
  });

  await say(result.text);
});

app.event("app_mention", async ({ event, say }) => {
  if (event.bot_id) return;

  const cleaned = stripBotMention(event.text);
  if (!cleaned) {
    await say(`<@${event.user}> 何かお手伝いしましょうか？`);
    return;
  }

  const slackContext = await buildSlackContext({
    token: process.env.SLACK_BOT_TOKEN,
    channelId: event.channel,
    userId: event.user,
    threadTs: event.thread_ts,
  });

  const result = await respondMention({
    slackText: cleaned,
    workdir: process.env.PLANNER_REPO_DIR || process.cwd(),
    slackContext,
  });

  await say(`<@${event.user}> ${result.text}`);
});

await app.start();
console.log("⚡️ nomikai bot is running (Socket Mode)");
