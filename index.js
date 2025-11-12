// index.js — B案: まず場所を聞く → その後に詳細回答
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
あなたは「AIくん」です。親しみやすい自然な日本語で、
ユーザーの質問に「①結論 → ②具体 → ③最新SNS/WEB → ④代案 → ⑤次の一手」
の順で簡潔・実用的に答えます。固有名詞をできるだけ入れてください。
sources が薄い時は「可能性」「未確認」など控えめに。追加質問は1つだけ。
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
  const { data } = await supabase
    .from("conversation_messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT * 2);

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
async function socialSearch(queryText) {
  const tbs = daysToTbs(RECENCY_DAYS);
  const siteQuery =
    '(site:x.com OR site:twitter.com) OR site:instagram.com OR site:reddit.com';
  const q = `${queryText} ${siteQuery}`;
  const raw = await webSearch(q, { num: 8, tbs, gl: "jp", hl: "ja" });

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

/* ========= Intent & Location ========= */
const PREFS = "北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|東京都|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄";
const BIG_CITIES = "札幌|仙台|東京|渋谷|新宿|池袋|横浜|川崎|千葉|大宮|名古屋|京都|大阪|梅田|難波|天王寺|神戸|三宮|博多|天神|福岡|那覇|鎌倉|吉祥寺|中目黒|下北沢";

function classifyIntent(text) {
  const t = text || "";
  if (/どこ|近く|周辺|最寄り|アクセス|営業時間|住所|地図/i.test(t)) return "place";
  if (/(駅|市|区|町|村|県|都|道|府)/.test(t)) return "place";
  return "general";
}

function hasLocationHint(text) {
  const t = text || "";
  const re1 = new RegExp(`(${PREFS})`);
  const re2 = new RegExp(`(${BIG_CITIES})`);
  if (re1.test(t) || re2.test(t)) return true;
  if (/駅/.test(t)) return true;
  // 単語が短くても「渋谷」「原宿」等は上のBIG_CITIESで取れる
  return false;
}

/* 前回が「今どこに？」で、その直前のユーザー質問を取り出す */
function getPendingPlaceQuery(history) {
  // 履歴末尾から見て「assistant: 今どこにいますか？」があれば
  // その直前の user 発話を基点クエリとして返す
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant" && /今どこにいますか？/.test(m.content)) {
      // さらに前を探す
      for (let j = i - 1; j >= 0; j--) {
        if (history[j].role === "user") {
          return history[j].content.trim();
        }
      }
      break;
    }
  }
  return null;
}

/* ========= Health ========= */
app.get("/", (_, res) => res.send("AI-kun running"));

/* ========= Webhook ========= */
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events ?? [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error("Webhook error:", e);
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

  // --- B案：まず場所を聞く ---
  const intent = classifyIntent(userText);
  const locationInText = hasLocationHint(userText);

  // 1) 「場所系」かつ「地名なし」→ 以前の定型を返して終了
  if (intent === "place" && !locationInText) {
    const reply = "了解！調べるね。今どこにいますか？（市区町村や最寄り駅でもOK）";
    await saveMessage(conversationId, "assistant", reply);
    await lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
    return;
  }

  // 2) 位置だけ来たっぽい場合（例：「渋谷」）→ 直前の質問内容を補完
  let baseQuery = null;
  if (locationInText && !/どこ|周辺|近く|アクセス|住所|地図|営業時間/.test(userText)) {
    // ユーザーが「渋谷」だけ送ってきたケース
    baseQuery = getPendingPlaceQuery(history);
  }

  // 検索クエリを決定
  const finalQuery = baseQuery ? `${baseQuery} ${userText}` : userText;

  /* ====== SNS / Web 検索（常に実施） ====== */
  let social = [];
  let web = [];
  try {
    social = await socialSearch(finalQuery);
    web = await webSearch(finalQuery, {});
  } catch (e) {
    console.error("search error:", e);
  }

  /* ====== LLM に渡す素材 ====== */
  const sourceText =
    renderSources(`SNS（直近${RECENCY_DAYS}日）`, social) +
    renderSources("Web sources", web);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    {
      role: "user",
      content: `
【質問】
${finalQuery}

【意図分類】${intent}
（場所系のときでも、まず答えを返し、その後に具体住所を補って案内してください）

【検索素材】
${sourceText || "（該当する公開投稿が少ない/なし）"}

▼ 以下テンプレで回答
① 結論
② 具体情報（固有名詞 / 詳細 / 価格や営業時間 / 店名 等）
③ 最新SNS/WEBの観測（直近${RECENCY_DAYS}日の動き）
④ 別の選択肢/代案（実店舗 / EC / 相談先 / 動画など）
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
  } catch (e) {
    console.error("OpenAI error:", e);
    reply = "少し混み合っています…もう一度試してみてもらえますか？";
  }

  await saveMessage(conversationId, "assistant", reply);
  await lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
}

/* ========= Start ========= */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`AI-kun running on ${port}`));
