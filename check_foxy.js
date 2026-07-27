const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'foxy-shots');
fs.mkdirSync(OUT, { recursive: true });

const pages = [
  { name: '01-home', url: 'https://foxy.ai/' },
  { name: '02-ultra-realistic', url: 'https://foxy.ai/features/ultra-realistic-ai-images' },
  { name: '03-ai-videos', url: 'https://foxy.ai/features/ai-videos-and-reels' },
  { name: '04-ai-content-self', url: 'https://foxy.ai/features/make-ai-content-of-yourself' },
  { name: '05-ai-influencers', url: 'https://foxy.ai/features/ai-influencers' },
  { name: '06-academy', url: 'https://foxy.ai/academy' },
  { name: '07-pricing', url: 'https://foxy.ai/#pricing' },
  { name: '08-signup', url: 'https://app.foxy.ai/sign-up' },
  { name: '09-login', url: 'https://app.foxy.ai/sign-in' }
];

const results = [];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  for (const page of pages) {
    const p = await ctx.newPage();
    try {
      console.log(`\n=== ${page.name}: ${page.url} ===`);
      const resp = await p.goto(page.url, { waitUntil: 'networkidle', timeout: 30000 });
      console.log(`HTTP ${resp ? resp.status() : 'NO RESPONSE'} | title: ${await p.title()}`);

      // Full page screenshot
      await p.screenshot({ path: path.join(OUT, `${page.name}.png`), fullPage: true });

      // Extract structured info
      const h1s = (await p.$$eval('h1', els => els.map(e => e.innerText.trim()).filter(Boolean))).slice(0, 5);
      const h2s = (await p.$$eval('h2', els => els.map(e => e.innerText.trim()).filter(Boolean))).slice(0, 10);
      const links = (await p.$$eval('a[href]', els => els.map(e => ({ text: e.innerText.trim().slice(0, 60), href: e.href })).filter(l => l.text))).slice(0, 20);
      const buttons = (await p.$$eval('button', els => els.map(e => e.innerText.trim()).filter(Boolean))).slice(0, 10);
      const ctas = (await p.$$eval('[class*=btn], [class*=button], [class*=cta]', els => els.map(e => e.innerText.trim()).filter(Boolean))).slice(0, 10);

      results.push({
        page: page.name,
        url: page.url,
        status: resp ? resp.status() : 'error',
        title: await p.title(),
        h1: h1s, h2: h2s,
        links: links,
        buttons: buttons,
        ctas: ctas
      });

      // Visit pricing section specifically on home
      if (page.url.endsWith('#pricing')) {
        // scroll to pricing
        await p.evaluate(() => {
          const el = document.querySelector('#pricing') || [...document.querySelectorAll('h2')].find(h => h.innerText.toLowerCase().includes('pricing'));
          if (el) el.scrollIntoView();
        });
        await p.waitForTimeout(1500);
        await p.screenshot({ path: path.join(OUT, '07b-pricing-scroll.png'), fullPage: false });
      }

    } catch (e) {
      console.log(`ERROR: ${e.message.slice(0, 200)}`);
      results.push({ page: page.name, url: page.url, error: e.message.slice(0, 300) });
      try { await p.screenshot({ path: path.join(OUT, `${page.name}-error.png`) }); } catch {}
    }
    await p.close();
  }

  await browser.close();
  console.log('\n\n=== FULL RESULTS ===');
  console.log(JSON.stringify(results, null, 2));
})();
