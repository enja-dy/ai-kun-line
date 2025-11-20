// index.js — AIくん 完全版（TRIPMALL対応 + 画像解析 + 商品名抽出強化）
//
// ・テキスト：雑談 / 相談 / リサーチ（場所・住所・説明・商品検索）対応
// ・SNS/WEBリサーチ：SerpAPI
// ・画像解析：OpenAI Responses API
// ・TRIPMALL：Amazon / 楽天 / Yahoo の横断検索を自動提案（商品名抽出）
// ・回答構造：結論 → 具体情報 → SNS傾向（最大2件）→ 代案 → TRIPMALL

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
あなたは「AIくん」です。丁寧で親しみやすい自然な日本語で話します。

- 雑談や日常相談は、普通の会話としてゆるく返す。
- 調査が必要な質問（場所・住所・どんな場所・最新・比較・在庫・レビュー・ニュース・商品がどこに売ってるか等）は、
  SNS/WEBの検索結果を参考にまとめる。

【リサーチ回答フロー】
- まず「結論」を一文で伝える。
- 次に、固有名詞・数字・日付を含む「具体情報」を2〜4文で補足。
- 続いて「SNS/WEBで最近言われていること」を短く紹介（最大2件）。
- 余裕があれば「別の選択肢・代案・注意点」を添える。
- 最後に、必ず「オンライン最安値の横断検索（TRIPMALL）」のURLを提示する（控えめに自然に）。

【スタイル】
- 見出し・番号は付けない。
- 文体はやさしい会話調で、長くしすぎない。
- 不確実な情報は「可能性」「〜と言われている」など慎重に。
`;

/* ========= Util: Stream → Buffer ========= */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/* ========= Conversation ID ========= */
function getConversationId(event) {
  const s = event.source ?? {};
  if (s.groupId) return `group:${s.groupId}`;
  if (s.roomId) return `room:${s.roomId}`;
  if (s.userId) return `user:${s.userId}`;
  return "unknown";
}

/* ========= DB ========= */
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

/* ========= SerpAPI Google Search ========= */
function daysToTbs(days) {
  if (days <= 7) return "qdr:w";
  if (days <= 31) return "qdr:m";
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

  try {
    const j = await (await fetch("https://serpapi.com/search.json?" + params)).json();
    const items = j.organic_results || [];
    return items
      .map((it) => ({
        title: it.title,
        snippet: it.snippet || "",
        link: it.link,
      }))
      .filter((x) => x.title && x.link);
  } catch (e) {
    console.error("webSearch error:", e);
    return [];
  }
}

/* ========= SNS Search (X / Instagram / Reddit) ========= */
async function socialSearch(queryText) {
  const tbs = daysToTbs(RECENCY_DAYS);
  const q = `${queryText} (site:x.com OR site:twitter.com OR site:instagram.com OR site:reddit.com)`;

  const raw = await webSearch(q, { num: 8, tbs });
  const seen = new Set();
  const arr = [];

  for (const item of raw) {
    const key = item.link.replace(/(\?.*)$/, "");
    if (!seen.has(key)) {
      seen.add(key);
      arr.push(item);
    }
    if (arr.length >= 2) break; // ★ SNS 出典は最大2つ
  }
  return arr;
}

/* ========= TRIPMALL 商品名抽出（GPT使用） ========= */
async function extractProductName(text) {
  try {
    const prompt = `
次の文章から「商品名として検索に使える語」だけを抽出して返してください。
余計な語句（どこ・ある・買える・欲しい・手に入れたい・安い・通販・売ってる・場所 など）は削除し、
商品名と、商品を特定するための最小限の補助語だけを残してください。

例：
「スポンジボブのガチャガチャどこ？」 → 「スポンジボブ ガチャガチャ」
「スポンジボブのガチャガチャは買える？」 → 「スポンジボブ ガチャガチャ」
「ナルトのフィギュアを安く買うには？」 → 「ナルト フィギュア」
「鬼滅の刃のキーホルダーどこで売ってる？」 → 「鬼滅の刃 キーホルダー」

