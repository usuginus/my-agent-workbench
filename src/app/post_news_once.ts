import "dotenv/config";
import { postNewsDigest } from "../services/news.js";

// cron を待たずに1回だけニュース便を投稿する手動テスト用エントリポイント。
// --dry-run なら Slack には投稿せず、生成された本文を標準出力に出すだけ。
const dryRun = process.argv.includes("--dry-run");
const result = await postNewsDigest({ dryRun });
if (result.ok) {
  if (dryRun) {
    console.log("🗞 dry run (not posted):\n");
    console.log(result.text);
  } else {
    console.log(`🗞 posted news digest to ${result.channelId}`);
  }
  process.exit(0);
} else {
  console.error(`⚠️ news digest failed: ${result.error}`);
  process.exit(1);
}
