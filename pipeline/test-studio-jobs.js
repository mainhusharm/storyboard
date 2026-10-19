'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const {createJobStore,createStudioJobs,validateInput}=require('../web/studio-jobs');
const owner={id:'alice',email:'alice@test.invalid',name:'Alice'},other={id:'bob'};
const payload=(key='request-1234567890')=>({requestKey:key,source:'sjinn',title:'Sleep test',model:'wan3.0-video-prime',imageModel:'aqua:qwen-image-3.0-pro',ratio:'4:3',resolution:'1080P',duration:15,chained:true,scenes:[1,2].map(i=>({imagePrompt:'Portrait '+i,videoPrompt:'Scene '+i}))});
async function fixture(t,opts={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-jobs-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const messages=[],calls=[];let now=Date.now();
  const store=()=>createJobStore({root,getDb:async()=>null,isVercel:false});
  const execute=async(j,route,b)=>{
    calls.push({owner:j.ownerId,source:b.source,route,body:b});
    if(route.endsWith('generate-i2i'))return {imageUrl:'https://fixture.test/image.png'};
    if(route.endsWith('generate-video'))return b.pollTask ? {clip_url:'https://fixture.test/scene'+b.scene+'.mp4',chain_image_url:'https://fixture.test/last'+b.scene+'.png'} : {pending:true,task:'novita:task:'+b.scene};
    return b.normalizeOnly ? {clip_url:'https://fixture.test/norm'+b.scenes[0]+'.mp4'} : {vault_url:'/api/vault/owned-final/content',clips:b.scenes.length};
  };
  const service=()=>createStudioJobs({store:store(),publish:async(m,d)=>{messages.push({m,d});},execute:opts.execute||execute,pollImage:opts.pollImage||(async()=>({imageUrl:'https://fixture.test/async.png'})),now:()=>now,leaseMs:1000});
  return {root,messages,calls,store,service,advance:ms=>{now+=ms;}};
}
test('film completes without a browser, across a fresh store/worker for EVERY queue delivery',async t=>{
  const f=await fixture(t);const started=await f.service().start(owner,payload());
  assert.equal(started.status,'queued');let rounds=0;
  while(f.messages.length){const {m}=f.messages.shift();await f.service().process(m);assert.ok(++rounds<30);}
  const final=await f.service().get(owner,started.id);assert.equal(final.status,'completed');assert.equal(final.completedScenes,2);assert.equal(final.result.url,'/api/vault/owned-final/content');
  assert.equal(f.calls.filter(c=>c.route.endsWith('generate-i2i')).length,1,'chaining reuses the preceding final frame');
  assert.equal(f.calls.filter(c=>c.route.endsWith('generate-video')&&!c.body.pollTask).length,2);
  assert.equal(f.calls.filter(c=>c.body.normalizeOnly).length,2,'normalization is split into bounded invocations');
  assert.ok(f.calls.every(c=>c.owner==='alice'&&c.source==='sjinn'));
  const second=f.calls.find(c=>c.body.scene===2&&!c.body.pollTask);assert.equal(second.body.chainAnchor,'https://fixture.test/last1.png');
  const combine=f.calls.find(c=>c.body.preNormalized);assert.deepEqual(combine.body.scenes,[1,2]);assert.deepEqual(combine.body.clipUrls,['https://fixture.test/norm1.mp4','https://fixture.test/norm2.mp4']);assert.equal(combine.body.ratio,'4:3');
});
test('owner isolation, idempotent start, and cancellation retain finished work',async t=>{
 const f=await fixture(t),service=f.service();const j=await service.start(owner,payload());const again=await service.start(owner,payload());assert.equal(j.id,again.id);
 assert.equal(await service.get(other,j.id),null);assert.equal(await service.cancel(other,j.id),null);assert.deepEqual(await service.list(other,'sjinn'),[]);
 await service.process({id:j.id});const cancelled=await service.cancel(owner,j.id);assert.equal(cancelled.status,'cancelled');assert.ok(cancelled.scenes[0].imageUrl);
 const count=f.calls.length;for(const message of f.messages)await service.process(message.m);assert.equal(f.calls.length,count);
 assert.equal((await service.list(owner,'flashloop')).length,0);
});
test('duplicate queue delivery cannot overlap or repeat a paid step',async t=>{
 let release,entered;const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);let calls=0;
 const f=await fixture(t,{execute:async()=>{calls++;entered();await gate;return {imageUrl:'https://fixture.test/image.png'};}}),service=f.service();const j=await service.start(owner,payload());
 const first=service.process({id:j.id});await ready;
 await assert.rejects(service.process({id:j.id}),/already running/);assert.equal(calls,1);release();await first;
});
test('expired worker lease never blindly repeats an ambiguous paid submission',async t=>{
 const f=await fixture(t),service=f.service(),j=await service.start(owner,payload());
 await f.store().mutate(j.id,null,s=>{s.inflight={kind:'video',i:0};s.leaseUntil=1;s.status='running';});
 await service.process({id:j.id});const failed=await service.get(owner,j.id);assert.equal(failed.status,'failed');assert.match(failed.error,/duplicate charges/);assert.equal(f.calls.length,0);
});
test('an interrupted poll resumes its recorded task instead of submitting again',async t=>{
 const f=await fixture(t),service=f.service(),j=await service.start(owner,payload());
 await f.store().mutate(j.id,null,s=>{s.scenes[0].task='novita:task:existing';s.inflight={kind:'video-poll',i:0};s.leaseUntil=1;s.status='running';});
 await service.process({id:j.id});assert.equal(f.calls[0].body.pollTask,'novita:task:existing');assert.ok((await service.get(owner,j.id)).scenes[0].clip_url);
});
test('pending image tasks are checkpointed; provider failures stop without another submit',async t=>{
 let submits=0,polls=0;
 const f=await fixture(t,{execute:async()=>{submits++;return {taskUrl:'https://api.paxsenix.org/task/existing'};},pollImage:async()=>{polls++;if(polls<2)return {pending:true};throw Error('Provider rejected this image');}}),service=f.service(),j=await service.start(owner,payload());
 while(f.messages.length)await service.process(f.messages.shift().m);
 assert.equal(submits,1);assert.equal(polls,2);assert.equal((await service.get(owner,j.id)).status,'failed');
});
test('parallel mode checkpoints four renders before polling and preserves final scene order',async t=>{
 const f=await fixture(t),service=f.service();const input=payload();input.chained=false;input.scenes=Array.from({length:5},(_,i)=>({imageUrl:'https://fixture.test/image.png',videoPrompt:'Scene '+i}));const j=await service.start(owner,input);
 for(let i=0;i<5;i++)await service.process(f.messages.shift().m);
 const submitCalls=f.calls.filter(c=>!c.body.pollTask);assert.equal(submitCalls.length,4);assert.ok(f.calls[4].body.pollTask);
 while(f.messages.length)await service.process(f.messages.shift().m);
 assert.equal((await service.get(owner,j.id)).status,'completed');
 const final=f.calls.find(c=>c.body.preNormalized);assert.deepEqual(final.body.scenes,[1,2,3,4,5]);
});
test('queue publication failure retains the same job for a safe retry',async t=>{
 const f=await fixture(t);let broken=true;const service=createStudioJobs({store:f.store(),execute:async()=>{},publish:async()=>{if(broken)throw Error('Queue unavailable');},pollImage:async()=>{}});
 await assert.rejects(service.start(owner,payload()),/generation was saved/);const saved=await service.list(owner,'sjinn');assert.equal(saved.length,1);broken=false;const retry=await service.start(owner,payload());assert.equal(retry.id,saved[0].id);
});
test('cloud job storage refuses volatile disk and inputs cannot spoof owner or worker paths',async t=>{
 const f=await fixture(t);const cloud=createJobStore({root:f.root,isVercel:true,getDb:async()=>null});await assert.rejects(cloud.list('alice'),/DATABASE_URL/);
 const input=validateInput({...payload(),ownerId:'bob',videoDir:'C:/secrets',normalizeOnly:true});assert.equal(input.ownerId,undefined);assert.equal(input.videoDir,undefined);assert.equal(input.normalizeOnly,undefined);
 assert.throws(()=>validateInput({...payload(),refImageUrl:'file:///secret'}),/HTTPS/);
});

