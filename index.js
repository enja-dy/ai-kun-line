import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();
app.use(express.json());
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Webhook 受信
app.post("/callback", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;

    for (const event of events) {
      if (event.type === "message" && event.message.type === "text") {
        const userMessage = event.message.text;

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: userMessage }],
        });

        const replyMessage = completion.choices?.[0]?.message?.content ?? "エラー";

        await client.replyMessage(event.replyToken, {
          type: "text",
          text: replyMessage,
        });
      }
    }

    res.status(200).end();
  } catch (error) {
    console.error(error);
    res.status(500).end();
  }
});

// ✅ ポート起動
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
