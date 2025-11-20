// ============================================================================
// index.js — AIくん 完全統合版（TRIPMALL + 全商品対応 + SYSTEM PROMPT 改訂）
// ============================================================================
//
// ・雑談 / 相談 → 通常会話
// ・リサーチ → SerpAPI + SNS検索 → 結論 → 具体情報 → SNS傾向 → 代案 → 次の一手
// ・オンライン購入選択肢は必ず自然に添える（控えめ）
// ・商品探し intent（世の中のすべての商品名に対応）
// ・TRIPMALL（Amazon/Rakuten/Yahoo横断検索）URL を自動提案
// ・SNS/WEB 出典は2件
// ・画像解析 → OpenAI Responses API
//
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

/* ========= SNS recency ========= */
const RECENCY_DAYS = Math.max(
  1,
  parseInt(process.env.SOCIAL_SEARCH_RECENCY_DAYS || "14", 10)
);

/* ========= SYSTEM PROMPT（最新版） ========= */
const SYSTEM_PROMPT = `
あなたは「AIくん」です。丁寧で親しみやすい自然な日本語で話します。

- 雑談や日常の相談は普通の会話として自然に返す（見出し・番号は出さない）。
- 調査が必要な質問（場所 / 近隣 / 住所 / どんな場所 / 比較 / 最新 / 在庫 / レビュー / 評判 / ニュースなど）のときだけ、
  SNS/WEB の検索結果を参考にしながら答える。

【リサーチ回答フロー】
- 最初に「ユーザーが最も知りたい一文の結論」を述べる。
- 次に「固有名詞・数字・日付などを含む具体情報」を2〜4文で補足する。
- 続いて「最近のSNS/WEB上では〜と言われている・報告されている」を紹介する。
- 余裕があれば「代案・注意点」を控えめに添える。
- 最後に「ユーザーが今すぐ取れる次の一手」を一文で提案する。
- オンライン購入の選択肢は必ず自然に添える。ただし回答構造を邪魔しない程度に控えめに提示する。

【スタイル】
- やさしい会話口調。結論→具体→傾向→代案→次の一手。
- 不確実な情報は「可能性」「〜と言われている」など慎重に表現。
- 必要なときだけ最後に一つ質問を添えて会話を広げる。
`;

/* ========= Utility: Stream → Buffer ========= */
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
    const r = await fetch(
      `https://serpapi.com/search.json?${params.toString()}`
    );
    const j = await r.json();
    return (j.organic_results || [])
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

/* ========= SNS Search ========= */
async function socialSearch(query) {
  const tbs = daysToTbs(RECENCY_DAYS);
  const qs = `${query} (site:x.com OR site:twitter.com OR site:instagram.com OR site:reddit.com)`;

  const raw = await webSearch(qs, { num: 8, tbs, gl: "jp", hl: "ja" });

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

/* ========= 出典：上限2件 ========= */
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

/* ========= 全商品対応：商品購入 intent ========= */
function isProductWhere(text) {
  const t = text || "";

  // ① 購入・入手意図（すべての商品対応）
  const buy =
    /(買いたい|買う|買える|購入|欲しい|欲しかった|売ってる|売っている|手に入る|手に入れたい|通販|オンライン|最安|安い|どこで買う|どこで買える|探してる|探している|見つけたい|見つかる)/i.test(
      t
    );

  // ② where intent
  const where = /(どこで|どこに)/i.test(t);

  const hasProductIntent = buy || where;
  if (!hasProductIntent) return false;

  // ③ "近く" は商品検索ではない
  if (/(近く|周辺|最寄り)/i.test(t)) return false;

  // ④ 地名入り → 商品検索ではなく場所検索
  if (hasLocation(t)) return false;

  return true;
}

/* ========= TRIPMALL URL ========= */
function buildTripmallUrl(keyword) {
  const encoded = encodeURIComponent(keyword.trim());
  return keyword.includes(" ")
    ? `https://tripmall.online/search/?category=ALL&q=${encoded}&sort=`
    : `https://tripmall.online/search/?q=${encoded}&sort=`;
}

/* ========= MAIN ========= */
app.get("/", (_, res) => res.send("AI-kun running"));

app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    await Promise.all((req.body.events ?? []).map(handleEvent));
    res.status(200).end();
  } catch {
    res.status(200).end();
  }
});

