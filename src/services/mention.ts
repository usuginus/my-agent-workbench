import { runCodexExec, type ExecError } from "../integrations/codex_client.js";
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

function buildSlackReadabilityRules(): string {
  return `
トーン:
・自然体
・少しくだけても良い（ビジネス常識の範囲内）
・過剰に整理しない
・「結論」「背景」などの見出しは禁止
・AIっぽい定型構造は禁止
・自分をAIと名乗らない

Slack可読性ルール（厳守）:
・Slackのmrkdwnのみ使用: *太字* / \`inline code\` / \`\`\`code block\`\`\`
・リンクは <https://example.com|表示名> 形式を優先（生URLも可）。
・箇条書きは必ず「• 」か「- 」を使う（「・」は使わない）。
・2〜4行ごとに空行を入れ、長い1段落を避ける。

禁止:
・Markdownリンク [text](url)
・# 見出し記法、HTMLタグ、表形式
・不要な前置きや過度な装飾
・広域メンション（<!here> <!channel> <!everyone>）※明示依頼時のみ
・\`* 〜 *\` \`_ 〜 _\` \`~ 〜 ~\` のような空白入り記法

分量目安:
・基本は4〜10行。必要時のみ少し追記。
・1メッセージで完結。内部手順の長文説明はしない。
  `.trim();
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

function buildCommonPromptPolicies(): string {
  return `
共通ルール:
• 日本語で、簡潔・実用的に答える。
• 結論を先に書き、必要なら理由と次の一手を続ける。
• 内部手順・思考過程・ツール実行ログは書かない。
• 不確実な点は断定せず「前提」または「可能性」として示す。
• 情報不足で回答不能な場合のみ、質問は最大1つ。

${buildSlackReadabilityRules()}

軽量実行ルール:
• 追加処理は合計 ~10 秒以内。超えそうなら既知情報で回答する。
• Web検索は最新情報・比較・外部事実が必要な場合のみ。最大3件。
• Docs確認はこのリポジトリの実装質問のみ。開くファイルは1〜2件。

ローカル作業コンテキスト:
• この Slack エージェントは \`my-agent-workbench\` で動作する。
• \`my-agent-workbench/docs/\` は必要時のみ参照・要約に使ってよい。

出力制約:
• Slackに投稿する本文のみ出力する。
• JSON・前置き・自己紹介・メタ説明は出力しない。
• 出力直前に自己チェックし、Slack記法違反があれば必ず自分で修正してから出力する。
  `.trim();
}

function buildMentionPrompt(
  slackText: string,
  slackContext: SlackContext | null,
  meta: PromptMeta,
): string {
  return `
あなたは Slack チャンネルで返信するアシスタントです。
返信フェーズ: ${meta.pass}/${meta.totalPasses}（${meta.isFinal ? "最終回答" : "ドラフト"}）
今回の目標完成度: ${meta.targetPercent}%

このフェーズの目的:
• できるだけ速く、役に立つ一次回答を返す。
• まず短く結論を示し、必要最小限の理由と手順を添える。
• 可能なら参考リンクを添える。

ドラフト運用ルール:
• 不足があっても、わかる範囲で有用な回答を返す。
• ${meta.isFinal ? "最終回なので不完全マーカーは付けない。可能な限り完成させる。" : `回答が未完成なら末尾に「${INCOMPLETE_MARKER}${INCOMPLETE_SUFFIX}」を必ず付ける。`}
• 不足が致命的な場合のみ、質問は最大1つ。
• 出力直前に、\`* 〜 *\` や「・」箇条書きが残っていないか確認する。

${buildCommonPromptPolicies()}

入力:
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
返信フェーズ: ${meta.pass}/${meta.totalPasses}（改善）
今回の目標完成度: ${meta.targetPercent}%

このフェーズの目的:
• ドラフトを、より正確で実用的な回答に改善する。
• Web検索等を活用して、情報不足を補う。
• 不足補完・誤り修正・曖昧表現の解消を優先する。
• 良い部分は残し、必要な箇所だけを改善する。

改善ルール:
• ドラフトの主張が根拠薄い場合は、断定を弱めるか前提を明記する。
• 回答は具体的な次アクションにつなげる。
• ドラフトに「${INCOMPLETE_MARKER}」がある場合は、補完できたら必ず削除する。
• ${meta.isFinal ? "最終回ではマーカーを残さない。必要なら前提を明記し、質問は最大1つまで。" : "補完後も不足が残る場合のみ、マーカーを残してよい。"}
• 出力直前に、Slack表示が崩れる記法（\`* 〜 *\`、Markdownリンク、見出し\`#\`）を除去・修正する。

${buildCommonPromptPolicies()}

入力:
${buildInputSection(slackText, slackContext, draft)}
  `.trim();
}

function stripIncompleteMarker(text: string): string {
  let out = text || "";
  out = out.replace(INCOMPLETE_MARKER_PATTERN, "");
  return out
    .replace(/[ \t]{2,}/g, " ")
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
    let draftInternal = (stdout || "").trim();
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
