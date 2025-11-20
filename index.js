// ============================================================================
// index.js — AIくん 完全版
// ・テキスト：即レス「調べてるよ」→ 後から本回答（pushMessage）
// ・画像：その場で解析して即返信
// ・SerpAPI + SNSリサーチ
// ・TRIPMALL：商品名抽出（GPT）→ 検索URL自動付与
// ・SNS出典：最大2件
// ============================================================================

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
- 続いて、SNS/WEBで最近言われていることや傾向を簡潔に紹介する（最大2件）。
- 余裕があれば、別の選択肢や注意点を軽く添える。
- 最後に、商品を探している質問であれば、オンライン最安値の横断検索（TRIPMALL）のURLを控えめに自然に添える。

【スタイル】
- 見出しや番号は付けない。
- 文体はやさしい会話調で、長くしすぎない。
- 不確実な情報は「可能性」「〜と言われている」など慎重に。
`;

/* ========= Util: Stream → Buffer ========= */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
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

/* ========= Push 先 ID ========= */
function getPushTarget(event) {
  const s = event.source ?? {};
  if (s.userId) return s.userId;
  if (s.groupId) return s.groupId;
  if (s.roomId) return s.roomId;
  return null;
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
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role, content: r.content }));
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
    const res = await fetch(
      `https://serpapi.com/search.json?${params.toString()}`
    );
    const j = await res.json();
    const items = j.organic_results || [];
    return items
      .filter((it) => it.title && it.link)
      .map((it) => ({
        title: it.title,
        snippet: it.snippet || "",
        link: it.link,
      }));
  } catch (e) {
    console.error("webSearch error:", e);
    return [];
  }
}

/* ========= SNS Search ========= */
async function socialSearch(queryText) {
  const tbs = daysToTbs(RECENCY_DAYS);
  const q =
    `${queryText} ` +
    "(site:x.com OR site:twitter.com OR site:instagram.com OR site:reddit.com)";

  const raw = await webSearch(q, { num: 8, tbs, gl: "jp", hl: "ja" });
  const seen = new Set();
  const arr = [];

  for (const r of raw) {
    const key = r.link.replace(/(\?.*)$/, "");
    if (!seen.has(key)) {
      seen.add(key);
      arr.push(r);
    }
    if (arr.length >= 2) break; // ★最大2件
  }
  return arr;
}

/* ========= 出典（最大2件） ========= */
function renderSources(arr) {
  if (!arr?.length) return "";
  return (
    "\n\n出典:\n" +
    arr
      .slice(0, 2)
      .map((s, i) => `(${i + 1}) ${s.link}`)
      .join("\n")
  );
}

/* ========= Location 判定 ========= */
const PREFS =
  "北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|東京都|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄";

function hasLocation(text) {
  if (!text) return false;
  return new RegExp(`(${PREFS})`).test(text) || /駅/.test(text);
}

/* ========= 商品 intent 判定 ========= */
function isProductIntent(text) {
  const t = text || "";

  const buyIntents =
    /(買いたい|買う|買える|購入|欲しい|欲しかった|売ってる|売っている|手に入る|手に入れたい|通販|オンライン|最安|安い|どこで買う|どこで買える|探してる|探している|見つけたい|見つかる)/i.test(
      t
    );

  const whereIntents =
    /(どこで|どこに)/i.test(t) &&
    /(ある|売ってる|売っている|買える|置いてる|置いてある)/i.test(t);

  const productLike = buyIntents || whereIntents;
  if (!productLike) return false;

  // 「近く系」は除外（店舗検索）
  if (/(近く|周辺|最寄り)/i.test(t)) return false;
  // 明確な地名が入っている場合も除外（場所検索扱い）
  if (hasLocation(t)) return false;

  return true;
}

/* ========= Intent分類 ========= */
function classifyIntent(text) {
  const t = text || "";
  if (isProductIntent(t)) return "product";
  if (/(近く|周辺|最寄り)/i.test(t)) return "proximity";
  if (/(住所|所在地)/i.test(t)) return "address";
  if (/(どんな所|特徴|雰囲気|概要)/i.test(t)) return "describe";
  return "general";
}

/* ========= TRIPMALL URL ========= */
function buildTripmallUrlFromProductName(productName) {
  const encoded = encodeURIComponent(productName.trim());
  return `https://tripmall.online/search/?q=${encoded}&sort=`;
}

/* ========= TRIPMALL 用 商品名抽出（GPT） ========= */
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

    const name = resp.choices?.[0]?.message?.content?.trim() || "";
    return name.replace(/^[「『\s]+|[」』\s]+$/g, "");
  } catch (e) {
    console.error("extractProductName error:", e);
    return "";
  }
}

/* ========= Health ========= */
app.get("/", (_, res) => res.send("AI-kun running"));

/* ========= Webhook ========= */
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events ?? [];

    await Promise.all(
      events.map(async (event) => {
        // 画像は従来どおり即返信
        if (event.type === "message" && event.message?.type === "image") {
          await handleImageEvent(event);
          return;
        }

        // テキストは 2段階方式
        if (event.type === "message" && event.message?.type === "text") {
          await handleTextEventTwoStep(event);
          return;
        }

        // それ以外は今は無視
      })
    );

    res.status(200).end();
  } catch (e) {
    console.error("Webhook error:", e);
    res.status(200).end();
  }
});

