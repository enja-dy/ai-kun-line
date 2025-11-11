 import express from "express";
 import * as line from "@line/bot-sdk";
 import OpenAI from "openai";
 
 const config = {
   channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
   channelSecret: process.env.LINE_CHANNEL_SECRET,
 };
 
 const lineClient = new line.Client(config);
 const app = express();

+// ▼ 追加：具体志向へ矯正する system プロンプト
+const SYSTEM_PROMPT = `
+あなたは「AIくん」。日本語で、具体的・実用的に答えます。
+- 一般論だけで終わらせない。「公式サイト/SNSで確認してください」「データに含まれていません」等の逃げ表現は使わない。
+- 情報が足りない時は、先に最大2問だけ補足質問をしつつ、同時に暫定案（Top3）を必ず提示。
+- 可能なら名称/住所/目印/目安価格/営業時間/URLを含める。URLはhttpsから始まる簡潔なもの。
+- 出力テンプレ:
+  1) 要点1行
+  2) 具体候補(最大3)
+  3) 代替案 or 在庫確認の手順
+  4) 次の一手（短い指示）
+`;
 
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
-    messages: [{ role: "user", content: userText }],
+    messages: [
+      { role: "system", content: SYSTEM_PROMPT },
+      { role: "user", content: userText }
+    ],
     temperature: 0.5,
     max_tokens: 600,
   });
 
   const replyText = resp.choices?.[0]?.message?.content ?? "…";
   return lineClient.replyMessage(event.replyToken, { type: "text", text: replyText });
 }
 
 const port = process.env.PORT || 3000;
 app.listen(port, () => console.log(`Server running on ${port}`));
