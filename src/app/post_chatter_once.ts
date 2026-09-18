import "dotenv/config";
import { runChatterTick } from "../services/chatter.js";

// スケジュールを待たずに、直近の会話から投稿候補を1回だけ生成する。
// 既定は dry-run。--post を付けた時だけ Slack へ投稿する。
const post = process.argv.includes("--post");
const result = await runChatterTick({ force: true, dryRun: !post });

if (result.status === "generated" || result.status === "posted") {
  console.log(post ? "💬 posted ambient chatter:\n" : "💬 dry run (not posted):\n");
  console.log(result.text);
  process.exit(0);
}

if (result.status === "skipped") {
  console.log(`💬 no chatter generated: ${result.reason}`);
  process.exit(0);
}

if (result.status === "failed") {
  console.error(`⚠️ ambient chatter failed: ${result.reason}`);
  process.exit(1);
}
