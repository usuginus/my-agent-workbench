import { runCodexExec, type ExecError } from "../integrations/codex_client.js";
import { toSlackMarkdown } from "../integrations/slack_formatters.js";
import { type SlackContext } from "../integrations/slack_api.js";

const INCOMPLETE_MARKER = "※暫定回答";
const INCOMPLETE_SUFFIX = "（追記予定）";
const DEFAULT_MAX_REFINES = 4;
const DRAFT_COMPLETENESS = 50;

function getTargetCompleteness(pass: number, totalPasses: number): number {
  if (totalPasses <= 1) return 100;
  const clampedPass = Math.min(Math.max(pass, 1), totalPasses);
  const span = 100 - DRAFT_COMPLETENESS;
  const step = span / (totalPasses - 1);
  return Math.round(DRAFT_COMPLETENESS + step * (clampedPass - 1));
}

function buildMentionPrompt(
  slackText: string,
  slackContext: SlackContext | null,
  meta: {
    pass: number;
    totalPasses: number;
    targetPercent: number;
    isFinal: boolean;
  },
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

ユーザーメッセージ:
${JSON.stringify(slackText)}

Slack コンテキスト（JSON / ある場合）:
${JSON.stringify(slackContext || null)}
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
  meta: {
    pass: number;
    totalPasses: number;
    targetPercent: number;
    isFinal: boolean;
  };
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
• 食べログリンクは取れなければ省略

出力:
• Slack メッセージのみ
• 余計な文は出さない

ユーザーメッセージ:
${JSON.stringify(slackText)}

Slack コンテキスト（JSON / ある場合）:
${JSON.stringify(slackContext || null)}

ドラフト回答:
${JSON.stringify(draft)}
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
  onProgress?: (payload: {
    stage: "draft" | "refined";
    text: string;
    pass: number;
    totalPasses: number;
    pending: boolean;
  }) => void;
}) {
  const refineEnabled =
    process.env.CODEX_REFINE === undefined ||
    (process.env.CODEX_REFINE !== "0" &&
      process.env.CODEX_REFINE !== "false");
  const envMax = Number.parseInt(process.env.CODEX_REFINE_MAX || "", 10);
  const maxRefines =
    refineEnabled && Number.isFinite(envMax) && envMax > 0
      ? envMax
      : refineEnabled
        ? DEFAULT_MAX_REFINES
        : 0;
  const totalPasses = 1 + maxRefines;
  const prompt = buildMentionPrompt(slackText, slackContext, {
    pass: 1,
    totalPasses,
    targetPercent: getTargetCompleteness(1, totalPasses),
    isFinal: totalPasses === 1,
  });
  try {
    const { stdout } = await runCodexExec({ prompt, cwd: workdir });
    let draft = formatMentionReply((stdout || "").trim());
    if (!draft) {
      throw new Error("Empty response from codex.");
    }
    await onProgress?.({
      stage: "draft",
      text: draft,
      pass: 1,
      totalPasses,
      pending: refineEnabled && maxRefines > 0,
    });
    if (refineEnabled) {
      let current = draft;
      for (let attempt = 0; attempt < maxRefines; attempt += 1) {
        const refinePrompt = buildRefinePrompt({
          slackText,
          slackContext,
          draft: current,
          meta: {
            pass: attempt + 2,
            totalPasses,
            targetPercent: getTargetCompleteness(attempt + 2, totalPasses),
            isFinal: attempt + 2 >= totalPasses,
          },
        });
        try {
          const { stdout: refinedStdout } = await runCodexExec({
            prompt: refinePrompt,
            cwd: workdir,
          });
          const refined = formatMentionReply((refinedStdout || "").trim());
          if (refined && refined !== current) {
            current = refined;
            const remaining = maxRefines - attempt - 1;
            await onProgress?.({
              stage: "refined",
              text: current,
              pass: attempt + 2,
              totalPasses,
              pending:
                current.includes(INCOMPLETE_MARKER) && remaining > 0,
            });
          }
          if (!current.includes(INCOMPLETE_MARKER)) {
            return { ok: true, text: current, refined: true };
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
      if (current !== draft) {
        return { ok: true, text: current, refined: true };
      }
    }

    return { ok: true, text: draft, refined: false };
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
