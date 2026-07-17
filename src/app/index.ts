import "dotenv/config";
import { App } from "@slack/bolt";
import cron from "node-cron";
import { stripBotMention } from "../integrations/slack_formatters.js";
import {
  buildMentionBlocks,
  buildNomikaiBlocks,
  buildResearchCompletedBlocks,
  buildResearchFailedBlocks,
  buildResearchReportPages,
  buildResearchStatusBlocks,
  NOMIKAI_CLOSE_ACTION,
  NOMIKAI_VOTE_ACTION,
  sendSlackMessage,
  type MessagePayload,
} from "../integrations/slack_blocks.js";
import { planHangout, formatSearchConditions } from "../services/hangout.js";
import { respondMention } from "../services/mention.js";
import { isResearchRequest, runResearch } from "../services/research.js";
import { buildSlackContext } from "../integrations/slack_api.js";
import { loadMemoryContext, recordInteraction } from "../services/memory.js";
import { getNewsConfig, postNewsDigest } from "../services/news.js";
import { closePoll, createPoll, getPoll, pollKey, toggleVote } from "../services/polls.js";

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

const WORKDIR =
  process.env.PLANNER_REPO_DIR || process.env.CODEX_WORKDIR || process.cwd();

// ---- /nomikai: 候補提案 + 投票 ----

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

  if (!result.ok || !result.plan) {
    await say(result.text);
    return;
  }

  // 先に投げてから ts で投票を登録する。blocks は登録済み poll から再構築する
  const provisionalPoll = {
    requesterId: command.user_id,
    candidates: result.plan.candidates,
    finalMessage: result.plan.final_message,
    votes: result.plan.candidates.map(() => [] as string[]),
    closed: false,
  };
  const payload = buildNomikaiBlocks(provisionalPoll);
  let posted: Awaited<ReturnType<typeof say>> | undefined;
  await sendSlackMessage("nomikai_card", payload, async (p) => {
    posted = await say({ ...p });
  });
  if (posted?.ts) {
    createPoll(pollKey(command.channel_id, posted.ts), {
      requesterId: command.user_id,
      plan: result.plan,
    });
  }

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
});

app.action(NOMIKAI_VOTE_ACTION, async ({ ack, body, action, client }) => {
  await ack();
  const b: any = body;
  const channelId: string | undefined = b.channel?.id;
  const messageTs: string | undefined = b.message?.ts;
  const userId: string | undefined = b.user?.id;
  if (!channelId || !messageTs || !userId) return;

  const candidateIndex = Number.parseInt((action as any).value ?? "", 10);
  const poll = toggleVote(pollKey(channelId, messageTs), userId, candidateIndex);
  if (!poll) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: `<@${userId}> ごめん、この投票のデータが消えちゃってる（bot再起動とか）。もう一回 \`/nomikai\` してくれると助かる🙏`,
    });
    return;
  }
  const payload = buildNomikaiBlocks(poll);
  await sendSlackMessage("nomikai_vote_update", payload, (p) =>
    client.chat.update({ channel: channelId, ts: messageTs, ...p }),
  );
});

app.action(NOMIKAI_CLOSE_ACTION, async ({ ack, body, client }) => {
  await ack();
  const b: any = body;
  const channelId: string | undefined = b.channel?.id;
  const messageTs: string | undefined = b.message?.ts;
  if (!channelId || !messageTs) return;

  const key = pollKey(channelId, messageTs);
  const alreadyClosed = getPoll(key)?.closed;
  const poll = closePoll(key);
  if (!poll) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: "ごめん、この投票のデータが消えちゃってる（bot再起動とか）。もう一回 `/nomikai` してね🙏",
    });
    return;
  }
  const payload = buildNomikaiBlocks(poll);
  await sendSlackMessage("nomikai_close_update", payload, (p) =>
    client.chat.update({ channel: channelId, ts: messageTs, ...p }),
  );

  if (!alreadyClosed) {
    const winner =
      poll.winnerIndex != null ? poll.candidates[poll.winnerIndex] : null;
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: messageTs,
      text: winner
        ? `🍻 決定！ *${winner.name}* に集合ね。幹事よろしく！`
        : "投票ゼロで締め切られたよ。まあ、そういう日もある😇",
    });
  }
});

// ---- メンション: 通常応答 / 調査モード ----

