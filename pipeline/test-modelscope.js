'use strict';
const assert=require('node:assert/strict');
const {test,before,after}=require('node:test');
const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');
const {MODEL,BASE,PRESETS,settings,normalizeToken,createModelscopeProvider}=require('../web/modelscope');
const imageUrl='https://qwen-qwen-image-2-1.ms.show/gradio_api/file=/tmp/gradio/final/image.png';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=','base64');
function events(text){return new Response(new ReadableStream({start(c){const bytes=new TextEncoder().encode(text);for(let i=0;i<bytes.length;i+=13)c.enqueue(bytes.slice(i,i+13));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});}
function complete(url=imageUrl){return 'event: generating\ndata: [{"path":"/tmp/gradio/placeholder/image.png"},0,""]\n\nevent: heartbeat\ndata: null\n\nevent: complete\ndata: '+JSON.stringify([{path:'/tmp/gradio/final/image.png',url},42,'Enhanced prompt'])+'\n\n';}
test('token accepts raw, Bearer-prefixed and quoted values',()=>{assert.equal(normalizeToken('test-token'),'test-token');assert.equal(normalizeToken(' Bearer test-token '),'test-token');assert.equal(normalizeToken('"Bearer test-token"'),'test-token');});
function fakeFetch(calls,eventText=complete()) {return async(url,options={})=>{
  calls.push({url:String(url),options});
  if(String(url).endsWith('/upload'))return Response.json(['/tmp/gradio/reference/image.png']);
  if(String(url).includes('/call/v2/'))return Response.json({event_id:'task-123'});
  return events(eventText);
};}
test('five ratios support official 1K/2K presets; custom size, seed and booleans are validated',()=>{
  for(const [ratio,dims] of Object.entries(PRESETS))for(const resolution of ['1k','2k']){const actual=settings({resolution},ratio);assert.deepEqual([actual.width,actual.height],dims.map(n=>n*(resolution==='2k'?2:1)));}
  const custom=settings({resolution:'custom',width:800,height:1200,seed:42,randomizeSeed:false,enhancePrompt:false,negativePrompt:'blur'});
  assert.equal(custom.width,800);assert.equal(custom.randomize_seed,false);assert.equal(custom.enable_extend,false);assert.equal(custom.negative_prompt,'blur');
  for(const input of [{resolution:'bad'},{resolution:'custom',width:257,height:1024},{seed:-1},{seed:2147483648},{randomizeSeed:'false'},{enhancePrompt:0}])assert.throws(()=>settings(input),/Qwen/);
  assert.throws(()=>settings({},'7:1'),/aspect ratio/);
});
test('fragmented SSE ignores placeholders, parses final output, and authenticates all API requests',async()=>{
  const calls=[];const provider=createModelscopeProvider({getToken:()=>'test-token',fetchImpl:fakeFetch(calls)});
  const result=await provider.generate('blue teapot','9:16',[],{seed:42,randomizeSeed:false});
  assert.equal(result.url,imageUrl);assert.equal(result.seed,42);assert.equal(result.enhancedPrompt,'Enhanced prompt');
  const body=JSON.parse(calls[0].options.body);assert.equal(body.width,768);assert.equal(body.height,1344);assert.equal(body.input_images.length,0);assert.equal(body.custom_size,true);
  assert.equal(calls.length,2);for(const call of calls)assert.equal(call.options.headers.Authorization,'Bearer test-token');
  assert.equal(provider.finishedUrl(provider.marker(imageUrl)),imageUrl);
});
test('references upload bytes first and use Gallery image entries, never remote URLs as input',async()=>{
  const calls=[];const provider=createModelscopeProvider({getToken:()=>'test-token',fetchImpl:fakeFetch(calls)});
  await provider.generate('red teapot','1:1',[png,png]);
  assert.equal(calls.filter(c=>c.url.endsWith('/upload')).length,2);
  const file=calls[0].options.body.get('files');assert.equal(file.type,'image/png');assert.deepEqual(Buffer.from(await file.arrayBuffer()),png);
  const body=JSON.parse(calls.find(c=>c.url.includes('/call/v2/')).options.body);
  assert.equal(body.input_images.length,2);assert.equal(body.input_images[0].image.meta._type,'gradio.FileData');assert.equal(body.input_images[0].image.path,'/tmp/gradio/reference/image.png');
  await assert.rejects(provider.generate('x','1:1',Array(11).fill(png)),/at most 10/);
  await assert.rejects(provider.generate('x','1:1',[Buffer.from('not an image')]),/PNG, JPEG or WebP/);
});
test('authentication, stream errors, premature EOF and unsafe results fail without duplicate submissions',async()=>{
  let calls=[];const absent=createModelscopeProvider({getToken:()=>'',fetchImpl:fakeFetch(calls)});
  await assert.rejects(absent.generate('x'),/MODELSCOPE_API_TOKEN/);assert.equal(calls.length,0);
  for(const response of ['event: error\ndata: "GPU unavailable"\n\n','event: generating\ndata: null\n\n',complete('https://untrusted.test/image.png')]){
    calls=[];const provider=createModelscopeProvider({getToken:()=>'test-token',fetchImpl:fakeFetch(calls,response)});
    await assert.rejects(provider.generate('x'),e=>e.terminal===true);
    assert.equal(calls.filter(c=>c.url.includes('/call/v2/')).length,1);
  }
  const denied=createModelscopeProvider({getToken:()=>'test-token',fetchImpl:async()=>new Response('private upstream detail',{status:401})});
  await assert.rejects(denied.generate('x'),/verify MODELSCOPE_API_TOKEN/);
});
test('parallel requests isolate controls and preserve explicit seed zero',async()=>{
  const calls=[];const provider=createModelscopeProvider({getToken:()=>'test-token',fetchImpl:fakeFetch(calls)});
  await Promise.all([provider.run(async()=>{provider.setOptions({seed:0,randomizeSeed:false,resolution:'2k'});await new Promise(r=>setTimeout(r,15));return provider.generate('alice','4:3');}),provider.run(async()=>{provider.setOptions({seed:99,resolution:'custom',width:800,height:1200});return provider.generate('bob','1:1');})]);
  const bodies=calls.filter(c=>c.options.body&&typeof c.options.body==='string').map(c=>JSON.parse(c.options.body));
  assert.equal(bodies.find(b=>b.original_prompt==='alice').seed,0);assert.equal(bodies.find(b=>b.original_prompt==='alice').width,2368);assert.equal(bodies.find(b=>b.original_prompt==='bob').width,800);
});
let root,server,base,token,handler;const nativeFetch=global.fetch;const serverCalls=[];
before(async()=>{
  root=await fs.mkdtemp(path.join(__dirname,'../.modelscope-test-'));
  process.env.STORYBOARD_DATA_DIR=root;process.env.MODELSCOPE_API_TOKEN='offline-test-token';process.env.SESSION_SECRET='offline-test-secret';delete process.env.VERCEL;delete process.env.DATABASE_URL;
  handler=require('../web/server');server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  const response=await nativeFetch(base+'/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Provider Test',email:'provider@test.invalid',password:'offline-test-password'})});assert.equal(response.status,200);token=(await response.json()).token;
  await fs.writeFile(path.join(root,'frames','reference.png'),png);
  const providerFetch=fakeFetch(serverCalls);
  global.fetch=(url,options)=>String(url).startsWith(BASE)?providerFetch(url,options):nativeFetch(url,options);
});
after(async()=>{global.fetch=nativeFetch;if(server)await new Promise(r=>server.close(r));if(root)await fs.rm(root,{recursive:true,force:true});});
test('real Flashloop and SJinn endpoints pass controls and references through request context',async()=>{
  const catalog=await (await nativeFetch(base+'/api/models')).json();assert.ok(catalog.image.includes(MODEL));
  assert.equal((await nativeFetch(base+'/api/flashloop/generate-i2i',{method:'POST'})).status,401);
  for(const source of ['flashloop','sjinn']){
    const response=await nativeFetch(base+'/api/flashloop/generate-i2i',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({source,model:MODEL,prompt:'Turn it red',ratio:'3:4',refImageUrl:'/frames/reference.png',referenceImages:['/frames/reference.png'],modelscope:{resolution:'2k',seed:17,randomizeSeed:false,enhancePrompt:false,negativePrompt:'blur'}})});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.provider,'modelscope');assert.equal(result.mode,'i2i');assert.equal(result.width,1728);assert.equal(result.height,2368);assert.equal(result.imageUrl,imageUrl);assert.equal(result.vault_saved,undefined);
    const body=JSON.parse(serverCalls.filter(c=>c.url.includes('/call/v2/')).at(-1).options.body);assert.equal(body.input_images.length,1);assert.equal(body.enable_extend,false);assert.equal(body.randomize_seed,false);assert.equal(body.seed,17);assert.equal(body.negative_prompt,'blur');
  }
});
test('Storyboard adapters route text and multiple-reference images directly to Qwen, not PaxSenix',async()=>{
  const {submitTask,submitImg2ImgTask,waitTask,modelscopeImages}=handler.__internal;
  await modelscopeImages.run(async()=>{
    modelscopeImages.setOptions({resolution:'1k',seed:21,randomizeSeed:false});
    const info={};const marker=await submitTask('/ai-image/nano-banana?model='+encodeURIComponent(MODEL)+'&prompt=portrait&ratio=1:1',()=>{},info);
    assert.ok(marker,JSON.stringify(info));assert.equal(await waitTask(marker),imageUrl);
    const edited=await submitImg2ImgTask('same character',['/frames/reference.png','/frames/reference.png'],MODEL,'16:9',info);
    assert.ok(edited,JSON.stringify(info));assert.equal(await waitTask(edited),imageUrl);
    const body=JSON.parse(serverCalls.filter(c=>c.url.includes('/call/v2/')).at(-1).options.body);assert.equal(body.input_images.length,2);assert.equal(body.width,1344);assert.equal(body.seed,21);
  });
});

