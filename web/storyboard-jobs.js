'use strict';
// A Storyboard film advances one checkpoint per private queue delivery.
const copy=v=>JSON.parse(JSON.stringify(v));
const giz=require('./giz');
const bad=m=>Object.assign(Error(m),{statusCode:400});
const text=(v,n)=>String(v||'').slice(0,n);
const url=v=>{const s=text(v,5000);if(s&&!/^https:\/\//i.test(s))throw bad('Saved cloud assets need public HTTPS URLs.');return s;};
const styles=['cinematic','animatic','anime','realistic','fantasy','scifi','noir','horror','pixar','ghibli','cyberpunk','vintage','watercolor','comic','oilpainting','minimalist'];
function validate(body){
 const frames=(Array.isArray(body.framesData)?body.framesData:[]).map((f,i)=>({...copy(f),frame:Number(f.frame)||i+1,duration_sec:Math.max(1,Math.min(30,Number(f.duration_sec)||Number(body.clipDuration)||6)),generated_image_url:url(f.generated_image_url),clip_url:url(body.clipUrls?.[f.frame]||f.clip_url),chain_image_url:url(f.chain_image_url)}));
 if(frames.some(f=>!Number.isInteger(f.frame)||f.frame<1))throw bad('Frame numbers must be positive integers.');
 if(frames.length>100||new Set(frames.map(f=>f.frame)).size!==frames.length)throw bad('Supply up to 100 uniquely numbered frames.');
 const characters=(Array.isArray(body.characters)?copy(body.characters):[]);if(characters.length>40)throw bad('Too many characters.');
 for(const c of characters){if(!/^[\p{L}\p{N} _-]{1,100}$/u.test(String(c.id||'')))throw bad('Invalid character ID.');c.reference_image_url=url(c.reference_image_url);delete c.gizTask;}
 const script=text(body.script,60000);if(!frames.length&&script.trim().length<10)throw bad('Paste a story script first.');
 if(body.style&&!styles.includes(body.style))throw bad('Select a supported visual style.');
  const videoModel=text(body.videoModel,100)||'omni-flash';if(!['grok-video','veo-3.1','omni-flash','wan3.0-video-prime','wan3.0-video-standard','wan3.0-video','wan2.7-t2v','wan2.1-t2v-turbo','wan2.1-t2v-plus','wan2.7-i2v','wan2.1-i2v-turbo','wan2.1-i2v-plus'].includes(videoModel)&&giz.meta(videoModel)?.kind!=='video')throw bad('Unsupported video model.');
  if(body.musicModel&&giz.meta(body.musicModel)?.kind!=='music')throw bad('Unsupported music model.');
  if(String(body.imageModel||'').startsWith('giz:')&&giz.meta(body.imageModel)?.kind!=='image')throw bad('Unsupported Giz image model.');
  if(String(body.narrationEngine||'').startsWith('giz:')&&giz.meta(body.narrationEngine)?.kind!=='speech')throw bad('Unsupported Giz narration model.');
  const gizOptions=giz.options(body.giz||{});if(body.musicModel&&!body.musicUrl)giz.shape(body.musicModel,{},gizOptions[body.musicModel]);
  const mode=['combine','references','images','narration','videos'].includes(body.mode)?body.mode:'full';if(mode==='combine'&&(!frames.length||frames.some(f=>!f.clip_url)))throw bad('Finish rendering every scene first. Combine needs all saved clip URLs.');
  if(!['full','combine'].includes(mode)&&!frames.length)throw bad('Generate a storyboard before running an individual phase.');
  const targets=Array.isArray(body.frames)?body.frames.map(Number):frames.map(f=>f.frame);
  const onlyCharacters=Array.isArray(body.onlyCharacters)?body.onlyCharacters.map(String):characters.map(c=>c.id);
  if(mode==='references')for(const c of characters)if(onlyCharacters.includes(c.id)){c.reference_image_url='';delete c.gizTask;}
  if(mode==='images')for(const f of frames)if(targets.includes(f.frame)){f.generated_image_url='';f.clip_url='';}
  if(mode==='videos')for(const f of frames)if(targets.includes(f.frame))f.clip_url='';
  const voiceUrls={};for(const f of frames)if(body.voiceUrls?.[f.frame])voiceUrls[f.frame]=url(body.voiceUrls[f.frame]);
 return {kind:'storyboard',source:'storyboard',mode,script,model:text(body.model||body.chatModel,100)||'gemini-2.5-pro',title:text(body.title||script.split('\n').find(s=>s.trim()),160).replace(/^#+\s*/,'' )||'Storyboard film',
  style:body.style||'cinematic',videoModel,imageModel:text(body.imageModel,100)||'nano-banana-pro',duration:Math.max(10,Math.min(600,Number(body.duration)||120)),clipDuration:Math.max(1,Math.min(30,Number(body.clipDuration)||6)),
  ratio:['16:9','9:16','1:1','4:3','3:4'].includes(body.ratio)?body.ratio:'16:9',resolution:body.resolution==='1080P'?'1080P':'720P',look:text(body.look,6000),voice:text(body.voice,100)||'female',language:text(body.language,20)||'en',
  narrationMode:body.narrationMode==='prompt'?'prompt':'tts',narrationEngine:text(body.narrationEngine,40)||'fish',narrVolume:body.narrVolume,origVolume:body.origVolume,narrationUrl:body.narrationMode==='prompt'?'':url(body.narrationUrl),consistency:body.consistency!==false,chained:body.chainContinuity!==false,
   targets,onlyCharacters,voiceUrls,giz:gizOptions,musicModel:body.musicModel||'',musicUrl:url(body.musicUrl),musicVolume:Math.max(0,Math.min(1,Number(body.musicVolume??0.15))),modelscope:body.modelscope&&typeof body.modelscope==='object'?copy(body.modelscope):undefined,characters,framesData:frames,scenes:frames.map(f=>({imageUrl:f.generated_image_url}))};
}
function initialize(j){j.board={characters:j.input.characters,frames:j.input.framesData};if(giz.meta(j.input.imageModel)&&j.input.mode==='full')for(const c of j.board.characters)if(c.reference_style!==j.input.style)c.reference_image_url='';j.scenes=j.board.frames.map(f=>({image:f.generated_image_url,clip:f.clip_url,chain:f.chain_image_url,voice:j.input.mode==='narration'?'':j.input.voiceUrls?.[f.frame],stage:f.clip_url?'video-ready':'queued'}));}
function next(j){
 const I=j.input,B=j.board;if(!B.frames.length)return {kind:'board',key:'board'};
  if(['full','references'].includes(I.mode)&&(I.consistency||I.mode==='references')){const i=B.characters.findIndex(c=>!c.reference_image_url&&(I.mode!=='references'||I.onlyCharacters.includes(c.id)));if(i>=0)return {kind:B.characters[i].gizTask?'reference-poll':'reference',i,key:'reference:'+i};}
  if(I.mode==='references')return {kind:'phase-complete',key:'phase-complete'};
  if(['full','images'].includes(I.mode)){const i=j.scenes.findIndex((s,i)=>!s.image&&!s.clip&&(I.mode!=='images'||I.targets.includes(B.frames[i].frame)));if(i>=0)return {kind:j.scenes[i].imageTask?'frame-image-poll':'frame-image',i,key:'frame-image:'+i};}
  if(I.mode==='images')return {kind:'phase-complete',key:'phase-complete'};
  if(['full','combine','narration'].includes(I.mode)&&I.narrationMode==='tts'&&!I.narrationUrl){const i=j.scenes.findIndex((s,i)=>!s.voice&&(B.frames[i].narration||B.frames[i].dialogue));if(i>=0)return {kind:j.scenes[i].voiceTask?'narrate-poll':'narrate',i,key:'narrate:'+i};}
  if(I.mode==='narration')return {kind:'phase-complete',key:'phase-complete'};
  const i=j.scenes.findIndex((s,i)=>!s.clip&&(I.mode!=='videos'||I.targets.includes(B.frames[i].frame)));if(i>=0)return {kind:j.scenes[i].task?'video-poll':'video',i,key:'video:'+i};
  if(I.mode==='videos')return {kind:'phase-complete',key:'phase-complete'};
  const n=j.scenes.findIndex(s=>!s.normalized);if(n>=0)return {kind:'normalize',i:n,key:'normalize:'+n};
  if(I.musicModel&&!j.music&&!I.musicUrl)return {kind:j.musicTask?'music-poll':'music',key:'music'};
  return {kind:'combine',key:'combine'};
}
function label(j,op){const names={board:'Planning storyboard',reference:'Character reference','reference-poll':'Character reference rendering', 'frame-image':'Scene image','frame-image-poll':'Scene image rendering',narrate:'Scene narration','narrate-poll':'Scene narration rendering',music:'Submitting soundtrack','music-poll':'Soundtrack rendering',video:'Submitting scene video','video-poll':'Scene video rendering',normalize:'Preparing scene for final cut',combine:'Joining prepared scenes and saving final film'};return names[op.kind]+(op.i===undefined?'':' '+(op.i+1)+'/'+(op.kind.startsWith('reference')?j.board.characters.length:j.scenes.length))+'…';}
async function execute(j,op,run){
  if(op.kind==='phase-complete')return {ok:true};
  const I=j.input,B=j.board,f=B.frames[op.i],s=j.scenes[op.i],common={...I,characters:B.characters,framesData:f?[f]:B.frames};
  if(op.kind.startsWith('reference')&&giz.meta(I.imageModel)?.kind==='image')return run(j,'/api/giz/media',{...common,model:I.imageModel,pollTask:B.characters[op.i].gizTask||'',params:{prompt:B.characters[op.i].reference_prompt||B.characters[op.i].description,ratio:'1:1'},referencePortrait:true,applyVisualStyle:true});
  if(op.kind.startsWith('frame-image')&&giz.meta(I.imageModel)?.kind==='image')return run(j,'/api/giz/media',{...common,model:I.imageModel,pollTask:s.imageTask||'',params:{prompt:f.image_prompt,ratio:I.ratio,references:I.consistency?B.characters.filter(c=>(f.characters_present||[]).includes(c.id)&&c.reference_style===I.style).map(c=>c.reference_image_url).filter(Boolean):[]},applyVisualStyle:true});
  if(op.kind.startsWith('narrate')&&giz.meta(I.narrationEngine)?.kind==='speech')return run(j,'/api/giz/media',{...common,model:I.narrationEngine,pollTask:s.voiceTask||'',params:{text:[f.narration,f.dialogue].filter(Boolean).join('\n'),voice:I.voice,language:I.language}});
  if(op.kind==='music'||op.kind==='music-poll')return run(j,'/api/giz/media',{...common,model:I.musicModel,pollTask:j.musicTask||''});
 if(op.kind==='board')return run(j,'/api/storyboard',I);
 if(op.kind==='reference')return run(j,'/api/char-refs',{...common,force:[B.characters[op.i].id]});
 if(op.kind==='frame-image')return run(j,'/api/images',{...common,frames:[f.frame]});
 if(op.kind==='narrate')return run(j,'/api/narration',common);
 if(op.kind==='video'||op.kind==='video-poll')return run(j,'/api/flashloop/generate-video',{...common,model:I.videoModel,scene:f.frame,duration:f.duration_sec,prompt:f.animation_prompt||f.summary||f.image_prompt,imageUrl:s.image,chainAnchor:I.chained&&op.i>0?j.scenes[op.i-1].chain:'',pollTask:s.task||'',narration:f.narration,dialogue:f.dialogue});
 if(op.kind==='normalize')return run(j,'/api/flashloop/combine',{...common,model:I.videoModel,scenes:[f.frame],clipUrls:[s.clip],normalizeOnly:true,targetDuration:f.duration_sec,narrationUrl:s.voice||'',narrVolume:I.narrVolume,origVolume:I.origVolume});
  return run(j,'/api/flashloop/combine',{...common,model:I.videoModel,scenes:B.frames.map(f=>f.frame),clipUrls:j.scenes.map(s=>s.normalized),preNormalized:true,narrationUrl:I.narrationUrl,musicUrl:j.music||I.musicUrl});
}
function apply(j,op,r){
  if(op.kind==='phase-complete'){j.status='completed';j.result={phase:j.input.mode,voiceUrls:Object.fromEntries(j.scenes.map((s,i)=>[j.board.frames[i].frame,s.voice]).filter(([,v])=>v))};return;}
 const s=j.scenes[op.i],f=j.board.frames[op.i];
  if(r.ok===false||r.error)throw Error(r.error||'Storyboard step failed.');
  if(op.kind.startsWith('reference')&&giz.meta(j.input.imageModel)?.kind==='image'){
    const c=j.board.characters[op.i];if(r.pending){c.gizTask=r.task;return;}if(!r.imageUrl)throw Error('Giz reference has no media URL.');c.reference_image_url=r.imageUrl;c.reference_style=j.input.style;delete c.gizTask;return;
  }
  if(op.kind.startsWith('frame-image')&&giz.meta(j.input.imageModel)?.kind==='image'){
    if(r.pending){s.imageTask=r.task;return;}if(!r.imageUrl)throw Error('Giz image has no media URL.');s.image=r.imageUrl;s.imageTask='';s.stage='image-ready';f.generated_image_url=s.image;f.generated_image_urls=r.urls;return;
  }
  if(op.kind.startsWith('narrate')&&giz.meta(j.input.narrationEngine)?.kind==='speech'){
    if(r.pending){s.voiceTask=r.task;return;}if(!r.audioUrl)throw Error('Giz narration has no media URL.');s.voice=r.audioUrl;s.voiceTask='';s.voiceOutput=r.output;return;
  }
  if(op.kind==='music'||op.kind==='music-poll'){if(r.pending){j.musicTask=r.task;return;}if(!r.audioUrl)throw Error('Giz soundtrack has no media URL.');j.music=r.audioUrl;j.musicTask='';return;}
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
   script:j.input.script,options:Object.fromEntries(['model','style','imageModel','videoModel','duration','clipDuration','ratio','resolution','look','voice','language','narrationMode','narrationEngine','narrVolume','origVolume','consistency','chained','modelscope','giz','musicModel','musicVolume','musicUrl','narrationUrl'].filter(k=>j.input[k]!==undefined).map(k=>[k,j.input[k]])),percent:j.status==='completed'?100:Math.min(99,Math.floor(done/steps*100)),message:j.error||j.message,error:j.error,phase:j.inflight?.kind||j.phase||'queued',board:B,scenes:j.scenes.map((s,i)=>({scene:B.frames[i]?.frame||i+1,imageUrl:s.image,clip_url:s.clip,chain_image_url:s.chain,status:s.stage})),result:j.result,logs:j.logs,background:true};
}
module.exports={validate,initialize,next,label,execute,apply,publicJob};
