const fs = require("fs");
const key = fs.readFileSync("pipeline/logfare_apikey.txt", "utf8").trim();
async function tryModel(model, msgs, maxT) {
  try {
    const r = await fetch("https://logfare.ai/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: msgs, max_tokens: maxT, temperature: 0.2 }), signal: AbortSignal.timeout(120000) });
    const t = await r.text();
    console.log(model, "=>", r.status, "len", t.length);
    console.log(" ::", t.slice(0, 800).replace(/\n/g, " "));
  } catch (e) { console.log(model, "ERR", e.message); }
}
(async () => {
  const visionMsgs = [{ role: "user", content: [{ type: "text", text: "Describe this image in 8 words and nothing else." }, { type: "image_url", image_url: { url: "https://assets.flashloop.app/temp/trend-examples/sports-anime/celebrating-poster.jpg" } }] }];
  await tryModel("logfare/auto", visionMsgs, 300);
})();
