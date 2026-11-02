'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createJobStore,createStudioJobs}=require('../web/studio-jobs');
const giz=require('../web/giz');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'giz-worker-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const messages=[],calls=[],polls=new Map();const store=()=>createJobStore({root,isVercel:false,getDb:async()=>null});const provider=giz.createGizProvider({getKey:()=> 'mock',fetchImpl:async(url,options)=>{const body=JSON.parse(options.body);calls.push({url,body});if(!url.endsWith('/job.get'))return Response.json({id:'job-'+calls.length},{status:201});const n=polls.get(body.job)||0;polls.set(body.job,n+1);return Response.json(n===0?{status:'running'}:{status:'completed',result:{output:'https://fixture.test/'+body.job+'.png'}});}});const execute=async(j,route,b)=>provider.run(async()=>{provider.setOptions(b.giz);if(route==='/api/giz/media'){const kind=giz.meta(b.model)?.kind;if(b.pollTask){const r=await provider.poll(b.pollTask);return r.pending?r:kind==='image'?{imageUrl:r.url}:{audioUrl:r.url};}return {pending:true,task:await provider.submit(b.model,b.params)};}if(route.endsWith('generate-i2i'))return {pending:true,taskUrl:await provider.submit(b.model,{prompt:b.prompt,references:b.referenceImages})};if(route.endsWith('generate-video'))return b.pollTask?{clip_url:'https://fixture.test/clip.mp4',chain_image_url:'https://fixture.test/chain.png'}:{pending:true,task:await provider.submit(b.model,{prompt:b.prompt,duration:b.duration,image:b.chainAnchor||b.imageUrl})};return {clip_url:'https://fixture.test/final.mp4'};});const service=()=>createStudioJobs({store:store(),publish:async m=>messages.push(m),execute,pollImage:async task=>{const r=await provider.poll(task);return r.pending?r:{imageUrl:r.url};}});return {store,service,messages,calls};}
test('Storyboard references and images submit then poll across fresh workers exactly once each',async t=>{
 const f=await fixture(t),owner={id:'alice'};const job=await f.service().start(owner,{kind:'storyboard',requestKey:'giz-board-key-123456',imageModel:'giz:krea-2',videoModel:'giz:minimax-h3-turbo',narrationMode:'prompt',style:'animatic',characters:[{id:'A',reference_prompt:'Locked character'}],framesData:[{frame:1,image_prompt:'A walks',animation_prompt:'A moves',characters_present:['A']}]});
 let rounds=0;while(f.messages.length){await f.service().process(f.messages.shift());assert.ok(++rounds<20);}
 const final=await f.service().get(owner,job.id);assert.equal(final.status,'completed',JSON.stringify(final));assert.equal(final.board.characters[0].reference_style,'animatic');
 const submits=f.calls.filter(c=>!c.url.endsWith('/job.get'));assert.equal(submits.length,3);assert.equal(submits.filter(c=>c.body.model==='krea-2').length,2);assert.deepEqual(submits[1].body.references,[final.board.characters[0].reference_image_url]);assert.equal(final.options.imageModel,'giz:krea-2');
});
test('Flashloop and SJinn image jobs checkpoint paid submission across reload and owner isolation',async t=>{
 for(const source of ['flashloop','sjinn']){const f=await fixture(t),owner={id:'alice'},j=await f.service().start(owner,{kind:'image',source,requestKey:'giz-'+source+'-123456789',imageModel:'giz:gpt-image-2-lite',scenes:[{imagePrompt:'Keep both identities'}],referenceImages:['https://fixture.test/a','https://fixture.test/b']});while(f.messages.length)await f.service().process(f.messages.shift());assert.equal((await f.service().get(owner,j.id)).status,'completed');assert.equal(f.calls.filter(c=>!c.url.endsWith('/job.get')).length,1);assert.equal(await f.service().get({id:'bob'},j.id),null);}
});
test('stale image/reference submit is never replayed; stale polls recover the same checkpoint',async t=>{
 for(const kind of ['reference','frame-image','reference-poll','frame-image-poll']){const f=await fixture(t),owner={id:'alice'},j=await f.service().start(owner,{kind:'storyboard',requestKey:'stale-giz-key-123456',imageModel:'giz:krea-2',mode:'images',characters:[],framesData:[{frame:1,image_prompt:'A'}]});await f.store().mutate(j.id,null,s=>{s.inflight={kind,i:0};s.leaseUntil=1;if(kind.endsWith('poll'))s.scenes[0].imageTask='giz:task:existing';});await f.service().process({id:j.id});const saved=await f.service().get(owner,j.id);assert.equal(f.calls.filter(c=>!c.url.endsWith('/job.get')).length,0);if(kind.endsWith('poll'))assert.equal(saved.status,'running');else {assert.equal(saved.status,'failed');assert.match(saved.error,/duplicate charges/);}}
});
test('Storyboard narration and soundtrack jobs submit once each and checkpoint their audio',async t=>{
 const f=await fixture(t),owner={id:'alice'};
 const job=await f.service().start(owner,{kind:'storyboard',requestKey:'giz-audio-key-123456',imageModel:'giz:krea-2',videoModel:'giz:minimax-h3-turbo',narrationMode:'tts',narrationEngine:'giz:tts-1',voice:'female',language:'en',musicModel:'giz:acestep',musicVolume:0.2,giz:{'giz:acestep':{tags:'cinematic synth'}},style:'cinematic',characters:[],framesData:[{frame:1,image_prompt:'A walks',narration:'Welcome to the show'}]});
 let rounds=0;while(f.messages.length){await f.service().process(f.messages.shift());assert.ok(++rounds<20);}
 const final=await f.service().get(owner,job.id);
 assert.equal(final.status,'completed',JSON.stringify(final));
 assert.deepEqual(f.calls.filter(c=>!c.url.endsWith('/job.get')).map(c=>c.body.model),['krea-2','tts-1','minimax-h3-turbo','acestep']);
 assert.equal(final.options.narrationEngine,'giz:tts-1');
 assert.equal(final.options.musicModel,'giz:acestep');
 assert.equal(final.options.musicVolume,0.2);
});

