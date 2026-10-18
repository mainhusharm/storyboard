'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const MODEL = 'modelscope:qwen-image-2.1';
const BASE = 'https://studio-qwen-qwen-image-2-1.api-inference.modelscope.net';
const PUBLIC_HOST = 'qwen-qwen-image-2-1.ms.show';
const PREFIX = 'modelscope:result:';
const PRESETS = { '16:9':[1344,768], '9:16':[768,1344], '1:1':[1024,1024], '4:3':[1184,864], '3:4':[864,1184] };
function settings(input = {}, ratio = '16:9') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('Invalid Qwen image settings.', true);
  const resolution = input.resolution || '1k';
  if (!['1k','2k','custom'].includes(resolution)) throw failure('Qwen resolution must be 1k, 2k or custom.', true);
  let width, height;
  if (resolution === 'custom') { width=Number(input.width); height=Number(input.height); }
  else { const preset=PRESETS[ratio]; if (!preset) throw failure('Unsupported Qwen aspect ratio.', true); [width,height]=preset.map(n=>n*(resolution==='2k'?2:1)); }
  if (![width,height].every(n=>Number.isInteger(n)&&n>=256&&n<=2688&&n%8===0)) throw failure('Qwen width and height must be multiples of 8 between 256 and 2688.', true);
  const seed = input.seed === undefined ? 0 : Number(input.seed);
  if (!Number.isInteger(seed)||seed<0||seed>2147483647) throw failure('Qwen seed must be an integer from 0 to 2147483647.', true);
  for (const key of ['randomizeSeed','enhancePrompt']) if (input[key]!==undefined&&typeof input[key]!=='boolean') throw failure('Invalid Qwen '+key+'.',true);
  return { width,height,seed,randomize_seed:input.randomizeSeed!==false,enable_extend:input.enhancePrompt!==false,negative_prompt:String(input.negativePrompt||'').slice(0,4000) };
}
function failure(message, permanent = false) { return Object.assign(new Error(message), { code:'MODELSCOPE_IMAGE_ERROR', terminal:true, permanent }); }
function createModelscopeProvider({ getToken, fetchImpl = (...args)=>fetch(...args), log = ()=>{}, requestBudgetMs = Infinity } = {}) {
  const context = new AsyncLocalStorage();
  const run = fn => context.run({ options:{}, deadline:Date.now()+requestBudgetMs },fn);
  function setOptions(options) { const scope=context.getStore(); if(scope) scope.options=options||{}; }
  function finishedUrl(marker) { return String(marker).startsWith(PREFIX) ? decodeURIComponent(String(marker).slice(PREFIX.length)) : null; }
  async function generate(prompt, ratio='16:9', references=[], overrides) {
    const token=getToken?.();
    if(!token) throw failure('ModelScope needs MODELSCOPE_API_TOKEN on the server. Add it in Vercel and redeploy.',true);
    const params=settings(overrides||context.getStore()?.options,ratio);
    if(!String(prompt||'').trim())throw failure('Qwen image prompt is required.',true);
    if(!Array.isArray(references)||references.length>10)throw failure('Qwen accepts at most 10 reference images.',true);
    const remaining=(context.getStore()?.deadline||Date.now()+240000)-Date.now()-5000;
    if(remaining<5000)throw failure('Not enough server time remains for Qwen. Retry this image phase.');
    const signal=AbortSignal.timeout(Math.min(240000,remaining));
    const headers={Authorization:'Bearer '+token};
    const request=async(route,options={})=>{
      const r=await fetchImpl(BASE+route,{...options,headers:{...headers,...options.headers},signal,redirect:'error'});
      if(!r.ok) { await r.body?.cancel(); throw failure('ModelScope HTTP '+r.status+(r.status===401||r.status===403?': verify MODELSCOPE_API_TOKEN and access to this studio.':r.status===429?': rate limit reached. Retry later.':': image request failed.'),r.status===401||r.status===403); }
      return r;
    };
    let eventId='';
    try {
      const input_images=[];
      for(let i=0;i<references.length;i++) {
        const buffer=references[i];
        if(!Buffer.isBuffer(buffer)||!buffer.length||buffer.length>20*1024*1024)throw failure('Each Qwen reference must be a valid image under 20 MB.',true);
        const isPng=buffer[0]===0x89&&buffer.subarray(1,4).toString()==='PNG';
        const isJpg=buffer[0]===0xff&&buffer[1]===0xd8;
        const isWebp=buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP';
        if(!isPng&&!isJpg&&!isWebp)throw failure('Qwen references must be PNG, JPEG or WebP.',true);
        const type=isPng?'image/png':isJpg?'image/jpeg':'image/webp';
        const form=new FormData();form.append('files',new Blob([buffer],{type}),'reference-'+i+(isPng?'.png':isJpg?'.jpg':'.webp'));
        const uploaded=await (await request('/gradio_api/upload',{method:'POST',body:form})).json();
        if(!Array.isArray(uploaded)||!uploaded[0]?.startsWith('/tmp/gradio/'))throw failure('ModelScope returned an invalid reference upload.');
        input_images.push({image:{path:uploaded[0],meta:{_type:'gradio.FileData'}},caption:null});
      }
      const body={input_images,original_prompt:String(prompt),custom_size:true,...params};
      const submitted=await (await request('/gradio_api/call/v2/generate_with_enhance',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).json();
      eventId=submitted.event_id;
      if(!/^[a-zA-Z0-9_-]+$/.test(eventId||''))throw failure('ModelScope did not return an image task.');
      log('Qwen ModelScope: '+(references.length?'editing with '+references.length+' reference(s)':'text-to-image')+' at '+params.width+'x'+params.height);
      const response=await request('/gradio_api/call/generate_with_enhance/'+eventId);
      const reader=response.body.getReader();const decoder=new TextDecoder();let pending='';
      try {
        while(true){
          const {done,value}=await reader.read();pending+=decoder.decode(value||new Uint8Array(),{stream:!done});
          let split;
          while((split=pending.search(/\r?\n\r?\n/))>=0){
            const block=pending.slice(0,split);pending=pending.slice(split+(/\r\n\r\n/.test(pending.slice(split,split+4))?4:2));
            const lines=block.split(/\r?\n/);const event=lines.find(l=>l.startsWith('event:'))?.slice(6).trim();
            const text=lines.filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
            if(event==='error')throw failure('ModelScope generation failed. Retry later; check studio availability and quota.');
            if(event!=='complete')continue; // Never expose intermediate or placeholder images.
            let data;try{data=JSON.parse(text);}catch{throw failure('ModelScope returned an invalid final result.');}
            const image=data?.[0];
            if(!image?.path?.startsWith('/tmp/gradio/'))throw failure('ModelScope completed without an image.');
            const url=new URL(image.url||'/gradio_api/file='+image.path,BASE);
            if(url.protocol!=='https:'||![new URL(BASE).hostname,PUBLIC_HOST].includes(url.hostname)||!url.pathname.startsWith('/gradio_api/file='))throw failure('ModelScope returned an unexpected image address.');
            log('Qwen ModelScope: image ready (seed '+data[1]+')');
            return {url:url.href,seed:data[1],enhancedPrompt:data[2]||'',width:params.width,height:params.height};
          }
          if(done)break;
        }
      } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
      throw failure('ModelScope ended before completing this image.');
    } catch(error) {
      if(error.code==='MODELSCOPE_IMAGE_ERROR')throw error;
      throw failure('ModelScope '+(eventId?'task '+eventId+' was submitted but did not finish in time; it may still be running. Retry later.':'image request could not complete. Check your connection and retry.'));
    }
  }
  return {run,setOptions,generate,finishedUrl,marker:url=>PREFIX+encodeURIComponent(url)};
}
module.exports={MODEL,BASE,PRESETS,settings,createModelscopeProvider};
