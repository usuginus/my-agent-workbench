import { runCodexExec, type ExecError } from "../integrations/codex_client.js";
import { toSlackMarkdown } from "../integrations/slack_formatters.js";
import { type SlackContext } from "../integrations/slack_api.js";

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

function buildInputSection(
  slackText: string,
  slackContext: SlackContext | null,
  draft?: string,
): string {
  const base = `
ユーザーメッセージ:
${JSON.stringify(slackText)}

Slack コンテキスト（JSON / ある場合）:
${JSON.stringify(slackContext || null)}
  `.trim();

  if (!draft) return base;

  return `${base}\n\nドラフト回答:\n${JSON.stringify(draft)}`;
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

function buildMentionPrompt(
  slackText: string,
  slackContext: SlackContext | null,
  meta: PromptMeta,
): string {
  return `
あなたは Slack チャンネルで返信するアシスタントです。
これは「${meta.pass}回目の返信（${meta.isFinal ? "最終回答" : "ドラフト"}）」です。

目的:
• できるだけ早く、役に立つ一次回答を返す。
• 今回の目標完成度は ${meta.targetPercent}%（全${meta.totalPasses}回のうち${meta.pass}回目）。

やること:
• まず短く結論や方向性を示す。
• 不足がある場合でも、今わかる範囲で答える。
${meta.isFinal ? "• 最終回なので、マーカーは付けない。足りない場合は質問は最大1つ。" : `• 不十分だと判断したら、文末に「${INCOMPLETE_MARKER}${INCOMPLETE_SUFFIX}」を必ず付ける。`}
• 不足が致命的な場合のみ、質問は最大1つ。
${meta.isFinal ? "• 今回が最終回なので、可能な限り完成させ、マーカーは付けない。" : "• 不十分な場合は、後続の改善で補完する前提でよい。"}

守ること:
• 日本語で自然に返答する。
• 簡潔・親しみやすい・実用的に。
• 求められない限り内部手順は書かない。
• 外部参照（Web/Docs/ログ）は可能だが軽量に。
• Slack 返信を遅らせない。

文体:
• 先に短く答える
• 必要なら箇条書き
• 説明はコンパクトに
• 2回目以降は読みやすさ優先（改行・箇条書き・適度な絵文字を活用）

ローカル作業コンテキスト:
• この Slack エージェントは \`my-agent-workbench\` で動作する。
• \`my-agent-workbench/docs/\` は必要時のみ参照・要約に使ってよい。

軽量実行ルール:
• 追加処理は合計 ~10 秒以内
• 超えそうなら省略して回答

Web 検索ポリシー:
• 最新情報/レコメンド/比較/外部事実が必要なら使う
• 検索は最大3件、要点のみ、遅いなら打ち切り

Docs 検索ポリシー:
• このリポジトリ/実装/設計の質問のみ
• 開くファイルは1〜2件まで

サマリーログ方針:
• 可能なら短いサマリー（5〜8行）
• 時間がなければスキップ
• 保存先: \`my-agent-workbench/docs/{theme}/{date}.md\`

飲食店・カフェ提案:
• 最大3件
• 店名と短い理由
• 食べログリンクは取れなければ省略

出力:
• Slack メッセージのみ
• サマリー内容は出さない

${buildInputSection(slackText, slackContext)}
  `.trim();
}

function buildRefinePrompt({
  slackText,
  slackContext,
  draft,
  meta,
}: {
  slackText: string;
  slackContext: SlackContext | null;
  draft: string;
  meta: PromptMeta;
}): string {
  return `
あなたは Slack チャンネルで返信するアシスタントです。
これは「${meta.pass}回目の返信（改善版）」です。

目的:
• ドラフトをより完成度の高い回答に引き上げる。
• 今回の目標完成度は ${meta.targetPercent}%（全${meta.totalPasses}回のうち${meta.pass}回目）。

やること:
• 不足部分の補完、誤り修正、曖昧さの解消。
• 必要なら外部参照（Web/Docs/ログ）を軽量に行う。
• 本当に必要な情報が欠けている場合のみ、質問は最大1つ。
• ドラフトに「${INCOMPLETE_MARKER}」がある場合は補完し、マーカーは削除する。
${meta.isFinal ? "• 今回が最終回なら、マーカーは残さず、質問は最大1つに留める。" : "• それでも不足が残る場合は、マーカーを残して次の改善に回す。"}

守ること:
• 日本語で自然に返答する。
• 簡潔・親しみやすい・実用的に。
• 求められない限り内部手順は書かない。
• 返信はコンパクトに。

文体:
• 先に短く答える
• 必要なら箇条書き
• 説明はコンパクトに

ローカル作業コンテキスト:
• この Slack エージェントは \`my-agent-workbench\` で動作する。
• \`my-agent-workbench/docs/\` は必要時のみ参照・要約に使ってよい。

軽量実行ルール:
• 追加処理は合計 ~10 秒以内
• 超えそうなら省略して回答

Web 検索ポリシー:
• 最新情報/レコメンド/比較/外部事実が必要なら使う
• 検索は最大3件、要点のみ、遅いなら打ち切り

Docs 検索ポリシー:
• このリポジトリ/実装/設計の質問のみ
• 開くファイルは1〜2件まで

サマリーログ方針:
• 可能なら短いサマリー（5〜8行）
• 時間がなければスキップ
• 保存先: \`my-agent-workbench/docs/{theme}/{date}.md\`

飲食店・カフェ提案:
• 最大3件
• 店名と短い理由
• 食べログリンクを必ずつける

出力:
• Slack メッセージのみ
• 余計な文は出さない

${buildInputSection(slackText, slackContext, draft)}
  `.trim();
}

function formatMentionReply(text: string): string {
  let out = toSlackMarkdown(text);
  // Remove empty parentheses left behind by link stripping.
  out = out.replace(/\s*\(\s*\)\s*/g, " ");
  // Ensure numbered lists start on a new line.
  out = out.replace(/\s(\d+)\)/g, "\n$1)");
  // Ensure bullet points start on a new line.
  out = out.replace(/\s•/g, "\n•");
  // Collapse excessive newlines.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

function stripIncompleteMarker(text: string): string {
  let out = text || "";
  out = out.replace(INCOMPLETE_MARKER_PATTERN, "");
  return out
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function diagnoseFailure(err: ExecError) {
  const msg = `${err?.message ?? ""}\n${err?.stderr ?? ""}`.toLowerCase();
  if (msg.includes("enoent") || msg.includes("spawn codex")) {
    return "Codex CLI not found. Make sure `codex` is installed and on PATH.";
  }
  if (
    msg.includes("login") ||
    msg.includes("not logged in") ||
    msg.includes("auth")
  ) {
    return "Codex CLI authentication required. Run `codex login` and try again.";
  }
  if (msg.includes("timed out")) {
    return "Codex timed out. Shorten the request or increase the timeout.";
  }
  return "Codex execution failed. Check server stderr for details.";
}

export async function respondMention({
  slackText,
  workdir,
  slackContext,
  onProgress,
}: {
  slackText: string;
  workdir: string;
  slackContext: SlackContext | null;
  onProgress?: (payload: ProgressPayload) => void;
}) {
  const refineConfig = getRefineConfig();
  const meta = buildMeta(1, refineConfig.totalPasses);
  const prompt = buildMentionPrompt(slackText, slackContext, meta);
  try {
    const { stdout } = await runCodexExec({ prompt, cwd: workdir });
    let draftInternal = formatMentionReply((stdout || "").trim());
    if (!draftInternal) {
      throw new Error("Empty response from codex.");
    }
    const draftDisplay = stripIncompleteMarker(draftInternal);
    await onProgress?.({
      stage: "draft",
      text: draftDisplay,
      pass: 1,
      totalPasses: refineConfig.totalPasses,
      pending: refineConfig.enabled && refineConfig.maxRefines > 0,
    });
    if (refineConfig.enabled) {
      let currentInternal = draftInternal;
      let currentDisplay = draftDisplay;
      for (let attempt = 0; attempt < refineConfig.maxRefines; attempt += 1) {
        const pass = attempt + 2;
        const refinePrompt = buildRefinePrompt({
          slackText,
          slackContext,
          draft: currentInternal,
          meta: buildMeta(pass, refineConfig.totalPasses),
        });
        try {
          const { stdout: refinedStdout } = await runCodexExec({
            prompt: refinePrompt,
            cwd: workdir,
          });
          const refinedInternal = formatMentionReply(
            (refinedStdout || "").trim(),
          );
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
      if (currentInternal !== draftInternal) {
        return { ok: true, text: currentDisplay, refined: true };
      }
    }

    return { ok: true, text: draftDisplay, refined: false };
  } catch (e) {
    const hint = diagnoseFailure(e as ExecError);
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
