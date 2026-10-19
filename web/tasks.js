'use strict';
const fs=require('node:fs/promises');const path=require('node:path');
const ACTIVE=new Set(['queued','running','cancelling']);
const TERMINAL=new Set(['completed','failed','cancelled','interrupted']);
const error=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
function cloudTask(job){
 const n=job.sceneCount||1,done=job.completedScenes||0;let percent=null,label;
 if(job.kind==='storyboard'){percent=job.percent;label=job.message||'Waiting for cloud worker';}
 else if(job.kind==='film'){
  const normalized=job.scenes.filter(s=>s.status==='ready').length;
  percent=Math.floor((done*2+normalized)/(3*n+1)*100);label=done+'/'+n+' scenes rendered · '+normalized+'/'+n+' prepared';
 }else if(job.kind==='prompt'){
  const planned=done>0||/writing script|Script ready/i.test(job.message||'');percent=Math.floor((done+(planned?1:0))/(n+1)*100);label=done+'/'+n+' scenes written';
 }else label=job.status==='queued'?'Waiting to start':ACTIVE.has(job.status)?'Waiting for image provider':job.status==='completed'?'Image ready':'Image generation '+job.status;
 if(job.status==='completed')percent=100;else if(percent!==null)percent=Math.min(99,percent);
 return {id:'cloud_'+job.id,title:job.title,source:job.source,kind:job.kind==='storyboard'?'film':job.kind,status:job.status,percent,progressLabel:label,message:job.error||job.message,
  createdAt:job.createdAt,updatedAt:job.updatedAt,background:true,cancelable:ACTIVE.has(job.status),openUrl:job.source==='storyboard'?'/storyboard?job='+encodeURIComponent(job.id):'/flashloop-studio?source='+job.source,resultUrl:job.result?.url||'',logs:(job.logs||[]).slice(-5)};
}
function createTasks({root,isVercel,getDb,studioJobs,now=Date.now}){
 let schema,serial=Promise.resolve();const file=path.join(root,'task-activity','tasks.json');
 async function db(){const pool=await getDb();if(!pool&&isVercel)throw error('Task tracking needs the project DATABASE_URL.',503);if(pool){if(!schema)schema=pool.query('CREATE TABLE IF NOT EXISTS sb_task_activity (owner_id TEXT NOT NULL,id TEXT NOT NULL,updated_at BIGINT NOT NULL,data JSONB NOT NULL,PRIMARY KEY(owner_id,id))').catch(e=>{schema=null;throw e;});await schema;}return pool;}
 async function local(fn){const run=serial.then(async()=>{let rows=[];try{rows=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}const result=await fn(rows);await fs.mkdir(path.dirname(file),{recursive:true});const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(rows));await fs.rename(tmp,file);return JSON.parse(JSON.stringify(result));});serial=run.catch(()=>{});return run;}
 function browserTask(row){
  const task={...row};delete task.ownerId;
  if(ACTIVE.has(task.status)&&now()-task.updatedAt>90000){task.status='connection_lost';task.message=task.cancelRequested?'Cancel requested; waiting for the original page to reconnect.':'The Storyboard page has stopped reporting. Its provider request may still finish.';}
  task.cancelable=ACTIVE.has(task.status)||task.status==='connection_lost';task.background=false;task.openUrl=task.queue?'/generations':'/storyboard';return task;
 }
 async function heartbeat(user,tasks){
  if(!Array.isArray(tasks)||tasks.length>30)throw error('Supply up to 30 task updates.');
  const clean=tasks.map(t=>{
   if(!/^browser_[a-zA-Z0-9_-]{16,110}$/.test(t.id||''))throw error('Invalid task ID.');
   if(!ACTIVE.has(t.status)&&!TERMINAL.has(t.status))throw error('Invalid task status.');
   return {id:t.id,ownerId:user.id,title:String(t.title||'Storyboard generation').slice(0,160),source:'storyboard',kind:'film',queue:!!t.queue,status:t.status,
    percent:t.percent===null?null:Math.max(0,Math.min(t.status==='completed'?100:99,Math.floor(Number(t.percent)||0))),message:String(t.message||'').slice(0,350),progressLabel:String(t.progressLabel||'').slice(0,160),createdAt:now(),updatedAt:now()};
  });
  const pool=await db(),cancelIds=[];
  const merge=(old,t)=>{const value={...t,createdAt:old?.createdAt||t.createdAt,cancelRequested:old?.cancelRequested||false};if(value.cancelRequested&&ACTIVE.has(value.status))value.status='cancelling';if(value.cancelRequested)cancelIds.push(value.id);return value;};
  if(!pool)await local(rows=>{for(const t of clean){const i=rows.findIndex(r=>r.ownerId===user.id&&r.id===t.id);const value=merge(rows[i],t);if(i<0)rows.push(value);else rows[i]=value;}return true;});
  else for(const t of clean){
   // Atomic upsert keeps a cancellation requested concurrently with a heartbeat.
   const result=await pool.query("INSERT INTO sb_task_activity(owner_id,id,updated_at,data) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,id) DO UPDATE SET updated_at=EXCLUDED.updated_at,data=EXCLUDED.data || jsonb_build_object('createdAt',sb_task_activity.data->'createdAt','cancelRequested',COALESCE((sb_task_activity.data->>'cancelRequested')::boolean,false),'status',CASE WHEN COALESCE((sb_task_activity.data->>'cancelRequested')::boolean,false) AND EXCLUDED.data->>'status' IN ('queued','running','cancelling') THEN 'cancelling' ELSE EXCLUDED.data->>'status' END) RETURNING data",[user.id,t.id,t.updatedAt,t]);
   if(result.rows[0]?.data.cancelRequested)cancelIds.push(t.id);
  }
  return {ok:true,cancelIds};
 }
 async function list(user){
  const pool=await db();
  const rows=pool?(await pool.query('SELECT data FROM sb_task_activity WHERE owner_id=$1 AND updated_at>$2 ORDER BY updated_at DESC LIMIT 100',[user.id,now()-86400000])).rows.map(r=>r.data):await local(rows=>rows.filter(r=>r.ownerId===user.id&&r.updatedAt>now()-86400000));
  const clouds=await studioJobs.list(user);
  const tasks=[...clouds.map(cloudTask),...rows.map(browserTask)];
  return {ok:true,tasks:tasks.sort((a,b)=>Number(ACTIVE.has(b.status))-Number(ACTIVE.has(a.status))||b.createdAt-a.createdAt),serverTime:now()};
 }
 async function cancel(user,id){
  if(/^cloud_[a-f0-9-]{36}$/.test(id)){const j=await studioJobs.cancel(user,id.slice(6));return j?cloudTask(j):null;}
  if(!/^browser_[a-zA-Z0-9_-]{16,110}$/.test(id))return null;
  const pool=await db();let row;
  if(!pool)row=await local(rows=>{const t=rows.find(r=>r.ownerId===user.id&&r.id===id);if(!t)return null;if(ACTIVE.has(t.status)){t.cancelRequested=true;t.status='cancelling';}return t;});
  else {const result=await pool.query("UPDATE sb_task_activity SET data=CASE WHEN data->>'status' IN ('queued','running','cancelling') THEN data || '{\"cancelRequested\":true,\"status\":\"cancelling\"}'::jsonb ELSE data END WHERE owner_id=$1 AND id=$2 RETURNING data",[user.id,id]);row=result.rows[0]?.data;}
  return row?browserTask(row):null;
 }
 return {list,heartbeat,cancel};
}
module.exports={createTasks,cloudTask};
