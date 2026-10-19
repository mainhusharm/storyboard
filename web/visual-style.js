// Apply the selected rendering medium after every prompt rewrite, before capping.
function lockVisualStyle(prompt,key,styles){
 const style=styles[key]||styles.cinematic;key=styles[key]?key:'cinematic';let p=String(prompt||'');
 // Remove prior application and other presets without touching character identity.
 p=p.replace(/\[VISUAL STYLE:[^\]]*\]/gi,'');
 for(const [name,s] of Object.entries(styles)){
  for(const phrase of [s.prefix,s.suffix]){const value=phrase.replace(/^[,\s]+|[,\s]+$/g,'');if(value)p=p.split(value).join('');}
 }
 const realism=/\b(?:realistic|photo[- ]?realistic|hyper[- ]?realistic|photoreal|ultra[- ]realistic|live[- ]action|documentary photography|(?:RAW|studio|professional|smartphone) photo(?:graphy)?|realistic (?:skin|human|rendering|visuals?|textures?)|skin pores|85mm portrait lens)\b/gi;
 const anime=/\b(?:anime(?: key visual| aesthetic| style)?|manga(?: aesthetic| style)?|sakuga(?: quality)?|cel[- ]shad(?:ed|ing)|Studio Ghibli(?: style)?|Pixar(?: style)?|3D (?:animated|animation|render(?:ing)?))\b/gi;
 const painting=/\b(?:watercolor(?: painting| background)?|oil painting|impasto|comic book art|halftone dots)\b/gi;
 if(!['cinematic','realistic','vintage','minimalist'].includes(key))p=p.replace(realism,'');
 if(!['anime','ghibli','pixar'].includes(key))p=p.replace(anime,'');
 if(!['watercolor','oilpainting','comic','fantasy'].includes(key))p=p.replace(painting,'');
 if(key!=='animatic')p=p.replace(/\b(?:animatic|rough graphite linework|pencil (?:storyboard|drawing|sketch)|grayscale sketch panels|limited-motion storyboard drawing)\b/gi,'');
 if(['cinematic','realistic','vintage','minimalist'].includes(key))p=p.replace(/\b(?:hand[- ]drawn|clean lineart|paper texture|cartoon style|bold ink outlines|cel animation)\b/gi,'');
 if(key==='animatic')p=p.replace(/\b(?:cinematic film still|ultra detailed skin texture|professional studio lighting|photography|photorealistic|realistic|rendered|8K HDR)\b/gi,'');
 if(['anime','ghibli'].includes(key))p=p.replace(/\b(?:Pixar(?: style)?|3D animated|3D render)\b/gi,'');
 if(key==='pixar')p=p.replace(/\b(?:anime|manga|cel-shaded|sakuga|2D|watercolor)\b/gi,'');
 const lock='[VISUAL STYLE: '+style.label+' ONLY. '+style.prefix.trim().replace(/,$/,'')+'. Keep this rendering medium throughout; preserve character identity and scene action.]';
 p=p.replace(/\s{2,}/g,' ').replace(/(?:,\s*){2,}/g,', ').replace(/^[,\s—]+|[,\s—]+$/g,'');
 return lock+' '+p+' '+style.suffix.replace(/^,\s*/,'')+'. [VISUAL STYLE: '+style.label+' ONLY]';
}
module.exports={lockVisualStyle};
