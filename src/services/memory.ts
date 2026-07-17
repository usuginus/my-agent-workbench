import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCodexExec, type ExecError } from "../integrations/codex_client.js";
import { type SlackContext } from "../integrations/slack_api.js";

// 長期記憶の置き場。PORTAL.md が入口で、毎回の応答プロンプトに注入される。
// people/ channels/ は決定的な JS 書き込み、PORTAL.md は Codex による蒸留で育つ。
const MEMORY_DIR = path.resolve(process.env.MEMORY_DIR || "memory");
const PORTAL_PATH = path.join(MEMORY_DIR, "PORTAL.md");
const PEOPLE_DIR = path.join(MEMORY_DIR, "people");
const CHANNELS_DIR = path.join(MEMORY_DIR, "channels");
const LOG_DIR = path.join(MEMORY_DIR, "log");

const PORTAL_MAX_CHARS = 6000;
const PORTAL_INJECT_MAX_CHARS = 4000;
const RECENT_TOPICS_MAX = 5;
const TOPIC_SNIPPET_MAX = 80;

const PORTAL_SEED = `# 長期記憶ポータル

エージェントの長期記憶の入口。全ての応答プロンプトに自動で読み込まれる。
やり取りのたびに記憶蒸留プロセスが自動更新する。手動で直接編集しても良い。

## ワークスペース
（まだ情報なし）

## 人物
（まだ情報なし）

## 継続中の話題・約束
（まだ情報なし）

## 学び・好み
（まだ情報なし）
`;

export type PersonMemory = {
  id: string;
  name?: string;
  real_name?: string;
  display_name?: string;
  title?: string;
  first_seen: string;
  last_seen: string;
  interactions: number;
  recent_topics: string[];
};

export type ChannelMemory = {
  id: string;
  name?: string;
  topic?: string;
  purpose?: string;
  first_seen: string;
  last_seen: string;
  interactions: number;
  recent_topics: string[];
  member_ids?: string[];
};

export type MemoryContext = {
  portal: string;
  request_user?: PersonMemory;
  channel?: ChannelMemory;
};

export type InteractionRecord = {
  kind: "mention" | "nomikai";
  channel_id: string;
  user_id?: string;
  question: string;
  answer: string;
  at: string;
};

