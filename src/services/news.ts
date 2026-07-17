import { WebClient } from "@slack/web-api";
import {
  runCodexExec,
  diagnoseCodexFailure,
  type ExecError,
} from "../integrations/codex_client.js";
import { sanitizeForSlack } from "../integrations/slack_formatters.js";
import { mrkdwnSections, type MessagePayload } from "../integrations/slack_blocks.js";
import { loadMemoryContext } from "./memory.js";
import { nowJst, SLACK_MRKDWN_RULES } from "./prompt_rules.js";

// 毎日夕方にニューストピックを雑談ノリで投稿するデイリー便。
// NEWS_CHANNEL_ID が未設定なら機能ごと眠る。

const DEFAULT_CRON = "30 17 * * *"; // 毎日 17:30 JST
const NEWS_TIMEOUT_MS = 600_000;

function todayJp(): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date());
}

export function getNewsConfig(): { channelId?: string; cron: string } {
  return {
    channelId: process.env.NEWS_CHANNEL_ID || undefined,
    cron: process.env.NEWS_CRON || DEFAULT_CRON,
  };
}

function buildNewsPrompt({
  portal,
  channelNote,
}: {
  portal: string;
  channelNote: string;
}): string {
  return `
あなたは Slack チャンネルに毎日夕方、雑談のネタになるニューストピックを投稿するアシスタントです。
口調・人格はこのリポジトリの AGENTS.md に従ってください。堅いニュース原稿ではなく、同僚に「ねえこれ見た？」と話しかけるテンションで書きます。

# やること
・Web検索で「今日」のニュースを漁り、このチャンネルの面子が食いつきそうなトピックを3つ選ぶ。
・テック・AI・ソフトウェア開発ネタを中心に、たまに時事や小ネタを混ぜてよい。
・長期記憶やチャンネルの関心事があれば選定に反映する。
・ネタ被り防止に、直近で話題にしたトピックは避ける。

# 「今日のニュース」であること（最重要）
・入力の現在日時が今日。原則、今日（JST）に公開・発表されたニュースだけを選ぶ。
・候補ごとに記事の公開日時を必ず確認する。日付が確認できないネタは採用しない。
・数日前のニュースを今日のことのように書くのは禁止。読者は「今日の便り」として読む。
・どうしても今日のネタが3つ揃わない場合のみ、昨日以降のものを「昨日のだけど」と明示して補う。
・本文でも「今日発表された」「さっき出たばかりの」など、今日であることが伝わる言い方をする。

# 構成（Slack mrkdwn）
・冒頭は1行の軽い挨拶（毎回言い回しを変える）。
・各トピック: 太字1行の見出し + 2〜3行の雑談コメント（自分の感想やツッコミを入れる）+ <URL|ソース名>。
・最後に会話を誘う軽い一言で締める（「どれが気になる？」的な）。
・全体で20行以内。

${SLACK_MRKDWN_RULES}

# 出力
Slack に投稿する本文のみ。前置き・メタ説明は出力しない。

# 入力
現在日時: ${nowJst()} (JST)

長期記憶ポータル:
${portal || "（なし）"}

チャンネルについての記憶 (JSON):
${channelNote}
  `.trim();
}

export type NewsResult = {
  ok: boolean;
  text?: string;
  channelId?: string;
  error?: string;
};

export async function postNewsDigest(
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<NewsResult> {
  const { channelId } = getNewsConfig();
  if (!dryRun && !channelId) {
    return { ok: false, error: "NEWS_CHANNEL_ID is not set." };
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!dryRun && !token) {
    return { ok: false, error: "SLACK_BOT_TOKEN is not set." };
  }

  try {
    const memory = await loadMemoryContext({ channelId });
    const prompt = buildNewsPrompt({
      portal: memory?.portal || "",
      channelNote: JSON.stringify(memory?.channel || null),
    });
    const { stdout } = await runCodexExec({
      prompt,
      cwd: process.cwd(),
      timeoutMs: NEWS_TIMEOUT_MS,
    });
    const text = (stdout || "").trim();
    if (!text) {
      return { ok: false, error: "Empty news digest from codex." };
    }
    if (dryRun) {
      return { ok: true, text: sanitizeForSlack(text) };
    }

    const payload: MessagePayload = {
      text: sanitizeForSlack(text),
      blocks: [
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `🗞 *今日の夕方ニュース便*（${todayJp()}）` },
          ],
        },
        ...mrkdwnSections(text),
      ],
    };
    const client = new WebClient(token);
    await client.chat.postMessage({ channel: channelId, ...payload });
    return { ok: true, text, channelId };
  } catch (e) {
    const hint = diagnoseCodexFailure(e as ExecError);
    console.error("postNewsDigest failed", {
      error: (e as ExecError)?.message,
      stderr: (e as ExecError)?.stderr,
    });
    return { ok: false, error: hint };
  }
}
