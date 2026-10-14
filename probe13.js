process.env.PORT = "0";
const server = require("./web/server");
const T = server.__internal;
(async () => {
  try {
    const r = await T.buildTrendTemplate({ source: "flashloop", slug: "sports-anime-cv", name: "Sports Anime", refresh: true });
    require("fs").writeFileSync("probe-out.txt", "PARSE-DBG\n" + (global.__trendRaw || "(no raw captured)"));
    console.log("done beats=" + r.beats.length);
  } catch (e) { console.log("ERR", e.message); }
  process.exit(0);
})();
