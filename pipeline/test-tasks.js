'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const vm=require('node:vm');const crypto=require('node:crypto');const http=require('node:http');const {test}=require('node:test');
const {createTasks,cloudTask}=require('../web/tasks');
const alice={id:'alice'},bob={id:'bob'};const id='browser_00000000-0000-4000-8000-000000000001';
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'task-hub-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let time=Date.now();const tasks=createTasks({root,isVercel:false,getDb:async()=>null,studioJobs:{list:async()=>[],cancel:async()=>null},now:()=>time});return {tasks,advance:n=>time+=n};}
test('browser task names, progress and cancellation are account-scoped and cannot be spoofed',async t=>{
 const {tasks}=await fixture(t);await tasks.heartbeat(alice,[{id,title:'Krishna film',ownerId:'bob',source:'sjinn',status:'running',percent:40}]);
 assert.equal((await tasks.list(bob)).tasks.length,0);assert.equal(await tasks.cancel(bob,id),null);const initial=(await tasks.list(alice)).tasks[0];assert.equal(initial.source,'storyboard');assert.equal(initial.ownerId,undefined);assert.equal(initial.percent,40);
 const cancelled=await tasks.cancel(alice,id);assert.equal(cancelled.status,'cancelling');
 const response=await tasks.heartbeat(alice,[{id,status:'running',percent:42}]);assert.deepEqual(response.cancelIds,[id]);assert.equal((await tasks.list(alice)).tasks[0].status,'cancelling','heartbeat cannot erase a concurrent cancel');
 await tasks.heartbeat(alice,[{id,status:'cancelled',percent:42}]);assert.equal((await tasks.list(alice)).tasks[0].status,'cancelled');
});
test('a sleeping or closed Storyboard page is marked connection lost rather than running forever',async t=>{
 const f=await fixture(t);await f.tasks.heartbeat(alice,[{id,status:'running',percent:25}]);f.advance(91000);const old=(await f.tasks.list(alice)).tasks[0];assert.equal(old.status,'connection_lost');assert.equal(old.percent,25);
 await f.tasks.cancel(alice,id);const stale=(await f.tasks.list(alice)).tasks[0];assert.match(stale.message,/waiting for the original page/);
 assert.deepEqual((await f.tasks.heartbeat(alice,[{id,status:'running',percent:30}])).cancelIds,[id]);
});
test('percentages use completed milestones, retain partial failure progress and keep unknown renders indeterminate',()=>{
 const film={id:crypto.randomUUID(),kind:'film',title:'Film',source:'sjinn',status:'running',sceneCount:2,completedScenes:1,scenes:[{status:'ready'},{status:'video-rendering'}]};
 assert.equal(cloudTask(film).percent,42);assert.equal(cloudTask({...film,status:'failed'}).percent,42);assert.equal(cloudTask({...film,status:'completed'}).percent,100);
 assert.equal(cloudTask({...film,kind:'image'}).percent,null);assert.equal(cloudTask({...film,kind:'prompt',completedScenes:1,message:'writing script'}).percent,66);
});
test('cloud mode rejects temporary storage and validates activity IDs and progress',async t=>{
 const f=await fixture(t);await assert.rejects(f.tasks.heartbeat(alice,[{id:'../other',status:'running'}]),/Invalid task ID/);
 await f.tasks.heartbeat(alice,[{id,status:'running',percent:999}]);assert.equal((await f.tasks.list(alice)).tasks[0].percent,99);
 const tasks=createTasks({root:os.tmpdir(),isVercel:true,getDb:async()=>null,studioJobs:{}});await assert.rejects(tasks.list(alice),/DATABASE_URL/);
});
test('Storyboard monitor receives a remote cancellation without calling a global cancel endpoint',async()=>{
 let tick,cancelId='',sent=[];let clock=Date.now();
 const ctx={Date:{now:()=>clock},crypto,AbortSignal,setInterval:fn=>{tick=fn;},LOCAL_BUSY:true,SUBMITTING:true,LOCAL_PHASE:'IMAGES',LOCAL_RESULT:'running',USER_CANCELLED:false,PHASE_ABORT:new AbortController(),FRAMES:[{frame:1,generated_image_url:'https://img.test/1'},{frame:2}],CHARS:[],LOCAL_LOG:[{m:'Generating image 2'}],logLocal(){},
  document:{currentScript:{dataset:{mode:'storyboard'}},getElementById:id=>({value:'Krishna story',textContent:'IMAGES'}),addEventListener(){}},window:{addEventListener(){}},fetch:async(url,opts)=>{sent.push({url,tasks:JSON.parse(opts.body).tasks});return {ok:true,json:async()=>({cancelIds:cancelId?[cancelId]:[]})};}};
 vm.createContext(ctx);vm.runInContext(await fs.readFile(path.join(__dirname,'../web/public/task-monitor.js'),'utf8'),ctx);await new Promise(r=>setImmediate(r));assert.equal(sent.length,1);cancelId=sent[0].tasks[0].id;clock+=5000;await tick();
 assert.equal(ctx.USER_CANCELLED,true);assert.equal(ctx.LOCAL_RESULT,'cancelled');assert.equal(ctx.PHASE_ABORT.signal.aborted,true);assert.ok(sent.every(r=>r.url==='/api/tasks/heartbeat'));
 ctx.LOCAL_BUSY=false;ctx.SUBMITTING=false;clock+=5000;await tick();assert.equal(sent.at(-1).tasks[0].status,'cancelled');
});
test('the parallel queue monitor cancels only the selected run',async()=>{
 let tick,round=0;const runs=[{id:'one',title:'Film one',status:'running',running:true,log:[]},{id:'two',title:'Film two',status:'queued',running:false,log:[]}];let selected;
 const ctx={crypto,AbortSignal,Date:{now:()=>Date.now()+round*5000},RUNS:runs,progressOf:()=>20,setStatus:(r,s)=>r.status=s,setInterval:fn=>tick=fn,document:{currentScript:{dataset:{mode:'queue'}},addEventListener(){}},window:{addEventListener(){},cancelRun:id=>{const r=runs.find(r=>r.id===id);r.cancelled=true;r.status='cancelling';}},fetch:async(url,opts)=>{const tasks=JSON.parse(opts.body).tasks;selected=tasks.find(t=>t.title==='Film two').id;return {ok:true,json:async()=>({cancelIds:[selected]})};}};
 vm.createContext(ctx);vm.runInContext(await fs.readFile(path.join(__dirname,'../web/public/task-monitor.js'),'utf8'),ctx);await new Promise(r=>setImmediate(r));assert.equal(runs[0].status,'running');assert.equal(runs[1].status,'cancelled');assert.equal(runs[0].cancelled,undefined);
});
test('real tasks API and dashboard show progress, filter, cancel safely and work on mobile',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'task-api-'));process.env.STORYBOARD_DATA_DIR=root;process.env.SESSION_SECRET='task-offline-secret';delete process.env.VERCEL;delete process.env.DATABASE_URL;
 require('../web/studio-queue').publish=async()=>{};const handler=require('../web/server');const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
 const request=(route,user,opts={})=>fetch(base+route,{...opts,headers:{'Content-Type':'application/json',...(user?{Authorization:'Bearer '+user.token}:{}),...opts.headers}});
 const signup=async email=>(await(await request('/api/auth/signup',null,{method:'POST',body:JSON.stringify({email,name:'Test User',password:'offline-pass-12345'})})).json());const a=await signup('alice@tasks.test'),b=await signup('bob@tasks.test');
 assert.equal((await request('/api/tasks')).status,401);assert.equal((await request('/api/tasks/heartbeat',null,{method:'POST',body:'{}'})).status,401);
 const image=(await(await request('/api/studio-jobs',a,{method:'POST',body:JSON.stringify({requestKey:'image-task-key-1234',kind:'image',source:'flashloop',title:'Quiet river reference',scenes:[{imagePrompt:'River'}]})})).json()).job;
 const film=(await(await request('/api/studio-jobs',a,{method:'POST',body:JSON.stringify({requestKey:'film-task-key-12345',source:'sjinn',title:'Krishna — Govardhan film',model:'wan3.0-video-prime',scenes:[{imagePrompt:'Mountain',videoPrompt:'Rain'},{imagePrompt:'River',videoPrompt:'Water'}]})})).json()).job;
 await handler.__internal.studioJobs.store.mutate(film.id,a.user.id,j=>{j.status='running';j.scenes[0].clip='https://clip.test/1';j.scenes[0].stage='video-ready';j.message='Scene 2/2: video rendering…';});
 await request('/api/tasks/heartbeat',a,{method:'POST',body:JSON.stringify({tasks:[{id,title:'Kaliya storyboard',status:'running',percent:40,message:'Qwen image 4/10',progressLabel:'Images'}]})});
 assert.equal((await(await request('/api/tasks',b)).json()).tasks.length,0);assert.equal((await request('/api/tasks/cloud_'+image.id,b,{method:'DELETE'})).status,404);assert.equal((await request('/api/tasks/'+id,b,{method:'DELETE'})).status,404);
 const puppeteer=require('puppeteer-core');const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu']});t.after(()=>browser.close());const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setCookie({name:'sb_session',value:a.token,url:base,httpOnly:true});await page.setViewport({width:1280,height:1100});await page.goto(base+'/tasks',{waitUntil:'networkidle0'});await page.waitForSelector('.card');assert.equal(await page.$eval('#activeCount',el=>el.textContent),'3');assert.equal((await page.$$('.card')).length,3);assert.match(await page.$eval('[data-id="cloud_'+film.id+'"]',el=>el.textContent),/28%/);
 await page.select('#source','sjinn');assert.equal((await page.$$('.card')).length,1);await page.select('#source','');await page.type('#search','river');assert.equal((await page.$$('.card')).length,1);await page.$eval('#search',el=>{el.value='';el.dispatchEvent(new Event('input'));});
 await fs.mkdir(path.join(__dirname,'../node_modules/.cache'),{recursive:true});await page.screenshot({path:path.join(__dirname,'../node_modules/.cache/tasks-desktop.png'),fullPage:true});
 await page.click('[data-id="cloud_'+image.id+'"] .cancel');await page.waitForFunction(()=>document.querySelector('#activeCount').textContent==='2');assert.equal((await handler.__internal.studioJobs.get(a.user,film.id)).status,'running');
 await page.click('[data-id="'+id+'"] .cancel');await page.waitForFunction(()=>document.querySelector('.card[data-id^="browser_"]').textContent.includes('Cancel requested'));
 const heartbeat=await(await request('/api/tasks/heartbeat',a,{method:'POST',body:JSON.stringify({tasks:[{id,status:'running',percent:41}]})})).json();assert.deepEqual(heartbeat.cancelIds,[id]);await request('/api/tasks/heartbeat',a,{method:'POST',body:JSON.stringify({tasks:[{id,status:'cancelled',percent:41}]})});await page.click('#refresh');await page.waitForFunction(()=>document.querySelector('#activeCount').textContent==='1');
 await page.click('[data-filter="all"]');await page.setViewport({width:390,height:844});await page.screenshot({path:path.join(__dirname,'../node_modules/.cache/tasks-mobile.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 await page.close();
});

test('older active cloud jobs stay visible when many newer tasks have completed',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'task-order-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const {createJobStore}=require('../web/studio-jobs');const store=createJobStore({root,isVercel:false,getDb:async()=>null});const now=Date.now();
 await store.create({id:'old-active',ownerId:'alice',requestKey:'old',status:'running',createdAt:now-3600000,updatedAt:now,input:{source:'sjinn'}});
 for(let i=0;i<25;i++)await store.create({id:'done-'+i,ownerId:'alice',requestKey:'done-'+i,status:'completed',createdAt:now+i,updatedAt:now,input:{source:'sjinn'}});
 const jobs=await store.list('alice');assert.equal(jobs.length,20);assert.equal(jobs[0].id,'old-active');
});

test('a remotely aborted manual Storyboard phase finishes as cancelled instead of failed',async()=>{
 const text=await fs.readFile(path.join(__dirname,'../web/public/storyboard.html'),'utf8');const code=text.slice(text.indexOf(' async function postJob('),text.indexOf("$('btnStoryboard').onclick"));
 const ctx={SUBMITTING:false,USER_CANCELLED:false,IS_VERCEL_CLIENT:true,LOCAL_RESULT:'',guardBusy:async()=>true,clearLocalLog(){},logLocal(){},refreshCredits(){},alert(){throw Error('Cancellation should not open an error alert');},api:async()=>{ctx.USER_CANCELLED=true;throw Error('request aborted');}};
 vm.createContext(ctx);vm.runInContext(code,ctx);await ctx.postJob('/narration',{});assert.equal(ctx.LOCAL_RESULT,'cancelled');assert.equal(ctx.SUBMITTING,false);
});
