'use strict';
const assert=require('node:assert/strict');const {test}=require('node:test');const fs=require('node:fs/promises');const path=require('node:path');const vm=require('node:vm');
const {BASE,MODEL,createModelscopeProvider}=require('../web/modelscope');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=','base64');
const image='https://qwen-qwen-image-2-1.ms.show/gradio_api/file=/tmp/gradio/final/image.png';
const stream=text=>new Response(text,{headers:{'Content-Type':'text/event-stream'}});
const failed=detail=>stream('event: error\ndata: '+JSON.stringify(detail)+'\n\n');
const done=()=>stream('event: complete\ndata: '+JSON.stringify([{path:'/tmp/gradio/final/image.png',url:image},42,'Enhanced'])+'\n\n');
function fixture(responses,extra={}){
 const calls=[],waits=[],logs=[];let posts=0,gets=0;
 const fetchImpl=async(url,options={})=>{
  calls.push({url:String(url),options});
  if(String(url).endsWith('/upload'))return Response.json(['/tmp/gradio/reference/image.png']);
  if(options.method==='POST'){posts++;return Response.json({event_id:'task-'+posts});}
  const item=responses[Math.min(gets++,responses.length-1)];return typeof item==='function'?item():item;
 };
 const provider=createModelscopeProvider({getToken:()=>'offline-secret-token',fetchImpl,sleepImpl:async ms=>{waits.push(ms);},log:m=>logs.push(m),...extra});
 return {provider,calls,waits,logs,posts:()=>posts,gets:()=>gets};
}
test('explicit failed tasks retry twice with unchanged prompt, references, dimensions and seed',async()=>{
 const f=fixture([()=>failed(null),()=>failed({message:'GPU temporarily unavailable'}),done]);
 const result=await f.provider.generate('Krishna beside the mountain','16:9',[png],{resolution:'2k',seed:17,randomizeSeed:false,enhancePrompt:false,negativePrompt:'blur'});
 assert.equal(result.attempts,3);assert.equal(result.url,image);assert.equal(f.posts(),3);assert.deepEqual(f.waits,[8000,20000]);
 const posts=f.calls.filter(c=>c.options.method==='POST'&&!c.url.endsWith('/upload')).map(c=>JSON.parse(c.options.body));
 assert.deepEqual(posts[0],posts[1]);assert.deepEqual(posts[1],posts[2]);assert.equal(posts[0].seed,17);assert.equal(posts[0].width,2688);assert.equal(posts[0].input_images.length,1);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/upload')).length,1,'reuse uploaded reference paths within this generation');assert.equal(f.logs.filter(l=>l.includes('task failed; retry')).length,2);
});
test('exhaustion stops after three confirmed failures and exposes attempts plus the upstream reason',async()=>{
 const f=fixture([()=>failed('GPU worker unavailable')]);await assert.rejects(f.provider.generate('Portrait'),e=>e.terminal&&e.safeToRetry&&e.attempts===3&&/after 3 attempts/.test(e.message)&&/GPU worker unavailable/.test(e.message));assert.equal(f.posts(),3);
});
test('authentication, input, moderation and quota errors are actionable rather than automatically retried',async()=>{
 for(const reason of ['Unauthorized token','Invalid input parameter','Content safety filter','Daily quota exceeded','You have exceeded your GPU quota','Token is invalid']){
  const f=fixture([()=>failed(reason)]);await assert.rejects(f.provider.generate('Portrait'),e=>e.permanent&&e.attempts===1);assert.equal(f.posts(),1,reason);assert.deepEqual(f.waits,[]);
 }
 const f=fixture([()=>failed('Unauthorized Bearer offline-secret-token')]);await assert.rejects(f.provider.generate('x'),e=>!e.message.includes('offline-secret-token')&&e.message.includes('[redacted]'));
});
test('submission 429 respects Retry-After; submission 5xx or lost acknowledgement never buys another task',async()=>{
 for(const mode of ['429','503','network']){
  let posts=0;const waits=[];
  const provider=createModelscopeProvider({getToken:()=>'test',sleepImpl:async ms=>waits.push(ms),fetchImpl:async(url,options)=>{
   if(options.method==='POST'){posts++;if(posts===1){if(mode==='network')throw Error('Connection lost after POST');return new Response('',{status:Number(mode),headers:{'Retry-After':'12'}});}return Response.json({event_id:'accepted'});}return done();
  }});
  if(mode==='429'){assert.equal((await provider.generate('x')).attempts,2);assert.equal(posts,2);assert.deepEqual(waits,[12000]);}
  else {await assert.rejects(provider.generate('x'));assert.equal(posts,1);assert.deepEqual(waits,[]);}
 }
});
test('SSE 5xx, truncated streams and read errors reconnect to the SAME task ID',async()=>{
 for(const first of [()=>new Response('',{status:503}),()=>stream('event: generating\ndata: null\n\n'),()=>new Response(new ReadableStream({start(c){c.error(Error('socket lost'));}}))]){
  const f=fixture([first,done]);const result=await f.provider.generate('x');assert.equal(result.attempts,1);assert.equal(f.posts(),1);assert.equal(f.gets(),2);
  const urls=f.calls.filter(c=>c.options.method!=='POST').map(c=>c.url);assert.equal(urls[0],urls[1]);assert.deepEqual(f.waits,[1500]);
 }
});
test('an unrecoverable stream is never mistaken for a confirmed failed generation',async()=>{
 const f=fixture([()=>stream('event: heartbeat\ndata: null\n\n')]);await assert.rejects(f.provider.generate('x'),e=>e.eventId==='task-1'&&!e.safeToRetry&&e.attempts===1);assert.equal(f.posts(),1);assert.equal(f.gets(),3);assert.deepEqual(f.waits,[1500,4000]);
});
test('backoff and generation retries share one bounded Vercel request budget',async()=>{
 let clock=Date.now();let posts=0;const waits=[];
 const provider=createModelscopeProvider({getToken:()=>'test',now:()=>clock,requestBudgetMs:270000,sleepImpl:async ms=>waits.push(ms),fetchImpl:async(url,options)=>{
  if(options.method==='POST'){posts++;return Response.json({event_id:'slow-task'});}clock+=190000;return failed(null);
 }});
 await provider.run(()=>assert.rejects(provider.generate('x'),e=>e.attempts===1&&/insufficient time/.test(e.message)));assert.equal(posts,1);assert.deepEqual(waits,[]);
});
test('a stopped retry pause remains terminal to prevent the outer prompt-repair ladder from resubmitting',async()=>{
 const f=fixture([()=>failed(null)],{sleepImpl:async()=>{throw new DOMException('Aborted','AbortError');}});await assert.rejects(f.provider.generate('x'),e=>e.terminal&&e.code==='MODELSCOPE_IMAGE_ERROR');assert.equal(f.posts(),1);
});
test('frame 4 recovers, earlier images stay intact and the Storyboard batch continues to frame 5',async()=>{
 const submitted=[],counts=new Map(),logs=[];
 const provider=createModelscopeProvider({getToken:()=>'test',sleepImpl:async()=>{},fetchImpl:async(url,options={})=>{
  if(options.method==='POST') {const b=JSON.parse(options.body);const count=(counts.get(b.original_prompt)||0)+1;counts.set(b.original_prompt,count);submitted.push(b.original_prompt);return Response.json({event_id:b.original_prompt+'-'+count});}
  return String(url).endsWith('frame4-1')?failed(null):done();
 }});
 const text=await fs.readFile(path.join(__dirname,'../web/public/storyboard.html'),'utf8');const code=text.slice(text.indexOf('async function imagePhaseBatch('),text.indexOf('async function callPhase('));
 const context={USER_CANCELLED:false,CHARS:[{id:'A',reference_image_url:'https://existing/ref'}],FRAMES:[1,2,3,4,5].map(frame=>({frame})),logLocal:m=>logs.push(m)};
 context.callPhase=async(route,body)=>{const n=body.frames[0];const result=await provider.generate('frame'+n);return {ok:true,frames:[{frame:n,generated_image_url:image+'?frame='+n,image_retries:result.attempts-1}]};};
 context.acceptImageResults=async result=>{context.FRAMES=context.FRAMES.map(f=>result.frames.find(r=>r.frame===f.frame)||f);};context.acceptCharacterResults=async()=>{};
 vm.createContext(context);vm.runInContext(code,context);const result=await context.imagePhaseBatch('/images',{imageModel:MODEL,frames:[1,2,3,4,5]});
 assert.equal(result.ok,true);assert.deepEqual(submitted,['frame1','frame2','frame3','frame4','frame4','frame5']);assert.equal(context.FRAMES[3].image_retries,1);assert.equal(context.FRAMES[0].generated_image_url,image+'?frame=1');assert.ok(logs.some(l=>l.includes('recovered after 1 automatic retry')));
});
