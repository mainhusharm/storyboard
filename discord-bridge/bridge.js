const fs = require('fs');
const path = require('path');
const http = require('http');
const { Client, GatewayIntentBits } = require('discord.js');

const cfgPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('config.json missing - copy config.example.json and fill it in');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const results = new Map();

let client = null;
let usingContentIntent = true;

function makeClient(withContent) {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  if (withContent) intents.push(GatewayIntentBits.MessageContent);
  return new Client({ intents });
}

let ready = false;
let pending = null;

function settle(result) {
  if (!pending) return;
  const done = pending.done;
  pending = null;
  done(result);
}

function onMessage(msg) {
  const isTarget = msg.author && msg.author.id === String(cfg.targetBotId);
  const inChannel = msg.channelId === String(cfg.channelId);
  const inDM = !msg.guildId && isTarget;
  if (!inChannel && !inDM) return;
  const attNames = msg.attachments ? Array.from(msg.attachments.values()).map((a) => a.name).join(',') : '';
  const who = msg.author ? (msg.author.tag || msg.author.username) + ' id=' + msg.author.id + ' bot=' + msg.author.bot : 'unknown';
  console.log('[msg] ' + who + (inDM ? ' [DM]' : '') + (attNames ? ' files=[' + attNames + ']' : '') + (isTarget ? ' [TARGET]' : '') + ' :: ' + String(msg.content || '').slice(0, 140).replace(/\s+/g, ' '));
  if (!pending) return;
  if (!isTarget) return;
  const att = msg.attachments && msg.attachments.find((a) => /\.(mp4|mov|webm)$/i.test(a.name || a.url || ''));
  if (att) {
    settle({ ok: true, url: att.url, fileName: att.name || 'video.mp4', reply: msg.content || '' });
    return;
  }
  const link = (msg.content || '').match(/https?:\/\/\S+\.(?:mp4|mov|webm)\S*/i);
  if (link) {
    settle({ ok: true, url: link[0], fileName: 'video.mp4', reply: msg.content || '' });
    return;
  }
  if (/(failed|error|unable|could ?n[o']t)/i.test(msg.content || '')) {
    settle({ ok: false, error: 'target bot reported failure', reply: msg.content || '' });
  }
}

function markReady() {
  if (ready) return;
  ready = true;
  console.log('[bridge] logged in as ' + (client.user ? client.user.tag : 'unknown'));
}

function attach(c) {
  c.on('messageCreate', onMessage);
  c.once('clientReady', markReady);
  c.once('ready', markReady);
}

function buildMessage(model, prompt) {
  const tpl = cfg.messageTemplate || '@bot make a video with {model}: {prompt}';
  return tpl
    .replace('@bot', '<@' + cfg.targetBotId + '>')
    .replace('{model}', model)
    .replace('{prompt}', prompt);
}

function waitForVideo(timeoutMs) {
  return new Promise((resolve) => {
    const done = (v) => {
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      if (pending && pending.done === done) pending = null;
      resolve({ ok: false, error: 'timeout after ' + timeoutMs + 'ms waiting for target bot' });
    }, timeoutMs);
    pending = { done };
  });
}

function buildDMMessage(model, prompt) {
  return (cfg.dmTemplate || 'hey! make a video with {model} for me plz? prompt: {prompt}')
    .replace('{model}', model)
    .replace('{prompt}', prompt);
}

function pasteText(model, prompt) {
  const tpl = cfg.pasteTemplate || '@target make a video with {model}: {prompt}';
  return tpl
    .replace('@target', '<@' + cfg.targetBotId + '>')
    .replace('{model}', model)
    .replace('{prompt}', prompt);
}

async function dmOwner(text) {
  if (!cfg.ownerId) return;
  const user = await client.users.fetch(String(cfg.ownerId));
  await user.send(text);
}

async function generate(model, prompt, id) {
  if (!ready) {
    results.set(id, { status: 'error', error: 'discord client not ready' });
    return;
  }
  let sentId = null;
  if (cfg.relayMode) {
    try {
      await dmOwner('🎬 Website video request ' + id + ' — paste this into the video channel:\n```\n' + pasteText(model, prompt) + '\n```');
      console.log('[bridge] relay: DM sent to owner for ' + id);
    } catch (e) {
      console.log('[bridge] relay: DM failed (' + e.message + ') - paste text is in the API response');
    }
  } else if (cfg.dmMode) {
    try {
      const u = await client.users.fetch(String(cfg.targetBotId));
      const dm = await u.createDM();
      await dm.send(buildDMMessage(model, prompt));
      sentId = 'dm';
      console.log('[bridge] sent DM to target bot: ' + prompt);
      const nudgeList = Array.isArray(cfg.nudges) ? cfg.nudges : [];
      let at = Number(cfg.nudgeDelayMs || 45000);
      for (const text of nudgeList) {
        const wait = at;
        setTimeout(() => {
          if (!pending) return;
          console.log('[bridge] DM nudge: ' + text);
          dm.send(text).catch(() => {});
        }, wait);
        at = Math.round(at * 1.8);
      }
    } catch (e) {
      results.set(id, { status: 'error', error: 'DM failed: ' + e.message });
      return;
    }
  } else {
    const channel = await client.channels.fetch(String(cfg.channelId));
    const sent = await channel.send(buildMessage(model, prompt));
    sentId = sent.id;
    console.log('[bridge] sent request (' + model + '): ' + prompt);
    const nudgeList = Array.isArray(cfg.nudges) ? cfg.nudges : [];
    let at = Number(cfg.nudgeDelayMs || 45000);
    for (const text of nudgeList) {
      const wait = at;
      setTimeout(() => {
        if (!pending) return;
        console.log('[bridge] nudge: ' + text);
        channel.send(text).catch(() => {});
      }, wait);
      at = Math.round(at * 1.8);
    }
  }
  const res = await waitForVideo(Number(cfg.timeoutMs || 600000));
  if (!res.ok) {
    results.set(id, { status: 'error', error: res.error, reply: res.reply || '' });
    return;
  }
  const file = path.join(OUT, 'video_' + Date.now() + '.mp4');
  const r = await fetch(res.url);
  if (!r.ok) {
    results.set(id, { status: 'error', error: 'download failed with status ' + r.status, url: res.url });
    return;
  }
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  console.log('[bridge] saved ' + file + ' for ' + id);
  results.set(id, { status: 'done', file, url: res.url, reply: res.reply, requestMessageId: sentId });
}

let chain = Promise.resolve();
function enqueue(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const url = (req.url || '').split('?')[0];
  if (req.method === 'POST' && url === '/webhook-test') {
    if (!ready) return send(503, { ok: false, error: 'client not ready' });
    try {
      const q = new URL(req.url, 'http://x').searchParams;
      const text = q.get('text') || 'hey! make a video with wan3 for me plz? prompt: a fox jumping over a log, cinematic';
      const channel = await client.channels.fetch(String(cfg.channelId));
      const hooks = await channel.fetchWebhooks();
      let hook = hooks.find((h) => h.name === 'pint-bridge');
      if (!hook) hook = await channel.createWebhook({ name: 'pint-bridge' });
      const user = cfg.ownerId ? await client.users.fetch(String(cfg.ownerId)) : null;
      const sent = await hook.send({
        content: text,
        username: user ? user.username : 'kindheartedsuper',
        avatarURL: user ? user.displayAvatarURL({ size: 128 }) : undefined,
      });
      console.log('[bridge] webhook message sent as ' + (user ? user.username : 'kindheartedsuper') + ' :: ' + text);
      return send(200, { ok: true, messageId: sent.id, asUser: user ? user.username : 'kindheartedsuper', note: 'watching for target bot reaction - check /health logs or this console' });
    } catch (e) {
      return send(500, { ok: false, error: String((e && e.message) || e), hint: /403|missing|permissions/i.test(String(e)) ? 'grant pint the Manage Webhooks permission (Server Settings > Roles > pint)' : undefined });
    }
  }
  if (req.method === 'GET' && url === '/health') {
    return send(200, { ok: ready, user: client.user ? client.user.tag : null, contentIntent: usingContentIntent, relayMode: !!cfg.relayMode });
  }
  if (req.method === 'GET' && url === '/latest') {
    if (!ready) return send(503, { ok: false, error: 'client not ready' });
    try {
      const channel = await client.channels.fetch(String(cfg.channelId));
      const msgs = await channel.messages.fetch({ limit: 50 });
      const sorted = Array.from(msgs.values()).sort((a, b) => b.createdTimestamp - a.createdTimestamp);
      for (const m of sorted) {
        if (!m.author || m.author.id !== String(cfg.targetBotId)) continue;
        const att = m.attachments.find((a) => /\.(mp4|mov|webm)$/i.test(a.name || a.url || ''));
        if (att) {
          const file = path.join(OUT, 'video_latest.mp4');
          const r = await fetch(att.url);
          if (!r.ok) continue;
          fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
          return send(200, { ok: true, file, url: att.url, reply: m.content || '', timestamp: m.createdTimestamp });
        }
      }
      return send(404, { ok: false, error: 'no video from target bot in recent channel history' });
    } catch (e) {
      return send(500, { ok: false, error: String((e && e.message) || e) });
    }
  }
  if (req.method === 'GET' && url.startsWith('/result/')) {
    const id = url.slice('/result/'.length);
    const r = results.get(id);
    if (!r) return send(404, { ok: false, error: 'unknown id' });
    return send(200, Object.assign({ ok: true, id }, r));
  }
  if (req.method === 'GET' && url.startsWith('/video/')) {
    const name = path.basename(url.slice('/video/'.length));
    const file = path.join(OUT, name);
    if (!fs.existsSync(file)) return send(404, { ok: false, error: 'no such file' });
    res.writeHead(200, { 'content-type': 'video/mp4' });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method !== 'POST' || url !== '/generate') {
    return send(404, { ok: false, error: 'not found (GET /health, GET /result/:id, GET /video/:file, POST /generate)' });
  }
  if (cfg.apiKey && req.headers['x-api-key'] !== cfg.apiKey) {
    return send(401, { ok: false, error: 'invalid api key' });
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch (e) {
      return send(400, { ok: false, error: 'invalid json body' });
    }
    if (!parsed.prompt) return send(400, { ok: false, error: 'prompt required' });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const model = parsed.model || cfg.defaultModel || 'wan3';
    results.set(id, { status: 'pending' });
    enqueue(() => generate(model, parsed.prompt, id)).catch(() => {});
    const resp = { ok: true, id, status: 'pending', model };
    if (cfg.relayMode) {
      resp.relay = true;
      resp.paste = pasteText(model, parsed.prompt);
      resp.note = 'paste that text into the video channel - pint also DMs it to the owner';
    }
    send(202, resp);
  });
});

const port = Number(cfg.port || 5174);
server.listen(port, () => console.log('[bridge] api listening on http://localhost:' + port));

function login(withContent) {
  usingContentIntent = withContent;
  client = makeClient(withContent);
  attach(client);
  return client.login(cfg.token);
}

login(true).catch((e) => {
  const msg = String((e && e.message) || e);
  if (/disallowed intents/i.test(msg)) {
    console.log('[bridge] Message Content Intent not enabled in portal - reconnecting without it (relying on reply-mentions)');
    login(false).catch((e2) => {
      console.error('[bridge] login failed: ' + ((e2 && e2.message) || e2));
      process.exit(1);
    });
  } else {
    console.error('[bridge] login failed: ' + msg);
    process.exit(1);
  }
});