/* ========= EVENT HANDLER ========= */
async function handleEvent(event) {
  /* ========= 画像解析 ========= */
  if (event.type === "message" && event.message?.type === "image") {
    try {
      const stream = await lineClient.getMessageContent(event.message.id);
      const buf = await streamToBuffer(stream);
      const b64 = buf.toString("base64");

      const visionResp = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "この画像について、やさしい日本語で説明してください。",
              },
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${b64}`,
              },
            ],
          },
        ],
      });

      let answer =
        "画像を読み取れなかったみたい…もう一度送ってくれる？📷";

      try {
        const first = visionResp.output?.[0];
        if (first?.content?.length) {
          answer = first.content
            .filter((c) => c.type === "output_text")
            .map((c) => c.text)
            .join("\n")
            .trim();
        }
      } catch {}

      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: answer,
      });
    } catch {
      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: "画像を読み取れなかったよ…もう一度お願い！📷",
      });
    }
    return;
  }

  /* ========= テキスト ========= */
  if (event.type !== "message" || event.message?.type !== "text") return;

  const userText = event.message.text.trim();
  const conversationId = getConversationId(event);

  /* reset */
  if (userText === "リセット" || userText.toLowerCase() === "reset") {
    await supabase
      .from("conversation_messages")
      .delete()
      .eq("conversation_id", conversationId);

    const msg = "会話履歴をリセットしたよ。どうぞ！";
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: msg,
    });
    return;
  }

  await saveMessage(conversationId, "user", userText);
  const history = await fetchRecentMessages(conversationId);

  /* Intent 判定 */
  const productIntent = isProductWhere(userText);
  const locationHint = hasLocation(userText);

  let intent = "general";
  if (productIntent) intent = "product_where";
  else if (/(近く|周辺|最寄り)/i.test(userText)) intent = "proximity";
  else if (/(住所|所在地)/i.test(userText)) intent = "address";
  else if (/(どんな所|特徴|雰囲気|概要)/i.test(userText))
    intent = "describe";

  /* proximity: 今どこ？ */
  if (intent === "proximity" && !locationHint) {
    const msg =
      "了解！調べるね。今どこにいますか？（市区町村や最寄り駅でもOK）";
    await saveMessage(conversationId, "assistant", msg);
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: msg,
    });
    return;
  }

  const finalQuery = userText;

  /* 調査が必要？ */
  const needsResearch =
    intent !== "general" ||
    /(最新|速報|価格|値段|在庫|比較|レビュー|評判|動画)/.test(userText);

  let reply = "";

  if (!needsResearch) {
    /* 通常会話 */
    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
          { role: "user", content: finalQuery },
        ],
        temperature: 0.6,
        max_tokens: 800,
      });
      reply = resp.choices?.[0]?.message?.content?.trim() || "…";
    } catch {
      reply = "ちょっと混み合ってるみたい…もう一度お願い！";
    }
  } else {
    /* リサーチモード */
    let social = [];
    let web = [];
    try {
      social = await socialSearch(finalQuery);
      web = await webSearch(finalQuery);
    } catch {}

    const sources = [...social, ...web];

    let prompt =
      `${finalQuery}\n\n` +
      "以下の情報を参考に、結論 → 具体情報 → SNS/WEBの傾向 → 代案 → 次の一手 の流れで自然な日本語の文章として返してください（見出し不要）。\n";

    if (sources.length) {
      prompt +=
        "URL候補:\n" +
        sources
          .slice(0, 2)
          .map((s, i) => `(${i + 1}) ${s.link}`)
          .join("\n");
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
        max_tokens: 1200,
      });

      reply = resp.choices?.[0]?.message?.content?.trim() || "…";

      /* ===== TRIPMALL（全商品対応） ===== */
      if (intent === "product_where") {
        const url = buildTripmallUrl(finalQuery);
        reply += `\n\n・オンライン最安値の横断検索はこちら\n${url}`;
      }

      /* ===== 出典 2 件 ===== */
      if (sources.length && !/(https?:\/\/\S+)/.test(reply)) {
        reply += renderSources(sources);
      }
    } catch {
      reply =
        "うまく調べられなかった…もう少し詳しくキーワードを教えてくれる？";
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
