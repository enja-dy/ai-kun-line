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

/** ====== System Prompt ====== */
const SYSTEM_PROMPT = `
あなたは「AIくん」です。
回答は必ず日本語で、わかりやすく・具体的に返してください。

【禁止事項】
- 「公式サイトを確認してください」
- 「難しいです／わかりません」
- 「私のデータには含まれていません」
- 一般論だけで終わること

【不足情報の扱い】
- 情報が足りない場合、最大2つ質問する
- ただし、可能性の高い候補を同時に提示する

【回答フォーマット】
1) 要点1行
2) 具体候補 最大3件（名称 / 所在地 / URL / 価格目安など）
3) 代替案
4) 次の一手（1行）
`;

/** ====== 会話ID生成 ====== */
function getConversationId(event) {
  const src = event.source ?? {};
  if (src.groupId) return `group:${src.groupId}`;
  if (src.roomId) return `room:${src.roomId}`;
  if (src.userId) return `user:${src.userId}`;
  return "unknown";
}

/** ====== 履歴保存/取得 ====== */
const HISTORY_LIMIT = 12; // 直近のメッセージ数

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

  return (data ?? []).reverse() // 古い順
    .map(r => ({ role: r.role, content: r.content }))
    .filter(m => m.role === "user" || m.role === "assistant");
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
    return res.status(200).end(); // Verify用: 200必須
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

  // 入力を保存
  await saveMessage(conversationId, "user", userText);

  // 履歴を取得
  const history = await fetchRecentMessages(conversationId);

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
      max_tokens: 800,
      temperature: 0.5,
    });
    replyText = resp.choices?.[0]?.message?.content?.trim() || "…";
  } catch (err) {
    console.error("OpenAI error:", err);
    replyText = "すみません、少し混み合っています。もう一度お試しください。";
  }

  // 出力も保存
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
