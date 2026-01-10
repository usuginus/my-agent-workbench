import { WebClient } from "@slack/web-api";

function slimMessages(messages, limit = 20) {
  return (messages || [])
    .slice(0, limit)
    .map((m) => ({
      user: m.user || m.bot_id || "unknown",
      text: m.text || "",
      ts: m.ts || "",
      thread_ts: m.thread_ts || "",
    }));
}

export async function buildSlackContext({
  token,
  channelId,
  userId,
  threadTs,
}) {
  if (!token || !channelId) return null;

  const client = new WebClient(token);
  const context = { channel_id: channelId };

  try {
    const history = await client.conversations.history({
      channel: channelId,
      limit: 20,
    });
    context.recent_messages = slimMessages(history.messages, 20);
  } catch (e) {
    context.recent_messages_error = e?.data?.error || e?.message;
  }

  try {
    const members = await client.conversations.members({
      channel: channelId,
      limit: 50,
    });
    context.channel_members = (members.members || []).slice(0, 50);
  } catch (e) {
    context.channel_members_error = e?.data?.error || e?.message;
  }

  if (userId) {
    try {
      const userInfo = await client.users.info({ user: userId });
      const profile = userInfo.user?.profile || {};
      context.request_user = {
        id: userId,
        name: userInfo.user?.name,
        real_name: profile.real_name,
        display_name: profile.display_name,
        title: profile.title,
      };
    } catch (e) {
      context.request_user_error = e?.data?.error || e?.message;
    }
  }

  if (threadTs) {
    try {
      const replies = await client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 20,
      });
      context.thread_messages = slimMessages(replies.messages, 20);
    } catch (e) {
      context.thread_messages_error = e?.data?.error || e?.message;
    }
  }

  return context;
}
