import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanChatterOutput,
  computePostingProbability,
  isWithinActiveHours,
  selectRecentHumanMessages,
  weekStartJst,
} from "./chatter.js";

test("weekStartJst uses Monday in JST", () => {
  assert.equal(weekStartJst(new Date("2026-07-19T00:00:00Z")), "2026-07-13");
  assert.equal(weekStartJst(new Date("2026-07-19T15:30:00Z")), "2026-07-20");
});

test("isWithinActiveHours evaluates the hour in JST", () => {
  assert.equal(isWithinActiveHours(new Date("2026-07-19T00:00:00Z"), 9, 24), true);
  assert.equal(isWithinActiveHours(new Date("2026-07-18T23:59:00Z"), 9, 24), false);
});

test("selectRecentHumanMessages drops bots and stale messages", () => {
  const now = new Date("2026-07-19T12:00:00Z");
  const ts = (minutesAgo: number) =>
    String((now.getTime() - minutesAgo * 60 * 1000) / 1000);
  const selected = selectRecentHumanMessages(
    [
      { user: "U1", text: "最新", ts: ts(5) },
      { bot_id: "B1", text: "bot", ts: ts(10) },
      { user: "U2", text: "ちょい前", ts: ts(20) },
      { user: "U3", text: "古い", ts: ts(100) },
    ],
    now,
    90,
  );
  assert.deepEqual(
    selected.map((message) => message.user),
    ["U2", "U1"],
  );
});

test("computePostingProbability stays bounded and stops at the target", () => {
  assert.equal(
    computePostingProbability({
      remainingPosts: 0,
      remainingSlots: 100,
      messageCount: 5,
      newestAgeMinutes: 5,
      opportunityRate: 0.35,
    }),
    0,
  );
  const probability = computePostingProbability({
    remainingPosts: 5,
    remainingSlots: 100,
    messageCount: 12,
    newestAgeMinutes: 5,
    opportunityRate: 0.35,
  });
  assert.ok(probability >= 0.01 && probability <= 0.45);
});

test("cleanChatterOutput permits tiny reactions and blocks broad mentions", () => {
  assert.equal(cleanChatterOutput("草"), "草");
  assert.equal(cleanChatterOutput("<!channel> 草"), "草");
  assert.equal(cleanChatterOutput("<@U123ABC> それな"), "それな");
  assert.equal(cleanChatterOutput("SKIP"), null);
});
