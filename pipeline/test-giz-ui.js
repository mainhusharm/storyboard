'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
test('Giz model discovery, advanced controls and selections work across all studios on desktop/mobile', {timeout:150000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'giz-ui-'));process.env.STORYBOARD_DATA_DIR=root;delete process.env.VERCEL;delete process.env.DATABASE_URL;process.env.SESSION_SECRET='giz-ui-mock-secret';require('../web/studio-queue').publish=async()=>{};const handler=require('../web/server');const posts=[];
 const server=http.createServer(async(req,res)=>{const p=new URL(req.url,'http://localhost').pathname;if(!p.startsWith('/api/')){try{const file=p==='/storyboard'?'storyboard.html':p==='/flashloop-studio'?'flashloop-studio.html':p==='/generations'?'generations.html':path.basename(p);res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/html');return res.end(await fs.readFile(path.join(__dirname,'../web/public',file)));}catch{res.statusCode=404;return res.end();}}if(p==='/api/studio-jobs'&&req.method==='POST')posts.push(p);return handler(req,res);});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const user=await(await fetch(base+'/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'giz@ui.test',name:'Giz UI',password:'offline-password-12345'})})).json();
 const discovered=await(await fetch(base+'/api/models')).json();
 assert.equal(discovered.gizModels.length,17,'nine image/video, five speech and three music models');
 assert.ok(discovered.image.includes('giz:krea-2'));
 assert.ok(discovered.video.some(m=>m.id==='giz:minimax-h3-turbo'));
 assert.deepEqual(discovered.narrationEngines.filter(m=>m.id.startsWith('giz:')).map(m=>m.id),['giz:omnivoice','giz:inworld-tts-1-5-mini','giz:xai-tts','giz:tts-1','giz:gateway/heygen:voice@1.0']);
 assert.deepEqual(discovered.musicModels.map(m=>m.id),['giz:acestep','giz:stable-audio','giz:minimax-music']);
 assert.deepEqual(discovered.narrationVoices['giz:tts-1'].map(v=>v.id),['alloy','echo','fable','onyx','nova','shimmer']);
 const browser=await require('puppeteer-core').launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu']});t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});const errors=[];
 for(const route of ['/storyboard','/flashloop-studio?source=flashloop','/flashloop-studio?source=sjinn','/generations']){
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.setCookie({name:'sb_session',value:user.token,url:base,httpOnly:true});await page.goto(base+route,{waitUntil:'networkidle0'});const studio=route.startsWith('/flashloop');const image=studio?'i2iModel':'imageModel',video=studio?'mvModel':'videoModel';
  await page.waitForFunction(id=>[...document.getElementById(id).options].some(o=>o.value==='giz:krea-2'),{},image);await page.select('#'+image,'giz:krea-2');await page.select('#'+video,'giz:ltx2-5-distilled');

  // Spoken narration and soundtrack pickers: the native narration dropdown hosts Giz
  // speech on Storyboard, so Flashloop/generations get their own Giz-only selector.
  const hasEngine=!!(await page.$('#narrationEngine'));
  assert.ok(await page.$('#musicModel'),'soundtrack picker exists on '+route);
  assert.equal(!!(await page.$('#gizSpeechEngine')),!hasEngine,'speech picker mirrors the native narration engine on '+route);
  const speechValues=await page.$$eval('select#narrationEngine,select#gizSpeechEngine',els=>els.flatMap(e=>[...e.options].map(o=>o.value)));
  assert.ok(speechValues.includes('giz:omnivoice')&&speechValues.includes('giz:tts-1'),'Giz speech models offered on '+route);
  assert.deepEqual(await page.$$eval('#musicModel option',o=>o.map(x=>x.value)),['','giz:acestep','giz:stable-audio','giz:minimax-music']);
  await page.select('#musicModel','giz:stable-audio');
  if(hasEngine)await page.select('#narrationEngine','giz:omnivoice');else await page.select('#gizSpeechEngine','giz:omnivoice');

  await page.waitForSelector('[data-giz-field="maskImage"]');
  await page.waitForSelector('[data-giz-field="prompt"]',{timeout:5000});
  await page.waitForSelector('[data-giz-field="text"]',{timeout:5000});
  await page.evaluate(()=>{const el=document.querySelector('[data-giz-field="seed"]');el.value='42';el.dispatchEvent(new Event('input'));});
  const payload=await page.evaluate(()=>SBGiz.payload());
  assert.equal(payload.giz['giz:krea-2'].seed,42);
  assert.equal(payload.musicModel,'giz:stable-audio');
  assert.equal(payload.narrationEngine,'giz:omnivoice');
  assert.equal(typeof payload.musicVolume,'number');
  const keys=await page.$$eval('[data-giz-field]',els=>els.map(e=>e.dataset.gizField));for(const key of ['imageEnd','controlVideo','videoMask','injectedFrames','renderMode','negativePrompt','negative_prompt','duration','text'])assert.ok(keys.includes(key),key);
  const savedSelections=await page.evaluate(()=>localStorage.getItem('sb_giz_selections'));const selections=JSON.parse(savedSelections);
  assert.equal(selections[video],'giz:ltx2-5-distilled','Giz model selection saved before reload: '+savedSelections);
  assert.equal(selections.musicModel,'giz:stable-audio');
  assert.equal(selections[hasEngine?'narrationEngine':'gizSpeechEngine'],'giz:omnivoice');

  await page.reload({waitUntil:'networkidle0'});
  assert.equal(await page.$eval('#'+image,e=>e.value),'giz:krea-2',route);
  assert.equal(await page.$eval('#'+video,e=>e.value),'giz:ltx2-5-distilled',route);
  assert.equal(await page.$eval('#musicModel',e=>e.value),'giz:stable-audio',route);
  assert.equal(await page.$eval(hasEngine?'#narrationEngine':'#gizSpeechEngine',e=>e.value),'giz:omnivoice',route);

  // The studios only reveal their render sections once a job exists — open them the way
  // a user does before checking that every advanced field fits a 390px screen.
  await page.setViewport({width:390,height:844});
  await page.evaluate(()=>{const out=document.getElementById('outputPanel');if(out)out.classList.add('visible');for(const id of ['i2iSection','makeVideoSection']){const el=document.getElementById(id);if(el)el.style.display='block';}});
  await page.$$eval('details',els=>els.forEach(e=>{if(e.querySelector('[data-giz-field]'))e.open=true;}));
  const bad=await page.$$eval('[data-giz-field]',els=>els.filter(e=>{const r=e.getBoundingClientRect();return !(r.width>0&&r.width<=390);}).map(e=>e.dataset.gizField+':'+Math.round(e.getBoundingClientRect().width)));
  assert.deepEqual(bad,[]);
  await page.close();
 }
 assert.equal(posts.length,0,'discovery, edits and reload never submit provider jobs');assert.deepEqual(errors,[]);
});
