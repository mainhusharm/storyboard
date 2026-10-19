'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const {test}=require('node:test');
const {createJobStore,createStudioJobs}=require('../web/studio-jobs'),flow=require('../web/storyboard-jobs'),{lockVisualStyle}=require('../web/visual-style');
test('full Storyboard checkpoints every phase across fresh workers and never buys another submitted video',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'board-cloud-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const messages=[],calls=[],owner={id:'alice'};
 const input={kind:'storyboard',requestKey:'full-story-key-123456',script:'Krishna lifts Govardhan to protect the villagers.',style:'animatic',imageModel:'aqua:qwen-image-3.0-pro',videoModel:'veo-3.1',ratio:'4:3',narrationMode:'tts',chainContinuity:true};
 const frame=i=>({frame:i,duration_sec:8,image_prompt:'Krishna in a yellow dhoti',animation_prompt:'Krishna lifts a hill',narration:'He protects the village.'});
 const service=()=>createStudioJobs({store:createJobStore({root,isVercel:false,getDb:async()=>null}),publish:async m=>messages.push(m),execute:async(j,route,b)=>{
  calls.push({route,b});assert.equal(b.style,'animatic');
  if(route==='/api/storyboard')return {characters:[{id:'A',reference_prompt:'Krishna'}],frames:[frame(1),frame(2)]};
  if(route==='/api/char-refs'){assert.equal(b.force.length,1);return {characters:[{id:'A',reference_image_url:'https://fixture.test/ref.png',reference_style:'animatic'}]};}
  if(route==='/api/images')return {frames:b.framesData.map(f=>({...f,generated_image_url:'https://fixture.test/image'+f.frame+'.png'}))};
  if(route==='/api/narration')return {narrationUrl:'https://fixture.test/narration'+b.framesData[0].frame+'.mp3'};
  if(route.endsWith('generate-video')){assert.equal(b.model,'veo-3.1');if(!b.pollTask)return {pending:true,task:'https://provider.test/task/'+b.scene};return {clip_url:'https://fixture.test/clip'+b.scene+'.mp4',chain_image_url:'https://fixture.test/last'+b.scene+'.png'};}
  if(b.normalizeOnly){assert.equal(b.clipUrls.length,1);assert.ok(b.narrationUrl);return {clip_url:'https://fixture.test/prepared'+b.scenes[0]+'.mp4'};}
  assert.equal(b.preNormalized,true);assert.deepEqual(b.clipUrls,['https://fixture.test/prepared1.mp4','https://fixture.test/prepared2.mp4']);return {vault_url:'/api/vault/final/content'};
 }});
 const first=await service().start(owner,input);assert.equal(first.background,true);let deliveries=0,percent=0;
 while(messages.length){await service().process(messages.shift());const job=await service().get(owner,first.id);assert.ok(job.percent>=percent);percent=job.percent;assert.ok(++deliveries<20);}
 const final=await service().get(owner,first.id);assert.equal(final.status,'completed');assert.equal(final.result.url,'/api/vault/final/content');assert.equal(final.board.frames.length,2);
 assert.equal(calls.filter(c=>c.route.endsWith('generate-video')&&!c.b.pollTask).length,2);
 assert.equal(calls.find(c=>c.b.scene===2&&!c.b.pollTask).b.chainAnchor,'https://fixture.test/last1.png');assert.equal(final.percent,100);
});
test('recovering Combine uses existing media and never regenerates a storyboard, image or video',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'board-combine-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const messages=[],calls=[];
 const service=createStudioJobs({store:createJobStore({root,isVercel:false,getDb:async()=>null}),publish:async m=>messages.push(m),execute:async(j,route,b)=>{calls.push({route,b});assert.ok(route.endsWith('/combine'));return b.normalizeOnly?{clip_url:'https://fixture.test/prepared.mp4'}:{clip_url:'https://fixture.test/final.mp4'};}});
 const job=await service.start({id:'alice'},{kind:'storyboard',requestKey:'recover-combine-123456',mode:'combine',narrationMode:'tts',narrationUrl:'https://fixture.test/saved.mp3',framesData:[{frame:1,clip_url:'https://fixture.test/saved.mp4',narration:'Already recorded'}]});
 while(messages.length)await service.process(messages.shift());assert.equal((await service.get({id:'alice'},job.id)).status,'completed');assert.equal(calls.length,2);assert.equal(calls[1].b.narrationUrl,'https://fixture.test/saved.mp3');
 assert.throws(()=>flow.validate({mode:'combine',framesData:[{frame:1}]}),/Finish rendering/);
});
test('visual style removes conflicting rendering media, preserves identity and survives repeated prompt repair',()=>{
 const styles={animatic:{label:'Animatic',prefix:'2D pencil storyboard, ',suffix:', graphite lines'},anime:{label:'Anime',prefix:'anime cel-shaded, ',suffix:', clean lineart'},cinematic:{label:'Cinematic',prefix:'photorealistic film still, ',suffix:', film grain'}};
 const original='A photorealistic live-action anime portrait of Krishna with blue skin, yellow dhoti and peacock feather, lifting a hill.';
 let p=lockVisualStyle(original,'animatic',styles);p=lockVisualStyle(p,'animatic',styles);assert.match(p,/Animatic ONLY/);assert.doesNotMatch(p,/photorealistic|live-action|anime portrait/i);assert.match(p,/blue skin, yellow dhoti and peacock feather/);assert.match(p,/lifting a hill/);
 p=lockVisualStyle(original,'anime',styles);assert.doesNotMatch(p,/photorealistic|live-action/i);assert.match(p,/Anime ONLY/);
 p=lockVisualStyle(original,'cinematic',styles);assert.doesNotMatch(p,/anime portrait/i);assert.match(p,/photorealistic film still/);
});

test('cloud submissions do not create duplicate browser-connection tasks',async()=>{
 const vm=require('node:vm');let tick,calls=0;const ctx={CLOUD_JOB:null,CLOUD_SUBMITTING:true,SUBMITTING:true,Date,crypto:require('node:crypto'),setInterval:f=>tick=f,window:{addEventListener(){}},document:{currentScript:{dataset:{mode:'storyboard'}},addEventListener(){}},fetch:async()=>{calls++;return {ok:true,json:async()=>({})};}};
 vm.createContext(ctx);vm.runInContext(await fs.readFile(path.join(__dirname,'../web/public/task-monitor.js'),'utf8'),ctx);await new Promise(r=>setImmediate(r));assert.equal(calls,0);ctx.CLOUD_SUBMITTING=false;ctx.CLOUD_JOB={id:'cloud-test'};await tick();assert.equal(calls,0);
});
