// index.js — AIくん 完全版（画像解析: Responses API使用）
//
// ・テキスト：雑談 / 相談 / リサーチ（場所・住所・説明）対応
// ・場所B案：近くを聞かれたときだけ「今どこ？」で聞き返す
// ・SNS/WEBリサーチ：必要なときだけ SerpAPI で検索
// ・画像：送られた画像を OpenAI Responses API で解析して内容を説明

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

/* ========= SYSTEM PROMPT（見出しなし＆会話優先） ========= */
const SYSTEM_PROMPT = `
あなたは「AIくん」です。丁寧で親しみやすい自然な日本語で話します。

- 雑談や日常の相談は、普通の会話としてゆるく返事する。構造見出しや番号は出さない。
- 調査が必要な質問（場所・近くのお店・住所・どんな場所か・比較・最新・在庫・レビュー・動画・評判・ニュースなど）のときだけ、
  SNS/WEBの検索結果を参考にしながら答える。

【リサーチ回答の流れ（見出しは出さない）】
- まず最初に、ユーザーが一番知りたいポイントを「一文の結論」で伝える。
- 次に、固有名詞・数字・日付などを含めた「具体情報」を2〜4文で補足する。
- そのあとで、「最近のSNS/WEB上では〜と言われている / 報告されている」といった形で、直近の傾向や評判を簡潔に紹介する。
- 余裕があれば、「別の選択肢・代案・注意点」を一言添える。
- 最後に、ユーザーが今すぐ取れる「次の一手」（例：◯◯で検索してみる、この条件でもう一度相談する など）を一文で提案する。

【スタイル】
- 箇条書きは必要に応じて軽く使ってよいが、「① 結論」「② 具体情報」のような見出しや番号は付けない。
- 不確実な情報は「可能性」「未確認」「〜と言われている」など控えめな表現にする。
- 長くなりすぎないよう、要点を優先しつつ、やさしい会話口調でまとめる。
- 必要なときだけ、最後に質問を1つだけ添えて会話を広げる。
`;

/* ========= 補助関数: LINE画像Stream → Buffer ========= */
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
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

/* ========= Google Search via SerpAPI ========= */
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
  } catch (e) {
    console.error("webSearch error:", e);
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

/* ========= Sources render ========= */
function renderSources(arr) {
  if (!arr?.length) return "";
  const lines = arr
    .slice(0, 3)
    .map((s, i) => `(${i + 1}) ${s.link}`)
    .join("\n");
  return `\n\n出典:\n${lines}`;
}

/* ========= Intent & helpers ========= */
const PREFS =
  "北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|東京都|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄";
const BIG_CITIES =
  "札幌|仙台|東京|渋谷|新宿|池袋|横浜|川崎|千葉|大宮|名古屋|京都|大阪|梅田|難波|天王寺|神戸|三宮|博多|天神|福岡|那覇|鎌倉|吉祥寺|中目黒|下北沢";

/** 目的別：近接/住所/説明/その他 を判定 */
function classifyIntent(text) {
  const t = text || "";
  const proximity =
    /(近く|周辺|最寄り|どこ(に|で)|付近|近辺|今から行ける|近場)/i.test(t);
  const askAddress = /(住所|所在地|場所どこ|場所は)/i.test(t);
  const describe =
    /(どんな所|どんなところ|どういう(店|場所|施設)|概要|特徴|雰囲気|コンセプト)/i.test(t);

  if (proximity) return "proximity"; // 近くを探したい → 今どこ？
  if (askAddress) return "address"; // 住所が知りたい
  if (describe) return "describe"; // どんな場所か知りたい
  if (t.trim() === "住所") return "address";
  return "general";
}

function hasLocationHint(text) {
  const t = text || "";
  const re1 = new RegExp(`(${PREFS})`);
  const re2 = new RegExp(`(${BIG_CITIES})`);
  if (re1.test(t) || re2.test(t)) return true;
  if (/駅/.test(t)) return true;
  return false;
}

/** 会話履歴から対象名を推定（直近の固有名詞） */
async function inferTargetFromHistory(history, currentText) {
  try {
    const sample = [...history].slice(-6);
    const msg = [
      {
        role: "system",
        content:
          "直近の会話から、ユーザーが今話題にしている対象の固有名詞（店名・施設名・物件名・商品名など）を1つ抽出して返してください。なければ空文字だけ返してください。",
      },
      ...sample,
      {
        role: "user",
        content: `今回の入力: ${currentText}\n対象があれば固有名詞のみ、なければ空文字。`,
      },
    ];
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: msg,
      temperature: 0,
      max_tokens: 30,
    });
    const name =
      (resp.choices?.[0]?.message?.content || "")
        .trim()
        .replace(/^[「『(（\s]+|[」』)）\s]+$/g, "") || "";
    return name || null;
  } catch (e) {
    console.error("inferTargetFromHistory error:", e);
    return null;
  }
}

/** 調査の必要性（雑談/相談はfalse） */
function needsResearch(intent, text) {
  if (intent === "proximity" || intent === "address" || intent === "describe") {
    return true;
  }
  const t = (text || "").toLowerCase();
  const cues = [
    "最新",
    "速報",
    "価格",
    "値段",
    "在庫",
    "比較",
    "レビュー",
    "評判",
    "動画",
    "公式",
    "発表",
    "ニュース",
  ];
  return cues.some((kw) => t.includes(kw));
}

