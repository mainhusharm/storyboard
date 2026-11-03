'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('Giz chat and Flashloop routing preserve the selected model and OpenAI response',async()=>{
 process.env.GIZ_API_KEY='mock-giz-chat-key';
 const api=require('../web/server').__internal,original=global.fetch,calls=[];
 global.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({choices:[{message:{content:'A new story'}}]});};
 try{
  for(const run of [api.chatCompletion,api.chatWithLogfareFallback])assert.equal(await run('giz:gpt-6-luna',[{role:'user',content:'Write a story'}],123,0.5),'A new story');
  assert.equal(calls.length,2);
  for(const call of calls){assert.equal(call.url,'https://www.giz.ai/v1/chat/completions');assert.equal(call.body.model,'gpt-6-luna');assert.equal(call.body.max_tokens,123);}
  let attempts=0;
  global.fetch=async()=>{attempts++;return Response.json({error:{code:'rate_limit_exceeded',message:'Too many requests'}},{status:429,headers:{'retry-after':'30'}});};
  await assert.rejects(()=>api.chatWithLogfareFallback('giz:gpt-6-luna',[]),e=>e.statusCode===429&&e.retryAfterSeconds===30&&/Retry after 30 seconds/.test(e.message));
  assert.equal(attempts,1,'never automatically replay a rejected generation');
  global.fetch=async()=>Response.json({error:{code:'insufficient_quota',message:'Insufficient credits'}},{status:429});
  await assert.rejects(()=>api.chatCompletion('giz:gpt-6-luna',[]),e=>e.code==='GIZ_CHAT_QUOTA'&&/credits are exhausted/.test(e.message));
 }finally{global.fetch=original;}
});
