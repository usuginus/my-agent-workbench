import { sanitizeForSlack } from "./slack_formatters.js";
import { type Poll } from "../services/polls.js";

// Slack のサイズ制約:
// ・section の mrkdwn は 3000 文字、blocks は 50 個まで
// ・chat.update の text は 4,000「文字」だが実測ではバイト換算で効く
//   （日本語 2,001 文字 ≒ 6KB で msg_too_long になった）
// ・blocks 本文も 13,000 文字前後で msg_blocks_too_long の実測報告あり
// よって文字数ではなくバイト数で予算管理する
const SECTION_LIMIT = 2900;
const MAX_SECTIONS = 40;
const MESSAGE_BYTE_BUDGET = 12_000;
const FALLBACK_CHAR_LIMIT = 2_000;
const FALLBACK_BYTE_LIMIT = 3_000;

const utf8 = new TextEncoder();

function byteLength(text: string): number {
  return utf8.encode(text || "").length;
}

function truncateBytes(text: string, maxBytes: number): string {
  let out = text || "";
  while (out && byteLength(out) > maxBytes) {
    out = out.slice(0, Math.max(0, Math.floor(out.length * 0.9) - 1));
  }
  return out;
}

// 通知・プッシュ用の fallback text。chat.update の text 上限（4,000 ≒バイト）を
// 確実に下回るよう、文字数とバイト数の両方で切り詰める
export function fallbackText(text: string): string {
  const original = (text || "").trim();
  const truncated = truncateBytes(
    original.slice(0, FALLBACK_CHAR_LIMIT),
    FALLBACK_BYTE_LIMIT,
  );
  return truncated.length < original.length ? `${truncated}…` : truncated;
}

