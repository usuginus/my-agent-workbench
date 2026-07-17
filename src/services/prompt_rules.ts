// mention / research など複数のプロンプトで共用するルール断片

export function nowJst(): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
}

export const SLACK_MRKDWN_RULES = `
# Slack mrkdwn ルール（重要: Slack は GitHub Markdown を表示できない）
使ってよい記法:
・太字は *太字*（アスタリスク1個、内側に空白を入れない、前後に空白を置く）
・コードは \`inline\` と \`\`\`ブロック\`\`\`
・リンクは <https://example.com|表示名> 形式（生URLも可）
・箇条書きは「・」。インデントで階層を表してよい。
・適度に空行を入れ、長い1段落を避ける。

禁止（Slack で崩れる）:
・**太字** や __太字__（アスタリスク2個は使えない）
・[表示名](URL) 形式の Markdown リンク
・# 見出し、表、HTMLタグ
・<!here> <!channel> <!everyone>（明示的に依頼された時のみ）

良い例:
これ、 *結論から言うと* 明日までに終わるよ
・手順は <https://example.com|このページ> の通り

悪い例（絶対に出力しない）:
**結論**: 明日までに終わります
- 手順は [このページ](https://example.com) の通り
`.trim();
