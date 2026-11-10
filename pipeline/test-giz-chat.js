'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('Giz chat and Flashloop routing preserve the selected model and OpenAI response',async()=>{
 process.env.GIZ_API_KEY='mock-giz-chat-key';
 const api=require('../web/server').__internal,original=global.fetch,calls=[];
 global.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({choices:[{message:{content:'A new story'}}]});};
 try{
  for(const run of [api.chatCompletion,api.chatWithLogfareFallback])assert.equal(await run('giz:gpt-6-luna',[{role:'user',content:'Write a story'}],123,0.5),'A new story');
  assert.equal(calls.length,2);
  for(const call of calls){assert.equal(call.url,'https://www.giz.ai/v1/chat/completions');assert.equal(call.body.model,'openai/gpt-6-luna');assert.equal(call.body.max_tokens,123);}
  const mapping={'claude-opus-5-5':'anthropic/claude-opus-5.5','claude-opus-4-8':'anthropic/claude-opus-4.8','claude-sonnet-5-5':'anthropic/claude-sonnet-5.5','claude-fable-5-2':'anthropic/claude-fable-5.2','gpt-6-1-sol':'openai/gpt-6.1-sol','gpt-6-1-sol-pro':'openai/gpt-6.1-sol-pro','gpt-6-sol':'openai/gpt-6-sol','gpt-6-sol-pro':'openai/gpt-6-sol-pro','gpt-6-1-terra':'openai/gpt-6.1-terra','gpt-6-1-terra-pro':'openai/gpt-6.1-terra-pro','gpt-6-luna-pro':'openai/gpt-6-luna-pro','gpt-5-4-nano':'openai/gpt-5.4-nano','gemini-3-1-pro':'google/gemini-3.1-pro-preview','grok':'x-ai/grok-4.7','deepseek-v4-pro':'deepseek/deepseek-v4-pro','deepseek-flash':'deepseek/deepseek-v4.1-flash-1017','gemini-flash-lite':'google/gemini-3.5-flash-lite','gemini-flash':'google/gemini-3.8-flash','qwen3-8-max':'qwen/qwen3.8-max-prime','kimi-k3-1-pro':'moonshotai/kimi-k3.1-pro','mistral-large-4':'mistralai/mistral-large-4-0','glm-5-3-prime':'z-ai/glm-5.3-prime','gemma-4-31b':'google/gemma-4-31b-it','glm-5':'z-ai/glm-5.3'};
  for(const [alias,id]of Object.entries(mapping)){await api.chatCompletion('giz:'+alias,[]);assert.equal(calls.at(-1).body.model,id);}
  let attempts=0;
  global.fetch=async()=>{attempts++;return Response.json({error:{code:'rate_limit_exceeded',message:'Too many requests'}},{status:429,headers:{'retry-after':'30'}});};
  await assert.rejects(()=>api.chatWithLogfareFallback('giz:gpt-6-luna',[]),e=>e.statusCode===429&&e.retryAfterSeconds===30&&/Retry after 30 seconds/.test(e.message));
  assert.equal(attempts,1,'never automatically replay a rejected generation');
  global.fetch=async()=>Response.json({error:{code:'insufficient_quota',message:'Insufficient credits'}},{status:429});
  await assert.rejects(()=>api.chatCompletion('giz:gpt-6-luna',[]),e=>e.code==='GIZ_CHAT_QUOTA'&&/credits are exhausted/.test(e.message));
 }finally{global.fetch=original;}
});
