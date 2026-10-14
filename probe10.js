const fs = require("fs");
const key = fs.readFileSync("pipeline/logfare_apikey.txt", "utf8").trim();
async function tryOne(label, content, maxT) {
  try {
    const r = await fetch("https://logfare.ai/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify({ model: "gemma-4-26b", messages: [{ role: "user", content }], max_tokens: maxT, temperature: 0.2 }), signal: AbortSignal.timeout(180000) });
    const t = await r.text();
    let c = "";
    try { c = JSON.parse(t).choices?.[0]?.message?.content || process.versions && (JSON.parse(t).choices?.[0]?.message?.reasoning_content || ""); } catch { c = t.slice(0,150); }
    console.log(label, r.status, "::", String(c).slice(0, 400).replace(/\n/g, " "));
  } catch (e) { console.log(label, "ERR", e.message); }
}
(async () => {
  const poster = "https://assets.flashloop.app/temp/trend-examples/sports-anime/celebrating-poster.jpg";
  await tryOne("dataurl", [{ type: "text", text: "Describe this image in 8 words." }, { type: "image_url", image_url: { url: (await (async()=>{ const b=await (await fetch(poster)).arrayBuffer(); return "data:image/jpeg;base64,"+Buffer.from(b).toString("base64"); })()) } }], 300);
})();
