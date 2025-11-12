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

/** ====== SNS 検索の鮮度（日数） ====== */
const RECENCY_DAYS = Math.max(
  1,
  parseInt(process.env.SOCIAL_SEARCH_RECENCY_DAYS || "14", 10)
);

/** ====== 親しみ＋正確性重視 SYSTEM_PROMPT ====== */
const SYSTEM_PROMPT = `
あなたは「AIくん」です。親しみやすい自然な日本語で答えます。
sources があれば事実はそれを根拠にし、リンクも示します。
sources が乏しい時は「可能性」「要確認」など控えめに表現し、追加確認を促します。
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

/** ====== ユーティリティ ====== */
function daysToTbs(days) {
  // Googleの期間フィルタ tbs=qdr:d / w / m
  if (days <= 7) return "qdr:w";          // 1週間以内
  if (days <= 31) return "qdr:m";         // 1ヶ月以内
  return "qdr:y";                          // 1年以内（保険）
}

/** ====== SerpAPI で検索（期間など追加パラメタ対応） ====== */
async function webSearch(query, opts = {}) {
  if (!SERPAPI_KEY) return [];
  const {
    num = 6, gl = "jp", hl = "ja", tbs // tbs=期間フィルタ
  } = opts;
  const params = new URLSearchParams({
    engine: "google",
    q: query,
    num: String(num),
    gl, hl,
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

/** ====== SNS横断（X/Instagram/Reddit） ====== */
async function socialSearchAll(userText) {
  if (!SERPAPI_KEY) return [];
  const tbs = daysToTbs(RECENCY_DAYS);
  // X(旧Twitter) は x.com も twitter.com も拾う
  const siteQuery =
    '(site:x.com OR site:twitter.com) OR site:instagram.com OR site:reddit.com';
  const q = `${userText} ${siteQuery}`;
  const results = await webSearch(q, { num: 8, tbs, gl: "jp", hl: "ja" });

  // 似たURLの重複を軽く排除
  const seen = new Set();
  const dedup = [];
  for (const r of results) {
    const key = r.link.replace(/(\?.*)$/, "");
    if (!seen.has(key)) {
      seen.add(key);
      dedup.push(r);
    }
    if (dedup.length >= 8) break;
  }
  return dedup;
}

/** ====== 検索ヒントの簡易ルール ====== */
const PLACE_HINTS = [
  /場所|住所|地図|最寄り|近く|周辺|近辺|アクセス|電話|営業時間|定休日|何時まで/,
  /カフェ|居酒屋|レストラン|病院|クリニック|ホテル|温泉|レンタカー|美術館|水族館|動物園|図書館|保育園|幼稚園|役所|コンビニ|ATM|コインランドリー/,
  /東京|東京都|大阪|京都|札幌|仙台|名古屋|福岡|那覇|横浜|神戸|鎌倉|川崎|千葉|埼玉/,
  /渋谷|新宿|池袋|銀座|秋葉原|上野|品川|恵比寿|中目黒|自由が丘|下北沢|吉祥寺|梅田|難波|天王寺|心斎橋|三宮|元町|天神|博多/
];
const FACT_HINTS = [
  /最新|今日|昨日|今週|今月|今年|速報|本日/,
  /ニュース|発表|値上げ|値下げ|価格|料金|在庫|為替|金利|相場|スケジュール|日程|統計|人数|売上|利用者|シェア/,
  /法律|規制|規約|仕様|バージョン/
];
const PRODUCT_BUY_HINTS = [
  /どこに売って(ます|る)|どこで(買え|売っ)て|どこで手に入る|どこで購入|買いたい|販売店|取扱店/,
  /通販|オンライン|ネットショップ|EC|公式ストア|公式サイト|購入先|在庫/,
  /買える\?|売ってる\?/,
];

function hasPlaceWord(userText) {
  if (!userText) return false;
  return [
    /東京|東京都|大阪|京都|札幌|仙台|名古屋|福岡|那覇|横浜|神戸|鎌倉|川崎|千葉|埼玉/,
    /渋谷|新宿|池袋|銀座|秋葉原|上野|品川|恵比寿|中目黒|自由が丘|下北沢|吉祥寺|梅田|難波|天王寺|心斎橋|三宮|元町|天神|博多|大濠|中洲/,
    /駅|区|市|町|村|温泉|空港|港|インター|PA|SA|タワー|ドーム|アリーナ|ヒルズ|シティ|モール/,
  ].some((re) => re.test(userText));
}

function classifyIntent(userText) {
  if (!userText) return null;
  if (PRODUCT_BUY_HINTS.some((re) => re.test(userText))) return "product";
  if (PLACE_HINTS.some((re) => re.test(userText))) return "place";
  if (FACT_HINTS.some((re) => re.test(userText))) return "fact";
  return null;
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

/** ====== 共通：sources をテキスト化 ====== */
function renderSources(title, arr) {
  if (!arr?.length) return "";
  const lines = arr.slice(0, 6).map((s, i) => `(${i + 1}) ${s.title}\n${s.link}`);
  return `\n\n[${title}]\n${lines.join("\n")}`;
}

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

  const intent = classifyIntent(userText);

  /** ---------- 共通：SNSも常に検索 ---------- */
  let social = [];
  try {
    social = await socialSearchAll(userText);
  } catch (e) {
    console.error("socialSearch error:", e);
  }

  // product：オンライン優先
  if (intent === "product") {
    let sources = [];
    try {
      const qResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 60,
        messages: [
          { role: "system", content: "ユーザー質問から、オンライン購入先を探すGoogle検索クエリを20〜60文字で1行。語尾や装飾なし。『通販 公式 価格』を含める。" },
          { role: "user", content: userText }
        ],
      });
      const bestQ = (qResp.choices?.[0]?.message?.content?.trim() || (userText + " 通販 公式 価格"));
      sources = await webSearch(bestQ, { num: 6, gl: "jp", hl: "ja" });
    } catch (e) {
      console.error("query refine (product) error:", e);
      sources = await webSearch(userText + " 通販 公式 価格", { num: 6, gl: "jp", hl: "ja" });
    }

    const sourceBlock = renderSources("Web sources", sources) + renderSources(`SNS（直近${RECENCY_DAYS}日）`, social);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: `${userText}\n\n（方針：まずオンライン購入先を優先。入荷/在庫/評判はSNSを根拠に付記）${sourceBlock}` },
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
      console.error("OpenAI error (product):", err);
      replyText = "うまく調べられませんでした。商品名や型番をもう少しだけ具体的に教えてもらえますか？";
    }

    await saveMessage(conversationId, "assistant", replyText);
    await lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
    return;
  }

  // place：地名なし→場所を聞く / 地名あり→検索
  if (intent === "place") {
    if (!hasPlaceWord(userText)) {
      const reply = "了解！調べるね。今どこにいますか？（地名や最寄り駅があると、周辺の最新投稿も合わせて探せます）";
      await saveMessage(conversationId, "assistant", reply);
      await lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
      return;
    }
    let sources = [];
    try {
      const qResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 60,
        messages: [
          { role: "system", content: "日本語の質問から、場所検索向けのGoogleクエリを20〜60文字で1行だけ出力。装飾なし。" },
          { role: "user", content: userText }
        ],
      });
      const bestQ = qResp.choices?.[0]?.message?.content?.trim() || userText;
      sources = await webSearch(bestQ, { num: 6, gl: "jp", hl: "ja" });
    } catch (e) {
      console.error("query refine (place) error:", e);
      sources = await webSearch(userText, { num: 6, gl: "jp", hl: "ja" });
    }

    const sourceBlock = renderSources("Web sources", sources) + renderSources(`SNS（直近${RECENCY_DAYS}日）`, social);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: `${userText}${sourceBlock}` },
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
      console.error("OpenAI error (place):", err);
      replyText = "うまく調べられませんでした。地名や範囲をもう少しだけ具体的にいただけますか？";
    }

    await saveMessage(conversationId, "assistant", replyText);
    await lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
    return;
  }

  // fact：事実系は検索して根拠付きで回答（SNSも根拠に）
  if (intent === "fact") {
    let sources = [];
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
      sources = await webSearch(bestQ, { num: 6, gl: "jp", hl: "ja" });
    } catch (e) {
      console.error("query refine (fact) error:", e);
      sources = await webSearch(userText, { num: 6, gl: "jp", hl: "ja" });
    }

    const sourceBlock = renderSources("Web sources", sources) + renderSources(`SNS（直近${RECENCY_DAYS}日）`, social);

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: `${userText}${sourceBlock}` },
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
      console.error("OpenAI error (fact):", err);
      replyText = "うまく調べられませんでした。条件をもう少しだけ具体的にいただけますか？";
    }

    await saveMessage(conversationId, "assistant", replyText);
    await lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
    return;
  }

  // null：通常フロー（検索不要だがSNSは常に付ける）
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: `${userText}${renderSources(`SNS（直近${RECENCY_DAYS}日）`, social)}` },
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
    replyText = "少し混み合っています。言い回しを変えてもう一度だけ送ってみてもらえますか？";
  }

  await saveMessage(conversationId, "assistant", replyText);
  await lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
}

/** ====== 起動 ====== */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
