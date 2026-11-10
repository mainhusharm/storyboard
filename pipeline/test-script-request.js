'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('real script worker uses one bounded Giz request and no extra trend calls',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'single-script-'));
 const original=global.fetch,originalTimeout=AbortSignal.timeout,budgets=[];
 AbortSignal.timeout=ms=>{budgets.push(ms);return originalTimeout(ms);};
 process.env.STORYBOARD_DATA_DIR=root;process.env.GIZ_API_KEY='mock-script-key';delete process.env.VERCEL;delete process.env.DATABASE_URL;
 require('../web/studio-queue').publish=async()=>{};
 const api=require('../web/server').__internal;
 t.after(async()=>{global.fetch=original;AbortSignal.timeout=originalTimeout;await fs.rm(root,{recursive:true,force:true});});
 const input={kind:'prompt',source:'sjinn',idea:'A continuous journey',name:'Example',slug:'example',model:'giz:gpt-6-1-sol',duration:15,sceneLength:10,ratio:'9:16',references:[],trendThumbnail:'https://example.invalid/reference.png'};
 const job={id:'00000000-0000-4000-8000-000000000001',user:{id:'test-user'},input};
 let calls=0;
 global.fetch=async(url,opts)=>{
  assert.equal(url,'https://www.giz.ai/v1/chat/completions','no scraping, vision or per-scene requests');calls++;
  const body=JSON.parse(opts.body);assert.equal(body.model,'openai/gpt-6.1-sol');assert.equal(body.max_tokens,8192);
  assert.ok(opts.signal);assert.equal(opts.signal.aborted,false);
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'Journey',scenes:Array.from({length:6},(_,i)=>({scene:i+1,title:'Scene '+(i+1),imagePrompt:'A traveller on a path',videoPrompt:'0–10s: The traveller walks forward.'}))})}}]});
 };
 const result=await api.executeStudioStep(job,'/api/flashloop/generate-prompt',input);
 assert.equal(result.scenes.length,6);assert.equal(calls,1);assert.equal(result.trendTemplate.grounded,false);
 assert.ok(budgets.includes(220000),'model aborts before 255s internal deadline and 300s platform limit');
 for(const scenario of ['quota','timeout','malformed','partial','truncated','body-timeout']){
  calls=0;
  global.fetch=async()=>{calls++;if(scenario==='quota')return Response.json({error:{message:'Go allowance used; no credits charged'}},{status:429});
   if(scenario==='timeout')throw new DOMException('Timed out','TimeoutError');
   if(scenario==='body-timeout')return {ok:true,json:async()=>{throw new DOMException('Timed out','TimeoutError');}};
   return Response.json({choices:[{finish_reason:scenario==='truncated'?'length':'stop',message:{content:scenario==='malformed'?'not JSON':JSON.stringify({scenes:[{imagePrompt:'A traveller',videoPrompt:'Walk'}]})}}]});
  };
  await assert.rejects(()=>api.executeStudioStep(job,'/api/flashloop/generate-prompt',input),scenario==='quota'?/Choose another chat model/:scenario==='timeout'?/time budget/:scenario==='partial'?/1\/6 scenes/:scenario==='truncated'?/token limit/:scenario==='body-timeout'?/interrupted/:/no usable scenes|unavailable/i);
  assert.equal(calls,1,scenario+' never replays or buys per-scene replacements');
 }
});
