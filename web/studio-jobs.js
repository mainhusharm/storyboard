// Durable Flashloop/SJinn orchestration. Queue messages contain only a job ID.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const storyboardFlow=require('./storyboard-jobs');
const TTL = 7 * 86400000;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const copy = value => JSON.parse(JSON.stringify(value));

function createJobStore({ root, getDb, isVercel }) {
  let schema;
  let serial = Promise.resolve();
  const file = path.join(root, 'studio-jobs', 'jobs.json');
  async function db() {
    const pool = await getDb();
    if (!pool && isVercel) throw fail('Background generation needs the project Postgres DATABASE_URL. Temporary storage cannot keep cloud jobs.', 503);
    if (pool) {
      if (!schema) schema = pool.query('CREATE TABLE IF NOT EXISTS sb_studio_runs (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, request_key TEXT NOT NULL, updated_at BIGINT NOT NULL, data JSONB NOT NULL, UNIQUE(owner_id, request_key))').catch(e => { schema = null; throw e; });
      await schema;
    }
    return pool;
  }
  async function local(fn) {
    const run = serial.then(async () => {
      let rows = [];
      try { rows = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const result = await fn(rows);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = file + '.' + crypto.randomUUID() + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(rows));
      await fs.rename(tmp, file);
      return copy(result);
    });
    serial = run.catch(() => {});
    return run;
  }
  return {
    async create(job) {
      const pool = await db();
      const insert = rows => {
        const previous = rows.find(j => j.ownerId === job.ownerId && j.requestKey === job.requestKey);
        if (previous) return previous;
        if (rows.filter(j => j.ownerId === job.ownerId && !TERMINAL.has(j.status)).length >= 3) throw fail('You already have three active background generations. Cancel one or let it finish.', 409);
        rows.push(job); return job;
      };
      if (!pool) return local(rows => { for (let i = rows.length - 1; i >= 0; i--) if (TERMINAL.has(rows[i].status) && rows[i].updatedAt < Date.now() - TTL) rows.splice(i, 1); return insert(rows); });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['studio:' + job.ownerId]);
        await client.query("DELETE FROM sb_studio_runs WHERE owner_id=$1 AND updated_at<$2 AND data->>'status' IN ('completed','failed','cancelled')", [job.ownerId, Date.now() - TTL]);
        const found = await client.query('SELECT data FROM sb_studio_runs WHERE owner_id=$1', [job.ownerId]);
        const rows = found.rows.map(r => r.data);
        const value = insert(rows);
        if (value.id === job.id) await client.query('INSERT INTO sb_studio_runs(id,owner_id,request_key,updated_at,data) VALUES($1,$2,$3,$4,$5)', [job.id, job.ownerId, job.requestKey, job.updatedAt, job]);
        await client.query('COMMIT'); return value;
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    },
    async get(id, ownerId) {
      const pool = await db();
      if (!pool) return local(rows => rows.find(j => j.id===id && j.ownerId===ownerId) || null);
      const result = await pool.query('SELECT data FROM sb_studio_runs WHERE id=$1 AND owner_id=$2',[id,ownerId]);
      return result.rows[0]?.data || null;
    },
    async mutate(id, ownerId, fn) {
      const pool = await db();
      if (!pool) return local(async rows => { const job = rows.find(j => j.id === id && (!ownerId || j.ownerId === ownerId)); if (!job) return null; await fn(job); job.updatedAt = Date.now(); return job; });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await client.query('SELECT data FROM sb_studio_runs WHERE id=$1 FOR UPDATE', [id]);
        const job = result.rows[0]?.data;
        if (!job || (ownerId && job.ownerId !== ownerId)) { await client.query('COMMIT'); return null; }
        await fn(job); job.updatedAt = Date.now();
        await client.query('UPDATE sb_studio_runs SET data=$2,updated_at=$3 WHERE id=$1', [id, job, job.updatedAt]);
        await client.query('COMMIT'); return job;
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    },
    async list(ownerId, source) {
      const pool = await db();
      const rows = pool ? (await pool.query(`SELECT data FROM sb_studio_runs WHERE owner_id=$1 AND updated_at>$2 ORDER BY CASE WHEN data->>'status' IN ('queued','running') THEN 0 ELSE 1 END, updated_at DESC LIMIT 50`, [ownerId, Date.now() - TTL])).rows.map(r => r.data) : await local(rows => rows.filter(j => j.ownerId === ownerId && j.updatedAt > Date.now() - TTL));
      return rows.filter(j => !source || j.input.source === source).sort((a,b) => Number(!TERMINAL.has(b.status))-Number(!TERMINAL.has(a.status)) || b.createdAt - a.createdAt).slice(0, 20);
    },
    async active() {
      const pool = await db();
      return pool ? (await pool.query("SELECT data FROM sb_studio_runs WHERE data->>'status' NOT IN ('completed','failed','cancelled')")).rows.map(r => r.data) : local(rows => rows.filter(j => !TERMINAL.has(j.status)));
    }
  };
}
function validateInput(body) {
  if(body.kind==='storyboard')return storyboardFlow.validate(body);
  const kind = body.kind === 'prompt' ? 'prompt' : body.kind === 'image' ? 'image' : 'film';
  if (kind === 'prompt') {
    const text=(v,n)=>String(v||'').slice(0,n);
    if (!text(body.idea,30000).trim() && !text(body.name||body.slug,160).trim()) throw fail('Describe your scene or select a trend.');
    const duration=Number(body.duration)>0?Number(body.duration):15;
    const sceneLength=duration<=5?30:([5,8,10,15,30].includes(Number(body.sceneLength))?Number(body.sceneLength):8);
    const totalScenes=duration<=5?1:Math.max(2,Math.round((duration>=30?120:64)/sceneLength));
    return {kind,source:body.source==='sjinn'?'sjinn':'flashloop',title:text(body.title||body.name||body.idea,160)||'Studio script',
      name:text(body.name,160),slug:text(body.slug,200),idea:text(body.idea,30000),tagline:text(body.tagline,1000),trendThumbnail:text(body.trendThumbnail,3000),
      ratio:['9:16','16:9','1:1','4:3','3:4'].includes(body.ratio)?body.ratio:'9:16',model:text(body.model,100)||'logfare:auto',
      duration,sceneLength,totalScenes,references:(Array.isArray(body.references)?body.references:[]).slice(0,10).map(r=>({name:text(r.name,100),description:text(r.description,4000),imageUrl:text(r.imageUrl,3000)})),scenes:Array.from({length:totalScenes},()=>({}))};
  }
  if (!Array.isArray(body.scenes) || !body.scenes.length || body.scenes.length > 60) throw fail('Supply 1–60 scenes.');
  const text = (v, max) => String(v || '').slice(0, max);
  const media = v => { const s = text(v, 3000); if (s && !/^https:\/\//i.test(s)) throw fail('Background jobs need public HTTPS image/reference URLs. Re-upload local references.'); return s; };
  const scenes = body.scenes.map(s => ({ imagePrompt: text(s.imagePrompt, 24000), videoPrompt: text(s.videoPrompt, 24000), imageUrl: media(s.imageUrl) }));
  if (scenes.some(s => (kind==='film' && !s.videoPrompt.trim()) || (!s.imageUrl && !s.imagePrompt.trim()))) throw fail('Each scene needs a video prompt and an image or image prompt.');
  const model = text(body.model, 100);
  if (kind==='film' && !['omni-flash','wan3.0-video-prime','wan3.0-video','wan2.7-t2v','wan2.1-t2v-turbo','wan2.1-t2v-plus','wan2.7-i2v','wan2.1-i2v-turbo','wan2.1-i2v-plus'].includes(model)) throw fail('Unsupported video model.');
  let story;
  if(kind==='image'&&body.story){
    if(!Array.isArray(body.story.scenes)||!body.story.scenes.length||body.story.scenes.length>60)throw fail('Invalid parent story snapshot.');
    story={title:text(body.story.title,160),sceneLength:Math.max(1,Math.min(30,Number(body.story.sceneLength)||8)),scenes:body.story.scenes.map(s=>({title:text(s.title,160),imagePrompt:text(s.imagePrompt,24000),videoPrompt:text(s.videoPrompt,24000),imageUrl:media(s.imageUrl)}))};
  }
  return { story, kind, scenes, source: body.source === 'sjinn' ? 'sjinn' : 'flashloop', title: text(body.title,160) || 'Finished film', model,
    imageModel: text(body.imageModel,100) || 'seedream-5', ratio: ['9:16','16:9','1:1','4:3','3:4'].includes(body.ratio) ? body.ratio : '9:16',
    resolution: body.resolution === '1080P' ? '1080P' : '720P', duration: Math.max(1,Math.min(30,Number(body.duration)||8)), chained: body.chained !== false,
    refImageUrl: media(body.refImageUrl), referenceImages: (Array.isArray(body.referenceImages) ? body.referenceImages : []).slice(0,10).map(media),
    modelscope: body.modelscope && typeof body.modelscope === 'object' ? copy(body.modelscope) : undefined,
    trendName: text(body.trendName,160), tagline: text(body.tagline,1000), slug:text(body.slug,200), sceneIndex:Math.max(0,Number(body.sceneIndex)||0) };
}
function publicJob(j) {
  if(j.input.kind==='storyboard')return storyboardFlow.publicJob(j);
  return { id:j.id, kind:j.input.kind||'film', source:j.input.source, title:j.input.title, status:j.status, createdAt:j.createdAt, updatedAt:j.updatedAt,
    sceneCount:j.scenes.length, completedScenes:j.scenes.filter(s => j.input.kind==='prompt'?s.draft:j.input.kind==='image'?s.image:s.clip).length, message:j.message, error:j.error,
    scenes:j.scenes.map((s,i) => ({ scene:i+1, imageUrl:s.image, clip_url:s.clip, chain_image_url:s.chain, status:s.stage })),
    result:j.result, script:j.input.kind==='film'?{scenes:j.input.scenes,title:j.input.title,sceneLength:j.input.duration}:j.input.kind==='image'?j.input.story:undefined, logs:j.logs, background:true };
}
function createStudioJobs({ store, publish, execute, pollImage, now = Date.now, leaseMs = 330000 }) {
  const note = (j, message) => { j.message = message; j.logs.push(message); j.logs = j.logs.slice(-120); };
  async function schedule(j, delay = 0) { if (j && !TERMINAL.has(j.status)) await publish({ id:j.id }, delay); }
  function next(j) {
    if(j.input.kind==='storyboard')return storyboardFlow.next(j);
    if (j.input.kind==='prompt') {
      if(j.input.totalScenes===1)return {kind:'prompt-single',key:'prompt-single'};
      if(!j.outline)return {kind:'outline',key:'outline'};
      const i=j.scenes.findIndex(s=>!s.draft);return {kind:'write-scene',i,key:'write-scene:'+i};
    }
    if (j.input.kind==='image') return {kind:j.scenes[0].imageTask?'image-poll':'image',i:0,key:'image:0'};
    if (j.scenes.every(s => s.normalized)) return {kind:'combine', key:'combine'};
    if (j.scenes.every(s => s.clip)) { const i = j.scenes.findIndex(s => !s.normalized); return {kind:'normalize',i,key:'normalize:'+i}; }
    let i;
    if (j.input.chained) i = j.scenes.findIndex(s => !s.clip);
    else {
      const pending = j.scenes.filter(s => s.task && !s.clip).length;
      i = pending < 4 ? j.scenes.findIndex(s => !s.clip && !s.task) : -1;
      if (i < 0) { const ids = j.scenes.map((s,k) => s.task && !s.clip ? k : -1).filter(k => k >= 0); i = ids[j.cursor++ % ids.length]; }
    }
    const s = j.scenes[i];
    const anchor = j.input.chained && i > 0 ? j.scenes[i-1].chain : '';
    const kind = s.task ? 'video-poll' : (s.imageTask ? 'image-poll' : (!s.image && !anchor ? 'image' : 'video'));
    return {kind,i,anchor,key:kind+':'+i};
  }
  async function process(message) {
    if (!message || !/^[a-f0-9-]{36}$/.test(String(message.id))) return;
    const token = crypto.randomUUID(); let operation;
    const claimed = await store.mutate(message.id, null, j => {
      if (TERMINAL.has(j.status)) return;
      if (j.leaseUntil > now()) throw fail('Job step is already running.',503);
      if (now() - j.createdAt > 24 * 3600000) { j.status='failed'; j.error='This film exceeded the 24-hour job limit. Completed scenes were retained.'; note(j,j.error); return; }
      if (j.inflight && !['image-poll','video-poll','normalize'].includes(j.inflight.kind)) {
        j.status='failed'; j.error='A worker stopped during '+j.inflight.kind+'. Saved scenes are retained. The step was not submitted again to avoid duplicate charges.'; note(j,j.error); return;
      }
      operation = next(j); j.inflight=operation; j.leaseUntil=now()+leaseMs; j.leaseToken=token; j.status='running';
      const label={'image':'generating image','image-poll':'image rendering','video':'starting video','video-poll':'video rendering','normalize':'preparing final cut','outline':'planning script','write-scene':'writing script','prompt-single':'writing script'};
      j.phase=operation.kind;
      if(j.input.kind==='storyboard'){note(j,storyboardFlow.label(j,operation));return;}
      note(j, operation.kind==='combine' ? 'Combining final film…' : (operation.i===undefined?'':('Scene '+(operation.i+1)+'/'+j.scenes.length+': '))+label[operation.kind]+'…');
    });
    if (!claimed || !operation) return;
    const op = operation, input = claimed.input, scene = claimed.scenes[op.i];
    let result, error;
    const base = { source:input.source,title:input.title,ratio:input.ratio,resolution:input.resolution,model:input.model,duration:input.duration };
    try {
      if(input.kind==='storyboard')result=await storyboardFlow.execute(claimed,op,execute);
      else if (op.kind==='prompt-single') result=await execute(claimed,'/api/flashloop/generate-prompt',{...input,sceneDuration:input.duration});
      else if (op.kind==='outline') result=await execute(claimed,'/api/flashloop/generate-outline',input);
      else if (op.kind==='write-scene') {
        const beat=claimed.outline[op.i]||{},previous=claimed.outline[op.i-1]||{};
        result=await execute(claimed,'/api/flashloop/generate-scene',{...input,sceneIndex:op.i+1,sceneBeat:beat.summary||beat.title||'',sceneTitle:beat.title||'',prevBeat:previous.summary||previous.title||''});
      }
      else if (op.kind==='image-poll') result = await pollImage(scene.imageTask);
      else if (op.kind==='image') result = await execute(claimed, '/api/flashloop/generate-i2i', {...base, model:input.imageModel,prompt:input.scenes[op.i].imagePrompt,refImageUrl:input.refImageUrl,referenceImages:input.referenceImages,modelscope:input.modelscope,trendName:input.trendName,tagline:input.tagline,slug:input.slug});
      else if (op.kind==='video' || op.kind==='video-poll') result = await execute(claimed, '/api/flashloop/generate-video', {...base,scene:op.i+1,prompt:input.scenes[op.i].videoPrompt,imageUrl:scene.image,chainAnchor:op.anchor,pollTask:scene.task||''});
      else if (op.kind==='normalize') result = await execute(claimed, '/api/flashloop/combine', {...base,scenes:[op.i+1],clipUrls:[scene.clip],normalizeOnly:true});
      else result = await execute(claimed, '/api/flashloop/combine', {...base,scenes:claimed.scenes.map((_,i)=>i+1),clipUrls:claimed.scenes.map(s=>s.normalized),preNormalized:true});
      if (result.error && !result.pending) throw new Error(result.error);
    } catch (e) { error=e; }
    // A database failure here must throw: queue redelivery recovers a saved task
    // or marks an ambiguous submission for attention, never blindly buys it twice.
    const saved = await store.mutate(claimed.id,null,j => {
      if (j.leaseToken!==token) return;
      j.leaseUntil=0; j.inflight=null;
      if (j.status==='cancelled') return;
      if (error) { j.status='failed'; j.error=String(error.message||error); note(j,j.error); return; }
      const s=j.scenes[op.i];
      if(input.kind==='storyboard'){try{storyboardFlow.apply(j,op,result);if(j.status==='completed')note(j,'FINAL FILM READY');}catch(e){j.status='failed';j.error=e.message;note(j,e.message);}return;}
      if (op.kind==='prompt-single') {
        if(!Array.isArray(result.scenes)||!result.scenes.length){j.status='failed';j.error='No script scenes were returned.';}
        else {j.result=result;j.scenes=result.scenes.map(draft=>({draft,stage:'ready'}));j.status='completed';note(j,'Script ready.');}
      } else if (op.kind==='outline') {
        if(!Array.isArray(result.outline)||result.outline.length!==j.scenes.length){j.status='failed';j.error='The script outline is incomplete. No scenes were silently dropped.';}
        else {j.outline=result.outline;j.scriptTitle=result.title||input.title;j.input.sceneLength=result.sceneLength||input.sceneLength;}
      } else if (op.kind==='write-scene') {
        if(!result.scene){j.status='failed';j.error='The script writer returned no scene.';}
        else {s.draft=result.scene;s.stage='ready';if(j.scenes.every(s=>s.draft)){j.result={scenes:j.scenes.map(s=>s.draft),title:j.scriptTitle,sceneLength:result.sceneLength||input.sceneLength};j.status='completed';note(j,'Script ready.');}}
      } else if (op.kind==='image' || op.kind==='image-poll') {
        if (result.imageUrl) { s.image=result.imageUrl; s.imageTask=''; s.stage='image-ready'; if(input.kind==='image'){j.status='completed';j.result={imageUrl:result.imageUrl,sceneIndex:input.sceneIndex};note(j,'Image ready.');} }
        else if (result.taskUrl) { s.imageTask=result.taskUrl; s.stage='image-rendering'; }
        else if (!result.pending) { j.status='failed'; j.error='Image provider returned no image or task.'; }
      } else if (op.kind==='video' || op.kind==='video-poll') {
        if (result.pending && result.task) { s.task=result.task; s.stage='video-rendering'; }
        else if (result.clip_url) { s.clip=result.clip_url; s.chain=result.chain_image_url||''; s.task=''; s.stage='video-ready'; }
        else { j.status='failed'; j.error='The scene was not hosted durably. Completed provider output is retained; do not resubmit it automatically.'; }
      } else if (op.kind==='normalize') {
        if (result.clip_url) { s.normalized=result.clip_url; s.stage='ready'; }
        else { j.status='failed'; j.error='Normalized scene could not be hosted.'; }
      } else {
        const url=result.vault_url||result.clip_url||result.hosted_url;
        if (!url) { j.status='failed'; j.error='Final film could not be saved to a durable URL.'; }
        else { j.result={...result,url}; j.status='completed'; note(j,'VIDEO READY — '+j.scenes.length+' scenes combined.'); }
      }
      if (j.error) note(j,j.error);
    });
    await schedule(saved,result?.pending ? 20 : 0);
  }
  return {
    process, store,
    async start(user, body) {
      if (!/^[a-zA-Z0-9_-]{16,100}$/.test(body.requestKey||'')) throw fail('A unique request key is required.');
      const input=validateInput(body), timestamp=now();
      const initial={id:crypto.randomUUID(),ownerId:user.id,user:{id:user.id,email:user.email,name:user.name},requestKey:body.requestKey,input,
        scenes:input.scenes.map(s=>({image:s.imageUrl||'',stage:'queued'})),status:'queued',createdAt:timestamp,updatedAt:timestamp,logs:['Generation saved. Waiting for background worker…'],message:'Queued',cursor:0};
      if(input.kind==='storyboard')storyboardFlow.initialize(initial);
      const j=await store.create(initial);
      try { await schedule(j); } catch (e) { throw fail('The generation was saved, but the background queue could not be reached. Retry with the same request key. '+e.message,503); }
      return publicJob(j);
    },
    async list(user,source) { return (await store.list(user.id,source)).map(publicJob); },
    async get(user,id) { const j=await store.get(id,user.id); return j ? publicJob(j) : null; },
    async cancel(user,id) { const j=await store.mutate(id,user.id,j=>{ if (!TERMINAL.has(j.status)) {j.status='cancelled'; note(j,'Cancelled. Already-submitted provider work may finish; no further scenes will be started.');} }); return j ? publicJob(j) : null; },
    async recoverLocal() { for (const j of await store.active()) await schedule(j, Math.max(0, Math.ceil(((j.leaseUntil||0)-now())/1000))); }
  };
}
module.exports={createJobStore,createStudioJobs,validateInput,publicJob};
