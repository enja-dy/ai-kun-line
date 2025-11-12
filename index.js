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
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!,
  { auth: { persistSession: false } }
);

/** ====== 外部キー ====== */
const SERPAPI_KEY = process.env.SERPAPI_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const SOCIAL_SEARCH_RECENCY_DAYS = Number(process.env.SOCIAL_SEARCH_RECENCY_DAYS ?? 14);

/** ====== SYSTEM_PROMPT ====== */
const SYSTEM_PROMPT = `
あなたは「AIくん」です。親しみやすい口調で、自然な日本語で答えてください。
- 事実依存の内容は可能ならsourcesを参照し、SNSの鮮度情報は「最近の傾向」として簡潔に扱う。
- 断定できない場合は「可能性」「最新状況は要確認」と表現する。
`;

/** ====== 会話ID ====== */
function getConversationId(event:any) {
  const src = event.source ?? {};
  if (src.groupId) return `group:${src.groupId}`;
  if (src.roomId) return `room:${src.roomId}`;
  if (src.userId) return `user:${src.userId}`;
  return "unknown";
}

/** ====== 履歴保存/取得 ====== */
const HISTORY_LIMIT = 12;

async function fetchRecentMessages(conversationId:string) {
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
    .map((r:any) => ({ role: r.role, content: r.content }))
    .filter((m:any) => m.role === "user" || m.role === "assistant");
}

async function saveMessage(conversationId:string, role:"user"|"assistant", content:string) {
  const { error } = await supabase
    .from("conversation_messages")
    .insert([{ conversation_id: conversationId, role, content }]);
  if (error) console.error("saveMessage error:", error);
}

/** ====== 検索ヒント ====== */
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

/** 地名を含むか */
function hasPlaceWord(userText:string) {
  if (!userText) return false;
  return [
    /東京|東京都|大阪|京都|札幌|仙台|名古屋|福岡|那覇|横浜|神戸|鎌倉|川崎|千葉|埼玉/,
    /渋谷|新宿|池袋|銀座|秋葉原|上野|品川|恵比寿|中目黒|自由が丘|下北沢|吉祥寺|梅田|難波|天王寺|心斎橋|三宮|元町|天神|博多|大濠|中洲/,
    /駅|区|市|町|村|温泉|空港|港|インター|PA|SA|タワー|ドーム|アリーナ|ヒルズ|シティ|モール/,
  ].some(re => re.test(userText));
}

/** ====== 意図分類（優先度：product → place → fact → null） ====== */
function classifyIntent(userText:string) {
  if (!userText) return null;
  if (PRODUCT_BUY_HINTS.some(re => re.test(userText))) return "product";
  if (PLACE_HINTS.some(re => re.test(userText))) return "place";
  if (FACT_HINTS.some(re => re.test(userText))) return "fact";
  return null;
}

/** ====== SerpAPI: Google 検索 ====== */
async function googleSearchSerpApi(q:string, {
  num=6, gl="jp", hl="ja", tbs=""
}:{num?:number, gl?:string, hl?:string, tbs?:string} = {}) {
  if (!SERPAPI_KEY) return [];
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=${num}&gl=${gl}&hl=${hl}${tbs?`&tbs=${encodeURIComponent(tbs)}`:""}&api_key=${SERPAPI_KEY}`;
  try {
    const r = await fetch(url);
    const j:any = await r.json();
    const items = j.organic_results || [];
    return items
      .filter((it:any) => it.title && it.snippet && it.link)
      .map((it:any) => ({ title: it.title, snippet: it.snippet, link: it.link }));
  } catch (e) {
    console.error("googleSearchSerpApi error:", e);
    return [];
  }
}

/** ====== SerpAPI: Reddit 検索 ====== */
async function redditSearchSerpApi(q:string, num=6) {
  if (!SERPAPI_KEY) return [];
  const url = `https://serpapi.com/search.json?engine=reddit&q=${encodeURIComponent(q)}&num=${num}&api_key=${SERPAPI_KEY}`;
  try {
    const r = await fetch(url);
    const j:any = await r.json();
    const posts = (j.organic_results || []).map((p:any)=>({
      title: p.title, snippet: p.snippet, link: p.link
    }));
    return posts;
  } catch (e) {
    console.error("redditSearchSerpApi error:", e);
    return [];
  }
}

