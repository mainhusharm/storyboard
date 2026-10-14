process.env.PORT = "0";
const server = require("./web/server");
const T = server.__internal;
(async () => {
  try {
    const raw = require("fs").readFileSync("probe-out.txt", "utf8").split("RAW:\n")[1] || "";
    // emulate a fresh answer: analysis + FINALJSON line
    const fake = "ANALYSIS: football anime drama, locker rooms, champagne celebration.\nFINALJSON " + raw.slice(raw.indexOf("{\"concept\""), raw.indexOf("locker room") + 30) + "\"}]}";
    const p = T.parseTrendTemplateJson(fake);
    console.log("parsed:", p ? JSON.stringify(p).slice(0, 200) : "NULL");
    const n = (function(pp){ try { return null; } catch(e){ return null; } })(null);
  } catch (e) { console.log("ERR", e.message); }
  process.exit(0);
})();
