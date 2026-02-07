import { runCodexExec, type ExecError } from "../integrations/codex_client.js";
import { toSlackMarkdown } from "../integrations/slack_formatters.js";
import { type SlackContext } from "../integrations/slack_api.js";

function buildMentionPrompt(
  slackText: string,
  slackContext: SlackContext | null,
): string {
  return `
You are a helpful assistant responding in a Slack channel.
Respond naturally in Japanese to the user's mention. Be concise and friendly.

User message:
${JSON.stringify(slackText)}

Slack context (JSON, if available):
${JSON.stringify(slackContext || null)}

Workflow (do these in order):
1) Prefer web research: When answering, try to run an internet search first to ensure up-to-date and accurate info.
• URLs are allowed if relevant.
2) Reference local docs before answering: Search under /docs for related past notes and use them as optional context.
• You do NOT have to use them, but if they are helpful, briefly mention examples like: "参考: /docs/<theme>/<date>.md".
3) Persist the run result to docs: For every execution, summarize what you did and learned into:
• Path: /docs/{theme}/{date}.md
• {date}: YYYY-MM-DD (local time)
• {theme}: a short slug derived from the user's topic (e.g., "slack-agent-memory", "aws-budgets")
• If the file already exists, update/append rather than creating a duplicate.
4) Doc content guideline (keep it short): include
• Question, brief answer, key links, decisions/assumptions, TODO/next steps (if any)

Output constraints:
• In Slack reply, do not paste the full doc; only answer + (optional) 1-line reference to the doc path.
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