/** ====== YouTube 検索（公式 API / 任意） ====== */
async function youtubeSearch(q:string, maxResults=6) {
  if (!YOUTUBE_API_KEY) return [];
  const since = new Date(Date.now() - SOCIAL_SEARCH_RECENCY_DAYS*86400000).toISOString();
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=${maxResults}&publishedAfter=${encodeURIComponent(since)}&q=${encodeURIComponent(q)}&key=${YOUTUBE_API_KEY}`;
  try {
    const r = await fetch(url);
    const j:any = await r.json();
    const items = (j.items || []).map((it:any)=>({
      title: it.snippet.title,
      snippet: it.snippet.description,
      link: `https://www.youtube.com/watch?v=${it.id.videoId}`
    }));
    return items;
  } catch (e) {
    console.error("youtubeSearch error:", e);
    return [];
  }
}

/** ====== SNS横断検索（X/Instagram=site:, Reddit, YouTube） ====== */
async function socialSearch(userText:string) {
  const days = SOCIAL_SEARCH_RECENCY_DAYS;
  const tbs = days <= 1 ? "qdr:d" : days <= 7 ? "qdr:w" : "qdr:m"; // 期間指定
  const xQuery = `${userText} site:x.com OR site:twitter.com`;
  const igQuery = `${userText} site:instagram.com`;
  const xRes   = await googleSearchSerpApi(xQuery, { num: 6, tbs });
  const igRes  = await googleSearchSerpApi(igQuery, { num: 6, tbs });
  const rdRes  = await redditSearchSerpApi(userText, 6);
  const ytRes  = await youtubeSearch(userText, 6);

  const tag = (label:string) => (o:any)=>({ ...o, platform: label });
  const results = [
    ...xRes.map(tag("X")),
    ...igRes.map(tag("Instagram")),
    ...rdRes.map(tag("Reddit")),
    ...ytRes.map(tag("YouTube")),
  ];

  // 重複排除
  const seen = new Set<string>();
  const dedup = results.filter(r=>{
    try {
      const u = new URL(r.link);
      const key = u.hostname + u.pathname;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    } catch { return true; }
  });

  return dedup.slice(0, 8);
}

/** ====== SNS自動発火の条件 ====== */
function shouldUseSNS(text:string, intent:string|null) {
  // 雑談・挨拶だけっぽい超短文は抑制
  if (!text || text.length < 4) return false;

  // 一般的に鮮度メリットが高いクエリ
  const recencyHints = [
    /最新|最近|トレンド|評判|口コミ|レビュー|不具合|障害|アップデート|在庫|炎上|バズ/,
    /発売|発表|イベント|キャンペーン|セール|値上げ|値下げ/,
    /公式|アナウンス|告知/
  ];
  const strong = recencyHints.some(re => re.test(text));

  // intentに基づく基本方針
  if (intent === "fact" || intent === "product" || intent === "place") return true;
  // 通常LLMでも、強い鮮度ワードがあれば有効化
  if (strong) return true;

  return false;
}

/** ====== SNS結果の追記 ====== */
function appendSNSSection(draft:string, sns:any[]) {
  if (!sns || sns.length === 0) return draft;
  const list = sns.slice(0,5).map((s:any,i:number)=>`(${i+1}) [${s.platform}] ${s.title}\n${s.link}`).join("\n");
  return `${draft}\n\n【直近SNSの声】\n${list}\n\n※SNSは公開範囲や仕様に依存します。公式発表・一次情報もあわせてご確認ください。`;
}

/** ====== 既存の汎用 Google 検索（互換） ====== */
async function webSearch(query:string, num=6, gl="jp", hl="ja") {
  return googleSearchSerpApi(query, { num, gl, hl });
}

/** ====== Health check ====== */
app.get("/", (_req, res) => res.send("AI-kun running"));

