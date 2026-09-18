import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewsPrompt,
  getNewsConfig,
  updateNewsState,
  type NewsState,
} from "./news.js";

test("getNewsConfig parses extra interests and derives a local state path", () => {
  const config = getNewsConfig({
    NEWS_CHANNEL_ID: " C123 ",
    NEWS_CRON: "0 18 * * 1-5",
    NEWS_EXTRA_INTERESTS: "VRChat, 制御工学\n新しいSNS",
    MEMORY_DIR: "/tmp/news-test-memory",
  });

  assert.equal(config.channelId, "C123");
  assert.equal(config.cron, "0 18 * * 1-5");
  assert.deepEqual(config.extraInterests, ["VRChat", "制御工学", "新しいSNS"]);
  assert.equal(config.statePath, "/tmp/news-test-memory/news-state.json");
});

test("updateNewsState keeps public headings and URLs without duplicates", () => {
  const current: NewsState = {
    version: 1,
    lastPostedAt: "2026-09-17T08:30:00.000Z",
    recentTopics: ["前回のモデル更新"],
    recentUrls: ["https://example.com/old"],
  };
  const next = updateNewsState(
    current,
    [
      "*Geminiの日本語音声が改善*",
      "<https://example.com/gemini|公式>",
      "*国内フィジカルAIが量産へ*",
      "<https://example.com/robot|ニュース>",
      "<https://example.com/gemini|重複リンク>",
    ].join("\n"),
    "2026-09-18T08:30:00.000Z",
  );

  assert.deepEqual(next.recentTopics.slice(0, 3), [
    "Geminiの日本語音声が改善",
    "国内フィジカルAIが量産へ",
    "前回のモデル更新",
  ]);
  assert.deepEqual(next.recentUrls.slice(0, 3), [
    "https://example.com/gemini",
    "https://example.com/robot",
    "https://example.com/old",
  ]);
  assert.equal(next.lastPostedAt, "2026-09-18T08:30:00.000Z");
});

test("buildNewsPrompt encodes the agreed editorial and privacy policy", () => {
  const prompt = buildNewsPrompt({
    recentState: {
      version: 1,
      lastPostedAt: "2026-09-17T08:30:00.000Z",
      recentTopics: ["昨日扱ったAIモデル"],
      recentUrls: ["https://example.com/previous"],
    },
    extraInterests: ["VRChat"],
  });

  assert.match(prompt, /2〜3本/);
  assert.match(prompt, /3本に満たなくても穴埋めしない/);
  assert.match(prompt, /日本語の記事を中心/);
  assert.match(prompt, /中国系モデル.*日本語圏/u);
  assert.match(prompt, /日本の暗号資産市場構造法制/);
  assert.match(prompt, /Mogura VR/);
  assert.match(prompt, /合計8点以上/);
  assert.match(prompt, /昨日扱ったAIモデル/);
  assert.match(prompt, /example\.com\/previous/);
  assert.match(prompt, /VRChat/);
  assert.doesNotMatch(prompt, /長期記憶ポータル|直近のSlack会話/);
});
