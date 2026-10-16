// Reproduce console disappearance at idle/cold-instance transitions and reloads.
// Also verify watchdog aborts cannot restart a paid phase via network retry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/public/storyboard.html'), 'utf8');
const consoleSource = source.slice(source.indexOf('let SAVED_RUN={}'), source.indexOf('// A request with NO timeout'));
const pollSource = source.slice(source.indexOf('async function poll(){'), source.indexOf('// Cancel the currently running task.'));

function browser(storage = new Map()) {
  const elements = new Map();
  const context = {
    LOCAL_BUSY: false, SUBMITTING: false, USER_CANCELLED: false, PHASE_ABORT: null,
    Date, AbortController,
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    $: id => {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', style: {}, firstElementChild: { style: {} }, classList: { toggle() {} } });
      return elements.get(id);
    },
    esc: value => String(value).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])),
    api: async () => ({ phase: 'idle', total: 0, done: 0, log: [] }),
    refresh() {}, clientWatchdog() {}
  };
  vm.createContext(context);
  vm.runInContext(consoleSource, context);
  vm.runInContext(pollSource, context);
  return { context, storage };
}

async function main() {
  const state = browser();
  vm.runInContext("LOCAL_PHASE='CHARACTER REFERENCES';LOCAL_RESULT='failed';logLocal('Character A: provider rejected the reference (3030).','err');", state.context);
  await state.context.poll();
  assert.match(state.context.$('log').innerHTML, /provider rejected/);
  assert.equal(state.context.$('phasetxt').textContent, 'STOPPED');
  state.context.api = async () => ({ phase: 'idle', log: ['unrelated cold-instance log'] });
  await state.context.poll();
  assert.match(state.context.$('log').innerHTML, /provider rejected/);
  assert.ok(!state.context.$('log').innerHTML.includes('unrelated'));
  console.log('ok: becoming idle or switching instances preserves the failure and shows STOPPED');

  const reload = browser(state.storage);
  reload.context.restoreRunConsole();
  await reload.context.poll();
  assert.match(reload.context.$('log').innerHTML, /Character A/);
  assert.equal(reload.context.$('phasetxt').textContent, 'STOPPED');
  console.log('ok: a page reload retains the exact stopped-run error');

  vm.runInContext("LOCAL_PHASE='CHARACTER REFERENCES';LOCAL_RESULT='running';logLocal('Generating character references...');", state.context);
  const interrupted = browser(state.storage);
  let unexpectedSubmissions = 0;
  interrupted.context.api = async endpoint => {
    if (endpoint !== '/status') unexpectedSubmissions++;
    return { phase: 'idle', log: [] };
  };
  interrupted.context.restoreRunConsole();
  await interrupted.context.poll();
  assert.match(interrupted.context.$('log').innerHTML, /Page reopened during CHARACTER REFERENCES/);
  assert.equal(interrupted.context.$('phasetxt').textContent, 'INTERRUPTED');
  assert.equal(unexpectedSubmissions, 0, 'restoring the console must never start another generation');
  console.log('ok: reopening an active run is labelled interrupted and never resubmits work');

  interrupted.context.clearLocalLog();
  interrupted.context.api = async () => ({ phase: 'idle', log: ['new manual image phase'] });
  await interrupted.context.poll();
  assert.match(interrupted.context.$('log').innerHTML, /new manual image phase/);
  assert.ok(!interrupted.context.$('log').innerHTML.includes('Character A'));
  console.log('ok: starting a new job clears the old history so its logs remain visible');

  const retry = browser();
  retry.context.setTimeout = () => 1;
  retry.context.clearTimeout = () => {};
  let calls = 0;
  retry.context.api = async () => {
    calls++;
    retry.context.PHASE_ABORT.abort('watchdog');
    throw new Error('aborted');
  };
  vm.runInContext(source.slice(source.indexOf('async function callPhase('), source.indexOf('// VERCEL AUTO PIPELINE')), retry.context);
  await assert.rejects(retry.context.callPhase('/char-refs', {}), /will not be automatically submitted again/);
  assert.equal(calls, 1);
  console.log('ok: watchdog aborts cannot be retried as new paid submissions');

  const auth = browser();
  let redirected = false;
  auth.context.fetch = async () => ({ status: 401, text: async () => JSON.stringify({ error: 'session expired' }) });
  auth.context.location = { pathname: '/storyboard', search: '', replace() {
    const saved = JSON.parse(auth.storage.get('sb_run_console'));
    assert.equal(saved.result, 'failed');
    assert.match(saved.log.at(-1).m, /Session expired/);
    redirected = true;
  } };
  vm.runInContext(source.slice(source.indexOf('async function api(p,opts){'), source.indexOf('// Header credits pill')), auth.context);
  await assert.rejects(auth.context.api('/char-refs'), /session expired/);
  assert.equal(redirected, true);
  console.log('ok: authentication failures are recorded before redirecting away');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
