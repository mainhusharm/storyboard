const TOPIC = 'studio-generation';
let handler;
const timers = new Map();
function setLocalHandler(fn) { handler=fn; }
async function publish(message, delaySeconds=0) {
  if (process.env.VERCEL) {
    const { send } = require('@vercel/queue');
    return send(TOPIC,message,{delaySeconds,retentionSeconds:86400});
  }
  if (timers.has(message.id)) return;
  const timer=setTimeout(async()=>{
    timers.delete(message.id);
    try { await handler(message); }
    catch(e) { console.error('studio worker:',e.message); await publish(message,30); }
  },Math.max(1,delaySeconds*1000));
  timers.set(message.id,timer);
}
module.exports={TOPIC,publish,setLocalHandler};
