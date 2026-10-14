// Scratch probe: inspect flashloop flight payload + sjinn trend pages.
(async () => {
  const ua = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' };

  // 1) SJinn trend detail page
  try {
    const r = await fetch('https://sjinn.ai/trend-prompts/slime-face', { headers: ua });
    const t = await r.text();
    console.log('=== SJINN DETAIL status', r.status, 'len', t.length);
    const plain = t.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    console.log('TEXT:', plain.slice(0, 3000));
  } catch (e) { console.log('sjinn detail err', e.message); }

  // 2) Flashloop flight payload — dump rows that look like prompts
  try {
    const r = await fetch('https://www.flashloop.app/effects', { headers: ua });
    const html = await r.text();
    const pushRe = /self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g;
    let m; let all = '';
    while ((m = pushRe.exec(html)) !== null) {
      try { all += JSON.parse('"' + m[1] + '"'); } catch {}
    }
    console.log('\n=== FLIGHT payload len', all.length);
    const rows = all.split('\n').filter(l => /^[0-9a-f]+:T/.test(l));
    console.log('text rows:', rows.length);
    for (const row of rows) {
      if (/prompt|trend|anime/i.test(row) && row.length > 200) console.log('ROW', row.slice(0, 400));
    }
    const idx = all.indexOf('trendContent');
    console.log('trendContent idx', idx);
  } catch (e) { console.log('flashloop err', e.message); }
})();
