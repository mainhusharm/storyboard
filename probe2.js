(async () => {
  const ua = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36" };
  const out = [];
  const r = await fetch("https://www.flashloop.app/effects", { headers: ua });
  const html = await r.text();
  const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
  let m; const parts = [];
  while ((m = pushRe.exec(html)) !== null) { try { parts.push(JSON.parse("\"" + m[1] + "\"")); } catch {} }
  const all = parts.join("");
  out.push("row 42:" + (all.indexOf("42:T") !== -1));
  out.push("api refs: " + [...new Set((all.match(/https:\/\/api\.[a-z0-9.\-]+[^"\\\\ ]*/g) || []))].slice(0,5).join(" | "));
  out.push("trend-examples count: " + (all.match(/trend-examples/g) || []).length);
  const tc = all.slice(all.indexOf("trendContent"), all.indexOf("trendContent") + 1200);
  out.push("trendContent head: " + tc.slice(0, 900));
  const poster = "https://assets.flashloop.app/temp/trend-examples/sports-anime/celebrating-poster.jpg";
  const pr = await fetch(poster, { headers: ua });
  out.push("poster: " + pr.status + " " + pr.headers.get("content-type") + " " + pr.headers.get("content-length"));
  const m3 = await fetch("https://assets.flashloop.app/temp/trend-examples/sports-anime/celebrating/index.m3u8", { headers: ua });
  const m3t = await m3.text();
  out.push("m3u8: " + m3.status + " :: " + m3t.slice(0, 300).replace(/\n/g, " ~ "));
  require("fs").writeFileSync("probe-out.txt", out.join("\n"));
  console.log("done");
})();