async function ensureDirs() {
  await mkdir(PEOPLE_DIR, { recursive: true });
  await mkdir(CHANNELS_DIR, { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  const raw = await readTextIfExists(filePath);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function loadPortal(): Promise<string> {
  const existing = await readTextIfExists(PORTAL_PATH);
  if (existing?.trim()) return existing;
  await ensureDirs();
  await writeFile(PORTAL_PATH, PORTAL_SEED, "utf-8");
  return PORTAL_SEED;
}

/**
 * 応答プロンプトへ注入する記憶一式を読み込む。
 * ここで読めなくても応答は止めない（記憶なしで続行）。
 */
export async function loadMemoryContext({
  channelId,
  userId,
}: {
  channelId?: string;
  userId?: string;
}): Promise<MemoryContext | null> {
  try {
    const portal = await loadPortal();
    const context: MemoryContext = {
      portal:
        portal.length > PORTAL_INJECT_MAX_CHARS
          ? `${portal.slice(0, PORTAL_INJECT_MAX_CHARS)}\n…（以下省略）`
          : portal,
    };
    if (userId) {
      const person = await readJsonIfExists<PersonMemory>(
        path.join(PEOPLE_DIR, `${userId}.json`),
      );
      if (person) context.request_user = person;
    }
    if (channelId) {
      const channel = await readJsonIfExists<ChannelMemory>(
        path.join(CHANNELS_DIR, `${channelId}.json`),
      );
      if (channel) context.channel = channel;
    }
    return context;
  } catch (e) {
    console.warn("loadMemoryContext failed", (e as Error)?.message);
    return null;
  }
}

function pushTopic(topics: string[], question: string): string[] {
  const snippet = question.replace(/\s+/g, " ").trim().slice(0, TOPIC_SNIPPET_MAX);
  if (!snippet) return topics;
  const next = [snippet, ...topics.filter((t) => t !== snippet)];
  return next.slice(0, RECENT_TOPICS_MAX);
}

async function upsertPerson(record: InteractionRecord, slackContext: SlackContext | null) {
  if (!record.user_id) return;
  const filePath = path.join(PEOPLE_DIR, `${record.user_id}.json`);
  const existing = await readJsonIfExists<PersonMemory>(filePath);
  const profile = slackContext?.request_user;
  const person: PersonMemory = {
    id: record.user_id,
    name: profile?.name ?? existing?.name,
    real_name: profile?.real_name ?? existing?.real_name,
    display_name: profile?.display_name ?? existing?.display_name,
    title: profile?.title ?? existing?.title,
    first_seen: existing?.first_seen ?? record.at,
    last_seen: record.at,
    interactions: (existing?.interactions ?? 0) + 1,
    recent_topics: pushTopic(existing?.recent_topics ?? [], record.question),
  };
  await writeFile(filePath, `${JSON.stringify(person, null, 2)}\n`, "utf-8");
}

async function upsertChannel(record: InteractionRecord, slackContext: SlackContext | null) {
  const filePath = path.join(CHANNELS_DIR, `${record.channel_id}.json`);
  const existing = await readJsonIfExists<ChannelMemory>(filePath);
  const info = slackContext?.channel_info;
  const channel: ChannelMemory = {
    id: record.channel_id,
    name: info?.name ?? existing?.name,
    topic: info?.topic ?? existing?.topic,
    purpose: info?.purpose ?? existing?.purpose,
    first_seen: existing?.first_seen ?? record.at,
    last_seen: record.at,
    interactions: (existing?.interactions ?? 0) + 1,
    recent_topics: pushTopic(existing?.recent_topics ?? [], record.question),
    member_ids: slackContext?.channel_members ?? existing?.member_ids,
  };
  await writeFile(filePath, `${JSON.stringify(channel, null, 2)}\n`, "utf-8");
}

async function appendLog(record: InteractionRecord) {
  const month = record.at.slice(0, 7); // YYYY-MM
  await appendFile(
    path.join(LOG_DIR, `${month}.jsonl`),
    `${JSON.stringify(record)}\n`,
    "utf-8",
  );
}

function isDistillEnabled(): boolean {
  const v = process.env.MEMORY_DISTILL;
  return v !== "0" && v !== "false";
}

function buildDistillPrompt(portal: string, record: InteractionRecord, slackContext: SlackContext | null): string {
  return `
あなたは Slack アシスタントの記憶管理係です。
現在の長期記憶ポータルと、直近のやり取り1件を渡します。
永続的に価値のある情報だけをポータルへ反映し、更新後のポータル全文のみを出力してください。

反映してよい情報:
・人物の役割・専門・好み・呼び名などの持続的な特徴
・ワークスペースやチャンネルに関する事実
・継続中の話題、依頼、約束、宿題
・エージェントへのフィードバックや学び

ルール:
・出力は更新後のポータル全文のみ。前置き・説明・コードフェンスは禁止。
・全体で ${PORTAL_MAX_CHARS} 文字以内。超えそうなら古い・重要度の低い情報から削る。
・一時的な内容（挨拶、単発の雑談、その場限りの質問）は追加しない。
・見出し構造（## ワークスペース / ## 人物 / ## 継続中の話題・約束 / ## 学び・好み）は維持する。
・人物は「<@USERID>（表示名）: 事実」の形式で1人1行にまとめる。
・反映すべき新情報が何もなければ「NO_UPDATE」とだけ出力する。

現在のポータル:
---
${portal}
---

直近のやり取り (JSON):
${JSON.stringify(
    {
      at: record.at,
      kind: record.kind,
      channel: {
        id: record.channel_id,
        name: slackContext?.channel_info?.name,
        topic: slackContext?.channel_info?.topic,
      },
      user: slackContext?.request_user ?? { id: record.user_id },
      question: record.question,
      answer: record.answer,
    },
    null,
    2,
  )}
  `.trim();
}

async function distillPortal(record: InteractionRecord, slackContext: SlackContext | null) {
  if (!isDistillEnabled()) return;
  const portal = await loadPortal();
  const prompt = buildDistillPrompt(portal, record, slackContext);
  const { stdout } = await runCodexExec({ prompt, cwd: process.cwd() });
  const updated = (stdout || "").trim();
  if (!updated || updated === "NO_UPDATE") return;
  // 蒸留失敗で記憶が壊れるのが一番痛いので、ポータルらしい形をしているかだけ確認して書く
  if (updated.length < 100 || !updated.includes("## ")) {
    console.warn("memory distill produced unexpected output, skipped", {
      head: updated.slice(0, 120),
    });
    return;
  }
  await writeFile(PORTAL_PATH, `${updated.slice(0, PORTAL_MAX_CHARS)}\n`, "utf-8");
}

// 永続化は全て直列キューに載せ、並行メンションによるファイル競合を避ける
let persistQueue: Promise<void> = Promise.resolve();

function enqueue(job: () => Promise<void>) {
  persistQueue = persistQueue.then(job).catch((e) => {
    console.warn("memory persist failed", {
      error: (e as ExecError)?.message,
      stderr: (e as ExecError)?.stderr,
    });
  });
}

/**
 * やり取りを非同期で永続化する（fire-and-forget）。
 * 応答のレイテンシに影響させないため、呼び出し側は await しないこと。
 */
export function recordInteraction(
  record: InteractionRecord,
  slackContext: SlackContext | null,
): void {
  enqueue(async () => {
    await ensureDirs();
    await appendLog(record);
    await upsertPerson(record, slackContext);
    await upsertChannel(record, slackContext);
  });
  // 蒸留は Codex 呼び出しで重いので別ジョブとして直列に流す
  enqueue(() => distillPortal(record, slackContext));
}
