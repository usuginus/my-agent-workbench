import { runCodexExec, type ExecError } from "../integrations/codex_client.js";
import { toSlackMarkdown } from "../integrations/slack_formatters.js";
import { type SlackContext } from "../integrations/slack_api.js";

const JSON_SCHEMA = `{
  "candidates": [
    { "name": string, "reason": string, "budget_yen": number, "walk_min": number, "vibe": string, "tabelog_url": string }
  ],
  "final_message": string
}`;

function buildHangoutPrompt(
  slackText: string,
  slackContext: SlackContext | null
) {
  return `
You are a hangout planning assistant.

User request (raw Slack text):
${JSON.stringify(slackText)}

Slack context (JSON, if available):
${JSON.stringify(slackContext || null)}

Rules:
- Output VALID JSON ONLY. No markdown. No prose.
- Follow this JSON schema exactly:
${JSON_SCHEMA}
- Propose exactly 3 candidates.
- If information is missing, make reasonable assumptions instead of asking questions.
- Include a Tabelog URL for each candidate in "tabelog_url".
- Use the user's locale and context when possible. If unclear, assume Japan and typical local venues.
`.trim();
}

function tryParseJson(stdout: string) {
  // If extra lines exist, capture the first JSON object.
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in codex output.");
  }
  const jsonText = stdout.slice(start, end + 1);
  return JSON.parse(jsonText);
}

function parseHangoutText(slackText: string): {
  area: string;
  budget: string;
  people: string;
  time: string;
} {
  const text = (slackText || "").trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const [area, budget, people, time] = parts;
  return {
    area: area || "未指定",
    budget: budget || "未指定",
    people: people || "未指定",
    time: time || "未指定",
  };
}

export function formatSearchConditions(slackText: string): string {
  const cond = parseHangoutText(slackText);
  return `🔎 検索条件: エリア=${cond.area}, 予算=${cond.budget}円/人, 人数=${cond.people}, 開始=${cond.time}`;
}

function formatHangoutMessage(plan: {
  candidates: Array<{
    name: string;
    reason: string;
    budget_yen: number;
    walk_min: number;
    vibe: string;
    tabelog_url?: string;
  }>;
  final_message?: string;
}): string {
  const lines = [];
  lines.push(`🍻 *候補（3件）*`);
  for (const [i, c] of plan.candidates.entries()) {
    const reason = toSlackMarkdown(c.reason || "");
    const urlLine = c.tabelog_url ? `• <${c.tabelog_url}|食べログ>` : "";
    lines.push(
      `*${i + 1}. ${c.name}* (¥${c.budget_yen} / 徒歩${c.walk_min}分 / ${
        c.vibe
      })\n• ${reason}${urlLine ? `\n${urlLine}` : ""}`
    );
  }
  if (plan.final_message) {
    lines.push(`\n📣 *集合メッセージ*\n${toSlackMarkdown(plan.final_message)}`);
  }
  return lines.join("\n");
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

export async function planHangout({
  slackText,
  workdir,
  slackContext,
}: {
  slackText: string;
  workdir: string;
  slackContext: SlackContext | null;
}) {
  const prompt1 = buildHangoutPrompt(slackText, slackContext);

  try {
    const { stdout } = await runCodexExec({ prompt: prompt1, cwd: workdir });
    const plan = tryParseJson(stdout);
    return { ok: true, text: formatHangoutMessage(plan), raw: plan };
  } catch (e1) {
    // Retry once with a stronger JSON-only instruction.
    const prompt2 = `${prompt1}\n\nIMPORTANT: Output JSON ONLY. Do not include any other text.`;
    try {
      const { stdout } = await runCodexExec({ prompt: prompt2, cwd: workdir });
      const plan = tryParseJson(stdout);
      return { ok: true, text: formatHangoutMessage(plan), raw: plan };
    } catch (e2) {
      const hint = diagnoseFailure(e2 as ExecError);
      console.error("planHangout failed", {
        error1: (e1 as ExecError)?.message,
        error2: (e2 as ExecError)?.message,
        stderr: (e2 as ExecError)?.stderr ?? (e1 as ExecError)?.stderr,
        stdout: (e2 as ExecError)?.stdout ?? (e1 as ExecError)?.stdout,
      });
      const debugEnabled =
        process.env.PLANNER_DEBUG === "1" ||
        process.env.PLANNER_DEBUG === "true";
      return {
        ok: false,
        text: debugEnabled
          ? `⚠️ 提案を生成できませんでした。\n原因: ${hint}`
          : `⚠️ 提案を生成できませんでした。条件を短くしてもう一度試してください。（例: \`/hangout 六本木 5000 4 19:30\`）\n原因: ${hint}`,
        debug: {
          error1: e1?.message,
          error2: e2?.message,
          stderr: e2?.stderr ?? e1?.stderr,
        },
      };
    }
  }
}
