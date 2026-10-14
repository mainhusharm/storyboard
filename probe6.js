const fs = require("fs"), path = require("path");
const key = fs.readFileSync(path.join("pipeline", "apikey.txt"), "utf8").trim();
const models = ["gemini-3.1-flash-lite","deepseek-v3.2","deepseek-v4-flash","glm-5.2","glm-5.3","kimi-k3","kimi-k2.6","qwen3.8-max","grok-4.6","mimo-v2.5","minimax-m3","gpt-5.5","gpt-5","gpt-5.2","gpt-4.1","claude-sonnet-4-5","claude-opus-4-8"];
(async () => {
  const out = [];
  for (const model of models) {
    try {
      const r = await fetch("https://api.paxsenix.org/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with the single word OK." }], temperature: 0, max_tokens: 20, stream: false }),
        signal: AbortSignal.timeout(45000)
      });
      const t = await r.text();
      let reply = "";
      try { reply = JSON.parse(t).choices?.[0]?.message?.content ?? ""; } catch { reply = t.slice(0, 120); }
      out.push(model + " => HTTP " + r.status + " :: " + String(reply).slice(0, 80).replace(/\n/g, " "));
    } catch (e) { out.push(model + " => ERR " + e.message); }
    await new Promise(r2 => setTimeout(r2, 300));
  }
  fs.writeFileSync("probe-out.txt", out.join("\n"));
  console.log(out.join("\n"));
})();