// 単一 section に直接埋め込む LLM 出力用。3000 字制限と全体上限の両方から身を守る
function clamp(text: string, max: number): string {
  const t = (text || "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export type Block = Record<string, any>;

export type MessagePayload = {
  text: string;
  blocks: Block[];
};

/**
 * Slack への送信を包む安全弁。失敗時にペイロードサイズを必ずログし、
 * サイズ起因（msg_too_long / invalid_blocks）ならテキストのみに落として届け直す。
 */
export async function sendSlackMessage(
  label: string,
  payload: MessagePayload,
  send: (payload: MessagePayload) => Promise<unknown>,
): Promise<void> {
  try {
    await send(payload);
  } catch (e: any) {
    const code = e?.data?.error || e?.message;
    console.error(`slack send failed [${label}]`, {
      error: code,
      textChars: payload.text?.length ?? 0,
      blockCount: payload.blocks?.length ?? 0,
      blocksJsonChars: JSON.stringify(payload.blocks ?? []).length,
    });
    if (
      code === "msg_too_long" ||
      code === "msg_blocks_too_long" ||
      code === "invalid_blocks"
    ) {
      await send({ text: fallbackText(payload.text || "…"), blocks: [] });
      return;
    }
    throw e;
  }
}

function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(...texts: string[]): Block {
  return {
    type: "context",
    elements: texts.map((t) => ({ type: "mrkdwn", text: t })),
  };
}

function divider(): Block {
  return { type: "divider" };
}

function splitFenced(fenced: string): string[] {
  // 3000 文字を超えるコードブロックはフェンスを閉じ直しながら分割する
  const inner = fenced.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
  const chunkSize = SECTION_LIMIT - 8;
  const chunks: string[] = [];
  for (let i = 0; i < inner.length; i += chunkSize) {
    chunks.push(`\`\`\`\n${inner.slice(i, i + chunkSize)}\n\`\`\``);
  }
  return chunks;
}

/**
 * mrkdwn テキストを 3000 文字制限に収まるチャンク列へ変換する。
 * 段落単位で詰め、コードブロックはフェンスを保ったまま分割する。
 */
function mrkdwnChunks(rawText: string): string[] {
  const sanitized = sanitizeForSlack(rawText);
  const paragraphs: string[] = [];
  for (const segment of sanitized.split(/(```[\s\S]*?```)/g)) {
    if (!segment.trim()) continue;
    if (segment.startsWith("```")) {
      paragraphs.push(segment.trim());
    } else {
      paragraphs.push(
        ...segment
          .split(/\n{2,}/)
          .map((p) => p.trim())
          .filter(Boolean),
      );
    }
  }

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > SECTION_LIMIT) {
      flush();
      if (paragraph.startsWith("```")) {
        chunks.push(...splitFenced(paragraph));
      } else {
        for (let i = 0; i < paragraph.length; i += SECTION_LIMIT) {
          chunks.push(paragraph.slice(i, i + SECTION_LIMIT));
        }
      }
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > SECTION_LIMIT) {
      flush();
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  flush();
  return chunks;
}

/**
 * 1メッセージに収める前提の section block 列。上限を超えた分は省略する。
 * 省略したくない長文（調査レポート等）は paginateMrkdwn で複数メッセージに分ける。
 */
export function mrkdwnSections(rawText: string): Block[] {
  const limited: string[] = [];
  let totalBytes = 0;
  for (const chunk of mrkdwnChunks(rawText).slice(0, MAX_SECTIONS)) {
    const bytes = byteLength(chunk);
    if (totalBytes + bytes > MESSAGE_BYTE_BUDGET) {
      limited.push("…（長すぎたため以降は省略）");
      break;
    }
    limited.push(chunk);
    totalBytes += bytes;
  }
  return limited.map(section);
}

// 複数メッセージ分割時の1ページあたりの上限
const PAGE_MAX_SECTIONS = 35;
const MAX_PAGES = 10;

/**
 * 長文 mrkdwn を複数メッセージ（ページ）に分割する。
 * 各ページの本文はバイト予算内に収め、Slack の1メッセージとして安全に送れるようにする。
 */
export function paginateMrkdwn(rawText: string): Block[][] {
  const chunks = mrkdwnChunks(rawText);
  const pages: Block[][] = [];
  let current: Block[] = [];
  let totalBytes = 0;
  for (const chunk of chunks) {
    const bytes = byteLength(chunk);
    if (
      current.length > 0 &&
      (totalBytes + bytes > MESSAGE_BYTE_BUDGET ||
        current.length >= PAGE_MAX_SECTIONS)
    ) {
      pages.push(current);
      current = [];
      totalBytes = 0;
    }
    if (pages.length >= MAX_PAGES) {
      pages[pages.length - 1].push(section("…（長すぎたため以降は省略）"));
      return pages;
    }
    current.push(section(chunk));
    totalBytes += bytes;
  }
  if (current.length) pages.push(current);
  return pages.length ? pages : [[section("（本文なし）")]];
}

// ---- メンション応答 ----

export function buildMentionBlocks({
  userId,
  body,
  pending,
  pass,
  totalPasses,
}: {
  userId: string;
  body: string;
  pending?: boolean;
  pass?: number;
  totalPasses?: number;
}): MessagePayload {
  const status =
    pending && pass && totalPasses
      ? `<@${userId}> :loading: 磨き上げ中… (${pass}/${totalPasses})`
      : pending
        ? `<@${userId}> :loading: 思考中…`
        : `💬 <@${userId}>`;
  return {
    text: fallbackText(`<@${userId}>\n${sanitizeForSlack(body)}`),
    blocks: [context(status), ...mrkdwnSections(body)],
  };
}

// ---- 調査エージェントモード ----

export type ResearchPhase = "queued" | "planning" | "researching";

function topicQuote(topic: string): string {
  const oneline = topic.replace(/\s+/g, " ").trim().slice(0, 300);
  return `*調査テーマ*\n>${oneline}`;
}

function formatElapsed(elapsedMs: number): string {
  const totalSec = Math.round(elapsedMs / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}

export function buildResearchStatusBlocks({
  userId,
  topic,
  phase,
  position,
  plan,
}: {
  userId: string;
  topic: string;
  phase: ResearchPhase;
  position?: number;
  plan?: string;
}): MessagePayload {
  const blocks: Block[] = [
    context(`🔍 <@${userId}> 調査モードで受け付けたよ`),
    section(topicQuote(topic)),
    divider(),
  ];
  if (phase === "queued") {
    blocks.push(
      section(
        `🕐 順番待ち中…${position && position > 1 ? `（前に ${position - 1} 件）` : ""}`,
      ),
    );
  } else if (phase === "planning") {
    blocks.push(section("🧭 調査プランを組み立て中…"));
  } else {
    if (plan) {
      // プランは表示用。プラン立案パスが暴走して長文を返しても壊れないよう切り詰める
      blocks.push(section(`*調査プラン*\n${clamp(sanitizeForSlack(plan), 2000)}`));
    }
    blocks.push(
      section("🔍 調査中… Web を漁ってるから数分待ってて"),
      context("終わったらこのメッセージがレポートに変わるよ"),
    );
  }
  return { text: `🔍 <@${userId}> 調査中: ${topic.slice(0, 100)}`, blocks };
}

/**
 * 調査完了カード。ステータスカードの置き換え（chat.update）用。
 * chat.update は text ≒4,000 バイト制限が厳しいため、レポート本文はここに載せず
 * buildResearchReportPages で別メッセージとして投稿する。
 */
export function buildResearchCompletedBlocks({
  userId,
  topic,
  elapsedMs,
  pageCount,
}: {
  userId: string;
  topic: string;
  elapsedMs: number;
  pageCount: number;
}): MessagePayload {
  return {
    text: fallbackText(`✅ <@${userId}> 調査完了（⏱ ${formatElapsed(elapsedMs)}）`),
    blocks: [
      context(`✅ <@${userId}> 調査完了（⏱ ${formatElapsed(elapsedMs)}）`),
      section(topicQuote(topic)),
      context(
        pageCount > 1
          ? `📄 レポート ${pageCount} 通をこのスレッドに投稿したよ`
          : "📄 レポートをこのスレッドに投稿したよ",
      ),
    ],
  };
}

/**
 * 調査レポート本文をスレッド投稿用のメッセージ列に組み立てる。
 * すべて chat.postMessage で送る前提（chat.update より上限が緩い）。
 */
export function buildResearchReportPages({
  topic,
  report,
}: {
  topic: string;
  report: string;
}): MessagePayload[] {
  const pages = paginateMrkdwn(report);
  const total = pages.length;
  return pages.map((sections, i) => {
    const header =
      total > 1 ? `📄 調査レポート（${i + 1}/${total}）` : "📄 調査レポート";
    const blocks: Block[] =
      i === 0
        ? [context(header), section(topicQuote(topic)), divider(), ...sections]
        : [context(header), ...sections];
    return { text: fallbackText(header), blocks };
  });
}

export function buildResearchFailedBlocks({
  userId,
  topic,
  reason,
}: {
  userId: string;
  topic: string;
  reason: string;
}): MessagePayload {
  return {
    text: fallbackText(`⚠️ <@${userId}> 調査に失敗: ${reason}`),
    blocks: [
      context(`⚠️ <@${userId}> ごめん、調査に失敗しちゃった`),
      section(topicQuote(topic)),
      section(sanitizeForSlack(reason)),
      context("時間をおいて再依頼するか、テーマを絞ってみて"),
    ],
  };
}

// ---- /nomikai 投票 ----

export const NOMIKAI_VOTE_ACTION = "nomikai_vote";
export const NOMIKAI_CLOSE_ACTION = "nomikai_close";

function voteLine(voters: string[]): string {
  if (!voters.length) return "🗳 まだ票なし";
  const mentions = voters.map((id) => `<@${id}>`).join(" ");
  return `🗳 *${voters.length}票* ${mentions}`;
}

export function buildNomikaiBlocks(poll: Poll): MessagePayload {
  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "🍻 飲み会の候補、持ってきた！", emoji: true },
    },
    context(
      `<@${poll.requesterId}> の依頼${poll.closed ? "・投票は締め切ったよ" : "・気になる店に投票して（1人1票、押し直しで変更）"}`,
    ),
  ];

  poll.candidates.forEach((c, i) => {
    const isWinner = poll.closed && poll.winnerIndex === i;
    const title = `${isWinner ? "👑 " : ""}*${i + 1}. ${clamp(c.name, 120)}*`;
    const meta = [
      c.budget_yen ? `¥${c.budget_yen.toLocaleString()}` : null,
      c.walk_min ? `徒歩${c.walk_min}分` : null,
      c.vibe || null,
    ]
      .filter(Boolean)
      .join(" / ");
    const lines = [
      `${title}${meta ? `\n${meta}` : ""}`,
      clamp(sanitizeForSlack(c.reason || ""), 1000),
      c.tabelog_url ? `<${c.tabelog_url}|食べログで見る>` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const candidateSection: Block = section(lines);
    if (!poll.closed) {
      candidateSection.accessory = {
        type: "button",
        action_id: NOMIKAI_VOTE_ACTION,
        value: String(i),
        text: { type: "plain_text", text: "🍺 これがいい", emoji: true },
      };
    }
    blocks.push(candidateSection, context(voteLine(poll.votes[i] || [])));
  });

  blocks.push(divider());

  if (poll.closed) {
    const winner =
      poll.winnerIndex != null ? poll.candidates[poll.winnerIndex] : null;
    blocks.push(
      section(
        winner
          ? `✅ *決定: ${winner.name}* だよ！${winner.tabelog_url ? `\n<${winner.tabelog_url}|食べログで見る>` : ""}`
          : "✅ 投票を締め切ったよ（票が入らなかったから決定なし）",
      ),
    );
  } else {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: NOMIKAI_CLOSE_ACTION,
          style: "primary",
          text: { type: "plain_text", text: "✅ 締め切って決定", emoji: true },
        },
      ],
    });
  }

  if (poll.finalMessage) {
    blocks.push(
      section(`📣 *集合メッセージ*\n${clamp(sanitizeForSlack(poll.finalMessage), 2000)}`),
    );
  }

  const fallback = poll.candidates
    .map((c, i) => `${i + 1}. ${c.name} (${(poll.votes[i] || []).length}票)`)
    .join(" / ");
  return { text: `🍻 飲み会候補: ${fallback}`, blocks };
}