/** ====== Webhook ====== */
app.post("/callback", line.middleware(config), async (req:any, res:any) => {
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
async function handleEvent(event:any) {
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

  // —— 意図分類
  const intent = classifyIntent(userText);

  /** ---------- 分岐ロジック ----------
   * product：オンライン購入先
   * place  ：位置
   * fact   ：ニュース/統計など
   * null   ：通常LLM
   */

  // product
  if (intent === "product") {
    let sources:any[] = [];
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
      const bestQ = qResp.choices?.[0]?.message?.content?.trim() || (userText + " 通販 公式 価格");
      sources = await webSearch(bestQ, 6, "jp", "ja");
    } catch (e) {
      console.error("query refine (product) error:", e);
      sources = await webSearch(userText + " 通販 公式 価格", 6, "jp", "ja");
    }

    const sourceBlock = sources.length
      ? `\n\n[Sources]\n${sources.map((s, i) => `(${i + 1}) ${s.title}\n${s.snippet}\n${s.link}`).join("\n")}`
      : "";

    const messages:any[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: `${userText}\n\n（方針：まずオンラインの購入先を優先して紹介。必要なら近隣店舗も案内できると一言添える）${sourceBlock}` },
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

      if (sources.length && !/(https?:\/\/[^\s)]+)|（https?:\/\/[^\s)]+）/.test(draft)) {
        const cite = sources.slice(0, 3).map((s, i) => `(${i + 1}) ${s.link}`).join("\n");
        draft += `\n\n出典:\n${cite}`;
      }

      // ▼ 常時SNSサブクエリ
      if (shouldUseSNS(userText, intent)) {
        try {
          const sns = await socialSearch(userText);
          draft = appendSNSSection(draft, sns);
        } catch (e) { console.error("SNS append (product):", e); }
      }

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

  // place
  if (intent === "place") {
    if (!hasPlaceWord(userText)) {
      const reply = "了解！調べるね。今どこにいますか？";
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
      sources = await webSearch(bestQ, 6, "jp", "ja");
    } catch (e) {
      console.error("query refine (place) error:", e);
      sources = await webSearch(userText, 6, "jp", "ja");
    }

    const sourceBlock = sources.length
      ? `\n\n[Sources]\n${sources.map((s:any, i:number) => `(${i + 1}) ${s.title}\n${s.snippet}\n${s.link}`).join("\n")}`
      : "";

    const messages:any[] = [
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

      if (sources.length && !/(https?:\/\/[^\s)]+)|（https?:\/\/[^\s)]+）/.test(draft)) {
        const cite = (sources as any[]).slice(0, 3).map((s, i) => `(${i + 1}) ${s.link}`).join("\n");
        draft += `\n\n出典:\n${cite}`;
      }

      // ▼ 常時SNSサブクエリ
      if (shouldUseSNS(userText, intent)) {
        try {
          const sns = await socialSearch(userText);
          draft = appendSNSSection(draft, sns);
        } catch (e) { console.error("SNS append (place):", e); }
      }

      replyText = draft;
    } catch (err) {
      console.error("OpenAI error (place):", err);
      replyText = "うまく調べられませんでした。地名や範囲をもう少しだけ具体的にいただけますか？";
    }

    await saveMessage(conversationId, "assistant", replyText);
    await lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
    return;
  }

  // fact
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
      sources = await webSearch(bestQ, 6, "jp", "ja");
    } catch (e) {
      console.error("query refine (fact) error:", e);
      sources = await webSearch(userText, 6, "jp", "ja");
    }

    const sourceBlock = sources.length
      ? `\n\n[Sources]\n${sources.map((s:any, i:number) => `(${i + 1}) ${s.title}\n${s.snippet}\n${s.link}`).join("\n")}`
      : "";

    const messages:any[] = [
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
      if (sources.length && !/(https?:\/\/[^\s)]+)|（https?:\/\/[^\s)]+）/.test(draft)) {
        const cite = (sources as any[]).slice(0, 3).map((s, i) => `(${i + 1}) ${s.link}`).join("\n");
        draft += `\n\n出典:\n${cite}`;
      }

      // ▼ 常時SNSサブクエリ
      if (shouldUseSNS(userText, intent)) {
        try {
          const sns = await socialSearch(userText);
          draft = appendSNSSection(draft, sns);
        } catch (e) { console.error("SNS append (fact):", e); }
      }

      replyText = draft;
    } catch (err) {
      console.error("OpenAI error (fact):", err);
      replyText = "うまく調べられませんでした。条件をもう少しだけ具体的にいただけますか？";
    }

    await saveMessage(conversationId, "assistant", replyText);
    await lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
    return;
  }

  // null：通常LLM + 必要ならSNS追記
  const messages:any[] = [
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
    let draft = resp.choices?.[0]?.message?.content?.trim() || "…";

    if (shouldUseSNS(userText, null)) {
      try {
        const sns = await socialSearch(userText);
        draft = appendSNSSection(draft, sns);
      } catch (e) { console.error("SNS append (null):", e); }
    }

    replyText = draft;
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
