export function stripBotMention(text: string): string {
  return (text || "").replace(/^<@[^>]+>\s*/, "").trim();
}

function toSlackLinks(text: string): string {
  return (text || "").replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>");
}

export function toSlackMarkdown(text: string): string {
  let out = text || "";
  // Headings: "# Title" -> "*Title*"
  out = out.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, "*$1*");
  // Bold: "**text**" -> "*text*"
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // List bullets: "- item" or "* item" -> "• item"
  out = out.replace(/^\s*[-*]\s+/gm, "• ");
  out = toSlackLinks(out);
  return out.trim();
}

export function parseSlackText(slackText: string): {
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
  const cond = parseSlackText(slackText);
  return `🔎 検索条件 エリア=${cond.area}, 予算=${cond.budget}円/人, 人数=${cond.people}名, 開始=${cond.time}`;
}

export function formatNomikaiMessage(plan: {
  candidates: Array<{
    name: string;
    reason: string;
    budget_yen: number;
    walk_min: number;
    vibe: string;
    tabelog_url: string;
  }>;
  final_message?: string;
}): string {
  const lines = [];
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
