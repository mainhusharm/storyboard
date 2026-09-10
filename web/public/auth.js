/* Storyboard Studio — shared client auth.
 *
 * Fixes the "logged in but keeps asking for my email" bug: the old per-page guard
 * redirected to /login on ANY failed /api/auth/me call (network blip, 5xx, or a
 * non-JSON response behind a proxy). Now only a real 401 logs you out, transient
 * failures retry with backoff, and the session also survives cookie loss via a
 * Bearer token kept in localStorage.
 *
 * Usage:
 *   <script src="/auth.js"></script>
 *   <script>await SBAuth.guard();</script>   // or SBAuth.guard() with .then()
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'sb_token';
  var MAX_RETRIES = 3;

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch (e) { return null; }
  }
  function setToken(t) {
    try { if (t) localStorage.setItem(TOKEN_KEY, t); } catch (e) {}
  }
  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  // fetch with the Bearer fallback attached (cookie still takes priority server-side).
  function authFetch(url, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    var t = getToken();
    if (t && !headers.Authorization) headers.Authorization = 'Bearer ' + t;
    opts.headers = headers;
    return fetch(url, opts);
  }

  // Attach the Bearer token to EVERY same-origin /api/ request, so the whole app
  // keeps working even if the HttpOnly cookie is dropped (privacy settings,
  // cross-site navigation, proxy stripping). Cookies still win server-side.
  (function patchFetch() {
    if (typeof window.fetch !== 'function' || window.__sbFetchPatched) return;
    window.__sbFetchPatched = true;
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var isApi = url.indexOf('/api/') === 0 || url.indexOf(location.origin + '/api/') === 0;
        var t = getToken();
        if (isApi && t) {
          init = init || {};
          var headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || undefined);
          if (!headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + t);
          init.headers = headers;
        }
      } catch (e) {}
      return nativeFetch(input, init);
    };
  })();

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Ask who we are. Retries transient failures so a flaky request never logs the
  // user out. Returns:
  //   { user }          — authenticated
  //   { unauth: true }  — a real 401 (no/expired session)
  //   { error }         — could not determine (stay put; do NOT redirect)
  async function me(attempts) {
    attempts = attempts || MAX_RETRIES;
    var lastErr = null;
    for (var i = 0; i < attempts; i++) {
      try {
        var r = await authFetch('/api/auth/me', { cache: 'no-store' });
        if (r.status === 401 || r.status === 403) {
          // Definitive: the session is gone. Drop the stale bearer token.
          clearToken();
          return { unauth: true };
        }
        if (!r.ok) { lastErr = new Error('HTTP ' + r.status); }
        else {
          var ct = r.headers.get('content-type') || '';
          if (ct.indexOf('application/json') === -1) {
            // A proxy/SSO page came back instead of our API — not an auth failure.
            lastErr = new Error('non-JSON response');
          } else {
            var j = await r.json();
            if (j && j.user) return { user: j.user };
            lastErr = new Error('malformed response');
          }
        }
      } catch (e) { lastErr = e; }
      if (i < attempts - 1) await sleep(400 * Math.pow(2, i));
    }
    return { error: lastErr || new Error('auth check failed') };
  }

  function showUser(user) {
    var name = (user && (user.name || user.email)) || '';
    var el = document.getElementById('authName');
    if (el) { el.style.display = ''; el.textContent = '👤 ' + name; }
    var pill = document.getElementById('userPill');
    var pname = document.getElementById('userName');
    if (pill && pname) { pill.style.display = ''; pname.textContent = name; }
    var lo = document.getElementById('btnLogout');
    if (lo) lo.style.display = '';
    return user;
  }

  function redirectToLogin() {
    var next = location.pathname + location.search;
    location.replace('/login?next=' + encodeURIComponent(next));
  }

  // Guard a protected page. Resolves with the user (or null). Never redirects on
  // transient errors — only on a definitive 401.
  async function guard() {
    var res = await me();
    if (res.user) return showUser(res.user);
    if (res.unauth) { redirectToLogin(); return null; }
    // Transient failure: keep the user on the page rather than bouncing them to
    // the login form they already passed.
    return null;
  }

  async function login(email, password) {
    var r = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.ok) throw new Error(j.error || ('Login failed (HTTP ' + r.status + ')'));
    if (j.token) setToken(j.token);
    return j.user;
  }

  async function signup(name, email, password) {
    var r = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, password: password })
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.ok) throw new Error(j.error || ('Signup failed (HTTP ' + r.status + ')'));
    if (j.token) setToken(j.token);
    return j.user;
  }

  async function logout() {
    try { await authFetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
    clearToken();
    location.replace('/login');
  }

  window.SBAuth = {
    me: me,
    guard: guard,
    login: login,
    signup: signup,
    logout: logout,
    authFetch: authFetch,
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken
  };
})();
