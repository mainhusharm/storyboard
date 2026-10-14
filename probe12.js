process.env.PORT = "0";
const server = require("./web/server");
const T = server.__internal;
function h(tag) { const ts = new Date().toISOString().slice(11, 23); console.log(ts, tag); }
(async () => {
  try {
    const formats = await T.scrapeFlashloop();
    h("scraped " + formats.length);
    const fmt = formats.find(f => f.slug === "sports-anime-cv");
    const media = fmt.examples.slice(0, 2).flatMap(e => e.videoUrl ? [{ kind: "video", url: e.videoUrl, label: "ex video" }] : []);
    h("sampling " + media.length + " videos");
    const r = await T.sampleTrendFrames(media, { maxFrames: 4 });
    h("frames=" + r.frames.length + " sources=" + JSON.stringify(r.sources));
    require("fs").writeFileSync("probe-out.txt", "frames=" + r.frames.length + " lens=" + r.frames.map(f=>f.length).join(","));
  } catch (e) { console.log("ERR", e.message); }
  process.exit(0);
})();
