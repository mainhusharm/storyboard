const fs = require("fs");
(async () => {
  const ua = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36" };
  const out = [];
  const html = await (await fetch("https://www.flashloop.app/effects", { headers: ua })).text();
  const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  let m; const parts = [];
  while ((m = pushRe.exec(html)) !== null) { try { parts.push(JSON.parse("\"" + m[1] + "\"")); } catch {} }
  const all = parts.join("");
  const rowRe = /(^|\n)([0-9a-f]+):T([0-9a-f]+),/g;
  let r; const rows = {};
  while ((r = rowRe.exec(all)) !== null) { const id = r[2]; const len = parseInt(r[3], 16); rows[id] = all.slice(rowRe.lastIndex, rowRe.lastIndex + len); }
  const raw = html;
  const key = "\"trendContent\"";
  const idx = all.indexOf(key);
  // brute: brace-match the trendContent object from decoded payload
  let braceIdx = all.indexOf("{", idx + key.length);
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = braceIdx; i < all.length; i++) { const c = all[i]; if (!inStr) { if (c === "{") depth++; else if (c === "}") { depth--; if (!depth) { end = i + 1; break; } } else if (c === "\"") inStr = true; } else { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; } }
  const tc = JSON.parse(all.slice(braceIdx, end));
  const slugs = Object.keys(tc);
  out.push("trends: " + slugs.length);
  let withPrompt = 0, totalExamples = 0, resolved = 0;
  for (const s of slugs) {
    const ex = tc[s].examples || [];
    totalExamples += ex.length;
    ex.forEach(e => { const mm = String(e.prompt || "").match(/^\$([0-9a-f]+)$/); if (mm && rows[mm[1]]) { resolved++; withPrompt++; } });
  }
  out.push("examples: " + totalExamples + " resolvedPrompts: " + resolved);
  out.push("sample slugs: " + slugs.slice(0, 12).join(", "));
  const withT = slugs.filter(s => (tc[s].examples || []).some(e => { const mm = String(e.prompt || "").match(/^\$([0-9a-f]+)$/); return mm && rows[mm[1]]; }));
  out.push("trendsWithPrompts: " + withT.join(", "));
  out.push("\nsample example: " + JSON.stringify(tc[slugs[0]]).slice(0, 400));
  fs.writeFileSync("probe-out.txt", out.join("\n"));
  console.log("ok");
})();
