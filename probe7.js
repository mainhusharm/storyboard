const fs = require("fs");
const key = fs.readFileSync("pipeline/apikey.txt", "utf8").trim();
async function tryModel(model, msgs) {
  try {
    const r = await fetch("https://api.paxsenix.org/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model, messages: msgs, temperature: 0.3, max_tokens: 120, stream: false }), signal: AbortSignal.timeout(60000) });
    const t = await r.text();
    let reply = "";
    try { reply = JSON.parse(t).choices?.[0]?.message?.content ?? ""; } catch { reply = t.slice(0, 150); }
    console.log(model, "=>", r.status, "::", String(reply).slice(0, 100).replace(/\n/g, " "));
    fs.appendFileSync("probe-out.txt", model + " => " + r.status + " :: " + String(reply).slice(0, 100).replace(/\n/g, " ") + "\n");
  } catch (e) { console.log(model, "ERR", e.message); }
}
(async () => {
  fs.writeFileSync("probe-out.txt", "");
  const visionMsgs = [{ role: "user", content: [{ type: "text", text: "Describe this image in 5 words." }, { type: "image_url", image_url: { url: "https://assets.flashloop.app/temp/trend-examples/sports-anime/celebrating-poster.jpg" } }] }];
  const textMsgs = [{ role: "user", content: "Reply with the single word OK." }];
  await tryModel("gpt-4o-mini", visionMsgs);
  await tryModel("gpt-4o-mini", textMsgs);
})();
