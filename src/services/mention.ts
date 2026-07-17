import {
  runCodexExec,
  diagnoseCodexFailure,
  type ExecError,
} from "../integrations/codex_client.js";
import { type SlackContext } from "../integrations/slack_api.js";
import { type MemoryContext } from "./memory.js";
import { nowJst, SLACK_MRKDWN_RULES } from "./prompt_rules.js";
import { RESEARCH_ESCALATION_MARKER } from "./research.js";

const INCOMPLETE_MARKER = "※暫定回答";
const INCOMPLETE_SUFFIX = "（追記予定）";
const DEFAULT_MAX_REFINES = 4;
const DRAFT_COMPLETENESS = 50;

type PromptMeta = {
  pass: number;
  totalPasses: number;
  targetPercent: number;
  isFinal: boolean;
};

type ProgressPayload = {
  stage: "draft" | "refined";
  text: string;
  pass: number;
  totalPasses: number;
  pending: boolean;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const INCOMPLETE_MARKER_PATTERN = new RegExp(
  `${escapeRegExp(INCOMPLETE_MARKER)}\\s*${escapeRegExp(INCOMPLETE_SUFFIX)}?`,
  "g",
);

function getTargetCompleteness(pass: number, totalPasses: number): number {
  if (totalPasses <= 1) return 100;
  const clampedPass = Math.min(Math.max(pass, 1), totalPasses);
  const span = 100 - DRAFT_COMPLETENESS;
  const step = span / (totalPasses - 1);
  return Math.round(DRAFT_COMPLETENESS + step * (clampedPass - 1));
}

function buildMeta(pass: number, totalPasses: number): PromptMeta {
  return {
    pass,
    totalPasses,
    targetPercent: getTargetCompleteness(pass, totalPasses),
    isFinal: pass >= totalPasses,
  };
}

function buildContextSection({
  slackText,
  slackContext,
  memory,
  draft,
}: {
  slackText: string;
  slackContext: SlackContext | null;
  memory: MemoryContext | null;
  draft?: string;
}): string {
  const parts = [
    `現在日時: ${nowJst()} (JST)`,
    "",
    "## 長期記憶ポータル（過去のやり取りから蒸留した記憶）",
    memory?.portal?.trim() || "（記憶なし）",
  ];

  if (memory?.request_user) {
    parts.push(
      "",
      "## 発言者について記憶していること (JSON)",
      JSON.stringify(memory.request_user),
    );
  }
  if (memory?.channel) {
    parts.push(
      "",
      "## このチャンネルについて記憶していること (JSON)",
      JSON.stringify(memory.channel),
    );
  }

  parts.push(
    "",
    "## Slack の現在の状況 (JSON)",
    JSON.stringify(slackContext || null),
    "",
    "## ユーザーメッセージ（これに答える）",
    JSON.stringify(slackText),
  );

  if (draft) {
    parts.push("", "## 改善対象のドラフト回答", JSON.stringify(draft));
  }

  return parts.join("\n");
}

function buildCommonPromptPolicies(): string {
  return `
# 使える情報の優先順位
1. ユーザーメッセージ。これに直接答える。
2. スレッド・チャンネルの直近メッセージ。会話の文脈として使う。
3. 長期記憶（ポータル・発言者・チャンネル）。相手の役割・好み・過去の経緯を自然に活かす。最新の Slack 情報と矛盾したら Slack 側を信じる。
4. Web検索。最新性・外部の事実・比較が少しでも絡むなら、回答前に必ず使う。複数ソースを照合する。
5. さらに詳しい記憶が必要なら \`memory/\` ディレクトリ（people/ channels/ log/）を読んでよい。

# 回答の作り方
・最初の1〜2行で結論を言い切る。理由・手順は必要最小限を続ける。
・具体的な次アクションで締める。
・不確実な点は断定せず「たぶん」「〜のはず」と正直に言う。
・情報不足で答えようがない時だけ、質問を1つだけ返す。
・内部手順・思考過程・ツール実行ログは書かない。自分を AI と名乗らない。

${SLACK_MRKDWN_RULES}

# 出力
・Slack に投稿する本文のみ。前置き・自己紹介・メタ説明・JSON は出力しない。
・基本は4〜20行。1メッセージで完結させる。
  `.trim();
}

function buildMentionPrompt({
  slackText,
  slackContext,
  memory,
  meta,
}: {
  slackText: string;
  slackContext: SlackContext | null;
  memory: MemoryContext | null;
  meta: PromptMeta;
}): string {
  return `
あなたは Slack ワークスペースの一員として、メンションに返信するアシスタントです。
口調・人格はこのリポジトリの AGENTS.md に従ってください。

返信フェーズ: ${meta.pass}/${meta.totalPasses}（${meta.isFinal ? "最終回答" : "一次回答ドラフト"}）／目標完成度: ${meta.targetPercent}%

# このフェーズの目的
・速さ優先。まず役に立つ一次回答を返す（調査は最大 ~30 秒、検索は1〜3件まで）。
・わかる範囲で結論を出す。完璧さは後続の改善フェーズに任せてよい。
${meta.isFinal ? "・最終回なので不完全マーカーは付けず、可能な限り完成させる。" : `・回答が未完成なら末尾に「${INCOMPLETE_MARKER}${INCOMPLETE_SUFFIX}」を必ず付ける。`}

# 調査モードへのエスカレーション判断（回答を書く前に必ず考える）
依頼が本格的な調査を要すると判断したら、回答本文を一切書かず、次の1行だけを出力する:
${RESEARCH_ESCALATION_MARKER} <調査テーマを1行で>

エスカレーションすべき例:
・複数ソースの照合や広い最新情報の収集が必要（技術選定の比較、市場動向、網羅的な調査依頼）
・「徹底的に」「詳しく」「まとめて」など、深さ・網羅性を求められている
・短い回答を返しても、どうせ追加で深掘りを求められそうな重い問い

エスカレーションしない例:
・雑談、感想、軽い質問、記憶や会話の文脈だけで答えられるもの
・1〜3件の検索でサクッと答えられる単発の事実確認
・迷ったら通常回答を選ぶ（エスカレーションは確信がある時だけ）。

${buildCommonPromptPolicies()}

# 入力
${buildContextSection({ slackText, slackContext, memory })}
  `.trim();
}

function buildRefinePrompt({
  slackText,
  slackContext,
  memory,
  draft,
  meta,
}: {
  slackText: string;
  slackContext: SlackContext | null;
  memory: MemoryContext | null;
  draft: string;
  meta: PromptMeta;
}): string {
  return `
あなたは Slack ワークスペースの一員として、メンションに返信するアシスタントです。
口調・人格はこのリポジトリの AGENTS.md に従ってください。

返信フェーズ: ${meta.pass}/${meta.totalPasses}（ドラフト改善）／目標完成度: ${meta.targetPercent}%

# このフェーズの目的
・ドラフトをより正確で実用的な回答に改善する。良い部分は残し、必要な箇所だけ直す。
・Web検索でファクトチェックし、情報不足の補完・誤りの修正・曖昧表現の解消を優先する。
・根拠の薄い主張は、断定を弱めるか前提を明記する。
・ドラフトに「${INCOMPLETE_MARKER}」があり補完できたら必ず削除する。
${meta.isFinal ? "・最終回なのでマーカーは残さない。埋めきれない場合は前提を明記して完成形にする。" : "・補完後も本質的な不足が残る場合のみ、マーカーを残してよい。"}

${buildCommonPromptPolicies()}

# 入力
${buildContextSection({ slackText, slackContext, memory, draft })}
  `.trim();
}

// 1パス目の出力がエスカレーションマーカーなら調査テーマを取り出す。
// 出力全体がマーカーで始まる時だけ採用し、本文中の引用等での誤発動を防ぐ
function parseResearchEscalation(text: string): string | null {
  const trimmed = (text || "").trim();
  if (!trimmed.startsWith(RESEARCH_ESCALATION_MARKER)) return null;
  const topic = trimmed
    .slice(RESEARCH_ESCALATION_MARKER.length)
    .split("\n")[0]
    .trim();
  return topic ? topic.slice(0, 200) : null;
}

function stripIncompleteMarker(text: string): string {
  let out = text || "";
  out = out.replace(INCOMPLETE_MARKER_PATTERN, "");
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getRefineConfig() {
  const enabled =
    process.env.CODEX_REFINE === undefined ||
    (process.env.CODEX_REFINE !== "0" && process.env.CODEX_REFINE !== "false");
  const envMax = Number.parseInt(process.env.CODEX_REFINE_MAX || "", 10);
  const maxRefines =
    enabled && Number.isFinite(envMax) && envMax > 0
      ? envMax
      : enabled
        ? DEFAULT_MAX_REFINES
        : 0;
  const totalPasses = 1 + maxRefines;
  return { enabled, maxRefines, totalPasses };
}

export async function respondMention({
  slackText,
  workdir,
  slackContext,
  memory,
  onProgress,
}: {
  slackText: string;
  workdir: string;
  slackContext: SlackContext | null;
  memory?: MemoryContext | null;
  onProgress?: (payload: ProgressPayload) => void;
}) {
  const refineConfig = getRefineConfig();
  const meta = buildMeta(1, refineConfig.totalPasses);
  const prompt = buildMentionPrompt({
    slackText,
    slackContext,
    memory: memory ?? null,
    meta,
  });
  try {
    const { stdout } = await runCodexExec({ prompt, cwd: workdir });
    let draftInternal = (stdout || "").trim();
    if (!draftInternal) {
      throw new Error("Empty response from codex.");
    }
    const escalationTopic = parseResearchEscalation(draftInternal);
    if (escalationTopic) {
      return { ok: true, text: "", escalateToResearch: escalationTopic };
    }
    const draftDisplay = stripIncompleteMarker(draftInternal);
    await onProgress?.({
      stage: "draft",
      text: draftDisplay,
      pass: 1,
      totalPasses: refineConfig.totalPasses,
      pending: refineConfig.enabled && refineConfig.maxRefines > 0,
    });
    let currentInternal = draftInternal;
    let currentDisplay = draftDisplay;
    if (refineConfig.enabled) {
      for (let attempt = 0; attempt < refineConfig.maxRefines; attempt += 1) {
        const pass = attempt + 2;
        const refinePrompt = buildRefinePrompt({
          slackText,
          slackContext,
          memory: memory ?? null,
          draft: currentInternal,
          meta: buildMeta(pass, refineConfig.totalPasses),
        });
        try {
          const { stdout: refinedStdout } = await runCodexExec({
            prompt: refinePrompt,
            cwd: workdir,
          });
          const refinedInternal = (refinedStdout || "").trim();
          if (refinedInternal && refinedInternal !== currentInternal) {
            currentInternal = refinedInternal;
            currentDisplay = stripIncompleteMarker(currentInternal);
            const remaining = refineConfig.maxRefines - attempt - 1;
            await onProgress?.({
              stage: "refined",
              text: currentDisplay,
              pass,
              totalPasses: refineConfig.totalPasses,
              pending:
                currentInternal.includes(INCOMPLETE_MARKER) && remaining > 0,
            });
          }
          if (!currentInternal.includes(INCOMPLETE_MARKER)) {
            return { ok: true, text: currentDisplay, refined: true };
          }
        } catch (e) {
          console.warn("respondMention refine failed", {
            error: (e as ExecError)?.message,
            stderr: (e as ExecError)?.stderr,
            stdout: (e as ExecError)?.stdout,
          });
          break;
        }
      }
    }

    return {
      ok: true,
      text: currentDisplay,
      refined: currentInternal !== draftInternal,
    };
  } catch (e) {
    const hint = diagnoseCodexFailure(e as ExecError);
    console.error("respondMention failed", {
      error: (e as ExecError)?.message,
      stderr: (e as ExecError)?.stderr,
      stdout: (e as ExecError)?.stdout,
    });
    return {
      ok: false,
      text: `⚠️ 返信を生成できませんでした。原因: ${hint}`,
      debug: {
        error: (e as ExecError)?.message,
        stderr: (e as ExecError)?.stderr,
      },
    };
  }
}