/** 直前の「今どこ？」の前の質問を取得 */
function getPendingPlaceQuery(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "assistant" && /今どこにいますか？/.test(m.content)) {
      for (let j = i - 1; j >= 0; j--) {
        if (history[j].role === "user") return history[j].content.trim();
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
  // 画像メッセージ（Responses APIで解析）
  if (event.type === "message" && event.message?.type === "image") {
    try {
      const stream = await lineClient.getMessageContent(event.message.id);
      const buffer = await streamToBuffer(stream);
      const base64Image = buffer.toString("base64");

      // OpenAI Responses API を使った画像解析
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
        "画像についてうまく説明できませんでした…もう一度送ってもらえる？";

      try {
        const first = visionResp.output[0];
        if (first && first.content && first.content.length > 0) {
          const textPieces = first.content
            .filter((c) => c.type === "output_text")
            .map((c) => c.text);
          if (textPieces.length > 0) {
            answer = textPieces.join("\n").trim();
          }
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
    return;
  }

  // テキスト以外は現時点では無視
  if (event.type !== "message" || event.message?.type !== "text") {
    return;
  }

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

  // Intent & location
  const intent = classifyIntent(userText);
  const locationInText = hasLocationHint(userText);

  // 近接検索だけ、地名なしなら「今どこ？」（B案）
  if (intent === "proximity" && !locationInText) {
    const reply =
      "了解！調べるね。今どこにいますか？（市区町村や最寄り駅でもOK）";
    await saveMessage(conversationId, "assistant", reply);
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: reply,
    });
    return;
  }

  // 対象名の推定（住所/どんな所？でターゲット不明なとき）
  let targetName = null;
  if (intent === "address" || intent === "describe") {
    targetName = await inferTargetFromHistory(history, userText);
  }

  // 「渋谷」など場所単体 → 直前の基点質問を補完
  let baseQuery = null;
  if (
    locationInText &&
    intent !== "proximity" &&
    !/住所|どんな所|どんなところ/.test(userText)
  ) {
    baseQuery = getPendingPlaceQuery(history);
  }

  // 検索クエリを決定
  let finalQuery = userText;
  if (targetName && (intent === "address" || intent === "describe")) {
    finalQuery = `${targetName} 住所 概要`;
  } else if (baseQuery) {
    finalQuery = `${baseQuery} ${userText}`;
  }

  // 調査の要否
  let doResearch = needsResearch(intent, finalQuery);

  // ★ 直前に「今どこ？」と聞き返していた場合は、地名だけ返されてもリサーチを強制
  if (baseQuery) {
    doResearch = true;
  }

  let reply = "…";

  if (!doResearch) {
    // 会話モード（検索なし）
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
    } catch (e) {
      console.error("OpenAI error (chat):", e);
      reply = "少し込み合ってるみたい。もう一度だけ送ってみて！";
    }
  } else {
    // 調査モード（SNS/WEB検索 → 要約）
    let social = [];
    let web = [];
    try {
      social = await socialSearch(finalQuery);
      web = await webSearch(finalQuery, {});
    } catch (e) {
      console.error("search error:", e);
    }

    const sources = [...social, ...web];
    const hint =
      sources.length > 0
        ? "以下のURL候補を参考に、(1) まず一文で結論、(2) 具体的な情報、(3) SNS/WEBで最近言われていることや傾向、(4) 別の選択肢や注意点、(5) ユーザーが今できる次の一手、という流れで自然な日本語の文章としてまとめてください。見出しや番号は付けず、会話口調で書いてください。"
        : "公開情報が少ない場合でも、(1) 一文の結論、(2) 分かる範囲の具体情報、(3) 注意点や不確実さ、(4) それでもユーザーが取れる次の一手、という流れで自然な日本語の文章にしてください。見出しや番号は付けず、会話口調で書いてください。";

    let prompt = finalQuery;
    if (intent === "address") {
      prompt +=
        "\n（住所・所在地・アクセス・目印を優先して、簡潔に教えてください。）";
    }
    if (intent === "describe") {
      prompt +=
        "\n（どんな場所/施設/物件か、特徴・雰囲気・価格帯や利用シーンなどを、分かりやすく教えてください。）";
    }
    if (intent === "proximity" && locationInText) {
      prompt +=
        "\n（指定エリア内の候補を具体名で挙げ、混雑/在庫の傾向などが分かれば触れてください。）";
    }

    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
          {
            role: "user",
            content:
              `${prompt}\n\n${hint}\n` +
              (sources.length
                ? `URL候補:\n${sources
                    .slice(0, 5)
                    .map((s, i) => `(${i + 1}) ${s.link}`)
                    .join("\n")}`
                : ""),
          },
        ],
        temperature: 0.5,
        max_tokens: 1100,
      });
      reply = resp.choices?.[0]?.message?.content?.trim() || "…";

      // URLが本文に含まれていない場合だけ、最後に出典として3件足す
      if (sources.length && !/(https?:\/\/\S+)/.test(reply)) {
        reply += renderSources(sources);
      }
    } catch (e) {
      console.error("OpenAI error (research):", e);
      reply =
        "うまく調べられなかった…対象名やキーワードを、もう少しだけ具体的に教えてもらえる？";
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
