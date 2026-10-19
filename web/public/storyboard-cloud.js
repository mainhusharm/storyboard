// This client only observes durable jobs. Queue workers own all generation steps.
(()=>{
 async function request(path,options={}){const r=await fetch('/api/studio-jobs'+path,{cache:'no-store',...options,headers:{'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(25000)});const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error||'Cloud job request failed ('+r.status+').'),{statusCode:r.status});return j;}
 const active=j=>j&&['queued','running'].includes(j.status);
 async function submit(body,requestKey){return (await request('',{method:'POST',body:JSON.stringify({...body,kind:'storyboard',source:'storyboard',requestKey})})).job;}
 async function list(){return (await request('?source=storyboard')).jobs;}
 async function get(id){return (await request('/'+encodeURIComponent(id))).job;}
 async function cancel(id){return (await request('/'+encodeURIComponent(id),{method:'DELETE'})).job;}
 function watch(id,onJob,onError=()=>{}){let stopped=false,timer;const tick=async()=>{let again=true;try{const j=await get(id);if(stopped)return;onJob(j);again=active(j);}catch(e){if(!stopped)onError(e);}if(!stopped&&again)timer=setTimeout(tick,5000);};tick();return ()=>{stopped=true;clearTimeout(timer);};}
 window.SBStoryCloud={submit,list,get,cancel,watch,active};
})();
