import { runCodexExec } from "./codex.js";

const JSON_SCHEMA = `{
  "candidates": [
    { "name": string, "reason": string, "budget_yen": number, "walk_min": number, "vibe": string, "tabelog_url": string }
  ],
  "final_message": string
}`;

function buildPrompt(slackText) {
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

export function parseSlackText(slackText) {
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

export function formatSearchConditions(slackText) {
  const cond = parseSlackText(slackText);
  return `🔎 検索条件 エリア=${cond.area} / 予算=${cond.budget}円/人 / 人数=${cond.people}名 / 開始=${cond.time}`;
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

function formatSlackText(plan) {
  const lines = [];
  const toSlackLinks = (text) =>
    text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>");
  lines.push(`🍻 *飲み会候補（3件）*`);
  for (const [i, c] of plan.candidates.entries()) {
    const rawReason = c.reason || "";
    const hasUrl = /https?:\/\//.test(rawReason);
    const reasonWithLink = hasUrl
      ? rawReason
      : `${rawReason} ([食べログ](${c.tabelog_url}))`;
    const reason = toSlackLinks(reasonWithLink);
    lines.push(
      `*${i + 1}. ${c.name}* （目安 ¥${c.budget_yen} / 徒歩${c.walk_min}分 / ${
        c.vibe
      }）\n・${reason}`
    );
  }
  if (plan.final_message) {
    lines.push(`\n📣 *集合メッセージ案*\n${toSlackLinks(plan.final_message)}`);
  }
  return lines.join("\n");
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
  const prompt1 = buildPrompt(slackText);

  try {
    const { stdout } = await runCodexExec({ prompt: prompt1, cwd: workdir });
    const plan = tryParseJson(stdout);
    return { ok: true, text: formatSlackText(plan), raw: plan };
  } catch (e1) {
    // 1回だけ再試行：JSON only をさらに強く
    const prompt2 = `${prompt1}\n\nIMPORTANT: Output JSON ONLY. Do not include any other text.`;
    try {
      const { stdout } = await runCodexExec({ prompt: prompt2, cwd: workdir });
      const plan = tryParseJson(stdout);
      return { ok: true, text: formatSlackText(plan), raw: plan };
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
    const text = (stdout || "").trim();
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
