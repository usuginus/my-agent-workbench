import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebClient } from "@slack/web-api";
import {
  runCodexExec,
  diagnoseCodexFailure,
  type ExecError,
} from "../integrations/codex_client.js";
import { sanitizeForSlack } from "../integrations/slack_formatters.js";
import {
  fallbackText,
  mrkdwnSections,
  sendSlackMessage,
  type MessagePayload,
} from "../integrations/slack_blocks.js";
import { nowJst, SLACK_MRKDWN_RULES } from "./prompt_rules.js";

// 毎日夕方にニューストピックを雑談ノリで投稿するデイリー便。
// NEWS_CHANNEL_ID が未設定なら機能ごと眠る。

const DEFAULT_CRON = "30 17 * * *"; // 毎日 17:30 JST
const NEWS_TIMEOUT_MS = 600_000;
const MAX_RECENT_TOPICS = 24;
const MAX_RECENT_URLS = 36;

export type NewsConfig = {
  channelId?: string;
  cron: string;
  extraInterests: string[];
  statePath: string;
};

export type NewsState = {
  version: 1;
  lastPostedAt?: string;
  recentTopics: string[];
  recentUrls: string[];
};

const EMPTY_NEWS_STATE: NewsState = {
  version: 1,
  recentTopics: [],
  recentUrls: [],
};

const INTEREST_PROFILE = `
優先度3（重要な更新があれば最優先）:
・AIの新モデル発表と、日本語圏の開発者による初期評判・実利用比較
・OpenAI / Anthropic / Googleなどのモデル、Codex / Claude Code / Devinなどのコーディングエージェント
・モデルのコーディング性能、エージェント性能、API価格、速度、コンテキスト長、実運用コスト
・AIエージェントのツール利用、ブラウザ操作、長期記憶、MCPなどの連携技術
・日本語性能、日本国内のAI導入・開発事例
・日本の暗号資産市場構造法制、金商法・資金決済法・税制、米国CLARITY法案周辺
・ステーブルコイン、交換業・仲介業・カストディ、暗号資産関連の重要判例
・日本語圏で話題のエンジニアリング記事、新しい開発ツール・OSS、新しいSNSやプロダクト
・国内企業の開発事例、プロダクトディスカバリー、PdMとエンジニアの協働
・制御工学、ロボティクス、フィジカルAI、VR / AR / 空間コンピューティング

優先度2（良い更新があれば採用）:
・モデル評価手法、オープンウェイト・ローカルLLM、画像・動画・音声モデル
・障害報告、アーキテクチャ刷新、性能改善、SRE、セキュリティ
・RWA、トークン化証券、ETF、DeFi、AML。ただし価格予想より制度・実務を優先

優先度1（通常は見送るが、国内で大きく話題化したら昇格）:
・Kimi / Qwen / DeepSeekなど中国系モデル。日本語圏での利用・比較・反応が十分ある時だけ採用
・RAG、ファインチューニング、蒸留、合成データ
・AIチップ、データセンター、スタートアップ資金調達
・シンガポールなど、日本・米国以外の暗号資産法制

優先度0（原則採用しない）:
・暗号資産の価格予想や煽り、企業評価額だけの話、一般的なBig Tech決算
・抽象的な「AIで仕事が変わる」論、実利用情報のないベンチマーク順位
・海外政治一般、消費者向けガジェットの噂、SEO目的のまとめ記事
`.trim();

