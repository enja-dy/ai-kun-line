import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/* ========= LINE / OpenAI ========= */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(config);
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ========= Supabase ========= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

/* ========= SerpAPI ========= */
const SERPAPI_KEY = process.env.SERPAPI_KEY;

/* ========= SNS recency days ========= */
const RECENCY_DAYS = Math.max(
  1,
  parseInt(process.env.SOCIAL_SEARCH_RECENCY_DAYS || "14", 10)
);

/* ========= SYSTEM PROMPT ========= */
const SYSTEM_PROMPT = `
あなたは「AIくん」です。
親しみやすい自然な日本語で、ユーザーの質問に
「①結論 → ②具体 → ③最新SNS/WEB → ④代案 → ⑤次の一手」
の流れで、簡潔かつ役立つ回答を返します。

▼回答テンプレ
① 結論（まず答える）
② 具体情報（固有名詞 / 詳細 / 価格 / 店名 等）
③ 最新SNS/WEBの観測
④ 別の選択肢 / 代案
⑤ 次の一手（追加質問1つ）

▼重要
- なるべく固有名詞を使う
- SNS/WEB情報を要約し「動き/傾向/目撃/感想」を反映
- 不確実なら「可能性」「未確認」等の表現
- 追加質問は1つだけ
- 相談系もOK：状況整理→提案→次の一手
- 文章は簡潔
`;

/* ========= Conversation ID ========= */
function getConversationId(event) {
  const s = event.source ?? {};
  if (s.groupId) return `group:${s.groupId}`;
  if (s.roomId) return `room:${s.roomId}`;
  if (s.userId) return `user:${s.userId}`;
  return "unknown";
}

/* ========= DB: HISTORY ========= */
const HISTORY_LIMIT = 12;

async function fetchRecentMessages(conversationId) {
  const { data, error } = await supabase
    .from("conversation_messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT * 2);
  if (error) return [];

  return (data ?? [])
    .reverse()
    .map((r) => ({ role: r.role, content: r.content }))
    .filter((m) => m.role === "user" || m.role === "assistant");
}

async function saveMessage(conversationId, role, content) {
  await supabase.from("conversation_messages").insert([
    { conversation_id: conversationId, role, content },
  ]);
}

/* ========= Google Search via SerpAPI ========= */
function daysToTbs(days) {
  if (days <= 7) return "qdr:w";  // 1 week
  if (days <= 31) return "qdr:m"; // 1 month
  return "qdr:y";
}

async function webSearch(query, opts = {}) {
  if (!SERPAPI_KEY) return [];
  const { num = 6, gl = "jp", hl = "ja", tbs } = opts;
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    num: String(num),
    gl,
    hl,
    api_key: SERPAPI_KEY,
  });
  if (tbs) params.set("tbs", tbs);

  const url = `https://serpapi.com/search.json?${params.toString()}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    const items = j.organic_results || [];
    return items
      .filter((it) => it.title && it.link)
      .map((it) => ({
        title: it.title,
        snippet: it.snippet || "",
        link: it.link,
      }));
  } catch {
    return [];
  }
}

/* ========= SNS (X / Instagram / Reddit) ========= */
async function socialSearch(userText) {
  const tbs = daysToTbs(RECENCY_DAYS);
  const siteQuery =
    '(site:x.com OR site:twitter.com) OR site:instagram.com OR site:reddit.com';
  const q = `${userText} ${siteQuery}`;
  const raw = await webSearch(q, { num: 8, tbs });

  // 限定して整理
  const seen = new Set();
  const arr = [];
  for (const r of raw) {
    const key = r.link.replace(/(\?.*)$/, "");
    if (!seen.has(key)) {
      seen.add(key);
      arr.push(r);
    }
    if (arr.length >= 8) break;
  }
  return arr;
}

/* ========= Sources → text ========= */
function renderSources(title, arr) {
  if (!arr?.length) return "";
  const lines = arr
    .slice(0, 6)
    .map((s, i) => `(${i + 1}) ${s.title}\n${s.link}`)
    .join("\n");
  return `\n\n[${title}]\n${lines}`;
}

/* ========= Intent (緩め) ========= */
const PLACE_HINTS = [
  /場所|住所|地図|最寄り|周辺|アクセス/,
  /カフェ|レストラン|コンビニ|駅|渋谷|新宿|池袋|横浜|鎌倉|博多/,
];

function classifyIntent(userText) {
  if (!userText) return "general";
  if (PLACE_HINTS.some((re) => re.test(userText))) return "place";
  return "general";
}

/* ========= Health ========= */
app.get("/", (_, res) => res.send("AI-kun running"));

/* ========= Webhook ========= */
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events ?? [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch {
    res.status(200).end();
  }
});

/* ========= MAIN ========= */
async function handleEvent(event) {
  if (event.type !== "message" || event.message?.type !== "text") return;

  const userText = (event.message.text ?? "").trim();
  const conversationId = getConversationId(event);

  // reset
  if (userText === "リセット" || userText.toLowerCase() === "reset") {
    await supabase
      .from("conversation_messages")
      .delete()
      .eq("conversation_id", conversationId);
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "会話履歴をリセットしました。どうぞ！",
    });
    return;
  }

  await saveMessage(conversationId, "user", userText);

  const history = await fetchRecentMessages(conversationId);
  const intent = classifyIntent(userText);

  /* ====== SNS / Web を常に検索 ====== */
  let social = [];
  let web = [];
  try {
    social = await socialSearch(userText);
    web = await webSearch(userText, {});
  } catch {}

  /* ====== LLM に渡す素材 ====== */
  const sourceText =
    renderSources("SNS（直近）", social) +
    renderSources("Web sources", web);

  /* ====== 共通テンプレで返す ====== */
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    {
      role: "user",
      content: `
【質問】
${userText}

【検索素材】
${sourceText}

▼ 以下テンプレで回答
① 結論
② 具体情報（固有名詞 / 詳細）
③ 最新SNS/WEBの観測
④ 別の選択肢/代案
⑤ 次の一手（追加質問1つ）
`,
    },
  ];

  let reply = "…";
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.5,
      max_tokens: 1100,
    });
    reply = resp.choices?.[0]?.message?.content?.trim() || "…";
  } catch {
    reply = "混み合っています…もう一度試してください！";
  }

  await saveMessage(conversationId, "assistant", reply);
  await lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: reply,
  });
}

/* ========= Start ========= */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`AI-kun running on ${port}`));
