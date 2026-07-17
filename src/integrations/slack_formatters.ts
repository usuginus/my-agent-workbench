export function stripBotMention(text: string): string {
  return (text || "").replace(/^<@[^>]+>\s*/, "").trim();
}

// コードブロック・inline code はサニタイズ対象から外す（split の capture group で奇数 index に入る）
const CODE_SEGMENT_PATTERN = /(```[\s\S]*?```|`[^`\n]+`)/g;

// Slack の太字は `*text*`（内側に前後空白なし）のみ有効
const BOLD_PATTERN = "\\*[^*\\s\\n](?:[^*\\n]*[^*\\s\\n])?\\*";

function convertProse(text: string): string {
  let out = text;

  // モデルがまれに吐く HTML 断片
  out = out.replace(/<br\s*\/?>/gi, "\n");
  out = out.replace(/<\/?(?:b|i|em|strong|u|p|div|span|ul|ol|li|h[1-6])\s*>/gi, "");

  // 見出し → 太字行
  out = out.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, "*$1*");

  // GitHub Markdown の強調 → Slack mrkdwn
  out = out.replace(/\*\*\*([^*\n]+)\*\*\*/g, "*$1*");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  out = out.replace(/__([^_\n]+)__/g, "*$1*");

  // Markdown リンク → Slack リンク
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>");

  // 箇条書き → ・（インデントは維持。`* item` を先に潰しておくと後段の太字補正と干渉しない）
  out = out.replace(/^(\s*)[-*+]\s+/gm, "$1・");

  // `* 〜 *` の空白入り太字は Slack で描画されない。
  // ただし `*a* と *b*` の「* と *」を誤って太字化しないよう、両端が空白/行頭行末のときだけ直す
  out = out.replace(
    /(^|[\s　])\*[ \t]+([^*\n]+?)[ \t]+\*(?=$|[\s　])/gm,
    "$1*$2*",
  );

  // 「これは*重要*です」のように文字が密着していると描画されないため空白を補う
  out = out.replace(
    new RegExp(`([\\p{L}\\p{N}])(${BOLD_PATTERN})`, "gu"),
    "$1 $2",
  );
  out = out.replace(
    new RegExp(`(${BOLD_PATTERN})([\\p{L}\\p{N}])`, "gu"),
    "$1 $2",
  );

  return out;
}

/**
 * LLM 出力を Slack mrkdwn として安全に表示できる形へ正規化する。
 * Slack へ投稿するテキストは必ずこの関数を通す。
 */
export function sanitizeForSlack(text: string): string {
  const parts = (text || "")
    .split(CODE_SEGMENT_PATTERN)
    .map((segment, index) => (index % 2 === 1 ? segment : convertProse(segment)));

  // inline code も太字と同じ単語境界ルールがあり、「`xxx`というのも」のように
  // 文字が密着すると描画されない。コード側は触れず、前後の地の文に空白を補う
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i].startsWith("```")) continue;
    if (/[\p{L}\p{N}]$/u.test(parts[i - 1] ?? "")) {
      parts[i - 1] = `${parts[i - 1]} `;
    }
    if (/^[\p{L}\p{N}]/u.test(parts[i + 1] ?? "")) {
      parts[i + 1] = ` ${parts[i + 1]}`;
    }
  }

  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}
