import { WebClient } from "@slack/web-api";

type SlimMessage = {
  user: string;
  text: string;
  ts: string;
  thread_ts: string;
};

function slimMessages(messages: any[] | undefined, limit: number | null = 20): SlimMessage[] {
  const list = messages || [];
  const sliced = limit == null ? list : list.slice(0, limit);
  return sliced.map((m) => ({
    user: m.user || m.bot_id || "unknown",
    text: m.text || "",
    ts: m.ts || "",
    thread_ts: m.thread_ts || "",
  }));
}

function errorMessage(e: any): string {
  return e?.data?.error || e?.message || "unknown_error";
}

export type SlackContext = {
  channel_id: string;
  channel_info?: {
    id: string;
    name?: string;
    topic?: string;
    purpose?: string;
    is_private?: boolean;
  };
  channel_info_error?: string;
  recent_messages?: SlimMessage[];
  recent_messages_error?: string;
  channel_members?: string[];
  channel_members_error?: string;
  request_user?: {
    id: string;
    name?: string;
    real_name?: string;
    display_name?: string;
    title?: string;
  };
  request_user_error?: string;
  thread_messages?: SlimMessage[];
  thread_messages_error?: string;
};

export async function buildSlackContext({
  token,
  channelId,
  userId,
  threadTs,
}: {
  token?: string;
  channelId?: string;
  userId?: string;
  threadTs?: string;
}): Promise<SlackContext | null> {
  if (!token || !channelId) return null;

  const client = new WebClient(token);
  const context: SlackContext = { channel_id: channelId };

  try {
    const info = await client.conversations.info({ channel: channelId });
    const channel: any = info.channel;
    context.channel_info = {
      id: channelId,
      name: channel?.name,
      topic: channel?.topic?.value || undefined,
      purpose: channel?.purpose?.value || undefined,
      is_private: channel?.is_private,
    };
  } catch (e) {
    context.channel_info_error = errorMessage(e);
  }

  try {
    const history = await client.conversations.history({
      channel: channelId,
      limit: 20,
    });
    context.recent_messages = slimMessages(history.messages as any[], 20);
  } catch (e) {
    context.recent_messages_error = errorMessage(e);
  }

  try {
    const members = await client.conversations.members({
      channel: channelId,
      limit: 50,
    });
    context.channel_members = (members.members || []).slice(0, 50);
  } catch (e) {
    context.channel_members_error = errorMessage(e);
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
      context.request_user_error = errorMessage(e);
    }
  }

  if (threadTs) {
    try {
      const allReplies: any[] = [];
      let cursor: string | undefined = undefined;
      do {
        const replies = await client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 100,
          cursor,
        });
        if (replies.messages?.length) {
          allReplies.push(...replies.messages);
        }
        cursor = replies.response_metadata?.next_cursor || undefined;
        if (allReplies.length >= 200) break;
      } while (cursor);
      context.thread_messages = slimMessages(allReplies, null);
    } catch (e) {
      context.thread_messages_error = errorMessage(e);
    }
  }

  return context;
}
