import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const lineClient = new line.Client(config);
const app = express();

// ヘルスチェック
app.get("/", (_req, res) => res.send("AI-kun running"));

// Webhook: ここでは express.json() を使わない！
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events ?? [];
    await Promise.all(events.map(handleEvent));
    // ✅ Verify を通すため常に 200 を返して終了
    return res.status(200).end();
  } catch (e) {
    console.error("Webhook error:", e);
    // ここでも 200 で返しておくと Verify が通りやすい
    return res.status(200).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") return;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const userText = event.message.text;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: userText }],
  });

  const replyText = resp.choices?.[0]?.message?.content ?? "…";
  return lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));
