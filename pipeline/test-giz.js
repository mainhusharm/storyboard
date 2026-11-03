'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const giz=require('../web/giz');
const image='giz:krea-2',video='giz:minimax-h3-turbo',speech='giz:omnivoice',music='giz:acestep';
function fixture(respond){const calls=[];return {calls,provider:giz.createGizProvider({getKey:()=> 'mock-secret',fetchImpl:async(url,options)=>{const call={url,body:JSON.parse(options.body)};calls.push(call);assert.equal(options.headers.Authorization,'Bearer mock-secret');assert.equal(options.redirect,'error');return respond?respond(call,calls.length):Response.json({id:'original-job'},{status:201});}})};}
test('all supported IDs are discoverable and advanced values are validated',()=>{
 assert.deepEqual(giz.models.map(m=>m.id),[video,'giz:ltx2-5-distilled',image,'giz:gpt-image-2-lite','giz:omnivoice','giz:inworld-tts-1-5-mini','giz:xai-tts','giz:tts-1','giz:gateway/heygen:voice@1.0','giz:acestep','giz:stable-audio','giz:minimax-music','giz:gpt-image','giz:gpt-image-2-5-flare','giz:gpt-image-2-5-sunburst','giz:flux3-klein','giz:z-image-turbo']);
 assert.deepEqual(giz.options({'giz:tts-1':{}}),{'giz:tts-1':{}});
 assert.throws(()=>giz.options({'giz:tts-1':{voice:'baritone'}}),/Unsupported/);
 assert.throws(()=>giz.shape('giz:tts-1',{}),/text/);
 assert.throws(()=>giz.shape('giz:stable-audio',{}),/prompt/);
 assert.throws(()=>giz.shape('giz:omnivoice',{text:'Hi'},{ref_audio:'https://x/voice.mp3'}),/transcript/);
 assert.throws(()=>giz.shape(image,{prompt:'Scene'},{seed:-1}),/seed/);
 assert.throws(()=>giz.shape(video,{prompt:'Scene'},{frames:120}),/frames/);
 assert.throws(()=>giz.shape(image,{prompt:'Scene'},{apiKey:'secret'}),/Unknown/);
 assert.throws(()=>giz.shape(image,{prompt:'Scene',references:['https://x/1','https://x/2','https://x/3']}),/none were dropped/);
 assert.throws(()=>giz.shape(video,{prompt:'Scene'},{controlVideo:'file:///secret'}),/HTTPS/);
});
test('GPT 2.5 aliases send the verified gpt-image variant without resubmitting',async()=>{
 const {provider,calls}=fixture();
 for(const variant of ['flare','sunburst']){
  await provider.submit('giz:gpt-image-2-5-'+variant,{prompt:'Portrait',references:['https://x/ref.png']});
  const call=calls.at(-1);assert.match(call.url,/model.run$/);assert.equal(call.body.model,'gpt-image');assert.equal(call.body.input.variant,variant);assert.deepEqual(call.body.input.image,['https://x/ref.png']);
 }
});
test('basic image and video use exact generate tool contracts with selected IDs and references',async()=>{
 const {provider,calls}=fixture();
 assert.equal(await provider.submit(image,{prompt:'Keep her face',ratio:'4:3',references:['https://x/ref.png']}),'giz:task:original-job');
 assert.deepEqual(calls[0],{url:'https://www.giz.ai/api/tools/generateImage',body:{model:'krea-2',prompt:'Keep her face',aspectRatio:'4:3',references:['https://x/ref.png']}});
 await provider.submit(video,{prompt:'Walk',ratio:'9:16',duration:8,image:'https://x/chain.png'});
  assert.deepEqual(calls[1],{url:'https://www.giz.ai/api/tools/generateVideo',body:{model:'minimax-h3-turbo',prompt:'Walk',aspectRatio:'9:16',duration:8,resolution:'576x1024',references:['https://x/chain.png']}});
});
test('model.run keeps exact native fields, variant count, masks, keyframes and ending references',async()=>{
 const {provider,calls}=fixture();const settings={workflow:'inpaint',maskImage:'https://x/mask',referenceImages:['https://x/ref'],size:'2048x2048',seed:0,negativeGuidance:true,negativePrompt:'blur',upscale:false};
 await provider.submit(image,{prompt:'Portrait'},settings);
 assert.deepEqual(calls[0].body,{model:'krea-2',input:{...settings,prompt:'Portrait'}});
 await provider.submit('giz:gpt-image-2-lite',{prompt:'Edit',references:['https://x/person']},{n:5,quality:'low',output_format:'webp'});
 assert.deepEqual(calls[1].body,{model:'gpt-image-2-lite',input:{n:5,quality:'low',output_format:'webp',prompt:'Edit',size:'1536x1024',image:['https://x/person']}});
 const native={workflow:'inpainting',resolution:'1920x1088',frames:241,autoDuration:false,generateImage:true,imageEnd:'https://x/end',injectedFrames:['https://x/key'],injectedFramePositions:'49',video:'https://x/video',controlVideo:'https://x/control',videoMask:'https://x/mask',controlPreset:'DVG',audio:'https://x/audio',audioMode:'soundtrack',renderMode:'quality',decoder:'fidelity',steps:8,seed:-1,negative:'blur',inputVideoStrength:0.8};
 await provider.submit('giz:ltx2-5-distilled',{prompt:'Action',image:'https://x/chain'},native);
 assert.deepEqual(calls[2].body,{model:'ltx2-5-distilled',input:{...native,generateImage:false,prompt:'Action',image:'https://x/chain'}});
 assert.ok(calls.every(c=>c.url.endsWith('/model.run')));
});
test('speech and music jobs always run through model.run with verified model.get input',async()=>{
 const {provider,calls}=fixture();
 assert.equal(await provider.submit(speech,{text:'Hello there',voice:'female',language:'en'}),'giz:task:original-job');
 assert.deepEqual(calls[0],{url:'https://www.giz.ai/api/tools/model.run',body:{model:'omnivoice',input:{text:'Hello there',language:'en',voiceGender:'female'}}});
 await provider.run(()=>{provider.setOptions({[music]:{tags:'synthwave',bpm:120}});return provider.submit(music,{});});
 assert.deepEqual(calls[1].body,{model:'acestep',input:{tags:'synthwave',bpm:120,lyrics:'[inst]'}});
 await provider.submit('giz:gateway/heygen:voice@1.0',{text:'Plain words'});
 assert.deepEqual(calls[2].body,{model:'gateway/heygen:voice@1.0',input:{text:'Plain words',voice:'3195f3da04c94984a0a77a4b757c8119'}});
 assert.ok(calls.every(c=>c.url.endsWith('/model.run')),'audio never routes through generateAudio/generateMusic');
});
test('per-request options remain isolated across simultaneous submissions',async()=>{
 const {provider,calls}=fixture();
 await Promise.all([1,2].map(seed=>provider.run(async()=>{provider.setOptions({[image]:{seed}});await new Promise(r=>setImmediate(r));await provider.submit(image,{prompt:'Account '+seed});})));
 assert.deepEqual(calls.map(c=>[c.body.input.prompt,c.body.input.seed]).sort(),[['Account 1',1],['Account 2',2]]);
 await provider.run(()=>provider.submit(image,{prompt:'Default'}));assert.ok(calls[2].url.endsWith('/generateImage'));
});
test('polls keep the original ID and read only completed result.output variants',async()=>{
 const {provider,calls}=fixture((c,n)=>Response.json(n===1?{status:'running',result:{output:'https://x/placeholder'}}:{status:'completed',result:{output:[{url:'https://x/one'},{url:'https://x/two'}]}}));
 assert.deepEqual(await provider.poll('giz:task:original-job'),{pending:true,task:'giz:task:original-job'});
 const result=await provider.poll('giz:task:original-job');assert.deepEqual(result.urls,['https://x/one','https://x/two']);
 assert.ok(calls.every(c=>c.url.endsWith('/job.get')));assert.ok(calls.every(c=>c.body.job==='original-job'&&c.body.wait===false));
});
test('ambiguous submissions, malformed responses, poll errors and explicit failures never resubmit',async()=>{
 for(const response of [()=>{throw Error('network');},()=>new Response('not JSON'),()=>Response.json({},{status:201}),()=>Response.json({error:'secret mock-secret'},{status:503})]){
  const {provider,calls}=fixture(response);await assert.rejects(provider.submit(image,{prompt:'Scene'}),e=>e.terminal===true&&e.ambiguous===true&&!e.message.includes('mock-secret'));assert.equal(calls.length,1);
 }
 const {provider,calls}=fixture(()=>{throw Error('network');});await assert.rejects(provider.poll('giz:task:existing'));assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/job.get'));
 const failed=fixture(()=>Response.json({status:'failed'}));assert.equal((await failed.provider.poll('giz:task:existing')).failed,true);assert.equal(failed.calls.length,1);
 // A failed JOB carries its own `error` field — that is an outcome, never a broken request.
 const jobError=fixture(()=>Response.json({status:'failed',error:'No provider within the price ceiling is available for tts-1.'}));
 const outcome=await jobError.provider.poll('giz:task:existing');
 assert.equal(outcome.failed,true);assert.match(outcome.error,/price ceiling/);assert.equal(jobError.calls.length,1);
});
