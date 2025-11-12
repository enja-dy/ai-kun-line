import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/** ====== LINE / OpenAI 設定 ====== */
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new line.Client(config);
const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** ====== Supabase（server-only / service_role） ====== */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

/** ====== SerpAPI（Google検索の簡易導入） ====== */
const SERPAPI_KEY = process.env.SERPAPI_KEY;

/** ====== 親しみ＋正確性重視 SYSTEM_PROMPT ====== */
const SYSTEM_PROMPT = `
あなたは「AIくん」です。相手に寄りそい、親しみやすい口調で、自然な日本語の文章で答えてください。
箇条書きは必要に応じて軽く使ってOKですが、毎回同じ形式にはしないでください。
提案の根拠や具体例は簡潔に。必要なら追加の質問を1つだけ添えて会話を広げてください。

【正確性のルール】
- 日付、統計、制度、料金、人数、最新情報、店舗・施設の住所/営業時間など事実依存の内容は、
  可能であれば渡された sources を参考にしてください。
- sources が十分でない場合は断定せず、「可能性」「要確認」と表現してください。

【避けること】
- 「公式サイトを確認してください」だけで終わる
- 「わかりません」で終わる
- 一般論だけで終える
- sources があるのに無視する
`;

/** ====== 会話ID ====== */
function getConversationId(event) {
  const src = event.source ?? {};
  if (src.groupId) return `group:${src.groupId}`;
  if (src.roomId) return `room:${src.roomId}`;
  if (src.userId) return `user:${src.userId}`;
  return "unknown";
}

/** ====== 履歴保存/取得 ====== */
const HISTORY_LIMIT = 12;

async function fetchRecentMessages(conversationId) {
  const { data, error } = await supabase
    .from("conversation_messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT * 2);

  if (error) {
    console.error("fetchRecentMessages error:", error);
    return [];
  }

  return (data ?? [])
    .reverse()
    .map((r) => ({ role: r.role, content: r.content }))
    .filter((m) => m.role === "user" || m.role === "assistant");
}

async function saveMessage(conversationId, role, content) {
  const { error } = await supabase
    .from("conversation_messages")
    .insert([{ conversation_id: conversationId, role, content }]);
  if (error) console.error("saveMessage error:", error);
}

/** ====== 検索発火のためのヒント ====== */
/* 場所系：※「どこ」は外す（誤判定の原因） */
const PLACE_HINTS = [
  /場所|住所|地図|最寄り|近く|周辺|近辺|アクセス|電話|営業時間|定休日|何時まで/,
  /カフェ|居酒屋|レストラン|病院|クリニック|ホテル|温泉|レンタカー|美術館|水族館|動物園|図書館|保育園|幼稚園|役所|コンビニ|ATM|コインランドリー/,
  /東京|東京都|大阪|京都|札幌|仙台|名古屋|福岡|那覇|横浜|神戸|鎌倉|川崎|千葉|埼玉/,
  /渋谷|新宿|池袋|銀座|秋葉原|上野|品川|恵比寿|中目黒|自由が丘|下北沢|吉祥寺|梅田|難波|天王寺|心斎橋|三宮|元町|天神|博多/
];

/* 事実系 */
const FACT_HINTS = [
  /最新|今日|昨日|今週|今月|今年|速報|本日/,
  /ニュース|発表|値上げ|値下げ|価格|料金|在庫|為替|金利|相場|スケジュール|日程|統計|人数|売上|利用者|シェア/,
  /法律|規制|規約|仕様|バージョン/
];

/* 商品/サービス購入意図（オンライン優先） */
const PRODUCT_BUY_HINTS = [
  /どこに売って(ます|る)|どこで(買え|売っ)て|どこで手に入る|どこで購入|買いたい|販売店|取扱店/,
  /通販|オンライン|ネットショップ|EC|公式ストア|公式サイト|購入先|在庫/,
  /買える\?|売ってる\?/,
];

/** 地名・ランドマーク等が含まれているか簡易判定 */
function hasPlaceWord(userText) {
  if (!userText) return false;
  return [
    /東京|東京都|大阪|京都|札幌|仙台|名古屋|福岡|那覇|横浜|神戸|鎌倉|川崎|千葉|埼玉/,
    /渋谷|新宿|池袋|銀座|秋葉原|上野|品川|恵比寿|中目黒|自由が丘|下北沢|吉祥寺|梅田|難波|天王寺|心斎橋|三宮|元町|天神|博多|大濠|中洲/,
    /駅|区|市|町|村|温泉|空港|港|インター|PA|SA|タワー|ドーム|アリーナ|ヒルズ|シティ|モール/,
  ].some((re) => re.test(userText));
}

/** ====== 意図分類：優先度は「商品購入」→「場所」→「事実」 ====== */
function classifyIntent(userText) {
  if (!userText) return null;
  // 1) 商品購入（オンライン案内を最優先）
  if (PRODUCT_BUY_HINTS.some((re) => re.test(userText))) return "product";
  // 2) 場所（「どこ」は含めず、地名/施設/営業時間などで判断）
  if (PLACE_HINTS.some((re) => re.test(userText))) return "place";
  // 3) 事実系
  if (FACT_HINTS.some((re) => re.test(userText))) return "fact";
  return null;
}

/** ====== SerpAPIでGoogle検索 ====== */
async function webSearch(query, num = 6, gl = "jp", hl = "ja") {
  if (!SERPAPI_KEY) return [];
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(
    query
  )}&num=${num}&gl=${gl}&hl=${hl}&api_key=${SERPAPI_KEY}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    const items = j.organic_results || [];
    return items
      .filter((it) => it.title && it.snippet && it.link)
      .map((it) => ({ title: it.title, snippet: it.snippet, link: it.link }));
  } catch (e) {
    console.error("webSearch error:", e);
    return [];
  }
}