test('script outline and writing complete through saved worker steps without a browser',async t=>{
 const calls=[];const f=await fixture(t,{execute:async(j,route,b)=>{calls.push(route);if(route.endsWith('generate-outline'))return {title:'Saved script',sceneLength:8,outline:Array.from({length:8},(_,i)=>({title:'Beat '+i,summary:'Action '+i}))};return {scene:{title:'Scene '+b.sceneIndex,imagePrompt:'Image',videoPrompt:'Video'},sceneLength:8};}}),service=f.service();
 const job=await service.start(owner,{requestKey:'script-key-123456789',kind:'prompt',source:'sjinn',idea:'A calm story',duration:15,sceneLength:8,model:'logfare:auto'});
 while(f.messages.length)await service.process(f.messages.shift().m);
 const result=await service.get(owner,job.id);assert.equal(result.status,'completed');assert.equal(result.kind,'prompt');assert.equal(result.result.scenes.length,8);assert.equal(calls.length,9);assert.equal(calls.some(r=>r.endsWith('combine')),false);
});
test('single script and standalone image jobs finish without buying a video or entering the vault',async t=>{
 const calls=[];const f=await fixture(t,{execute:async(j,route)=>{calls.push(route);return route.endsWith('generate-prompt')?{title:'Single',sceneLength:30,scenes:[{imagePrompt:'Image',videoPrompt:'Video'}]}:{imageUrl:'https://fixture.test/standalone.png'};}}),service=f.service();
 const script=await service.start(owner,{kind:'prompt',requestKey:'single-key-123456789',source:'flashloop',idea:'A short scene',duration:5,sceneLength:30});
 while(f.messages.length)await service.process(f.messages.shift().m);
 assert.equal((await service.get(owner,script.id)).result.scenes.length,1);
 const image=await service.start(owner,{kind:'image',requestKey:'image-key-123456789',source:'flashloop',imageModel:'aqua:qwen-image-3.0-pro',sceneIndex:2,scenes:[{imagePrompt:'Image of a forest'}]});
 while(f.messages.length)await service.process(f.messages.shift().m);
 const result=await service.get(owner,image.id);assert.equal(result.status,'completed');assert.equal(result.result.sceneIndex,2);assert.equal(result.result.imageUrl,'https://fixture.test/standalone.png');assert.deepEqual(calls,['/api/flashloop/generate-prompt','/api/flashloop/generate-i2i']);
});

