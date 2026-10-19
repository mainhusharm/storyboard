'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');const {test}=require('node:test');const puppeteer=require('puppeteer-core');
test('reopened studio restores scripts, images and final films without restarting generation',async t=>{
 const scene={title:'River',imagePrompt:'A quiet blue river',videoPrompt:'The water flows gently'};
 const script={id:'00000000-0000-4000-8000-000000000001',kind:'prompt',source:'sjinn',title:'Saved river',status:'completed',sceneCount:1,completedScenes:1,scenes:[{}],logs:['Script ready.'],result:{title:'Saved river',sceneLength:30,scenes:[scene]}};
 const jobs=[script],posts=[],errors=[];
 const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');res.setHeader('Cache-Control','no-store');
  const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(url.pathname==='/api/auth/me')return json({ok:true,user:{id:'alice',name:'Alice',email:'alice@test.invalid',credits:100,plan:'pro'}});
  if(url.pathname==='/api/studio-jobs'&&req.method==='GET')return json({ok:true,jobs});
  if(url.pathname==='/api/studio-jobs'&&req.method==='POST'){
   let text='';for await(const chunk of req)text+=chunk;const payload=JSON.parse(text);posts.push(payload);
   const job={id:'00000000-0000-4000-8000-000000000002',kind:payload.kind||'film',source:'sjinn',title:'Saved river image',status:'queued',sceneCount:1,completedScenes:0,scenes:[{}],logs:['Queued']};jobs.unshift(job);
   setTimeout(()=>{job.status='completed';job.logs=['Image ready.'];job.result={imageUrl:'/fixture.png',sceneIndex:0};},100);
   return json({ok:true,job});
  }
  if(url.pathname.startsWith('/api/studio-jobs/'))return json({ok:true,job:jobs.find(j=>j.id===url.pathname.split('/').pop())});
  if(url.pathname.startsWith('/api/'))return json({ok:true});
  if(url.pathname==='/fixture.png'){res.setHeader('Content-Type','image/png');return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=','base64'));}
  const file=url.pathname==='/flashloop-studio'?'flashloop-studio.html':path.basename(url.pathname);
  try{res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':'text/html');res.end(await fs.readFile(path.join(__dirname,'../web/public',file)));}catch{res.statusCode=404;res.end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,args:['--disable-gpu']});t.after(()=>browser.close());
 const base='http://127.0.0.1:'+server.address().port;
 async function open(){const p=await browser.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base+'/flashloop-studio?source=sjinn',{waitUntil:'domcontentloaded'});return p;}
 let page=await open();await page.waitForSelector('#fullScriptBox');
 assert.match(await page.$eval('#fullScriptBox',el=>el.value),/water flows gently/);assert.equal(await page.$eval('#outputPanel',el=>getComputedStyle(el).display==='none'),false);
 await page.click('#btnGenerateImage');await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('Queued'));
 await page.close();await new Promise(r=>setTimeout(r,150));page=await open();await page.waitForFunction(()=>document.querySelector('#i2iImage').getAttribute('src')==='/fixture.png');
 assert.equal(posts.length,1);assert.equal(posts[0].kind,'image');assert.equal(posts[0].scenes[0].imagePrompt,'A quiet blue river');
 await page.close();
 jobs.unshift({id:'00000000-0000-4000-8000-000000000003',kind:'film',source:'sjinn',title:'Finished river',status:'completed',sceneCount:1,completedScenes:1,scenes:[],logs:['VIDEO READY'],script:{title:'Finished river',sceneLength:8,scenes:[scene]},result:{url:'/api/vault/final/content'}});
 page=await open();await page.waitForFunction(()=>document.querySelector('#mvVideo').getAttribute('src')==='/api/vault/final/content');
 assert.equal(await page.$eval('#mvVideo',el=>getComputedStyle(el).display),'block');assert.equal(posts.length,1,'reopening never submitted a generation');assert.deepEqual(errors,[]);
 await page.close();
});