文章：${text}
商品名のみ：`;

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 50,
    });

    const name = resp.choices?.[0]?.message?.content?.trim();
    return name || "";
  } catch (e) {
    console.error("extractProductName error:", e);
    return "";
  }
}

/* ========= Intent 判定 ========= */
function classifyIntent(text) {
  const t = text.toLowerCase();
  if (/どこ|売ってる|買える|手に入れたい|通販|安い|探してる/.test(t)) return "product";
  if (/近く|周辺|最寄り/.test(t)) return "proximity";
  if (/住所|所在地/.test(t)) return "address";
  if (/どんな所|特徴|概要/.test(t)) return "describe";
  return "general";
}

/* ========= Health Check ========= */
app.get("/", (_, res) => res.send("AI-kun running"));

/* ========= Webhook ========= */
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events ?? []).map(handleEvent));
    res.status(200).end();
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(200).end();
  }
});

/* ========= MAIN ========= */
async function handleEvent(event) {
  /* ==== 画像メッセージ ==== */
  if (event.type === "message" && event.message.type === "image") {
    try {
      const stream = await lineClient.getMessageContent(event.message.id);
      const buffer = await streamToBuffer(stream);
      const b64 = buffer.toString("base64");

      const vision = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "この画像について、どんな場面・物・雰囲気なのか優しく説明してください。",
              },
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${b64}`,
              },
            ],
          },
        ],
      });

      let answer = "画像をうまく読み取れなかったみたい…もう一度送ってくれる？📷";

      try {
        const out = vision.output?.[0]?.content || [];
        const t = out.filter((c) => c.type === "output_text").map((c) => c.text);
        if (t.length) answer = t.join("\n").trim();
      } catch {}

      await lineClient.replyMessage(event.replyToken, { type: "text", text: answer });
    } catch (err) {
      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: "画像を読み取れなかった…もう一度送ってみて！📷",
      });
    }
    return;
  }

  /* ==== テキスト ==== */
  if (event.type !== "message" || event.message.type !== "text") return;

  const userText = event.message.text.trim();
  const conversationId = getConversationId(event);

  if (userText === "リセット" || userText.toLowerCase() === "reset") {
    await supabase.from("conversation_messages").delete().eq("conversation_id", conversationId);
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "会話履歴をリセットしたよ！",
    });
    return;
  }

  await saveMessage(conversationId, "user", userText);
  const history = await fetchRecentMessages(conversationId);

  const intent = classifyIntent(userText);
  let doResearch = intent !== "general";

  /* ==== 商品名抽出（product Intent のとき） ==== */
  let tripmallURL = "";
  if (intent === "product") {
    const productName = await extractProductName(userText);
    if (productName) {
      const encoded = encodeURIComponent(productName);
      tripmallURL = `https://tripmall.online/search/?q=${encoded}&sort=`;
    }
  }

  let reply = "";

  /* ==== リサーチなし（雑談） ==== */
  if (!doResearch) {
    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
          { role: "user", content: userText },
        ],
        temperature: 0.6,
        max_tokens: 800,
      });
      reply = resp.choices?.[0]?.message?.content?.trim() || "…";
    } catch {
      reply = "ちょっと混み合ってるみたい…もう一度送ってみてね！";
    }
  }

  /* ==== リサーチあり ==== */
  else {
    let social = [];
    let web = [];
    try {
      social = await socialSearch(userText);
      web = await webSearch(userText);
    } catch (e) {
      console.error("search error:", e);
    }

    const sources = [...social, ...web].slice(0, 2); // ★ SNS出典 最大2つ

    /* プロンプト形成（TRIPMALL必ず追加） */
    const hint = `
以下の構造で自然な日本語でまとめてください（見出しなし）：
- 一文の結論
- 2〜4文の具体情報
- SNS/WEBの最近の傾向（最大2件）
- 代案・注意点（あれば）
- 最後にオンライン最安値の横断検索（TRIPMALL）のURLを控えめに添える
`;

    let finalPrompt = `${userText}\n${hint}`;

    if (sources.length) {
      finalPrompt +=
        "\n参考URL:\n" +
        sources.map((s, i) => `(${i + 1}) ${s.link}`).join("\n");
    }

    if (tripmallURL) {
      finalPrompt += `\nTRIPMALL_URL: ${tripmallURL}`;
    }

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
          { role: "user", content: finalPrompt },
        ],
        temperature: 0.5,
        max_tokens: 1100,
      });
      reply = resp.choices?.[0]?.message?.content?.trim() || "…";
    } catch (e) {
      reply = "うまく調べられなかった…もう少し具体的に教えてくれる？";
    }
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