const SOURCE_POLICY = `
一次確認に使う:
・AI企業、開発元、GitHub Releases、論文、大学・研究機関の公式発表
・金融庁、金融審議会、JVCEA、日本銀行、米議会・SEC・CFTCなどの公式資料

日本語の主要情報源:
・AI: ITmedia AI＋、Ledge.ai、gihyo.jp
・エンジニアリング: Publickey、DevelopersIO、CodeZine、ProductZine、Zenn、Qiita
・国内トレンド発見: はてなブックマーク テクノロジー、TechFeed、Speaker Deck、日本語X
・暗号資産: NADA NEWS、CoinPost。ただし法令・当局・ステーブルコイン・裁判に限定し、相場記事は除外
・ロボティクス / XR: Mogura VR、ロボスタ、MONOist、ITmedia AI＋
・新しいSNS / プロダクト: ITmedia NEWS、INTERNET Watch、日本語X

媒体の扱い:
・日本経済新聞・日経クロステックは論点発見に使ってよい。有料記事だけを根拠にせず、無料の一次情報または確認可能な別ソースを探す。
・Zenn、Qiita、はてな、TechFeed、Xは「日本語圏で何が話題か」のシグナル。事実は一次情報で確認する。
・PR TIMES、企業ブログ、SNS投稿は発見用または当事者発表として扱い、第三者記事のようには扱わない。
・AINOW、HuggingNewsなどの集約・SEO色が強い記事は原則採用しない。
・検索結果ページやトップページではなく、必ず個別記事または一次資料へ直接リンクする。
`.trim();

function parseInterests(raw: string | undefined): string[] {
  return (raw || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function todayJp(): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date());
}

export function getNewsConfig(
  env: NodeJS.ProcessEnv = process.env,
): NewsConfig {
  const memoryDir = path.resolve(env.MEMORY_DIR || "memory");
  return {
    channelId: env.NEWS_CHANNEL_ID?.trim() || undefined,
    cron: env.NEWS_CRON?.trim() || DEFAULT_CRON,
    extraInterests: parseInterests(env.NEWS_EXTRA_INTERESTS),
    statePath: path.join(memoryDir, "news-state.json"),
  };
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(
    0,
    limit,
  );
}

export function extractDigestTopics(text: string): string[] {
  return unique(
    [...String(text || "").matchAll(/\*([^*\n]{4,160})\*/gu)].map(
      (match) => match[1].replace(/\s+/g, " ").trim(),
    ),
    8,
  );
}

export function extractDigestUrls(text: string): string[] {
  return unique(
    [...String(text || "").matchAll(/<(https?:\/\/[^|>\s]+)(?:\|[^>]*)?>/giu)].map(
      (match) => match[1],
    ),
    12,
  );
}

export function updateNewsState(
  current: NewsState,
  digest: string,
  postedAt: string,
): NewsState {
  return {
    version: 1,
    lastPostedAt: postedAt,
    recentTopics: unique(
      [...extractDigestTopics(digest), ...(current.recentTopics || [])],
      MAX_RECENT_TOPICS,
    ),
    recentUrls: unique(
      [...extractDigestUrls(digest), ...(current.recentUrls || [])],
      MAX_RECENT_URLS,
    ),
  };
}

async function loadNewsState(statePath: string): Promise<NewsState> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf-8"));
    return {
      version: 1,
      lastPostedAt:
        typeof parsed?.lastPostedAt === "string" ? parsed.lastPostedAt : undefined,
      recentTopics: Array.isArray(parsed?.recentTopics)
        ? parsed.recentTopics.filter((item: unknown) => typeof item === "string")
        : [],
      recentUrls: Array.isArray(parsed?.recentUrls)
        ? parsed.recentUrls.filter((item: unknown) => typeof item === "string")
        : [],
    };
  } catch {
    return { ...EMPTY_NEWS_STATE };
  }
}

async function saveNewsState(statePath: string, state: NewsState): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await rename(temporaryPath, statePath);
}

