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

/** ====== 親しみやすい SYSTEM_PROMPT ====== */
const SYSTEM_PROMPT = `
あなたは「AIくん」です。相手に寄りそい、親しみやすい口調で、自然な日本語の文章で答えてください。
箇条書きは必要に応じて軽く使ってOKですが、毎回同じ形式にはしないでください。
提案の根拠や具体例は簡潔に。必要なら追加の質問を1つだけ添えて会話を広げてください。

【避けること】
- 「公式サイトを確認してください」だけで終わる
- 「わかりません」で終わる
- 一般論だけで終える
`;

/** ====== 会話ID（1:1/グループ/ルーム対応） ====== */
function getConversationId(event) {
  const src = event.source ?? {};
  if (src.groupId) return `group:${src.groupId}`;
  if (src.roomId) return `room:${src.roomId}`;
  if (src.userId) return `user:${src.userId}`;
  return "unknown";
}

/** ====== 履歴保存/取得 ====== */
const HISTORY_LIMIT = 12; // 直近の user/assistant を取り回し（6往復イメージ）

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
    .reverse() // 古→新
    .map((r) => ({ role: r.role, content: r.content }))
    .filter((m) => m.role === "user" || m.role === "assistant");
}

async function saveMessage(conversationId, role, content) {
  const { error } = await supabase
    .from("conversation_messages")
    .insert([{ conversation_id: conversationId, role, content }]);
  if (error) console.error("saveMessage error:", error);
}

/** ====== Health check ====== */
app.get("/", (_req, res) => res.send("AI-kun running"));

/** ====== Webhook ====== */
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events ?? [];
    await Promise.all(events.map(handleEvent));
    return res.status(200).end(); // Verify用: 常に200
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

  // 「リセット」で会話履歴を削除（運用便利）
  if (userText === "リセット" || userText.toLowerCase() === "reset") {
    const { error } = await supabase
      .from("conversation_messages")
      .delete()
      .eq("conversation_id", conversationId);
    const msg = error
      ? "リセットに失敗しました。少し時間をおいてお試しください。"
      : "会話履歴をリセットしました。改めてどうぞ！";
    await lineClient.replyMessage(event.replyToken, { type: "text", text: msg });
    return;
  }

  // 入力を保存
  await saveMessage(conversationId, "user", userText);

  // 履歴を取得
  const history = await fetchRecentMessages(conversationId);

  // ざっくり長さで絞る（簡易トークン節約）
  const approxLimitChars = 7000;
  let running = 0;
  const trimmed = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    running += (m.content?.length ?? 0);
    trimmed.unshift(m);
    if (running > approxLimitChars) {
      trimmed.shift();
      break;
    }
  }

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...trimmed,
    { role: "user", content: userText },
  ];

  let replyText = "…";
  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 800,
      temperature: 0.6, // 少しだけ表現を柔らかく
    });
    replyText = resp.choices?.[0]?.message?.content?.trim() || "…";
  } catch (err) {
    console.error("OpenAI error:", err);
    replyText =
      "今ちょっと混み合っているみたいです。短めにもう一度聞いてもらえると助かります！";
  }

  // 出力を保存
  await saveMessage(conversationId, "assistant", replyText);

  // 返信
  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

/** ====== 起動 ====== */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
