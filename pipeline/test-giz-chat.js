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
 }finally{global.fetch=original;}
});