/* ========= 画像イベント ========= */
async function handleImageEvent(event) {
  try {
    const stream = await lineClient.getMessageContent(event.message.id);
    const buffer = await streamToBuffer(stream);
    const base64Image = buffer.toString("base64");

    const visionResp = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "この画像について、どんな場面・物・雰囲気なのか、やさしく日本語で説明してください。",
            },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${base64Image}`,
            },
          ],
        },
      ],
    });

    let answer =
      "画像をうまく読み取れなかったみたい…もう一度送ってくれる？📷";

    try {
      const first = visionResp.output?.[0];
      if (first?.content?.length) {
        answer = first.content
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("\n")
          .trim();
      }
    } catch (e) {
      console.error("parse visionResp error:", e);
    }

    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: answer,
    });
  } catch (err) {
    console.error("Image analysis error:", err);
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "画像をうまく読み取れなかったみたい…もう一度送ってくれる？📷",
    });
  }
}

/* ========= テキスト：2段階方式 ========= */
async function handleTextEventTwoStep(event) {
  const userText = (event.message.text ?? "").trim();
  const conversationId = getConversationId(event);
  const pushTarget = getPushTarget(event);

  // リセットだけは即座にその場で処理（2段階にしない）
  if (userText === "リセット" || userText.toLowerCase() === "reset") {
    await supabase
      .from("conversation_messages")
      .delete()
      .eq("conversation_id", conversationId);

    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: "会話履歴をリセットしたよ。どうぞ！",
    });
    return;
  }

  // ① 即レス：「今ちょっと調べてるよ…」
  await lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: "今ちょっと調べてるよ…少しだけ待っててね🔍",
  });

  // ② 裏で本処理 → pushMessage
  (async () => {
    try {
      if (!pushTarget) return;

      await saveMessage(conversationId, "user", userText);
      const history = await fetchRecentMessages(conversationId);

      const intent = classifyIntent(userText);

      // 商品intentならTRIPMALL用の商品名抽出
      let productName = "";
      let tripmallUrl = "";
      if (intent === "product") {
        productName = await extractProductName(userText);
        if (productName) {
          tripmallUrl = buildTripmallUrlFromProductName(productName);
        }
      }

      const reply = await buildAiReply(
        userText,
        history,
        intent,
        tripmallUrl
      );

      await saveMessage(conversationId, "assistant", reply);

      await lineClient.pushMessage(pushTarget, {
        type: "text",
        text: reply,
      });
    } catch (e) {
      console.error("handleTextEventTwoStep async error:", e);
    }
  })();
}

/* ========= 本回答生成ロジック ========= */
async function buildAiReply(userText, history, intent, tripmallUrl) {
  // 調査が必要か？
  const needsResearch =
    intent !== "general" ||
    /(最新|速報|価格|値段|在庫|比較|レビュー|評判|ニュース|動画)/.test(
      userText
    );

  // 雑談・相談：OpenAIのみ
  if (!needsResearch) {
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
      return resp.choices?.[0]?.message?.content?.trim() || "…";
    } catch (e) {
      console.error("OpenAI error (chat):", e);
      return "ちょっと混み合ってるみたい…もう一度送ってみて！";
    }
  }

  // リサーチモード
  let social = [];
  let web = [];
  try {
    [social, web] = await Promise.all([
      socialSearch(userText),
      webSearch(userText),
    ]);
  } catch (e) {
    console.error("search error:", e);
  }

  const sources = [...social, ...web].slice(0, 2);

  let prompt =
    `${userText}\n\n` +
    "結論 → 具体情報（2〜4文）→ 最近のSNS/WEBの傾向（最大2件）→ 代案・注意点、という流れで自然な日本語の文章としてまとめてください。見出しや番号は付けないでください。\n";

  if (sources.length) {
    prompt +=
      "参考になりそうなURL:\n" +
      sources.map((s, i) => `(${i + 1}) ${s.link}`).join("\n");
  }

  if (intent === "product" && tripmallUrl) {
    prompt += `\n\nこのユーザーは何か商品を探しているので、最後にオンライン最安値の横断検索（TRIPMALL）のURLを控えめに一言そえてください。このURLを使ってください：${tripmallUrl}`;
  }

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: prompt },
      ],
      temperature: 0.5,
      max_tokens: 1100,
    });

    let reply = resp.choices?.[0]?.message?.content?.trim() || "…";

    // 商品intentだがモデルがURLを使わなかった場合の保険として、必ず最後に追加
    if (intent === "product" && tripmallUrl && !reply.includes(tripmallUrl)) {
      reply += `\n\nオンライン最安値の横断検索はこちら：\n${tripmallUrl}`;
    }

    // 出典が本文に無ければ追加（最大2件）
    if (sources.length && !/(https?:\/\/\S+)/.test(reply)) {
      reply += renderSources(sources);
    }

    return reply;
  } catch (e) {
    console.error("OpenAI error (research):", e);
    return "うまく調べられなかった…対象名やキーワードを、もう少しだけ具体的に教えてもらえる？";
  }
}

/* ========= Start ========= */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`AI-kun running on ${port}`));
