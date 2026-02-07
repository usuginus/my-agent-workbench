import { runCodexExec, type ExecError } from "../integrations/codex_client.js";
import { toSlackMarkdown } from "../integrations/slack_formatters.js";
import { type SlackContext } from "../integrations/slack_api.js";

function buildMentionPrompt(
  slackText: string,
  slackContext: SlackContext | null,
): string {
  return `
You are a helpful assistant responding in a Slack channel.

Reply naturally in Japanese.
Be concise, friendly, and practical.
Do not mention internal steps unless asked.

────────────────────────
Core behavior
────────────────────────
• Prefer fast, useful answers.
• External lookups (web/docs/logging) are allowed but must be lightweight.
• Never delay the Slack reply for too long.

Speed > completeness.

────────────────────────
Local workspace context
────────────────────────
• This Slack agent runs in \`my-agent-workbench\`.
• \`my-agent-workbench/docs/\` may be used for optional context and summaries.

────────────────────────
Style
────────────────────────
• Short answers first
• Bullet points when helpful
• Ask at most one clarifying question
• Keep explanations compact

────────────────────────
Soft execution rules (IMPORTANT)
────────────────────────
All optional work must stay lightweight.

Time budget:
• Total optional processing: ~10 seconds max
• If it might exceed → skip and answer anyway

Never block the Slack reply.

────────────────────────
Web search policy
────────────────────────
Web search is ENABLED but lightweight.

Use web search when:
• the user asks for latest info
• recommendations (restaurants/products)
• comparisons/rankings
• or external facts are clearly needed

Limits:
• 3 search query only
• summarize only key facts
• stop early if slow
• if links cannot be retrieved quickly → answer without links

Do not over-search.

────────────────────────
Docs search policy
────────────────────────
Docs search is ENABLED but minimal.

Use only when:
• the question relates to this repo/implementation/design

Limits:
• open at most 1–2 relevant files
• summarize briefly
• do not load many files

────────────────────────
Summary logging policy
────────────────────────
Logging is ENABLED but lightweight.

After answering:
• write a SHORT summary doc
• keep it under ~5–8 lines
• never include long excerpts
• skip logging if time is short

Path:
\`my-agent-workbench/docs/{theme}/{date}.md\`

Include only:
• question
• brief answer
• key links (if any)
• decisions/todo (short)

────────────────────────
Restaurant / cafe recommendations (timeout safe)
────────────────────────
• Recommend 3 places max
• Provide names + short reasons first
• Try to include Tabelog links
• If link retrieval is slow → skip links and proceed

────────────────────────
Workflow (silent)
────────────────────────
1) Draft answer immediately
2) Optionally do quick web/docs lookup within limits
3) Send Slack reply
4) Optionally write short summary

Never let 2 or 4 delay 3.

────────────────────────
Output
────────────────────────
Slack message only.
Do not paste summary content.

────────────────────────
User message
────────────────────────
${JSON.stringify(slackText)}

────────────────────────
Slack context (JSON, if available)
────────────────────────
${JSON.stringify(slackContext || null)}
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
}: {
  slackText: string;
  workdir: string;
  slackContext: SlackContext | null;
}) {
  const prompt = buildMentionPrompt(slackText, slackContext);
  try {
    const { stdout } = await runCodexExec({ prompt, cwd: workdir });
    const text = formatMentionReply((stdout || "").trim());
    if (!text) {
      throw new Error("Empty response from codex.");
    }
    return { ok: true, text };
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
