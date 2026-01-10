import { runCodexExec } from "./codex_client.js";
import { formatNomikaiMessage, toSlackMarkdown } from "./slack_formatters.js";

const JSON_SCHEMA = `{
  "candidates": [
    { "name": string, "reason": string, "budget_yen": number, "walk_min": number, "vibe": string, "tabelog_url": string }
  ],
  "final_message": string
}`;

function buildNomikaiPrompt(slackText) {
  return `
You are a nomikai planning agent.

User request (raw Slack text):
${JSON.stringify(slackText)}

Rules:
- Output VALID JSON ONLY. No markdown. No prose.
- Follow this JSON schema exactly:
${JSON_SCHEMA}
- Propose exactly 3 candidates.
- If information is missing, make reasonable assumptions instead of asking questions.
- Each candidate MUST include a valid Tabelog URL in "tabelog_url".
`.trim();
}

function buildMentionPrompt(slackText) {
  return `
You are a helpful assistant responding in a Slack channel.
Respond naturally in Japanese to the user's mention. Be concise and friendly.

User message:
${JSON.stringify(slackText)}
`.trim();
}

function tryParseJson(stdout) {
  // codexの出力に余計な行が混ざることがあるので、最初の { から最後の } までを拾う
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON object found in codex output.");
  }
  const jsonText = stdout.slice(start, end + 1);
  return JSON.parse(jsonText);
}

function diagnoseFailure(err) {
  const msg = `${err?.message ?? ""}\n${err?.stderr ?? ""}`.toLowerCase();
  if (msg.includes("enoent") || msg.includes("spawn codex")) {
    return "Codex CLI が見つかりません。実行環境に `codex` がインストールされ、PATH が通っているか確認してください。";
  }
  if (msg.includes("login") || msg.includes("not logged in") || msg.includes("auth")) {
    return "Codex CLI の認証が必要です。`codex login` を実行して再試行してください。";
  }
  if (msg.includes("timed out")) {
    return "Codex の応答がタイムアウトしました。条件を短くするか、タイムアウトを延ばしてください。";
  }
  return "Codex の実行に失敗しました。サーバーログの stderr を確認してください。";
}

export async function planNomikai({ slackText, workdir }) {
  const prompt1 = buildNomikaiPrompt(slackText);

  try {
    const { stdout } = await runCodexExec({ prompt: prompt1, cwd: workdir });
    const plan = tryParseJson(stdout);
    return { ok: true, text: formatNomikaiMessage(plan), raw: plan };
  } catch (e1) {
    // 1回だけ再試行：JSON only をさらに強く
    const prompt2 = `${prompt1}\n\nIMPORTANT: Output JSON ONLY. Do not include any other text.`;
    try {
      const { stdout } = await runCodexExec({ prompt: prompt2, cwd: workdir });
      const plan = tryParseJson(stdout);
      return { ok: true, text: formatNomikaiMessage(plan), raw: plan };
    } catch (e2) {
      const hint = diagnoseFailure(e2);
      console.error("planNomikai failed", {
        error1: e1?.message,
        error2: e2?.message,
        stderr: e2?.stderr ?? e1?.stderr,
        stdout: e2?.stdout ?? e1?.stdout,
      });
      const debugEnabled =
        process.env.PLANNER_DEBUG === "1" || process.env.PLANNER_DEBUG === "true";
      return {
        ok: false,
        text: debugEnabled
          ? `⚠️ うまく提案を生成できませんでした。\n原因: ${hint}`
          : `⚠️ うまく提案を生成できませんでした。条件を短くしてもう一度試してみてください。（例: \`/nomikai 渋谷 5000 4 19:30\`）\n原因: ${hint}`,
        debug: {
          error1: e1?.message,
          error2: e2?.message,
          stderr: e2?.stderr ?? e1?.stderr,
        },
      };
    }
  }
}

export async function respondMention({ slackText, workdir }) {
  const prompt = buildMentionPrompt(slackText);
  try {
    const { stdout } = await runCodexExec({ prompt, cwd: workdir });
    const text = toSlackMarkdown((stdout || "").trim());
    if (!text) {
      throw new Error("Empty response from codex.");
    }
    return { ok: true, text };
  } catch (e) {
    const hint = diagnoseFailure(e);
    console.error("respondMention failed", {
      error: e?.message,
      stderr: e?.stderr,
      stdout: e?.stdout,
    });
    return {
      ok: false,
      text: `⚠️ 返信を生成できませんでした。原因: ${hint}`,
      debug: { error: e?.message, stderr: e?.stderr },
    };
  }
}