test('background script scene counts match the supported total duration and scene length',()=>{
 for(const [duration,sceneLength,count,per] of [[30,30,4,30],[15,30,2,30],[30,5,24,5],[5,8,1,30],[15,9,8,8]]) {
  const input=validateInput({kind:'prompt',idea:'A story',duration,sceneLength});assert.equal(input.totalScenes,count);assert.equal(input.sceneLength,per);
 }
});

// Different stories can overlap; the active-job limit must not disturb accepted work.
test('three separate stories execute in parallel and cancellation affects only one',async t=>{
 let entered=0,release,ready;const gate=new Promise(r=>release=r),allEntered=new Promise(r=>ready=r);
 const f=await fixture(t,{execute:async(j)=>{if(++entered===3)ready();await gate;return {imageUrl:'https://fixture.test/'+j.id+'.png'};}}),service=f.service();
 const jobs=[];for(let i=0;i<3;i++)jobs.push(await service.start(owner,payload('parallel-key-'+i+'-12345')));
 await assert.rejects(service.start(owner,payload('parallel-key-four-12345')),/3|three|active/i);
 const work=jobs.map(j=>service.process({id:j.id}));await allEntered;
 await service.cancel(owner,jobs[0].id);release();await Promise.all(work);
 assert.equal((await service.get(owner,jobs[0].id)).status,'cancelled');
 for(const j of jobs.slice(1)){const saved=await service.get(owner,j.id);assert.notEqual(saved.status,'cancelled');assert.equal(saved.scenes[0].imageUrl,'https://fixture.test/'+j.id+'.png');}
});
