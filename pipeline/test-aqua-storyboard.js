'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const http=require('node:http');const vm=require('node:vm');const {test,before,after}=require('node:test');
const MODEL='aqua:qwen-image-3.0-pro';const nativeFetch=global.fetch;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XcAAAAASUVORK5CYII=','base64');
let root,server,base,token,blocked=false;const requests=[];
async function request(route,body){return nativeFetch(base+route,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
async function waitForPhase(){for(let i=0;i<100;i++){const status=await(await request('/api/status')).json();if(status.phase==='idle')return status;await new Promise(r=>setTimeout(r,10));}throw Error('Image phase did not settle');}
before(async()=>{
 root=await fs.mkdtemp(path.join(__dirname,'../.aqua-storyboard-test-'));process.env.STORYBOARD_DATA_DIR=root;process.env.AQUA_API_KEY='offline-aqua-key';process.env.PAXSENIX_API_KEY='offline-pax-key';process.env.NOVITA_API_KEY='offline-novita-key';process.env.SESSION_SECRET='offline-aqua-test-secret';delete process.env.VERCEL;delete process.env.DATABASE_URL;
 const handler=require('../web/server');server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 const signup=await nativeFetch(base+'/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Aqua Test',email:'aqua@test.invalid',password:'offline-aqua-password'})});assert.equal(signup.status,200);token=(await signup.json()).token;
 global.fetch=async(url,options={})=>{const address=String(url);requests.push({url:address,options});if(address==='https://api.aquadevs.com/v1/images/generations'){if(blocked)return new Response('<html>Just a moment...</html>',{status:403,headers:{'cf-mitigated':'challenge','cf-ray':'test-IAD'}});return Response.json({success:true,model:'qwen-image-3.0-pro',url:'https://api.aquadevs.com/generation/test.png'});}if(address==='https://api.aquadevs.com/generation/test.png')return new Response(png,{headers:{'Content-Type':'image/png'}});throw Error('Unexpected provider request: '+address);};
});
after(async()=>{global.fetch=nativeFetch;if(server)await new Promise(r=>server.close(r));if(root)await fs.rm(root,{recursive:true,force:true});});
test('Storyboard character references and both studios send the same Aqua model, headers and payload',async()=>{
 const characters=[{id:'Character A',name:'Krishna',reference_prompt:'Young Krishna with blue skin, curly black hair, peacock feather crown and yellow dhoti, serene expression.'}];
 const response=await request('/api/char-refs',{imageModel:MODEL,style:'cinematic',characters,force:true});assert.equal(response.status,202);await waitForPhase();
 const stored=JSON.parse(await fs.readFile(path.join(root,'storyboard','characters.json'),'utf8'));assert.ok(stored[0].reference_image_url);assert.equal(stored[0].reference_error,undefined);
 const storyboard=requests.find(r=>r.options.method==='POST');const body=JSON.parse(storyboard.options.body);assert.equal(body.model,'qwen-image-3.0-pro');assert.equal(body.ratio,'square');assert.match(body.prompt,/blue skin/);
 for(const source of ['flashloop','sjinn']){const response=await request('/api/flashloop/generate-i2i',{source,model:MODEL,prompt:body.prompt,ratio:'1:1'});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.provider,'aqua');assert.equal(result.model,MODEL);const studio=requests.filter(r=>r.options.method==='POST').at(-1);assert.equal(studio.url,storyboard.url);assert.deepEqual(studio.options.headers,storyboard.options.headers);assert.deepEqual(JSON.parse(studio.options.body),body);}
});
test('a Cloudflare rejection retains Aqua and never invokes another provider or repairs the prompt',async()=>{
 blocked=true;requests.length=0;
 const response=await request('/api/char-refs',{imageModel:MODEL,style:'cinematic',characters:[{id:'Character B',name:'Kaliya',reference_prompt:'Kaliya serpent portrait, black scales and multiple hoods.'}],force:true});assert.equal(response.status,202);const status=await waitForPhase();
 const stored=JSON.parse(await fs.readFile(path.join(root,'storyboard','characters.json'),'utf8'));assert.equal(stored[0].reference_error.code,'AQUA_CLOUDFLARE_BLOCKED');assert.equal(stored[0].reference_error.model,MODEL);
 assert.equal(requests.filter(r=>r.options.method==='POST').length,1,'no prompt repair or cross-provider generation');assert.match(JSON.stringify(status.log),/qwen-image-3.0-pro/);
 for(const source of ['flashloop','sjinn']){const rejected=await request('/api/flashloop/generate-i2i',{source,model:MODEL,prompt:'Kaliya portrait',ratio:'1:1'});const result=await rejected.json();assert.equal(rejected.status,503);assert.equal(result.provider,'aqua');assert.equal(result.model,MODEL);assert.equal(result.code,'AQUA_CLOUDFLARE_BLOCKED');}
 assert.ok(requests.every(r=>r.url.startsWith('https://api.aquadevs.com/')));
});
test('manual and automatic Vercel Aqua batches submit one unchanged model at a time',async()=>{
 const text=await fs.readFile(path.join(__dirname,'../web/public/storyboard.html'),'utf8');const code=text.slice(text.indexOf('async function imagePhaseBatch('),text.indexOf('// VERCEL AUTO PIPELINE'));
 const calls=[];let active=0,maxActive=0;const context={IS_VERCEL_CLIENT:true,USER_CANCELLED:false,CHARS:[{id:'A'},{id:'B'}],FRAMES:[{frame:1},{frame:2}],AbortController,setTimeout,clearTimeout,logLocal(){},acceptCharacterResults:async r=>{context.CHARS=r.characters;},acceptImageResults:async r=>{context.FRAMES=context.FRAMES.map(f=>r.frames.find(n=>n.frame===f.frame)||f);},api:async(route,options)=>{active++;maxActive=Math.max(active,maxActive);const body=JSON.parse(options.body);calls.push({route,body});await new Promise(r=>setTimeout(r,5));active--;return route==='/char-refs'?{ok:true,characters:body.characters.map(c=>body.force.includes(c.id)?{...c,reference_image_url:'https://aqua/'+c.id}:c)}:{ok:true,frames:body.frames.map(frame=>({frame,generated_image_url:'https://aqua/'+frame}))};}};
 vm.createContext(context);vm.runInContext(code,context);await context.callPhase('/char-refs',{imageModel:MODEL,force:true});assert.equal(calls.length,2);assert.equal(maxActive,1);assert.ok(calls.every(c=>c.body.imageModel===MODEL&&c.body.force.length===1));assert.equal(calls[1].body.characters[0].reference_image_url,'https://aqua/A');
 const start=text.indexOf('async function postJob(');vm.runInContext(text.slice(start,text.indexOf("$('btnStoryboard').onclick",start)),context);Object.assign(context,{SUBMITTING:false,guardBusy:async()=>true,clearLocalLog(){},refreshCredits(){},alert(){}});calls.length=0;context.USER_CANCELLED=true;await context.postJob('/images',{imageModel:MODEL,frames:[1,2]});assert.equal(calls.length,2);assert.ok(calls.every(c=>c.body.frames.length===1&&c.body.imageModel===MODEL));
 calls.length=0;context.api=async()=>{calls.push(1);throw Error('network disconnected');};await assert.rejects(context.callPhase('/images',{imageModel:MODEL,frames:[1]},{singleImage:true}),/network disconnected/);assert.equal(calls.length,1);
});

test('combining an Aqua film cannot silently use an emergency image from another provider',()=>{
 const {emergencyImageChain}=require('../web/server').__internal;assert.deepEqual(emergencyImageChain(MODEL),[MODEL]);
});
