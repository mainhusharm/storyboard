'use strict';
// Real HTTP auth + real server routes + real ffmpeg, with stubbed paid providers.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const http=require('node:http');const {execFileSync}=require('node:child_process');
const {test,before,after}=require('node:test');
let root,handler,server,base,alice,bob,video,jobId;const messages=[],external=[],hosted=new Map();const nativeFetch=global.fetch;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=','base64');
const body={requestKey:'offline-worker-key-1234',source:'sjinn',title:'Closed laptop test',model:'wan3.0-video-prime',imageModel:'aqua:qwen-image-3.0-pro',ratio:'16:9',resolution:'720P',duration:5,chained:true,scenes:[{imagePrompt:'A landscape',videoPrompt:'Camera moves slowly'}]};
async function listen(){server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;}
async function request(route,user,options={}){return nativeFetch(base+route,{...options,headers:{...(user?{Authorization:'Bearer '+user.token}:{}),'Content-Type':'application/json',...options.headers}});}
async function signup(email){return (await request('/api/auth/signup',null,{method:'POST',body:JSON.stringify({name:'Offline User',email,password:'offline-password-12345'})})).json();}
before(async()=>{
 root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-worker-'));process.env.STORYBOARD_DATA_DIR=root;delete process.env.VERCEL;delete process.env.DATABASE_URL;
 process.env.SESSION_SECRET='offline-studio-worker-secret';process.env.AQUA_API_KEY='offline-key';process.env.NOVITA_API_KEY='offline-key';process.env.NOVITA_BASE_URL='https://novita.test';process.env.PAXSENIX_API_KEY='offline-key';
 const ffmpeg=require('ffmpeg-static');const mp4=path.join(root,'fixture.mp4');execFileSync(ffmpeg,['-y','-f','lavfi','-i','color=c=blue:s=64x64:d=0.4','-c:v','libx264','-pix_fmt','yuv420p',mp4],{stdio:'ignore'});video=await fs.readFile(mp4);
 require('../web/studio-queue').publish=async(m,delay)=>{messages.push({m,delay});};
 handler=require('../web/server');await listen();alice=await signup('alice@worker.test');bob=await signup('bob@worker.test');assert.ok(alice.token&&bob.token);
 global.fetch=async(url,options={})=>{
  const u=String(url);external.push({url:u,method:options.method,body:typeof options.body==='string'?options.body:undefined});
  if(u==='https://api.aquadevs.com/v1/images/generations')return Response.json({data:[{url:'https://fixture.test/image.png'}]});
  if(u==='https://novita.test/v1/submit')return Response.json({ok:true,taskId:'original-video-task'});
  if(u.includes('/v1/status/'))return Response.json({status:'SUCCEEDED',output:{results:[{url:'https://fixture.test/video.mp4'}]}});
  if(u==='https://fixture.test/image.png')return new Response(png,{headers:{'Content-Type':'image/png'}});
  if(u==='https://fixture.test/video.mp4')return new Response(video);
  if(hosted.has(u))return new Response(hosted.get(u));
  if(u==='https://catbox.moe/user/api.php'){
   const file=options.body.get('fileToUpload');const out='https://fixture.test/hosted/'+hosted.size+'/'+file.name;hosted.set(out,Buffer.from(await file.arrayBuffer()));return new Response(out);
  }
  if(u.startsWith('https://api.paxsenix.org/ai-video/'))return Response.json({ok:true,task_url:'https://api.paxsenix.org/task/original-omni'});
  if(u==='https://api.paxsenix.org/task/original-omni')return Response.json({ok:true,status:'done',url:'https://fixture.test/video.mp4'});
  throw Error('Unexpected external request: '+u);
 };
});
after(async()=>{global.fetch=nativeFetch;if(server?.listening)await new Promise(r=>server.close(r));if(root)await fs.rm(root,{recursive:true,force:true});});
test('jobs API authenticates and stores owner-scoped progress without exposing internal dispatch',async()=>{
 assert.equal((await request('/api/studio-jobs')).status,401);
 const start=await request('/api/studio-jobs',alice,{method:'POST',body:JSON.stringify({...body,ownerId:bob.user.id,normalizeOnly:true})});assert.equal(start.status,202);const response=await start.json();jobId=response.job.id;assert.equal(response.job.status,'queued');assert.equal(response.job.input,undefined);
 assert.equal((await request('/api/studio-jobs/'+jobId,bob)).status,404);
 assert.equal((await request('/api/studio-jobs/'+jobId,bob,{method:'DELETE'})).status,404);
 const list=await(await request('/api/studio-jobs?source=sjinn',alice)).json();assert.equal(list.jobs[0].id,jobId);
 const other=await(await request('/api/studio-jobs',bob)).json();assert.equal(other.jobs.length,0);
});
test('accepted film finishes after all browser/API connections close; final vault owns the real mp4',async()=>{
 await new Promise(r=>server.close(r));assert.equal(server.listening,false);
 let steps=0;while(messages.length){await handler.processStudioJob(messages.shift().m);assert.ok(++steps<15);}
 await listen();const j=(await(await request('/api/studio-jobs/'+jobId,alice)).json()).job;
 assert.equal(j.status,'completed',JSON.stringify(j));assert.equal(j.completedScenes,1);assert.match(j.result.url,/^\/api\/vault\//);
 assert.equal(external.filter(r=>r.url.endsWith('/v1/submit')).length,1,'one paid video submit');
 const vault=await(await request('/api/vault',alice)).json();assert.equal(vault.vault.length,1);assert.equal(vault.vault[0].source,'sjinn');assert.equal(vault.vault[0].kind,'video');
 const movie=await request(j.result.url,alice);assert.equal(movie.status,200);assert.ok((await movie.arrayBuffer()).byteLength>1000);assert.equal((await request(j.result.url,bob)).status,404);
 assert.equal((await fs.readdir(path.join(root,'video'))).some(n=>n.startsWith('studio_')),false,'worker media directories cleaned after hosting');
});
test('Omni Flash submits asynchronously and resumes its original task through the same worker',async()=>{
 const start=await request('/api/studio-jobs',alice,{method:'POST',body:JSON.stringify({...body,requestKey:'offline-omni-key-1234',model:'omni-flash',source:'flashloop',scenes:[{imageUrl:'https://fixture.test/image.png',videoPrompt:'A calm shot'}]})});const {job}=await start.json();assert.equal(start.status,202);
 let steps=0;while(messages.length){await handler.processStudioJob(messages.shift().m);assert.ok(++steps<15);}
 const result=(await(await request('/api/studio-jobs/'+job.id,alice)).json()).job;assert.equal(result.status,'completed',JSON.stringify(result));
 assert.equal(external.filter(r=>r.url.startsWith('https://api.paxsenix.org/ai-video/')).length,1);assert.equal(external.filter(r=>r.url==='https://api.paxsenix.org/task/original-omni').length,1);
});
test('cloud queue trigger and studio UI cannot depend on browser orchestration',async()=>{
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'../vercel.json'),'utf8'));assert.equal(config.functions['api/studio-worker.js'].experimentalTriggers[0].topic,'studio-generation');
 const ui=await fs.readFile(path.join(__dirname,'../web/public/flashloop-studio.html'),'utf8');const makeVideo=ui.slice(ui.indexOf("$('btnMakeVideo').onclick"));assert.match(makeVideo,/queueStudioJob/);assert.match(ui,/\/api\/studio-jobs/);assert.doesNotMatch(makeVideo,/\/api\/flashloop\/(generate-video|combine|generate-i2i)/);assert.match(ui,/restoreStudioJobs\(\)/);
});