test('Vercel Qwen batches use one request per character/frame and carry previous successes forward',async()=>{
  const vm=require('node:vm');const text=await fs.readFile(path.join(__dirname,'../web/public/storyboard.html'),'utf8');
  const code=text.slice(text.indexOf('async function imagePhaseBatch('),text.indexOf('async function callPhase('));
  const calls=[];const context={USER_CANCELLED:false,CHARS:[{id:'A'},{id:'B'}],FRAMES:[{frame:1},{frame:2}],logLocal(){},
    callPhase:async(route,body,options)=>{calls.push({route,body,options});return route==='/char-refs'?{ok:true,characters:body.characters.map(c=>body.force.includes(c.id)?{...c,reference_image_url:'https://image/'+c.id}:c)}:{ok:true,frames:body.frames.map(frame=>({frame,generated_image_url:'https://image/'+frame}))};},
    acceptCharacterResults:async result=>{context.CHARS=result.characters;},
    acceptImageResults:async result=>{context.FRAMES=context.FRAMES.map(f=>result.frames.find(n=>n.frame===f.frame)||f);}};
  vm.createContext(context);vm.runInContext(code,context);
  await context.imagePhaseBatch('/char-refs',{imageModel:MODEL,force:true});
  assert.equal(calls.length,2);assert.equal(calls[0].body.force.length,1);assert.equal(calls[1].body.characters[0].reference_image_url,'https://image/A');assert.equal(calls[1].options.attempts,1);
  calls.length=0;await context.imagePhaseBatch('/images',{imageModel:MODEL,frames:[1,2]});
  assert.equal(calls.length,2);assert.equal(calls[1].body.framesData[0].generated_image_url,'https://image/1');
  calls.length=0;context.callPhase=async()=>{calls.push(1);return {ok:false,error:'provider unavailable'};};context.acceptImageResults=async()=>{};
  const failed=await context.imagePhaseBatch('/images',{frames:[1,2]});assert.equal(failed.ok,false);assert.equal(calls.length,1,'stop a failed batch without resubmitting');
});
test('a disconnected Qwen browser request is not automatically submitted again',async()=>{
  const vm=require('node:vm');const text=await fs.readFile(path.join(__dirname,'../web/public/storyboard.html'),'utf8');
  const code=text.slice(text.indexOf('async function callPhase('),text.indexOf('// VERCEL AUTO PIPELINE'));
  let calls=0;const context={IS_VERCEL_CLIENT:false,USER_CANCELLED:false,AbortController,setTimeout,clearTimeout,logLocal(){},api:async()=>{calls++;throw new Error('connection interrupted');}};
  vm.createContext(context);vm.runInContext(code,context);
  await assert.rejects(context.callPhase('/images',{imageModel:MODEL}),/connection interrupted/);assert.equal(calls,1);
});
