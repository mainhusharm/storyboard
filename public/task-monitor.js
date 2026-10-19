// Reports browser-driven Storyboard runs to the account's task page.
// This observes progress; it never submits provider generation requests.
(()=>{
 const queue=document.currentScript?.dataset.mode==='queue';const tracked=new Map();let single=null,sending=false,lastSent=0;
 const active=s=>['queued','running','cancelling'].includes(s);
 const status=s=>({done:'completed',complete:'completed',stalled:'interrupted'}[s]||(['failed','cancelled','interrupted'].includes(s)?s:'completed'));
 const uid=()=>'browser_'+crypto.randomUUID();
 function milestone(phase,frames,characters){
  const p=String(phase||'').toLowerCase(),f=frames||[],c=characters||[],n=Math.max(1,f.length);
  if(/combin/.test(p))return 95;
  if(/video/.test(p))return 50+Math.floor(40*f.filter(f=>f.clip_url||f.hasVideo).length/n);
  if(/narr/.test(p))return 45;
  if(/image/.test(p))return 20+Math.floor(25*f.filter(f=>!f.image_error&&(f.generated_image_url||f.hasImage)).length/n);
  if(/ref/.test(p))return 5+Math.floor(15*c.filter(c=>c.reference_image_url&&!c.reference_error).length/Math.max(1,c.length));
  return /storyboard/.test(p)?2:null;
 }
 function collect(){
  const out=[];
  if(queue){
   if(typeof RUNS==='undefined')return out;
   for(const r of RUNS)if(active(r.status)&&!tracked.has(r.id))tracked.set(r.id,{id:uid(),run:r});
   for(const [key,e] of tracked){const r=e.run;
    out.push({id:e.id,title:r.title||'Storyboard film',queue:true,status:active(r.status)?r.status:status(r.status),percent:r.status==='done'?100:progressOf(r),message:r.log?.at(-1)?.m||r.phase||'Queued',progressLabel:r.phase||r.status});
    e.cancel=()=>{if(!r.cancelled){window.cancelRun(r.id);if(!r.running)setStatus(r,'cancelled');}};
   }
  }else{
   const busy=(typeof LOCAL_BUSY!=='undefined'&&LOCAL_BUSY)||(typeof SUBMITTING!=='undefined'&&SUBMITTING);
   if(busy&&!single){single={id:uid(),title:(document.getElementById('script')?.value||'Storyboard generation').replace(/^[#\s]+/,'').replace(/\s+/g,' ').slice(0,120)};tracked.set('single',single);}
   if(single){
    const phase=typeof LOCAL_PHASE==='string'&&LOCAL_PHASE?LOCAL_PHASE:document.getElementById('phasetxt')?.textContent||'Storyboard';
    const end=typeof LOCAL_RESULT==='string'?LOCAL_RESULT:'';
    const s=busy?(typeof USER_CANCELLED!=='undefined'&&USER_CANCELLED?'cancelling':'running'):status(end);
    out.push({id:single.id,title:single.title,status:s,percent:s==='completed'?100:milestone(phase,typeof FRAMES!=='undefined'?FRAMES:[],typeof CHARS!=='undefined'?CHARS:[]),message:typeof LOCAL_LOG!=='undefined'?LOCAL_LOG.at(-1)?.m||phase:phase,progressLabel:phase});
    single.cancel=()=>{USER_CANCELLED=true;LOCAL_RESULT='cancelled';try{PHASE_ABORT?.abort('task-page-cancel');}catch{}logLocal('Cancel requested from Running tasks. Already-submitted provider work may finish.','err');};
   }
  }
  return out;
 }
 async function tick(){
  if(sending||Date.now()-lastSent<4000)return;
  const tasks=collect();if(!tasks.length)return;sending=true;lastSent=Date.now();
  try{
   const r=await fetch('/api/tasks/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tasks:tasks.slice(0,30)}),signal:AbortSignal.timeout(15000)});
   if(!r.ok)return;const result=await r.json();
   for(const [key,e] of tracked){
    const snapshot=tasks.find(t=>t.id===e.id);
    if(result.cancelIds?.includes(e.id)&&snapshot&&active(snapshot.status))e.cancel?.();
    if(snapshot&&!active(snapshot.status)){tracked.delete(key);if(single===e)single=null;}
   }
  }catch{}finally{sending=false;}
 }
 setInterval(tick,1000);window.addEventListener('online',()=>{lastSent=0;tick();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden){lastSent=0;tick();}});
 tick();
})();
