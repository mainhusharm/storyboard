'use strict';
// A Storyboard film advances one checkpoint per private queue delivery.
const copy=v=>JSON.parse(JSON.stringify(v));
const bad=m=>Object.assign(Error(m),{statusCode:400});
const text=(v,n)=>String(v||'').slice(0,n);
const url=v=>{const s=text(v,5000);if(s&&!/^https:\/\//i.test(s))throw bad('Saved cloud assets need public HTTPS URLs.');return s;};
const styles=['cinematic','animatic','anime','realistic','fantasy','scifi','noir','horror','pixar','ghibli','cyberpunk','vintage','watercolor','comic','oilpainting','minimalist'];
function validate(body){
 const frames=(Array.isArray(body.framesData)?body.framesData:[]).map((f,i)=>({...copy(f),frame:Number(f.frame)||i+1,duration_sec:Math.max(1,Math.min(30,Number(f.duration_sec)||Number(body.clipDuration)||6)),generated_image_url:url(f.generated_image_url),clip_url:url(body.clipUrls?.[f.frame]||f.clip_url),chain_image_url:url(f.chain_image_url)}));
 if(frames.some(f=>!Number.isInteger(f.frame)||f.frame<1))throw bad('Frame numbers must be positive integers.');
 if(frames.length>100||new Set(frames.map(f=>f.frame)).size!==frames.length)throw bad('Supply up to 100 uniquely numbered frames.');
 const characters=(Array.isArray(body.characters)?copy(body.characters):[]);if(characters.length>40)throw bad('Too many characters.');
 for(const c of characters){if(!/^[\p{L}\p{N} _-]{1,100}$/u.test(String(c.id||'')))throw bad('Invalid character ID.');c.reference_image_url=url(c.reference_image_url);}
 const script=text(body.script,60000);if(!frames.length&&script.trim().length<10)throw bad('Paste a story script first.');
 if(body.style&&!styles.includes(body.style))throw bad('Select a supported visual style.');
 const videoModel=text(body.videoModel,100)||'omni-flash';if(!['grok-video','veo-3.1','omni-flash','wan3.0-video-prime','wan3.0-video-standard','wan3.0-video','wan2.7-t2v','wan2.1-t2v-turbo','wan2.1-t2v-plus','wan2.7-i2v','wan2.1-i2v-turbo','wan2.1-i2v-plus'].includes(videoModel))throw bad('Unsupported video model.');
 const mode=body.mode==='combine'?'combine':'full';if(mode==='combine'&&(!frames.length||frames.some(f=>!f.clip_url)))throw bad('Finish rendering every scene first. Combine needs all saved clip URLs.');
 return {kind:'storyboard',source:'storyboard',mode,script,model:text(body.model||body.chatModel,100)||'gemini-2.5-pro',title:text(body.title||script.split('\n').find(s=>s.trim()),160).replace(/^#+\s*/,'' )||'Storyboard film',
  style:body.style||'cinematic',videoModel,imageModel:text(body.imageModel,100)||'nano-banana-pro',duration:Math.max(10,Math.min(600,Number(body.duration)||120)),clipDuration:Math.max(1,Math.min(30,Number(body.clipDuration)||6)),
  ratio:['16:9','9:16','1:1','4:3','3:4'].includes(body.ratio)?body.ratio:'16:9',resolution:body.resolution==='1080P'?'1080P':'720P',look:text(body.look,6000),voice:text(body.voice,100)||'female',language:text(body.language,20)||'en',
  narrationMode:body.narrationMode==='prompt'?'prompt':'tts',narrationEngine:text(body.narrationEngine,40)||'fish',narrVolume:body.narrVolume,origVolume:body.origVolume,narrationUrl:body.narrationMode==='prompt'?'':url(body.narrationUrl),consistency:body.consistency!==false,chained:body.chainContinuity!==false,
  modelscope:body.modelscope&&typeof body.modelscope==='object'?copy(body.modelscope):undefined,characters,framesData:frames,scenes:frames.map(f=>({imageUrl:f.generated_image_url}))};
}
function initialize(j){j.board={characters:j.input.characters,frames:j.input.framesData};j.scenes=j.board.frames.map(f=>({image:f.generated_image_url,clip:f.clip_url,chain:f.chain_image_url,stage:f.clip_url?'video-ready':'queued'}));}
function next(j){
 const I=j.input,B=j.board;if(!B.frames.length)return {kind:'board',key:'board'};
 if(I.mode!=='combine'&&I.consistency){const i=B.characters.findIndex(c=>!c.reference_image_url);if(i>=0)return {kind:'reference',i,key:'reference:'+i};}
 if(I.mode!=='combine'){const i=j.scenes.findIndex(s=>!s.image&&!s.clip);if(i>=0)return {kind:'frame-image',i,key:'frame-image:'+i};}
 if(I.narrationMode==='tts'&&!I.narrationUrl){const i=j.scenes.findIndex((s,i)=>!s.voice&&(B.frames[i].narration||B.frames[i].dialogue));if(i>=0)return {kind:'narrate',i,key:'narrate:'+i};}
 const i=j.scenes.findIndex(s=>!s.clip);if(i>=0)return {kind:j.scenes[i].task?'video-poll':'video',i,key:'video:'+i};
 const n=j.scenes.findIndex(s=>!s.normalized);return n>=0?{kind:'normalize',i:n,key:'normalize:'+n}:{kind:'combine',key:'combine'};
}
function label(j,op){const names={board:'Planning storyboard',reference:'Character reference', 'frame-image':'Scene image',narrate:'Scene narration',video:'Submitting scene video','video-poll':'Scene video rendering',normalize:'Preparing scene for final cut',combine:'Joining prepared scenes and saving final film'};return names[op.kind]+(op.i===undefined?'':' '+(op.i+1)+'/'+(op.kind==='reference'?j.board.characters.length:j.scenes.length))+'…';}
async function execute(j,op,run){
 const I=j.input,B=j.board,f=B.frames[op.i],s=j.scenes[op.i],common={...I,characters:B.characters,framesData:f?[f]:B.frames};
 if(op.kind==='board')return run(j,'/api/storyboard',I);
 if(op.kind==='reference')return run(j,'/api/char-refs',{...common,force:[B.characters[op.i].id]});
 if(op.kind==='frame-image')return run(j,'/api/images',{...common,frames:[f.frame]});
 if(op.kind==='narrate')return run(j,'/api/narration',common);
 if(op.kind==='video'||op.kind==='video-poll')return run(j,'/api/flashloop/generate-video',{...common,model:I.videoModel,scene:f.frame,duration:f.duration_sec,prompt:f.animation_prompt||f.summary||f.image_prompt,imageUrl:s.image,chainAnchor:I.chained&&op.i>0?j.scenes[op.i-1].chain:'',pollTask:s.task||'',narration:f.narration,dialogue:f.dialogue});
 if(op.kind==='normalize')return run(j,'/api/flashloop/combine',{...common,model:I.videoModel,scenes:[f.frame],clipUrls:[s.clip],normalizeOnly:true,targetDuration:f.duration_sec,narrationUrl:s.voice||'',narrVolume:I.narrVolume,origVolume:I.origVolume});
 return run(j,'/api/flashloop/combine',{...common,model:I.videoModel,scenes:B.frames.map(f=>f.frame),clipUrls:j.scenes.map(s=>s.normalized),preNormalized:true,narrationUrl:I.narrationUrl});
}
function apply(j,op,r){
 const s=j.scenes[op.i],f=j.board.frames[op.i];
 if(r.ok===false||r.error)throw Error(r.error||'Storyboard step failed.');
 if(op.kind==='board'){
  if(!Array.isArray(r.frames)||!r.frames.length||!Array.isArray(r.characters))throw Error('The storyboard returned no valid frames.');
  j.board={characters:r.characters,frames:r.frames};j.scenes=r.frames.map(()=>({stage:'queued'}));
 }else if(op.kind==='reference'){
  const c=r.characters?.find(c=>c.id===j.board.characters[op.i].id);if(!c?.reference_image_url||c.reference_error)throw Error(c?.reference_error?.message||'Character reference was not hosted.');j.board.characters[op.i]=c;
 }else if(op.kind==='frame-image'){
  const result=r.frames?.find(x=>x.frame===f.frame);if(!result?.generated_image_url||result.image_error)throw Error(result?.image_error?.message||'Scene image was not hosted.');Object.assign(f,result);s.image=result.generated_image_url;s.stage='image-ready';
 }else if(op.kind==='narrate'){if(!r.narrationUrl)throw Error('Narration was not hosted.');s.voice=r.narrationUrl;}
 else if(op.kind==='video'||op.kind==='video-poll'){
  if(r.pending&&r.task){s.task=r.task;s.stage='video-rendering';}
  else if(r.clip_url){s.clip=r.clip_url;s.chain=r.chain_image_url||'';s.task='';s.stage='video-ready';f.clip_url=s.clip;f.chain_image_url=s.chain;}
  else throw Error('The rendered scene has no saved clip URL.');
 }else if(op.kind==='normalize'){if(!r.clip_url)throw Error('The prepared scene has no saved clip URL.');s.normalized=r.clip_url;s.stage='ready';}
 else{const url=r.vault_url||r.clip_url||r.hosted_url;if(!url)throw Error('Final film has no saved URL.');j.result={...r,url};j.status='completed';}
}
function publicJob(j){
 const B=j.board||{frames:[],characters:[]},n=Math.max(1,j.scenes.length),refs=j.input.consistency&&j.input.mode!=='combine'?B.characters.length:0,speech=j.input.narrationMode==='tts'&&!j.input.narrationUrl?B.frames.filter(f=>f.narration||f.dialogue).length:0,steps=1+refs+3*n+speech+1;
 const done=(B.frames.length?1:0)+(refs?B.characters.filter(c=>c.reference_image_url).length:0)+j.scenes.reduce((n,s)=>n+!!(s.image||s.clip)+!!s.clip+!!s.normalized+(speech?!!s.voice:0),0);
 return {id:j.id,kind:'storyboard',source:'storyboard',title:j.input.title,status:j.status,createdAt:j.createdAt,updatedAt:j.updatedAt,sceneCount:j.scenes.length,completedScenes:j.scenes.filter(s=>s.clip).length,
  script:j.input.script,options:Object.fromEntries(['model','style','imageModel','videoModel','duration','clipDuration','ratio','resolution','look','voice','language','narrationMode','narrationEngine','narrVolume','origVolume','consistency','chained','modelscope','narrationUrl'].filter(k=>j.input[k]!==undefined).map(k=>[k,j.input[k]])),percent:j.status==='completed'?100:Math.min(99,Math.floor(done/steps*100)),message:j.error||j.message,error:j.error,phase:j.inflight?.kind||j.phase||'queued',board:B,scenes:j.scenes.map((s,i)=>({scene:B.frames[i]?.frame||i+1,imageUrl:s.image,clip_url:s.clip,chain_image_url:s.chain,status:s.stage})),result:j.result,logs:j.logs,background:true};
}
module.exports={validate,initialize,next,label,execute,apply,publicJob};