/** ====== Health check ====== */
app.get("/", (_req, res) => res.send("AI-kun running"));

/** ====== Webhook ====== */
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events ?? [];
    await Promise.all(events.map(handleEvent));
    return res.status(200).end();
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(200).end();
  }
});

/** ====== メイン処理 ====== */
async function handleEvent(event) {
  if (event.type !== "message" || event.message?.type !== "text") return;

  const userText = (event.message.text ?? "").trim();
  const conversationId = getConversationId(event);

  // 会話リセット
  if (userText === "リセット" || userText.toLowerCase() === "reset") {
    const { error } = await supabase
      .from("conversation_messages")
      .delete()
      .eq("conversation_id", conversationId);
    const msg = error
      ? "履歴のリセットに失敗しました。少し時間をおいてお試しください。"
      : "会話履歴をリセットしました。改めてどうぞ！";
    await lineClient.replyMessage(event.replyToken, { type: "text", text: msg });
    return;
  }

  // 入力保存
  await saveMessage(conversationId, "user", userText);

  // 直近履歴
  const history = await fetchRecentMessages(conversationId);

  // —— 意図分類（※優先度順で分岐）
  const intent = classifyIntent(userText);

  /** ---------- 分岐ロジック ----------
   * product：オンライン購入先を案内（位置は聞かない）
   * place   ：地名なしなら「今どこ？」→ 地名ありなら検索
   * fact    ：検索して根拠付きで回答
   * null    ：通常LLM
   */

  // product：オンライン優先
  if (intent === "product") {
    let sources = [];
    try {
      const qResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content:
              "ユーザー質問から、オンライン購入先を探すGoogle検索クエリを20〜60文字で1行。語尾や装飾なし。『通販 公式 価格』を含める。",
          },
          { role: "user", content: userText },
        ],
      });
      const bestQ =
        qResp.choices?.[0]?.message?.content?.trim() ||
        userText + " 通販 公式 価格";
      sources = await webSearch(bestQ, 6, "jp", "ja");
    } catch (e) {
      console.error("query refine (product) error:", e);
      sources = await webSearch(userText + " 通販 公式 価格", 6, "jp", "ja");
    }

    const sourceBlock = sources.length
      ? `\n\n[Sources]\n${sources
          .map(
            (s, i) => `(${i + 1}) ${s.title}\n${s.snippet}\n${s.link}`
          )
          .join("\n")}`
      : "";

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      {
        role: "user",
        content: `${userText}\n\n（方針：まずオンラインの購入先を優先して紹介。必要なら近隣店舗も案内できると一言添える）${sourceBlock}`,
      },
    ];

    let replyText = "…";
    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.5,
        max_tokens: 900,
      });
      let draft = resp.choices?.[0]?.message?.content?.trim() || "…";

      if (
        sources.length &&
        !/(https?:\/\/[^\s)]+)|（https?:\/\/[^\s)]+）/.test(draft)
      ) {
        const cite = sources
          .slice(0, 3)
          .map((s, i) => `(${i + 1}) ${s.link}`)
          .join("\n");
        draft += `\n\n出典:\n${cite}`;
      }

      draft += `\n\n※近くの実店舗が良ければ、地名か位置情報を教えてください。周辺の取扱店も探せます。`;
      replyText = draft;
    } catch (err) {
      console.error("OpenAI error (product):", err);
      replyText =
        "うまく調べられませんでした。商品名や型番をもう少しだけ具体的に教えてもらえますか？";
    }

    await saveMessage(conversationId, "assistant", replyText);
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: replyText,
    });
    return;
  }

  // place：地名なし→場所を聞く / 地名あり→検索
  if (intent === "place") {
    if (!hasPlaceWord(userText)) {
      const reply = "了解！調べるね。今どこにいますか？";
      await saveMessage(conversationId, "assistant", reply);
      await lineClient.replyMessage(event.replyToken, {
        type: "text",
        text: reply,
      });
      return;
    }
    // 地名あり → 検索
    let sources = [];
    try {
      const qResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content:
              "日本語の質問から、場所検索向けのGoogleクエリを20〜60文字で1行だけ出力。装飾なし。",
          },
          { role: "user", content: userText },
        ],
      });
      const bestQ = qResp.choices?.[0]?.message?.content?.trim() || userText;
      sources = await webSearch(bestQ, 6, "jp", "ja");
    } catch (e) {
      console.error("query refine (place) error:", e);
      sources = await webSearch(userText, 6, "jp", "ja");
    }

    const sourceBlock = sources.length
      ? `\n\n[Sources]\n${sources
          .map(
            (s, i) => `(${i + 1}) ${s.title}\n${s.snippet}\n${s.link}`
          )
          .join("\n")}`
      : "";

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: userText + sourceBlock },
    ];

    let replyText = "…";
    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.5,
        max_tokens: 900,
      });
      let draft = resp.choices?.[0]?.message?.content?.trim() || "…";

      if (
        sources.length &&
        !/(https?:\/\/[^\s)]+)|（https?:\/\/[^\s)]+）/.test(draft)
      ) {
        const cite = sources
          .slice(0, 3)
          .map((s, i) => `(${i + 1}) ${s.link}`)
          .join("\n");
        draft += `\n\n出典:\n${cite}`;
      }
      replyText = draft;
    } catch (err) {
      console.error("OpenAI error (place):", err);
      replyText =
        "うまく調べられませんでした。地名や範囲をもう少しだけ具体的にいただけますか？";
    }

    await saveMessage(conversationId, "assistant", replyText);
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: replyText,
    });
    return;
  }

  // fact：事実系は検索して根拠付きで回答
  if (intent === "fact") {
    let sources = [];
    try {
      const qResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 60,
        messages: [
          {
            role: "system",
            content:
              "日本語の質問から、Google検索に最適なクエリを20〜60文字で1行だけ出力。装飾なし。",
          },
          { role: "user", content: userText },
        ],
      });
      const bestQ = qResp.choices?.[0]?.message?.content?.trim() || userText;
      sources = await webSearch(bestQ, 6, "jp", "ja");
    } catch (e) {
      console.error("query refine (fact) error:", e);
      sources = await webSearch(userText, 6, "jp", "ja");
    }

    const sourceBlock = sources.length
      ? `\n\n[Sources]\n${sources
          .map(
            (s, i) => `(${i + 1}) ${s.title}\n${s.snippet}\n${s.link}`
          )
          .join("\n")}`
      : "";

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: userText + sourceBlock },
    ];

    let replyText = "…";
    try {
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.5,
        max_tokens: 900,
      });
      let draft = resp.choices?.[0]?.message?.content?.trim() || "…";
      if (
        sources.length &&
        !/(https?:\/\/[^\s)]+)|（https?:\/\/[^\s)]+）/.test(draft)
      ) {
        const cite = sources
          .slice(0, 3)
          .map((s, i) => `(${i + 1}) ${s.link}`)
          .join("\n");
        draft += `\n\n出典:\n${cite}`;
      }
      replyText = draft;
    } catch (err) {
      console.error("OpenAI error (fact):", err);
      replyText =
        "うまく調べられませんでした。条件をもう少しだけ具体的にいただけますか？";
    }

    await saveMessage(conversationId, "assistant", replyText);
    await lineClient.replyMessage(event.replyToken, {
      type: "text",
      text: replyText,
    });
    return;
  }

  // null：通常フロー（検索不要）
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userText },
  ];

  let replyText = "…";
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.5,
      max_tokens: 900,
    });
    replyText = resp.choices?.[0]?.message?.content?.trim() || "…";
  } catch (err) {
    console.error("OpenAI error:", err);
    replyText =
      "少し混み合っています。言い回しを変えてもう一度だけ送ってみてもらえますか？";
  }

  await saveMessage(conversationId, "assistant", replyText);
  await lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

/** ====== 起動 ====== */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
