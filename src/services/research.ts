import {
  runCodexExec,
  diagnoseCodexFailure,
  type ExecError,
} from "../integrations/codex_client.js";
import { type SlackContext } from "../integrations/slack_api.js";
import { type MemoryContext } from "./memory.js";
import { nowJst, SLACK_MRKDWN_RULES } from "./prompt_rules.js";

// 「調べといて」系のメンションは同期応答(180s)に収まらないので、
// 即 ACK して裏でロング調査を回す。ここはその調査ジョブ本体。

const PLAN_TIMEOUT_MS = 120_000;
const DEFAULT_RESEARCH_TIMEOUT_MS = 900_000; // 15分
const DEFAULT_MAX_CONCURRENT = 2;

const RESEARCH_TRIGGER = /調べ(て|といて|てほしい|てくれ|ておいて)|調査して|リサーチ|深掘り|deep\s*dive/i;

// 明示的なトリガー語による速いパス。これに引っかからなくても、
// メンション応答の1パス目が自己判断でエスカレーションできる（mention.ts 参照）
export function isResearchRequest(text: string): boolean {
  return RESEARCH_TRIGGER.test(text || "");
}

// メンション応答の1パス目が「本格調査が必要」と判断したときに出力するマーカー
export const RESEARCH_ESCALATION_MARKER = "RESEARCH_MODE:";

function getResearchTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.CODEX_RESEARCH_TIMEOUT_MS || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RESEARCH_TIMEOUT_MS;
}

function getMaxConcurrent(): number {
  const parsed = Number.parseInt(process.env.RESEARCH_MAX_CONCURRENT || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENT;
}

// Codex のロング実行が同時多発すると詰まるので、簡易セマフォで絞る
let active = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(onQueued?: (position: number) => void | Promise<void>) {
  if (active >= getMaxConcurrent()) {
    await onQueued?.(waiters.length + 1);
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active += 1;
}

function releaseSlot() {
  active = Math.max(0, active - 1);
  waiters.shift()?.();
}

function buildPlanPrompt({
  slackText,
  slackContext,
  memory,
}: {
  slackText: string;
  slackContext: SlackContext | null;
  memory: MemoryContext | null;
}): string {
  return `
あなたは調査アシスタントです。ユーザーの調査依頼を分解し、調査プランだけを出力してください。

ルール:
・「・」始まりの箇条書きで3〜6項目。各項目は1行・50文字以内。
・調査項目のみ。前置き・説明・実際の調査結果は書かない。
・依頼が曖昧でも質問せず、意図を推測して項目に落とす。

現在日時: ${nowJst()} (JST)

調査依頼:
${JSON.stringify(slackText)}

会話の文脈 (JSON):
${JSON.stringify({
    channel: slackContext?.channel_info || null,
    thread: (slackContext?.thread_messages || slackContext?.recent_messages || []).slice(-10),
  })}

長期記憶（依頼者の背景理解に使う）:
${memory?.portal?.slice(0, 1500) || "（なし）"}
  `.trim();
}

function buildResearchPrompt({
  slackText,
  plan,
  slackContext,
  memory,
}: {
  slackText: string;
  plan: string;
  slackContext: SlackContext | null;
  memory: MemoryContext | null;
}): string {
  return `
あなたは Slack ワークスペースの調査エージェントです。
口調・人格はこのリポジトリの AGENTS.md に従ってください。
依頼テーマを Web 検索を駆使して徹底的に調べ、Slack に投稿する調査レポート本文だけを出力してください。

# 調査の進め方
・調査プランの項目ごとに複数ソースを当たる（合計10件以上見てよい）。
・一次情報・公式ドキュメントを優先し、情報の日付を確認する。
・ソース間で食い違う場合は両論併記し、どちらが確からしいか自分の見解を短く添える。
・時間はたっぷりある。速さより正確さと網羅性を優先する。

# レポート構成
・冒頭2〜3行で *結論サマリ*（これだけ読めば要点がわかる状態にする）。
・調査項目ごとの詳細。見出しは太字の1行で作る。
・最後に *参考リンク* セクションを置き、<URL|タイトル> 形式で主要ソースを列挙する。
・全体で最大60行。表は使わず、箇条書きの「・」で構造化する。

${SLACK_MRKDWN_RULES}

# 出力
Slack に投稿するレポート本文のみ。前置き・メタ説明・作業ログは出力しない。

# 入力
現在日時: ${nowJst()} (JST)

調査依頼:
${JSON.stringify(slackText)}

調査プラン:
${plan}

会話の文脈 (JSON):
${JSON.stringify({
    channel: slackContext?.channel_info || null,
    thread: (slackContext?.thread_messages || slackContext?.recent_messages || []).slice(-10),
    request_user: slackContext?.request_user || null,
  })}

長期記憶ポータル:
${memory?.portal || "（なし）"}
  `.trim();
}

export type ResearchProgress =
  | { phase: "queued"; position: number }
  | { phase: "planning" }
  | { phase: "researching"; plan: string };

export type ResearchResult =
  | { ok: true; text: string; plan?: string; elapsedMs: number }
  | { ok: false; text: string; elapsedMs: number };

export async function runResearch({
  slackText,
  workdir,
  slackContext,
  memory,
  onProgress,
}: {
  slackText: string;
  workdir: string;
  slackContext: SlackContext | null;
  memory: MemoryContext | null;
  onProgress?: (progress: ResearchProgress) => void | Promise<void>;
}): Promise<ResearchResult> {
  const startedAt = Date.now();
  await acquireSlot((position) => onProgress?.({ phase: "queued", position }));
  try {
    await onProgress?.({ phase: "planning" });

    // プラン立案に失敗しても調査自体は続行する（プランなしの一発調査に切替）
    let plan = "";
    try {
      const { stdout } = await runCodexExec({
        prompt: buildPlanPrompt({ slackText, slackContext, memory }),
        cwd: workdir,
        timeoutMs: PLAN_TIMEOUT_MS,
      });
      plan = (stdout || "").trim();
    } catch (e) {
      console.warn("research plan failed, continue without plan", {
        error: (e as ExecError)?.message,
      });
    }

    await onProgress?.({ phase: "researching", plan });

    const { stdout } = await runCodexExec({
      prompt: buildResearchPrompt({
        slackText,
        plan: plan || "（プランなし。依頼文から直接調査する）",
        slackContext,
        memory,
      }),
      cwd: workdir,
      timeoutMs: getResearchTimeoutMs(),
    });
    const report = (stdout || "").trim();
    if (!report) {
      throw new Error("Empty research report from codex.");
    }
    return { ok: true, text: report, plan, elapsedMs: Date.now() - startedAt };
  } catch (e) {
    const hint = diagnoseCodexFailure(e as ExecError);
    console.error("runResearch failed", {
      error: (e as ExecError)?.message,
      stderr: (e as ExecError)?.stderr,
    });
    return { ok: false, text: hint, elapsedMs: Date.now() - startedAt };
  } finally {
    releaseSlot();
  }
}
