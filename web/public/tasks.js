(()=>{
 const $=id=>document.getElementById(id);let tasks=[],filter='active',loading=false,timer;const pending=new Set();
 const active=t=>['queued','running','cancelling'].includes(t.status);
 const attention=t=>['failed','connection_lost','interrupted'].includes(t.status);
 const el=(tag,text,className)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;};
 function safeUrl(value){try{const u=new URL(value,location.origin);return u.protocol==='https:'||u.origin===location.origin?u.href:null;}catch{return null;}}
 function render(){
  $('activeCount').textContent=tasks.filter(active).length;$('doneCount').textContent=tasks.filter(t=>t.status==='completed').length;$('attentionCount').textContent=tasks.filter(attention).length;
  const source=$('source').value,query=$('search').value.toLowerCase();
  const visible=tasks.filter(t=>(!source||t.source===source)&&t.title.toLowerCase().includes(query)&&(filter==='all'||filter==='completed'&&t.status==='completed'||filter==='active'&&(active(t)||t.status==='connection_lost')));
  $('tasks').replaceChildren();$('empty').hidden=!!visible.length;
  if(!visible.length){$('empty').querySelector('h2').textContent=filter==='active'&&!source&&!query?'Nothing running right now':'No matching tasks';}
  for(const t of visible){
   const card=el('article',undefined,'card');card.dataset.id=t.id;const top=el('div',undefined,'top'),info=el('div'),badges=el('div',undefined,'badges');
   badges.append(el('span',t.source==='sjinn'?'SJinn':t.source==='flashloop'?'Flashloop':'Storyboard'),el('span',t.status.replaceAll('_',' '),'badge '+t.status),el('span',t.kind==='prompt'?'script':t.kind));
   info.append(badges,el('h2',t.title),el('p',t.message||'Waiting for the next update…','message'));
   const actions=el('div',undefined,'actions');const url=safeUrl(t.openUrl);if(url){const a=el('a','Open studio','open');a.href=url;a.target='_blank';a.rel='noopener';actions.append(a);}
   if(t.cancelable){const button=el('button',t.status==='cancelling'||t.cancelRequested?'Cancel requested':'Cancel','cancel');button.disabled=pending.has(t.id)||t.status==='cancelling'||t.cancelRequested;button.setAttribute('aria-label','Cancel '+t.title);button.onclick=()=>cancel(t,button);actions.append(button);}
   top.append(info,actions);card.append(top);
   const meter=el('div',undefined,'meter'),bar=el('progress');bar.max=100;bar.setAttribute('aria-label','Progress for '+t.title);if(t.percent!==null&&Number.isFinite(t.percent))bar.value=t.percent;else if(!active(t))bar.value=0;
   meter.append(bar,el('span',t.percent===null?(t.status==='queued'?'Queued':active(t)?'In progress':t.status.replaceAll('_',' ')):t.percent+'%'));card.append(meter);
   const detail=el('div',undefined,'detail');detail.append(el('span',t.progressLabel||'Progress updates as steps finish'),el('span',(t.background?'Cloud job':'Browser connection')+' · Updated '+new Date(t.updatedAt).toLocaleTimeString()));card.append(detail);$('tasks').append(card);
  }
 }
 async function load(){if(loading)return;loading=true;clearTimeout(timer);
  try{const r=await fetch('/api/tasks',{cache:'no-store',signal:AbortSignal.timeout(20000)});if(r.status===401){location.replace('/login?next=%2Ftasks');return;}const j=await r.json();if(!r.ok)throw Error(j.error||'Could not load tasks');tasks=j.tasks||[];render();$('error').hidden=true;$('sync').textContent='Live · refreshes every 5s';}
  catch(e){$('error').hidden=false;$('error').textContent='Could not refresh tasks. '+e.message;$('sync').textContent='Reconnecting…';}
  finally{loading=false;$('tasks').setAttribute('aria-busy','false');timer=setTimeout(load,5000);}
 }
 async function cancel(t,button){pending.add(t.id);button.disabled=true;button.textContent='Cancelling…';
  try{const r=await fetch('/api/tasks/'+encodeURIComponent(t.id),{method:'DELETE',signal:AbortSignal.timeout(20000)});const j=await r.json();if(!r.ok)throw Error(j.error||'Cancellation failed');tasks=tasks.map(task=>task.id===t.id?j.task:task);render();}
  catch(e){$('error').hidden=false;$('error').textContent=e.message;button.disabled=false;button.textContent='Cancel';}
  finally{pending.delete(t.id);}
 }
 document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));render();});
 $('source').onchange=render;$('search').oninput=render;$('refresh').onclick=load;window.addEventListener('online',load);document.addEventListener('visibilitychange',()=>{if(!document.hidden)load();});
 window.SBAuth?.me().then(j=>{if(j.user)$('account').textContent=j.user.name||j.user.email;}).catch(()=>{});load();
})();
