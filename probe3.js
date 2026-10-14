const fs = require("fs");
(async () => {
  const ua = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36" };
  const out = [];
  const html = await (await fetch("https://www.flashloop.app/effects", { headers: ua })).text();
  const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  let m; const parts = [];
  while ((m = pushRe.exec(html)) !== null) { try { parts.push(JSON.parse("\"" + m[1] + "\"")); } catch {} }
  const all = parts.join("");
  // parse text rows: <id>:T<hexLen>,<text>
  const rowRe = /(^|\n)([0-9a-f]+):T([0-9a-f]+),/g;
  let r;
  const rows = {};
  while ((r = rowRe.exec(all)) !== null) {
    const id = r[2];
    const len = parseInt(r[3], 16);
    const start = rowRe.lastIndex;
    rows[id] = all.slice(start, start + len);
  }
  out.push("rowIds: " + Object.keys(rows).join(","));
  ["42","43","44","45","46","47","48","49","4a","4b"].forEach(id => {
    if (rows[id]) out.push("\n=== row " + id + " (" + rows[id].length + ") ===\n" + rows[id].slice(0, 1200));
  });
  // sjinn detail page: look for embedded json / prompt strings
  const sh = await (await fetch("https://sjinn.ai/trend-prompts/slime-face", { headers: ua })).text();
  const hits = [];
  const re2 = /(prompt|video_url|videoUrl|preview)/gi; let h2;
  while ((h2 = re2.exec(sh)) !== null) hits.push(sh.slice(Math.max(0, h2.index - 120), h2.index + 200).replace(/\s+/g, " "));
  out.push("\n=== SJINN hits (" + hits.length + ") ===\n" + hits.slice(0, 6).join("\n---\n"));
  fs.writeFileSync("probe-out.txt", out.join("\n"));
  console.log("done", Object.keys(rows).length);
})();
