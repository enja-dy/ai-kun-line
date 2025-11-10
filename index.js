import express from "express";
import line from "@line/bot-sdk";
import OpenAI from "openai";

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const app = express();
const client = new line.Client(config);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 簡易メモリ（本番はDBへ）
const usage = new Map();
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 5);

app.post("/webhook", line.middleware(config), async (req, res) => {
  const events = req.body?.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  if (event.type !== "message") return;
  const userId = event.source?.userId || "unknown";
  const msg = event.message;
  const today = new Date().toISOString().slice(0, 10);

  let u = usage.get(userId);
  if (!u || u.date !== today) { u = { count: 0, date: today }; usage.set(userId, u); }

  const isPaid = false; // ← 有料は後でDB等と連携

  if (!isPaid && u.count >= FREE_DAILY_LIMIT) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `今日は無料の質問上限（${FREE_DAILY_LIMIT}回）に達しました。\n` +
        `👉 月500円「AIくんプレミアム」で使い放題：\n` +
        `https://your-site.example/premium\n\n` +
        `※毎日0時に回数はリセットされます。`,
    });
  }

  let userText = "";
  if (msg.type === "text") userText = msg.text?.trim() || "";
  else if (msg.type === "location")
    userText = `ユーザー提供の位置情報: 緯度=${msg.latitude}, 経度=${msg.longitude}。近場のおすすめやルートがあれば教えて。`;
  else userText = `ユーザーは ${msg.type} を送信。役立つ返答を日本語で。`;

  const systemPrompt = `
あなたは「AIくん」。LINE内の日本語アシスタントです。
- 回答は簡潔（最大5行＋箇条書き推奨）。
- 不確実なら追加情報を質問。
- 観光/地図/生活/英語の“ちょい相談”が得意。
`;

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 500,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ]
    });
    const answer = (resp.choices?.[0]?.message?.content || "").trim() || "うまく答えられませんでした。";
    u.count += 1;

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: answer,
    });
  } catch (e) {
    console.error(e);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "内部エラーが発生しました。しばらくして再度お試しください。"
    });
  }
}

app.get("/", (_, res) => res.send("AIくん running"));
app.listen(process.env.PORT || 3000, () => console.log("Server started"));
