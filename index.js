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
    .map(r => ({ role: r.role, content: r.content }))
    .filter(m => m.role === "user" || m.role === "assistant");
}

async function saveMessage(conversationId, role, content) {
  const { error } = await supabase
    .from("conversation_messages")
    .insert([{ conversation_id: conversationId, role, content }]);
  if (error) console.error("saveMessage error:", error);
}

/** ====== 検索発火条件（場所/最新/料金/営業時間など） ====== */
const PLACE_HINTS = [
  /どこ|場所|住所|地図|最寄り|近く|周辺|近辺|アクセス|電話|営業時間|定休日|何時まで/,
  /カフェ|居酒屋|レストラン|病院|クリニック|ホテル|温泉|レンタカー|美術館|水族館|動物園|図書館|保育園|幼稚園|役所|コンビニ|ATM|コインランドリー/,
  /東京|東京都|大阪|京都|札幌|仙台|名古屋|福岡|那覇|横浜|神戸|鎌倉|川崎|千葉|埼玉/,
  /渋谷|新宿|池袋|銀座|秋葉原|上野|品川|恵比寿|中目黒|自由が丘|下北沢|吉祥寺|梅田|難波|天王寺|心斎橋|三宮|元町|天神|博多/
];
const FACT_HINTS = [
  /最新|今日|昨日|今週|今月|今年|速報|本日/,
  /ニュース|発表|値上げ|値下げ|価格|料金|在庫|為替|金利|相場|スケジュール|日程|統計|人数|売上|利用者|シェア/,
  /法律|規制|規約|仕様|バージョン/
];

/** —— 商品/サービスの購入意図（オンライン優先） —— */
const PRODUCT_BUY_HINTS = [
  /どこに売って(ます|る)|どこで(買え|売っ)て|どこで手に入る|どこで購入|買いたい|販売店|取扱店/,
  /通販|オンライン|ネットショップ|EC|公式ストア|公式サイト|購入先|在庫/,
  /買える\?|売ってる\?/
];

function needsSearch(userText) {
  if (!userText) return false;
  const t = userText.toLowerCase();
  if (t.includes("検証モード")) return true;    // 手動強制
  if (t.includes("オフライン")) return false;  // 手動オフ
  return [...PLACE_HINTS, ...FACT_HINTS, ...PRODUCT_BUY_HINTS].some(re => re.test(userText));
}

/** 地名・ランドマーク等が含まれているか簡易判定 */
function hasPlaceWord(userText) {
  if (!userText) return false;
  return [
    /東京|東京都|大阪|京都|札幌|仙台|名古屋|福岡|那覇|横浜|神戸|鎌倉|川崎|千葉|埼玉/,
    /渋谷|新宿|池袋|銀座|秋葉原|上野|品川|恵比寿|中目黒|自由が丘|下北沢|吉祥寺|梅田|難波|天王寺|心斎橋|三宮|元町|天神|博多|大濠|中洲/,
    /駅|区|市|町|村|温泉|空港|港|インター|PA|SA|タワー|ドーム|アリーナ|ヒルズ|シティ|モール/,
  ].some(re => re.test(userText));
}

/** 質問が「場所案内」系かを判定（商品購入意図と分離） */
function isPlaceIntent(userText) {
  if (!userText) return false;
  return PLACE_HINTS.some(re => re.test(userText));
}

/** 質問が「商品/サービス購入」意図かを判定（オンライン優先） */
function isProductIntent(userText) {
  if (!userText) return false;
  return PRODUCT_BUY_HINTS.some(re => re.test(userText));
}

