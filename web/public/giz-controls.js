(() => {
  'use strict';
  const get=id=>document.getElementById(id);
  let models=[],saved={},selection={};
  try{saved=JSON.parse(localStorage.getItem('sb_giz_options')||'{}');selection=JSON.parse(localStorage.getItem('sb_giz_selections')||'{}');}catch{}
  const boxes=new Map();
  function persist(){try{localStorage.setItem('sb_giz_options',JSON.stringify(saved));localStorage.setItem('sb_giz_selections',JSON.stringify(selection));}catch{}}
  const entries=[['imageModel','image'],['i2iModel','image'],['videoModel','video'],['mvModel','video']];
  function values(){
    const out={};for(const [id]of entries){const model=get(id)?.value;if(model?.startsWith('giz:'))out[model]={...(saved[model]||{})};}
    return out;
  }
  // Storyboard/Flashloop job options store these fields under different keys.
  const optionKey={i2iModel:'imageModel',mvModel:'model',gizSpeechEngine:'narrationEngine'};
  function payload(){
    const out={giz:values()};
    const music=get('musicModel')?.value||'';
    if(music.startsWith('giz:')){out.musicModel=music;const volume=Number(get('musicVolume')?.value);out.musicVolume=Number.isFinite(volume)?Math.max(0,Math.min(1,volume)):0.15;}
    const engine=get('narrationEngine')?.value||get('gizSpeechEngine')?.value||'';
    if(engine.startsWith('giz:'))out.narrationEngine=engine;
    return out;
  }
  function restore(options){
    saved={...(options.giz||{})};
    for(const id of [...new Set([...entries.map(([id])=>id),'musicModel','gizSpeechEngine'])]){
      const model=options[optionKey[id]||id];
      if(model)selection[id]=model;
      const el=get(id);if(!el)continue;
      if(model&&Array.from(el.options||[]).some(o=>o.value===String(model)))el.value=model;
      render(el);
    }
    if(options.musicVolume!==undefined){selection.musicVolume=options.musicVolume;const gain=get('musicVolume');if(gain)gain.value=options.musicVolume;}
    persist();
  }
  window.SBGiz={values,payload,restore,active:()=>Object.keys(values()).length>0||!!get('musicModel')?.value||!!get('gizSpeechEngine')?.value};
  function render(el){
    let box=boxes.get(el.id);if(!box){box=document.createElement('details');box.style.cssText='border:1px solid var(--line2,var(--line,#444));border-radius:10px;padding:12px;margin:12px 0;font-size:12px;max-width:100%;overflow-wrap:anywhere';(el.closest('.field')||el.closest('label')||el).after(box);boxes.set(el.id,box);}
    const m=models.find(m=>m.id===el.value);box.hidden=!m;box.replaceChildren();if(!m)return;
    const summary=document.createElement('summary');summary.textContent=m.label+' advanced parameters';box.append(summary);
    const hint=document.createElement('p');
    hint.textContent=m.kind==='music'?'Fill the required style, prompt and lyric fields; blank values use the provider default. Media fields accept public HTTPS URLs. The film uses the first result and keeps every returned variant.'
      :m.kind==='speech'?'Blank means the provider default. Enter the exact words to speak in the text field when the story does not supply narration text; media fields accept public HTTPS URLs.'
      :'Blank means automatic or provider default. Media fields accept public HTTPS URLs; arrays use one URL per line. Film jobs use the first result and retain all returned variants. Story prompts, voice text and chained opening frames are supplied by the story; other values are kept exactly.';
    box.append(hint);
    for(const [key,s]of Object.entries(m.input.properties)){
      if(key==='prompt'&&m.kind!=='music')continue;
      const label=document.createElement('label');label.style.cssText='display:block;margin:10px 0';label.textContent=(s.title||key)+(m.input.required.includes(key)?' (required)':'');
      let input;
      const optionLabels={renderMode:{fast:'Fast (fast)',quality:'Two-stage quality (quality)'},decoder:{fast:'Fast (fast)',fidelity:'Higher fidelity (fidelity)'}};
      if(s.enum){input=document.createElement('select');input.append(new Option('Automatic / provider default','__auto__'));for(const value of s.enum)input.append(new Option(optionLabels[key]?.[value]||String(value),String(value)));}
      else if(s.type==='boolean'){input=document.createElement('select');for(const [v,l]of [['__auto__','Automatic / provider default'],['true','Enabled'],['false','Disabled']])input.append(new Option(l,v));}
      else if(s.type==='array'||['prompt','text','lyrics','tags','negative','negativePrompt','negative_prompt'].includes(key)){input=document.createElement('textarea');input.rows=3;}
      else {input=document.createElement('input');input.type=['integer','number'].includes(s.type)?'number':'text';if(input.type==='number'){input.step=s.multipleOf|| (s.type==='integer'?1:'any');if(input.type==='integer')input.inputMode='numeric';if(s.minimum!==undefined)input.min=s.minimum;if(s.maximum!==undefined)input.max=s.maximum;}}
      input.style.cssText='display:block;width:100%;min-width:0;box-sizing:border-box;margin-top:4px';input.dataset.gizField=key;
      input.title=s.description||key;input.placeholder=s.default===undefined?'Optional':String(s.default);
      if(s.maxLength)input.maxLength=s.maxLength;
      const v=saved[m.id]?.[key];if(v!==undefined)input.value=Array.isArray(v)?v.join('\n'):String(v);else if(input.tagName==='SELECT')input.value=(m.id==='giz:ltx2-5-distilled'&&(key==='renderMode'||key==='decoder')&&s.default)?String(s.default):'__auto__';
      // HeyGen accepts a cloned ID as well as named public voices.
      if(s.anyOf?.some(v=>v.const)){const list=document.createElement('datalist');list.id='giz_'+el.id+'_'+key;for(const v of s.anyOf.filter(v=>v.const))list.append(new Option(v.description||v.const,v.const));input.setAttribute('list',list.id);label.append(list);}
      input.addEventListener('input',()=>{const data=saved[m.id]||={};if(input.value===''||input.value==='__auto__')delete data[key];else data[key]=s.type==='array'?input.value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean):s.type==='boolean'?input.value==='true':['integer','number'].includes(s.type)?Number(input.value):input.value;persist();});
      label.append(input);const help=document.createElement('small');help.textContent=s.description||'';label.append(help);box.append(label);
    }
  }
  function addAudioSelectors(){
    if(get('musicModel'))return;
    const host=get('narrationEngine')||get('mvModel')||get('videoModel');if(!host)return;
    // Insert after the whole grid/flex cell group so a 3-column picker never gains a stray fourth item.
    let anchor=host.closest('.field')||host;
    const parent=anchor.parentElement;
    if(parent&&['grid','flex','inline-flex'].some(d=>getComputedStyle(parent).display.includes(d)))anchor=parent;
    const wrap=document.createElement('div');wrap.className='field';wrap.style.cssText='margin-top:12px;max-width:100%';
    if(!get('narrationEngine')){
      const speechLabel=document.createElement('label');speechLabel.textContent='Spoken narration (Giz; enter the exact words in its advanced parameters)';
      const speech=document.createElement('select');speech.id='gizSpeechEngine';speech.append(new Option('No separate spoken narration',''));
      for(const m of models.filter(m=>m.kind==='speech'))speech.append(new Option(m.label,m.id));
      speechLabel.append(speech);wrap.append(speechLabel);entries.push(['gizSpeechEngine','speech']);
    }
    const musicLabel=document.createElement('label');musicLabel.textContent='Optional soundtrack (separate from speech)';
    const music=document.createElement('select');music.id='musicModel';music.append(new Option('No generated soundtrack',''));
    for(const m of models.filter(m=>m.kind==='music'))music.append(new Option(m.label,m.id));
    musicLabel.append(music);
    const gain=document.createElement('input');gain.id='musicVolume';gain.type='number';gain.min='0';gain.max='1';gain.step='0.05';gain.value=selection.musicVolume??'0.15';
    gain.setAttribute('aria-label','Soundtrack volume from 0 to 1');gain.addEventListener('input',()=>{selection.musicVolume=gain.value;persist();});
    musicLabel.append(document.createTextNode(' Mix volume (0-1) '),gain);wrap.append(musicLabel);
    anchor.after(wrap);entries.push(['musicModel','music']);
  }
  fetch('/api/models').then(r=>r.json()).then(data=>{
    models=data.gizModels||[];
    addAudioSelectors();
    // The Storyboard narration dropdown hosts Giz speech models too — give them the same advanced controls.
    if(get('narrationEngine'))entries.push(['narrationEngine','speech']);
    for(const [id,kind]of entries){const el=get(id);if(!el)continue;let changedByUser=false;const update=()=>{for(const m of models.filter(m=>m.kind===kind))if(!Array.from(el.options).some(o=>o.value===m.id))el.append(new Option(m.label,m.id));if(!changedByUser&&selection[id]!==undefined&&Array.from(el.options).some(o=>o.value===selection[id]))el.value=selection[id];render(el);};
      el.addEventListener('change',()=>{changedByUser=true;selection[id]=el.value;persist();render(el);});new MutationObserver(update).observe(el,{childList:true});update();}
  }).catch(()=>{});
})();