export function buildNewsPrompt({
  recentState = EMPTY_NEWS_STATE,
  extraInterests = [],
}: {
  recentState?: NewsState;
  extraInterests?: string[];
}): string {
  return `
あなたは Slack チャンネルに夕方のニュース便を投稿する編集者です。
口調・人格はこのリポジトリの AGENTS.md に従ってください。ニュース原稿ではなく、同僚に「これ見た？」と話しかける自然な日本語で書きます。

# 編集方針
・Web検索で候補を広く調べた後、下記の関心プロファイルに強く合うものだけを2〜3本選ぶ。3本に満たなくても穴埋めしない。
・AIを主軸にする。通常はAIを1〜2本、エンジニアリング / プロダクト開発 / ロボティクス / XRから0〜1本。暗号資産は重要な法令・制度・ステーブルコインの更新がある時だけ最大1本。
・日本語の記事を中心にする。3本なら原則2本以上、2本なら原則1本以上を日本語記事にする。
・英語の一次情報しかない重要ニュースは採用してよいが、日本語圏での反応や実務的な意味も調べ、日本語で説明する。
・過去便と同じ発表・同じ論点・同じURLは、明確な続報がない限り採用しない。

# 関心プロファイル
${INTEREST_PROFILE}

追加の関心事:
${extraInterests.length ? extraInterests.map((item) => `・${item}`).join("\n") : "（なし）"}

# 情報源ポリシー
${SOURCE_POLICY}

# 候補の内部採点
候補ごとに次を内部で採点し、合計8点以上かつ関心適合度2点以上だけを採用する。採点結果そのものは出力しない。
・関心適合度: 0〜3点（2倍して計算）
・日本語圏での注目: 0〜2点
・情報源の信頼性: 0〜2点
・鮮度: 0〜2点
・過去便と重複しない新規性: 0〜1点

# 鮮度
・新モデル、API、プロダクトの発表・障害など速報性が高いものは原則72時間以内。
・法令、規制、プロダクト開発、実利用レポート、技術解説は原則7日以内。特に質の高い分析は14日以内まで可。
・記事の公開日と、記事が扱う出来事の日付を確認する。日付が確認できない候補は採用しない。
・今日でないものを「今日発表された」と書かない。「今週」「昨日」「9月17日」のように正確に書く。

# 構成（Slack mrkdwn）
・冒頭は1行の軽い挨拶。毎回言い回しを変える。
・各トピック: 太字1行の見出し + 2〜3行の雑談コメント + <URL|ソース名>。
・モデルやツールのニュースでは「何が変わったか」「日本語圏での評判」「誰に効くか」を短く入れる。
・法令ニュースでは「何が決まりそうか / 決まったか」「実務への影響」を短く入れる。
・最後に会話を誘う軽い一言で締める。
・全体で20行以内。

${SLACK_MRKDWN_RULES}

# 出力
Slack に投稿する本文のみ。前置き、採点、調査過程、メタ説明は出力しない。

# 入力
現在日時: ${nowJst()} (JST)

過去に投稿した公開ニュースの見出しとURL (JSON):
${JSON.stringify(
  {
    lastPostedAt: recentState.lastPostedAt,
    recentTopics: recentState.recentTopics,
    recentUrls: recentState.recentUrls,
  },
  null,
  2,
)}
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
  const config = getNewsConfig();
  const { channelId } = config;
  if (!dryRun && !channelId) {
    return { ok: false, error: "NEWS_CHANNEL_ID is not set." };
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!dryRun && !token) {
    return { ok: false, error: "SLACK_BOT_TOKEN is not set." };
  }

  try {
    const recentState = await loadNewsState(config.statePath);
    const prompt = buildNewsPrompt({
      recentState,
      extraInterests: config.extraInterests,
    });
    const { stdout } = await runCodexExec({
      prompt,
      cwd: process.cwd(),
      timeoutMs: NEWS_TIMEOUT_MS,
      webSearch: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
    });
    const text = (stdout || "").trim();
    if (!text) {
      return { ok: false, error: "Empty news digest from codex." };
    }
    const safeText = sanitizeForSlack(text);
    if (dryRun) {
      return { ok: true, text: safeText };
    }

    const payload: MessagePayload = {
      text: fallbackText(safeText),
      blocks: [
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `🗞 *今日の夕方ニュース便*（${todayJp()}）` },
          ],
        },
        ...mrkdwnSections(safeText),
      ],
    };
    const client = new WebClient(token);
    await sendSlackMessage("news_digest", payload, (p) =>
      client.chat.postMessage({ channel: channelId!, ...p }),
    );

    try {
      await saveNewsState(
        config.statePath,
        updateNewsState(recentState, safeText, new Date().toISOString()),
      );
    } catch (stateError) {
      console.warn("news state save failed", (stateError as Error)?.message);
    }

    return { ok: true, text: safeText, channelId };
  } catch (e) {
    const hint = diagnoseCodexFailure(e as ExecError);
    console.error("postNewsDigest failed", {
      error: (e as ExecError)?.message,
      stderr: (e as ExecError)?.stderr,
    });
    return { ok: false, error: hint };
  }
}
