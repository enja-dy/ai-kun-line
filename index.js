import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.Client(config);
const app = express();

// ▼ system prompt
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

// ✅ Health check
app.get("/", (_req, res) => res.send("AI-kun running"));

// ✅ Webhook
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

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const userText = event.message.text;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText },
    ],
    temperature: 0.5,
    max_tokens: 800,
  });

  const replyText = resp.choices?.[0]?.message?.content ?? "…";
  return lineClient.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