// 調査ジョブの起動。statusTs を渡すと既存メッセージ（例: 「思考中...」）を
// ステータスカードに転用し、なければスレッドに新規投稿する
async function launchResearch({
  client,
  say,
  channelId,
  threadTs,
  contextThreadTs,
  userId,
  requestText,
  topic,
  statusTs: existingStatusTs,
}: {
  client: any;
  say: any;
  channelId: string;
  threadTs: string;
  contextThreadTs?: string;
  userId: string;
  requestText: string;
  topic: string;
  statusTs?: string;
}) {
  let statusTs = existingStatusTs;
  const initial = buildResearchStatusBlocks({
    userId,
    topic,
    phase: "queued",
    position: 1,
  });
  if (statusTs) {
    await sendSlackMessage("research_status", initial, (p) =>
      client.chat.update({ channel: channelId, ts: statusTs, ...p }),
    );
  } else {
    const posted = await say({ ...initial, thread_ts: threadTs });
    statusTs = posted?.ts;
  }

  const updateStatus = async (payload: MessagePayload) => {
    if (!statusTs) return;
    await sendSlackMessage("research_status", payload, (p) =>
      client.chat.update({ channel: channelId, ts: statusTs, ...p }),
    );
  };

  void (async () => {
    try {
      const [slackContext, memory] = await Promise.all([
        buildSlackContext({
          token: process.env.SLACK_BOT_TOKEN,
          channelId,
          userId,
          threadTs: contextThreadTs,
        }),
        loadMemoryContext({ channelId, userId }),
      ]);

      const result = await runResearch({
        slackText: requestText,
        workdir: WORKDIR,
        slackContext,
        memory,
        onProgress: async (progress) => {
          await updateStatus(
            buildResearchStatusBlocks({
              userId,
              topic,
              phase: progress.phase,
              position: progress.phase === "queued" ? progress.position : undefined,
              plan: progress.phase === "researching" ? progress.plan : undefined,
            }),
          );
        },
      });

      if (result.ok) {
        // chat.update はサイズ上限が厳しいので、カードは小さな完了表示に留め、
        // レポート本文は postMessage でページ分割してスレッドに投稿する
        const pages = buildResearchReportPages({
          topic,
          report: result.text,
        });
        await updateStatus(
          buildResearchCompletedBlocks({
            userId,
            topic,
            elapsedMs: result.elapsedMs,
            pageCount: pages.length,
          }),
        );
        for (const page of pages) {
          await sendSlackMessage("research_report_page", page, (p) =>
            client.chat.postMessage({
              channel: channelId,
              thread_ts: threadTs,
              ...p,
            }),
          );
        }
        recordInteraction(
          {
            kind: "research",
            channel_id: channelId,
            user_id: userId,
            question: requestText,
            answer: result.text,
            at: new Date().toISOString(),
          },
          slackContext,
        );
      } else {
        await updateStatus(
          buildResearchFailedBlocks({
            userId,
            topic,
            reason: result.text,
          }),
        );
      }
    } catch (e) {
      console.error("research job crashed", (e as Error)?.message);
      await updateStatus(
        buildResearchFailedBlocks({
          userId,
          topic,
          reason: "内部エラーで調査ジョブが落ちちゃった。ログを見てみて。",
        }),
      ).catch(() => {});
    }
  })();
}

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

  const threadTs = event.thread_ts || event.ts;

  // 明示的な「調べて」系は即・調査モードへ（速いパス）。
  // トリガー語がなくても、通常応答の1パス目が自己判断でエスカレーションする（下記）
  if (isResearchRequest(cleaned)) {
    await launchResearch({
      client,
      say,
      channelId: event.channel,
      threadTs,
      contextThreadTs: event.thread_ts,
      userId: event.user,
      requestText: cleaned,
      topic: cleaned,
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

  const updateMessage = async (
    text: string,
    opts: { pending?: boolean; pass?: number; totalPasses?: number } = {},
  ) => {
    const payload = buildMentionBlocks({
      userId: event.user,
      body: stripLeadingSelfMention(text),
      pending: opts.pending,
      pass: opts.pass,
      totalPasses: opts.totalPasses,
    });
    await sendSlackMessage("mention_reply", payload, (p) =>
      thinkingTs
        ? client.chat.update({ channel: event.channel, ts: thinkingTs, ...p })
        : say({ ...p, thread_ts: threadTs }),
    );
  };

  const result = await respondMention({
    slackText: cleaned,
    workdir: WORKDIR,
    slackContext,
    memory,
    onProgress: async ({ text, pending, pass, totalPasses }) => {
      await updateMessage(text, { pending, pass, totalPasses });
    },
  });

  // 1パス目が「本格調査が必要」と判断したら、「思考中...」メッセージを
  // ステータスカードに転用して調査モードへ切り替える
  if (result.ok && result.escalateToResearch) {
    await launchResearch({
      client,
      say,
      channelId: event.channel,
      threadTs,
      contextThreadTs: event.thread_ts,
      userId: event.user,
      requestText: cleaned,
      topic: result.escalateToResearch,
      statusTs: thinkingTs,
    });
    return;
  }

  // refine が途中で失敗しても「思考中...」表示を残さないよう、最終状態で必ず上書きする
  await updateMessage(result.text);

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

// ---- 夕方ニュース便（NEWS_CHANNEL_ID 設定時のみ稼働） ----

const newsConfig = getNewsConfig();
if (newsConfig.channelId) {
  let expr = newsConfig.cron;
  if (!cron.validate(expr)) {
    console.warn(`invalid NEWS_CRON "${expr}", falling back to 17:30 JST`);
    expr = "30 17 * * *";
  }
  cron.schedule(
    expr,
    () => {
      postNewsDigest().catch((e) =>
        console.error("news digest crashed", (e as Error)?.message),
      );
    },
    { timezone: "Asia/Tokyo" },
  );
  console.log(
    `🗞 news digest scheduled: "${expr}" (Asia/Tokyo) -> ${newsConfig.channelId}`,
  );
}
