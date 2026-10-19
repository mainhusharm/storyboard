'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {test}=require('node:test');
test('overlapping Storyboard runs isolate files, cached boards, progress and cancellation by owner',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'parallel-story-'));process.env.STORYBOARD_DATA_DIR=root;process.env.VERCEL='1';process.env.SESSION_SECRET='offline-parallel-secret';delete process.env.DATABASE_URL;
 const handler=require('../web/server'),api=handler.__internal;
 let arrivals=0,release;const gate=new Promise(r=>release=r);
 const server=http.createServer((req,res)=>{
  if(req.url!=='/fixture')return handler(req,res);
  api.withStoryboardRun(req,res,async()=>{
   api.job.phase='images';api.job.startedAt=Date.now();api.job.lastProgressAt=Date.now();api.job.done=Number(req.headers['x-fixture-number']);
   const file=api.frameFile(1);await fs.writeFile(file,req.headers['x-fixture-number']);
   await api.saveStoryboardJob('same-account',{title:req.headers['x-fixture-number']});
   if(++arrivals===3)release();await gate;
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify({file,bytes:await fs.readFile(file,'utf8'),job:{...api.job},board:await api.loadStoryboardJob('same-account')}));
  }).catch(e=>{res.statusCode=500;res.end(e.stack);});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port;
 const request=(url,token,run,options={})=>fetch(base+url,{...options,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(run?{'X-Storyboard-Run':run}:{}),...options.headers}});
 async function signup(email){const r=await request('/api/auth/signup',null,null,{method:'POST',body:JSON.stringify({email,name:'Parallel User',password:'offline-pass-12345'})});assert.equal(r.status,200);return (await r.json()).token;}
 const a=await signup('a@parallel.test'),b=await signup('b@parallel.test');
 const specs=[[a,'story_run_one','1'],[a,'story_run_two','2'],[b,'story_run_one','3']];
 const results=await Promise.all(specs.map(async([token,run,num])=>{const r=await request('/fixture',token,run,{headers:{'x-fixture-number':num}});assert.equal(r.status,200);return r.json();}));
 assert.equal(new Set(results.map(r=>r.file)).size,3);
 results.forEach((r,i)=>{assert.equal(r.bytes,String(i+1));assert.equal(r.board.title,String(i+1));assert.equal(r.job.done,i+1);});
 const cancelled=await request('/api/cancel',a,'story_run_one',{method:'POST',body:'{}'});assert.equal(cancelled.status,200);
 await api.withStoryboardRun({headers:{authorization:'Bearer '+a,'x-storyboard-run':'story_run_one'}},{},async()=>assert.equal(api.job.cancelRequested,true));
 await api.withStoryboardRun({headers:{authorization:'Bearer '+a,'x-storyboard-run':'story_run_two'}},{},async()=>assert.equal(api.job.cancelRequested,false));
 assert.equal(api.job.phase,'idle','legacy single-story state is untouched');
 assert.equal((await request('/api/status',a,'../invalid')).status,400);
 assert.equal((await request('/api/status',null,'story_run_one')).status,401);
});

test('Flashloop and SJinn can start another story while existing stories remain queued, and restore their own image context',async t=>{
 const puppeteer=require('puppeteer-core'),jobs=[],posts=[],errors=[];
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');const json=j=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(j));};
  if(url.pathname==='/api/auth/me')return json({ok:true,user:{id:'alice',name:'Alice',credits:100,plan:'pro'}});
  if(url.pathname==='/api/studio-jobs'&&req.method==='GET')return json({ok:true,jobs:jobs.filter(j=>j.source===url.searchParams.get('source'))});
  if(url.pathname==='/api/studio-jobs'&&req.method==='POST'){
   let body='';for await(const chunk of req)body+=chunk;const p=JSON.parse(body);posts.push(p);
   const job={id:require('node:crypto').randomUUID(),kind:p.kind,source:p.source,title:p.title,status:'queued',sceneCount:1,completedScenes:0,scenes:[],logs:['Queued'],script:p.story};jobs.unshift(job);return json({ok:true,job});
  }
  if(url.pathname.startsWith('/api/studio-jobs/'))return json({ok:true,job:jobs.find(j=>j.id===url.pathname.split('/').pop())});
  if(url.pathname.startsWith('/api/'))return json({ok:true});
  const file=url.pathname==='/flashloop-studio'?'flashloop-studio.html':path.basename(url.pathname);
  try{res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/html');res.end(await fs.readFile(path.join(__dirname,'../web/public',file)));}catch{res.statusCode=404;res.end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu']});t.after(()=>browser.close());const base='http://127.0.0.1:'+server.address().port;
 for(const source of ['flashloop','sjinn']){
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/flashloop-studio?source='+source,{waitUntil:'networkidle0'});
  await page.type('#idea','A river journey');await page.type('#storyTitle','River story');await page.click('#btnGenerate');await page.waitForFunction(()=>!document.querySelector('#btnNewStory').disabled&&document.querySelector('#btnGenerate').disabled);
  const first=posts.at(-1);assert.equal(first.title,'River story');
  await page.click('#btnNewStory');assert.equal(await page.$eval('#btnGenerate',el=>el.disabled),false);
  await page.type('#idea','A mountain journey');await page.type('#storyTitle','Mountain story');await page.click('#btnGenerate');await page.waitForFunction(()=>!document.querySelector('#btnNewStory').disabled&&document.querySelector('#btnGenerate').disabled);
  assert.equal(posts.at(-1).title,'Mountain story');assert.notEqual(posts.at(-1).requestKey,first.requestKey);assert.equal(jobs.filter(j=>j.source===source&&j.status==='queued').length,2);
  await page.click('#btnNewStory');await page.locator('summary').filter(el=>el.textContent.includes('Generate several')).click();await page.type('#batchIdeas','Desert story\n---\nForest story\n---\nOcean story');await page.click('#btnBatchStories');await page.waitForFunction(()=>!document.querySelector('#btnBatchStories').disabled);
  assert.deepEqual(posts.slice(-3).map(p=>p.idea),['Desert story','Forest story','Ocean story']);
  const saved=jobs.find(j=>j.source===source&&j.title==='River story');saved.status='completed';saved.result={title:'River story',sceneLength:8,scenes:[{title:'River',imagePrompt:'Only river reference',videoPrompt:'Water flows'}]};
  await page.select('#mvJobSelect',saved.id);await page.waitForSelector('#fullScriptBox');await page.click('#btnGenerateImage');await page.waitForFunction(()=>!document.querySelector('#btnNewStory').disabled&&document.querySelector('#btnGenerateImage').disabled);
  assert.equal(posts.at(-1).story.scenes[0].imagePrompt,'Only river reference','image carries the selected story, never the last batch idea');
  await page.close();
 }
 assert.deepEqual(errors,[]);
});

