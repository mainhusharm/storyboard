'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const models=require('./giz-models');
const PREFIX='giz:task:';
const fail=(message,extra={})=>Object.assign(Error(message),{code:'GIZ_ERROR',terminal:true,statusCode:400,...extra});
const meta=id=>models.find(m=>m.id===id);
function validateValue(v,s,key){
 if(s.const!==undefined&&v!==s.const)throw fail('Invalid Giz '+key+'.');
 if(s.enum&&!s.enum.includes(v))throw fail('Unsupported Giz '+key+'.');
  if(s.type==='array'){if(!Array.isArray(v)||v.length>(s.maxItems||100))throw fail('Invalid Giz '+key+'.');v.forEach(x=>validateValue(x,s.items,key));}
 else if(s.type==='number'||s.type==='integer'){if(typeof v!=='number'||!Number.isFinite(v)||(s.type==='integer'&&!Number.isInteger(v))||(s.minimum!==undefined&&v<s.minimum)||(s.maximum!==undefined&&v>s.maximum)||(s.multipleOf&&Math.abs(v/s.multipleOf-Math.round(v/s.multipleOf))>1e-7))throw fail('Invalid Giz '+key+'.');}
 else if(s.type&&typeof v!==s.type)throw fail('Invalid Giz '+key+'.');
 if(typeof v==='string'){
  if(v.length>(s.maxLength||60000)||v.length<(s.minLength||0)||(s.pattern&&!new RegExp(s.pattern).test(v)))throw fail('Invalid Giz '+key+'.');
  if(s.format==='uuid'&&!/^[a-f0-9-]{36}$/i.test(v))throw fail('Invalid Giz '+key+' UUID.');
  if(['uri','uri-reference'].includes(s.format)&&!/^https:\/\/[^\s]+$/i.test(v))throw fail('Giz '+key+' needs a public HTTPS media URL.');
 }
 if(s.anyOf&&!s.anyOf.some(option=>{try{validateValue(v,option,key);return true;}catch{return false;}}))throw fail('Invalid Giz '+key+'.');
}
function validate(id,input={},partial=false){
 const m=meta(id);if(!m)throw fail('Unsupported Giz model.');
 if(!input||typeof input!=='object'||Array.isArray(input))throw fail('Invalid Giz settings.');
 for(const [k,v] of Object.entries(input)){if(!Object.hasOwn(m.input.properties,k))throw fail('Unknown Giz parameter '+k+'.');validateValue(v,m.input.properties[k],k);}
 if(!partial)for(const k of m.input.required)if(input[k]===undefined||input[k]==='')throw fail('Giz '+k+' is required.');
 if(!partial&&id==='giz:omnivoice'&&input.ref_audio&&!input.ref_text)throw fail('OmniVoice reference audio needs its transcript.');
 return JSON.parse(JSON.stringify(input));
}
function options(value={}){if(!value||typeof value!=='object'||Array.isArray(value))throw fail('Invalid Giz options.');const out={};for(const [id,input]of Object.entries(value))out[id]=validate(id,input,true);return out;}
const nearest=(values,n)=>values.reduce((a,b)=>Math.abs(b-n)<Math.abs(a-n)?b:a);
function shape(id,{prompt,text,ratio='16:9',duration=8,references=[],image,voice,language}={},settings={}){
 const m=meta(id);if(!m)throw fail('Unsupported Giz model.');
 const p=m.input.properties,input={...validate(id,settings,true)};
 // Story action, narration and chaining own these fields; advanced options own all others.
 if(prompt!==undefined)input.prompt=prompt;
 if(text!==undefined)input.text=text;
 if(m.kind==='image'){
  if(input.size===undefined){const target=Number(ratio.split(':')[0])/Number(ratio.split(':')[1]);input.size=p.size.enum.reduce((a,b)=>{const ar=s=>{const [w,h]=s.split('x').map(Number);return w/h;};return Math.abs(ar(b)-target)<Math.abs(ar(a)-target)?b:a;});}
    if(references.length){const key=p.referenceImages?'referenceImages':'image';input[key]=[...new Set([...references,...(input[key]||[])])];if(id==='giz:krea-2'&&(!input.workflow||input.workflow==='create'))input.workflow='edit';}
   if(id==='giz:krea-2'&&input.workflow==='edit'&&input.referenceImages?.length>2)throw fail('KREA edit accepts one or two references. Select GPT Image Lite to preserve more references; none were dropped.');
 }
 if(m.kind==='video'){
  if(input.frames===undefined)input.frames=nearest(p.frames.enum,Number(duration)*24+(id==='giz:ltx2-5-distilled'?1:0));
   if(input.resolution===undefined){const target=Number(ratio.split(':')[0])/Number(ratio.split(':')[1]);input.resolution=p.resolution.enum.reduce((a,b)=>{const ar=s=>{const [w,h]=s.split('x').map(Number);return w/h;};return Math.abs(ar(b)-target)<Math.abs(ar(a)-target)?b:a;});}
   if(image){input.image=image;input.generateImage=false;}
 }
 if(m.kind==='speech'){
  if(p.language&&input.language===undefined&&language){if(!p.language.enum.includes(language))throw fail('Selected Giz speech model does not support language '+language+'. Select a supported language in its advanced controls.');input.language=language;}
  if(id==='giz:omnivoice'&&input.voiceGender===undefined&&['female','male'].includes(voice))input.voiceGender=voice;
  else if(p.voice&&input.voice===undefined&&voice&&!['female','male'].includes(voice))input.voice=voice;
  if(id==='giz:gateway/heygen:voice@1.0'&&!input.voice&&!input.audio)input.voice='3195f3da04c94984a0a77a4b757c8119';
 }
 if(m.kind==='music'&&id==='giz:acestep'&&input.lyrics===undefined)input.lyrics='[inst]';
  Object.assign(input,m.fixedInput||{});
  return validate(id,input);
}
function outputUrls(output){
 const urls=[];
 function visit(v){if(typeof v==='string'&&/^https:\/\//i.test(v))urls.push(v);else if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object'){for(const k of ['url','urls','image','images','video','video_url','image_url','audio','audio_url','files','artifacts','results','outputs','output','media'])if(v[k]!==undefined)visit(v[k]);}}
 visit(output);return [...new Set(urls)];
}
function createGizProvider({getKey,fetchImpl=(...args)=>fetch(...args),log=()=>{},sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
 const context=new AsyncLocalStorage();
 const run=fn=>context.run({options:{}},fn);
 const setOptions=value=>{const s=context.getStore();if(s)s.options=options(value||{});};
 async function request(tool,body){
  const key=String(getKey?.()||'').trim();if(!key)throw fail('Giz needs GIZ_API_KEY on the server.',{permanent:true,statusCode:503});
   const submitting=tool!=='job.get';
   let r,data;try{r=await fetchImpl('https://www.giz.ai/api/tools/'+tool,{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000),redirect:'error'});data=await r.json();}catch{throw fail(submitting?'Giz submission result is unknown. It was not retried to avoid duplicate charges.':'Giz polling could not complete; keep the existing task ID.',{ambiguous:submitting,statusCode:502});}
   // A 2xx job payload (submit / job.get) carries its own status and may describe a
   // failed job in `error` — that is a job outcome for poll(), not a broken request.
   const jobResult=data&&typeof data==='object'&&(typeof data.status==='string'||typeof data.id==='string');
   if(!r.ok||(data.isError===true&&!jobResult)||(data.error&&!jobResult))throw fail('Giz '+tool+' failed (HTTP '+r.status+'). '+(r.status===403?'Verify giz.inference/model.run, giz.write/generate tools and giz.read/job.get permissions.':''),{permanent:[400,401,402,403,404,422].includes(r.status),ambiguous:submitting&&r.status>=500,statusCode:502});
  return data;
 }
  async function submit(id,params={},overrides){
   const m=meta(id),settings=overrides||context.getStore()?.options[id]||{},input=shape(id,params,settings);
   // Speech and music always use model.run: generateMusic cannot pin a model and
   // generateAudio renames the verified model.get fields (text → script).
    const advanced=m.native||Object.keys(settings).length>0||params.native===true||!['image','video'].includes(m.kind);
   const tool=advanced?'model.run':m.kind==='image'?'generateImage':'generateVideo';
   const references=[...new Set(params.references||[])];
   if(!advanced&&m.kind==='image'&&references.length>4)throw fail('Giz generateImage accepts up to four references; none were dropped.');
   const body=advanced?{model:m.model,input}:{model:m.model,prompt:input.prompt,aspectRatio:params.ratio||'16:9',references:m.kind==='image'?references:params.image?[params.image]:references,...(m.kind==='video'?{duration:Number(params.duration)||8,resolution:input.resolution}:{})};
   log('Giz submit: model='+m.model+', kind='+m.kind+', route='+tool+', ratio='+(params.ratio||'16:9')+', references='+(body.references||[]).length+', promptLength='+String(input.prompt||input.text||input.tags||input.lyrics||'').length);
   const data=await request(tool,body);const job=data.id;if(typeof job!=='string'||!job||job.length>200)throw fail('Giz accepted no usable job ID; submission was not replayed.',{ambiguous:true,statusCode:502});return PREFIX+encodeURIComponent(job);
  }
 async function poll(task){
  if(!String(task).startsWith(PREFIX))throw fail('Invalid Giz task.');let id;try{id=decodeURIComponent(task.slice(PREFIX.length));}catch{throw fail('Invalid Giz task.');}if(!id||id.length>200)throw fail('Invalid Giz task.');
  const data=await request('job.get',{job:id,wait:false});const status=String(data.status||data.job?.status||'').toLowerCase();
    if(['queued','running','pending','created','processing'].includes(status))return {pending:true,task};
  if(['failed','cancelled','canceled'].includes(status))return {failed:true,error:'Giz job '+status+(data.error?': '+String(data.error).replace(/[.\s]+$/,''):'')+'. Saved outputs retained; no generation was resubmitted.'};
   if(status!=='completed')throw fail('Giz returned an unknown job state. Keep the existing task ID; no new generation was submitted.',{permanent:true,statusCode:502});
   const output=data.result?.output||data.job?.result?.output;const urls=outputUrls(output);if(!urls.length)throw fail('Giz completed without a downloadable media URL. Existing task retained.',{permanent:true,statusCode:502});return {url:urls[0],urls,output};
 }
 async function wait(task,minutes=25){const deadline=now()+minutes*60000;while(now()<deadline){const r=await poll(task);if(r.failed)throw fail(r.error);if(r.url)return r.url;await sleep(10000);}throw fail('Giz job is still pending. Keep task '+task+'; no new generation was submitted.',{task,statusCode:504});}
 return {run,setOptions,submit,poll,wait};
}
module.exports={models,meta,validate,options,shape,outputUrls,PREFIX,createGizProvider};
