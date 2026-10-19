(() => {
  'use strict';
  const model = document.getElementById('imageModel') || document.getElementById('i2iModel');
  const ratio = document.getElementById('ratio');
  if (!model || !ratio) return;
  const presets = { '16:9':[1344,768], '9:16':[768,1344], '1:1':[1024,1024], '4:3':[1184,864], '3:4':[864,1184] };
  // Match the preset labels and ordering in the ModelScope Qwen studio.
  const resolutionOptions = [{ value:'custom', label:'Custom' }];
  for (const [level, aspects] of [['2k',['16:9','9:16','1:1','4:3','3:4']],['1k',['16:9','9:16','4:3','3:4','1:1']]]) {
    for (const aspect of aspects) {
      const scale=level==='2k'?2:1, [width,height]=presets[aspect].map(n=>n*scale);
      resolutionOptions.push({value:level+'|'+aspect,label:level.toUpperCase()+' - '+width+'x'+height+' ('+aspect+')'});
    }
  }
  const box = document.createElement('fieldset');
  box.id = 'modelscopeOptions'; box.hidden = true;
  box.style.cssText = 'border:1px solid var(--line2,var(--line));border-radius:10px;padding:12px;margin:12px 0;color:var(--dim);font-size:12px';
  box.innerHTML = '<legend>Qwen Image 2.1 · ModelScope</legend>'
    + '<label style="display:block;margin:8px 0">Preset resolution <select id="qwenResolution">' + resolutionOptions.map(option=>'<option value="'+option.value+'">'+option.label+'</option>').join('') + '</select></label>'
    + '<div style="display:flex;gap:8px"><label>Width <input id="qwenWidth" type="number" min="256" max="2688" step="8" value="1344" style="width:100%"></label><label>Height <input id="qwenHeight" type="number" min="256" max="2688" step="8" value="768" style="width:100%"></label></div>'
    + '<p id="qwenSizeHint" style="margin:8px 0"></p>'
    + '<label style="display:block;margin:8px 0">Seed <input id="qwenSeed" type="number" min="0" max="2147483647" step="1" value="0" style="width:100%"></label>'
    + '<label style="display:flex;align-items:center;gap:8px;margin:8px 0"><input id="qwenRandom" type="checkbox" checked style="width:auto"> Randomize seed for each image</label>'
    + '<label style="display:flex;align-items:center;gap:8px;margin:8px 0"><input id="qwenEnhance" type="checkbox" checked style="width:auto"> Enhance prompt</label>'
    + '<label style="display:block;margin:8px 0">Negative prompt <textarea id="qwenNegative" maxlength="4000" rows="2" placeholder="Things to avoid in the generated image" style="width:100%;min-height:60px"></textarea></label>'
    + '<p style="margin:8px 0">Supports text-to-image and up to 10 references. Choose a resolution preset to set its aspect ratio. Custom dimensions override it for images. Dimensions must be multiples of 8, from 256 to 2688.</p>';
  const field = model.closest('.field');
  if (field) field.after(box); else model.after(box);
  const get = id => document.getElementById(id);
  function values() {
    if (model.value !== 'modelscope:qwen-image-2.1') return undefined;
    return { resolution:get('qwenResolution').value.split('|')[0], preset:get('qwenResolution').value, width:Number(get('qwenWidth').value), height:Number(get('qwenHeight').value), seed:Number(get('qwenSeed').value), randomizeSeed:get('qwenRandom').checked, enhancePrompt:get('qwenEnhance').checked, negativePrompt:get('qwenNegative').value };
  }
  function update() {
    box.hidden = model.value !== 'modelscope:qwen-image-2.1';
    const custom=get('qwenResolution').value==='custom';
    get('qwenWidth').disabled=!custom; get('qwenHeight').disabled=!custom;
    if(!custom) { const [level,aspect]=get('qwenResolution').value.split('|'); const dims=presets[aspect]||presets['16:9']; const scale=level==='2k'?2:1; get('qwenWidth').value=dims[0]*scale; get('qwenHeight').value=dims[1]*scale; }
    get('qwenSeed').disabled=get('qwenRandom').checked;
    get('qwenSizeHint').textContent = custom ? 'Custom image size; your movie keeps its selected aspect ratio.' : get('qwenWidth').value+' × '+get('qwenHeight').value+' · '+get('qwenResolution').value.split('|')[1];
    const data=values(); if(data)try{localStorage.setItem('sb_modelscope_options',JSON.stringify(data));}catch{}
  }
  get('qwenResolution').value='2k|'+(presets[ratio.value]?ratio.value:'16:9');
  try {
    const saved=JSON.parse(localStorage.getItem('sb_modelscope_options')||'null');
    if(saved) { const restored = saved.preset || (saved.resolution==='custom'?'custom':(['1k','2k'].includes(saved.resolution)?saved.resolution:'2k')+'|'+(presets[ratio.value]?ratio.value:'16:9')); if(resolutionOptions.some(option=>option.value===restored))get('qwenResolution').value=restored; for(const [key,id] of [['width','qwenWidth'],['height','qwenHeight'],['seed','qwenSeed'],['negativePrompt','qwenNegative']])if(saved[key]!==undefined)get(id).value=saved[key];get('qwenRandom').checked=saved.randomizeSeed!==false;get('qwenEnhance').checked=saved.enhancePrompt!==false; }
  }catch{}
  function applyPresetRatio() {
    const aspect=get('qwenResolution').value.split('|')[1];
    if(aspect && model.value==='modelscope:qwen-image-2.1' && ratio.value!==aspect) {
      ratio.value=aspect;ratio.dispatchEvent(new Event('change',{bubbles:true}));
    }
    update();
  }
  box.addEventListener('input',update);
  get('qwenResolution').addEventListener('change',applyPresetRatio);
  model.addEventListener('change',applyPresetRatio);
  ratio.addEventListener('change',()=>{
    if(get('qwenResolution').value!=='custom')get('qwenResolution').value=get('qwenResolution').value.split('|')[0]+'|'+ratio.value;
    update();
  });
  // Storyboard fills its model dropdown after /api/models returns.
  new MutationObserver(update).observe(model,{childList:true});
  window.SBModelscope={values,payload:()=>{const data=values();return data?{modelscope:data}:{};}};
  update();
})();