/** ====== SerpAPIでGoogle検索 ====== */
async function webSearch(query, num = 6, gl = "jp", hl = "ja") {
  if (!SERPAPI_KEY) return [];
  const url =
    `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${num}&gl=${gl}&hl=${hl}&api_key=${SERPAPI_KEY}`;
  try {
    const r = await fetch(url);
    const j = await r.json();
    const items = j.organic_results || [];
    return items
      .filter(it => it.title && it.snippet && it.link)
      .map(it => ({ title: it.title, snippet: it.snippet, link: it.link }));
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

  /** ---------- 分岐ロジック ----------
   * 1) 場所系だが地名なし → まず場所を聞く（即レス）
   * 2) 商品/サービス購入の意図で地名なし → オンライン優先で検索＆案内（位置は聞かない）
   * 3) それ以外 → 通常フロー（必要時検索）
   */

  // 1) 場所意図 & 地名なし → 位置情報を尋ねる
  if (isPlaceIntent(userText) && !hasPlaceWord(userText)) {
    const reply = "了解！調べるね。今どこにいますか？";
    await saveMessage(conversationId, "assistant", reply);
    await lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
    return;
  }

  // 2) 商品/サービス購入意図 & 地名なし → オンライン優先で検索＆回答
  if (isProductIntent(userText) && !hasPlaceWord(userText)) {
    let sources = [];
    try {
      // 検索クエリを「通販/公式/オンライン」を意識して最適化
      const qResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 60,
        messages: [
          { role: "system", content: "ユーザー質問から、オンライン購入先を探すGoogle検索クエリを20〜60文字で1行。語尾や装飾なし。キーワードに『通販 公式 価格』を含める。" },
          { role: "user", content: userText }
        ],
      });
      const bestQ = qResp.choices?.[0]?.message?.content?.trim() || (userText + " 通販 公式 価格");
      sources = await webSearch(bestQ, 6, "jp", "ja");
    } catch (e) {
      console.error("query refine (product) error:", e);
      sources = await webSearch(userText + " 通販 公式 価格", 6, "jp", "ja");
    }

    const sourceBlock = sources.length
      ? `\n\n[Sources]\n${sources.map((s, i) => `(${i + 1}) ${s.title}\n${s.snippet}\n${s.link}`).join("\n")}`
      : "";

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: `${userText}\n\n（方針：まずオンラインの購入先を優先して紹介。必要なら近隣店舗も案内可と一言添える）${sourceBlock}` },
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

      // URLがなければ出典を補完
      if (sources.length && !/(https?:\/\/[^\s)]+)|（https?:\/\/[^\s)]+）/.test(draft)) {
        const cite = sources.slice(0, 3).map((s, i) => `(${i + 1}) ${s.link}`).join("\n");
        draft += `\n\n出典:\n${cite}`;
      }

      // ひとこと補足（ローカル店が必要なら地名/位置を依頼）
      draft += `\n\n※近くの実店舗が良ければ、地名か位置情報を教えてください。周辺の取扱店も探せます。`;

      replyText = draft;
    } catch (err) {
      console.error("OpenAI error (product):", err);
      replyText = "うまく調べられませんでした。商品名や型番をもう少しだけ具体的に教えてもらえますか？";
    }

    await saveMessage(conversationId, "assistant", replyText);
    await lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
    return;
  }

  // 3) 通常フロー（必要時のみ検索）
  let sources = [];
  if (needsSearch(userText)) {
    try {
      const qResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 60,
        messages: [
          { role: "system", content: "日本語の質問から、Google検索に最適なクエリを20〜60文字で1行だけ出力。装飾なし。" },
          { role: "user", content: userText }
        ],
      });
      const bestQ = qResp.choices?.[0]?.message?.content?.trim() || userText;
      sources = await webSearch(bestQ, 6, "jp", "ja");
    } catch (e) {
      console.error("query refine error:", e);
      sources = await webSearch(userText, 6, "jp", "ja");
    }
  }

  const sourceBlock = sources.length
    ? `\n\n[Sources]\n${sources.map((s, i) => `(${i + 1}) ${s.title}\n${s.snippet}\n${s.link}`).join("\n")}`
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
      temperature: 0.5,       // 自然さ維持
      max_tokens: 900,
    });
    let draft = resp.choices?.[0]?.message?.content?.trim() || "…";

    if (sources.length && !/(https?:\/\/[^\s)]+)|（https?:\/\/[^\s)]+）/.test(draft)) {
      const cite = sources.slice(0, 3).map((s, i) => `(${i + 1}) ${s.link}`).join("\n");
      draft += `\n\n出典:\n${cite}`;
    }

    replyText = draft;
  } catch (err) {
    console.error("OpenAI error:", err);
    replyText = "うまく調べられませんでした。条件をもう少しだけ具体的にいただけますか？";
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