test('Flashloop film renders Giz narration and soundtrack around its scene clips',async t=>{
 const f=await fixture(t),owner={id:'alice'};
 const job=await f.service().start(owner,{kind:'film',source:'flashloop',requestKey:'giz-film-key-123456',model:'giz:minimax-h3-turbo',imageModel:'giz:krea-2',ratio:'9:16',duration:8,narrationEngine:'giz:omnivoice',musicModel:'giz:stable-audio',giz:{'giz:omnivoice':{text:'Welcome to the show'},'giz:stable-audio':{prompt:'Slow cinematic synth pad, 8 seconds'}},scenes:[{imagePrompt:'A walks',videoPrompt:'A moves'}]});
 let rounds=0;while(f.messages.length){await f.service().process(f.messages.shift());assert.ok(++rounds<30);}
 const final=await f.service().get(owner,job.id);
 assert.equal(final.status,'completed',JSON.stringify(final));
 const submits=f.calls.filter(c=>!c.url.endsWith('/job.get')).map(c=>c.body.model);
 assert.ok(submits.includes('omnivoice'),'narration submitted: '+JSON.stringify(submits));
 assert.ok(submits.includes('stable-audio'),'soundtrack submitted: '+JSON.stringify(submits));
 assert.equal(final.options.narrationEngine,'giz:omnivoice');
 assert.equal(final.options.musicModel,'giz:stable-audio');
});

test('client cannot import somebody else\'s provider reference task',()=>{
 const flow=require('../web/storyboard-jobs');const input=flow.validate({mode:'references',imageModel:'giz:krea-2',characters:[{id:'A',gizTask:'giz:task:other-owner'}],framesData:[{frame:1}]});assert.equal(input.characters[0].gizTask,undefined);
});
