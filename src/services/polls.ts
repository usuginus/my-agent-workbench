import { type HangoutPlan } from "./hangout.js";

// 投票状態はインメモリ管理。bot 再起動で消えるが、飲み会投票の寿命は短いので許容する。
// 消えた投票へのアクションはハンドラ側で「取り直して」と案内する。

export type Poll = {
  requesterId: string;
  candidates: HangoutPlan["candidates"];
  finalMessage?: string;
  votes: string[][]; // 候補 index ごとの投票者 user_id リスト
  closed: boolean;
  winnerIndex?: number;
};

const polls = new Map<string, Poll>();

export function pollKey(channelId: string, ts: string): string {
  return `${channelId}:${ts}`;
}

export function createPoll(
  key: string,
  {
    requesterId,
    plan,
  }: {
    requesterId: string;
    plan: HangoutPlan;
  },
): Poll {
  const poll: Poll = {
    requesterId,
    candidates: plan.candidates,
    finalMessage: plan.final_message,
    votes: plan.candidates.map(() => []),
    closed: false,
  };
  polls.set(key, poll);
  return poll;
}

export function getPoll(key: string): Poll | null {
  return polls.get(key) ?? null;
}

/**
 * 1人1票。別候補を押したら移動、同じ候補をもう一度押したら取り消し。
 */
export function toggleVote(
  key: string,
  userId: string,
  candidateIndex: number,
): Poll | null {
  const poll = polls.get(key);
  if (!poll || poll.closed) return poll ?? null;
  if (candidateIndex < 0 || candidateIndex >= poll.candidates.length) {
    return poll;
  }
  const hadVoted = poll.votes[candidateIndex].includes(userId);
  poll.votes = poll.votes.map((voters) => voters.filter((v) => v !== userId));
  if (!hadVoted) {
    poll.votes[candidateIndex].push(userId);
  }
  return poll;
}

export function closePoll(key: string): Poll | null {
  const poll = polls.get(key);
  if (!poll) return null;
  if (poll.closed) return poll;
  poll.closed = true;
  const counts = poll.votes.map((voters) => voters.length);
  const max = Math.max(...counts);
  poll.winnerIndex = max > 0 ? counts.indexOf(max) : undefined;
  return poll;
}
