const fs = require("fs");
function decode(html) {
  const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  let m; const parts = [];
  while ((m = pushRe.exec(html)) !== null) { try { parts.push(JSON.parse("\"" + m[1] + "\"")); } catch {} }
  return parts.join("");
}
function rows(all) { const rowRe = /(^|\n)([0-9a-f]+):T([0-9a-f]+),/g; let r; const o = {}; while ((r = rowRe.exec(all)) !== null) o[r[2]] = all.slice(rowRe.lastIndex, rowRe.lastIndex + parseInt(r[3], 16)); return o; }
(async () => {
  const ua = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36" };
  const out = [];
  const main = await (await fetch("https://www.flashloop.app/effects", { headers: ua })).text();
  const all = decode(main);
  out.push("effect links: " + [...new Set((all.match(/\/effects\/[a-z0-9\-]+/g) || []))].slice(0, 20).join(", "));
  const cache = {};
  for (const url of ["https://www.flashloop.app/effects/watercolor", "https://www.flashloop.app/trends/watercolor"]) {
    try {
      const r = await fetch(url, { headers: ua, redirect: "follow" });
      const t = await r.text();
      const a2 = decode(t);
      const ids = Object.keys(rows(a2));
      cache[url] = { status: r.status, len: t.length, rowIds: ids.join(","), hasTrend: a2.includes("trendContent"), refs: [...new Set((a2.match(/\$[0-9a-f]{1,3}/g) || []))].join(" ") };
      out.push(url + " -> " + JSON.stringify(cache[url]).slice(0, 500));
      const rw = rows(a2);
      const firstBig = Object.entries(rw).find(([k, v]) => v.length > 600 && !v.startsWith("[{"));
      out.push(" first big row: " + (firstBig ? firstBig[0] + " :: " + firstBig[1].slice(0, 300) : "none"));
    } catch (e) { out.push(url + " ERR " + e.message); }
  }
  // sjinn detail page media
  const sh = await (await fetch("https://sjinn.ai/trend-prompts/slime-face", { headers: ua })).text();
  out.push("\nsjinn mp4s: " + [...new Set((sh.match(/https:\/\/[^"\x27 ]+\.(mp4|webm|m3u8|mov)/g) || []))].join(" | "));
  out.push("sjinn _next data: " + (sh.match(/self\.__next_f/g) || []).length);
  const body = sh.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "\x27").replace(/\s+/g, " ");
  out.push("\nsjinn body: " + body.slice(0, 4000));
  fs.writeFileSync("probe-out.txt", out.join("\n"));
  console.log("ok");
})();
