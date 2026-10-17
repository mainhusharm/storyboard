(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const sources = { storyboard: 'Storyboard', flashloop: 'Flashloop', sjinn: 'SJinn' };
  const kinds = { script: 'Script', image: 'Image', audio: 'Audio', video: 'Video' };
  const icons = { script: '≡', image: '▧', audio: '♫', video: '▷' };
  const params = new URLSearchParams(location.search);
  const state = { source: sources[params.get('source')] ? params.get('source') : '', kind: kinds[params.get('kind')] ? params.get('kind') : '', q: (params.get('q') || '').slice(0, 200), items: [], cursor: null, loading: false, revision: 0, controller: null };
  const thumbnails = new Map();
  const thumbnailRequests = new Map();
  const downloadUrls = new Set();
  let currentItem = null, previewUrl = null, previewController = null, toastTimer, searchTimer;
  const authFetch = (url, options) => SBAuth.authFetch(url, { credentials: 'same-origin', ...options });
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sizeLabel = bytes => !Number.isFinite(Number(bytes)) || Number(bytes) < 0 ? '' : Number(bytes) < 1024 ? Number(bytes) + ' B' : Number(bytes) < 1048576 ? (Number(bytes) / 1024).toFixed(1) + ' KB' : (Number(bytes) / 1048576).toFixed(1) + ' MB';
  const dateLabel = date => { const value = new Date(date); return Number.isNaN(value.getTime()) ? '' : value.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
  // Derive every content URL from the asset id. Never navigate to stored remote URLs.
  const contentUrl = item => '/api/vault/' + encodeURIComponent(item.id) + '/content';
  function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4500); }
  function redirectLogin() { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search)); }
  async function jsonRequest(url, options) {
    const response = await authFetch(url, options);
    if (response.status === 401) { redirectLogin(); throw new Error('Your session expired. Please sign in again.'); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(body.error || body.message || 'The vault is temporarily unavailable (HTTP ' + response.status + ').'); error.storage = body.storage; throw error; }
    return body;
  }
  function setStorage(storage) {
    if (!storage) return;
    const ready = storage.ready === true;
    $('storageStatus').className = 'storage-status ' + (ready ? 'ready' : 'warning');
    $('storageMessage').textContent = storage.message || (ready ? storage.mode === 'cloud' ? 'Cloud storage connected · Available across devices and Vercel deployments.' : 'Local storage connected · Saved on this server. Connect cloud storage before deploying to Vercel.' : 'Vault storage needs setup. Generations cannot be saved to the vault until durable storage is configured.');
    if (storage.last_warning && window.SBVaultWarnings) SBVaultWarnings.show(storage.last_warning);
  }
  function clearThumbnails() {
    thumbnailRequests.forEach(controller => controller.abort()); thumbnailRequests.clear();
    thumbnails.forEach(url => URL.revokeObjectURL(url)); thumbnails.clear();
    if (observer) observer.disconnect();
  }
  function updateFilters() {
    $('search').value = state.q; $('kind').value = state.kind;
    document.querySelectorAll('[data-source]').forEach(button => { if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(button.dataset.source === state.source)); });
    const query = new URLSearchParams();
    for (const key of ['source', 'kind', 'q']) if (state[key]) query.set(key, state[key]);
    history.replaceState(null, '', '/vault' + (query.size ? '?' + query : ''));
  }
  function showError(message) {
    const error = $('error'); error.replaceChildren(document.createTextNode(message));
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.onclick = () => load(false); error.appendChild(retry); error.hidden = false;
  }
  async function load(append) {
    if (append && (state.loading || !state.cursor)) return;
    if (state.controller) state.controller.abort();
    const controller = new AbortController(); state.controller = controller;
    const revision = ++state.revision;
    state.loading = true; $('assets').setAttribute('aria-busy', 'true'); $('error').hidden = true; $('refresh').disabled = true; $('loadMore').disabled = true;
    if (!append) {
      clearThumbnails(); state.items = []; state.cursor = null; $('empty').hidden = true; $('loadMore').hidden = true;
      $('resultsCount').textContent = 'Loading your library…';
      $('assets').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton" aria-hidden="true"></div>').join('');
    }
    const query = new URLSearchParams({ limit: '48' });
    for (const key of ['source', 'kind', 'q']) if (state[key]) query.set(key, state[key]);
    if (append) query.set('cursor', state.cursor);
    try {
      const data = await jsonRequest('/api/vault?' + query, { cache: 'no-store', signal: controller.signal });
      if (revision !== state.revision) return;
      setStorage(data.storage);
      if (data.usage) $('usageSummary').textContent = 'Your saved files: ' + sizeLabel(data.usage.bytes) + ' · ' + Number(data.usage.assets) + ' assets across all studios';
      $('retentionNotice').textContent = 'Files are kept for 7 days. Download anything you want to keep. Use Delete to free storage sooner. ' + (data.background_cleanup ? 'Daily background cleanup is active.' : data.storage?.mode === 'cloud' ? 'Background cleanup needs setup; expired files are still removed when you use the vault.' : 'Expired files are removed when you use the vault.');
      if (data.cleanup_warning) toast(data.cleanup_warning);
      if (data.last_warning && window.SBVaultWarnings) SBVaultWarnings.show(data.last_warning);
      const previousIds = new Set(state.items.map(item => item.id));
      const added = (Array.isArray(data.vault) ? data.vault : []).filter(item => item && typeof item.id === 'string' && !previousIds.has(item.id));
      state.items.push(...added); state.cursor = data.nextCursor || null;
      render();
      if (!state.items.length && data.storage && !data.storage.ready) showEmpty('Storage setup required', 'The vault will start saving your creations once cloud storage and the database are connected. ' + (data.storage.message || 'Ask your deployment administrator to finish vault storage setup.'), true);
    } catch (error) {
      if (error.name === 'AbortError' || revision !== state.revision) return;
      if (!append) { $('assets').replaceChildren(); $('resultsCount').textContent = 'Library unavailable'; }
      showError(error.message || 'Could not load your vault. Check your connection and retry.');
      if (error.storage) setStorage(error.storage);
      else {
        try { const status = await jsonRequest('/api/vault/status', { cache: 'no-store', signal: controller.signal }); if (revision === state.revision) { setStorage(status.storage || status); if (status.last_warning && window.SBVaultWarnings) SBVaultWarnings.show(status.last_warning); } } catch (_) {}
      }
    } finally {
      if (revision === state.revision) { state.loading = false; $('assets').setAttribute('aria-busy', 'false'); $('refresh').disabled = false; $('loadMore').disabled = false; }
    }
  }
  function showEmpty(title, message, setup) {
    $('empty').hidden = false;
    $('empty').innerHTML = '<div class="empty-icon" aria-hidden="true">' + (setup ? '◇' : '▧') + '</div><h2>' + escape(title) + '</h2><p>' + escape(message) + '</p>' + (setup ? '' : state.source || state.kind || state.q ? '<button id="clearFilters">Clear filters</button>' : '<a href="/storyboard">Create in Storyboard</a>');
    if ($('clearFilters')) $('clearFilters').onclick = () => { state.source = ''; state.kind = ''; state.q = ''; updateFilters(); load(false); };
  }
  function render() {
    if (observer) observer.disconnect();
    $('assets').innerHTML = state.items.map(item => '<article class="asset-card" data-id="' + escape(item.id) + '"><button class="asset-cover" data-action="preview" data-kind="' + escape(item.kind) + '" aria-label="Preview ' + escape(item.title || item.filename || 'asset') + '"><span class="cover-icon" aria-hidden="true">' + (icons[item.kind] || '◇') + '</span>' + (item.kind === 'image' ? '<img hidden alt="" loading="lazy" data-thumbnail="' + escape(item.id) + '">' : '') + '<span class="kind-badge">' + escape(kinds[item.kind] || 'File') + '</span><span class="cover-hint">Preview ↗</span></button><div class="asset-info"><h2 class="asset-title" title="' + escape(item.title || item.filename) + '">' + escape(item.title || item.filename || 'Untitled asset') + '</h2><div class="asset-details"><span class="studio-label" data-source="' + escape(item.source) + '">' + escape(sources[item.source] || 'Studio') + '</span><span>· ' + escape(dateLabel(item.created_at)) + '</span>' + (item.size_bytes != null ? '<span>· ' + escape(sizeLabel(item.size_bytes)) + '</span>' : '') + '</div><p class="asset-details">Expires ' + escape(dateLabel(item.expires_at)) + '</p><div class="asset-actions"><button data-action="preview">Preview</button><button class="download" data-action="download">↓ Download</button><button class="delete" data-action="delete" aria-label="Delete ' + escape(item.title || item.filename || 'asset') + '" title="Delete asset">Delete</button></div></div></article>').join('');
    $('resultsCount').textContent = state.items.length + (state.cursor ? '+' : '') + ' asset' + (state.items.length === 1 ? '' : 's') + (state.source ? ' in ' + sources[state.source] : ' in your vault');
    $('empty').hidden = true; $('loadMore').hidden = !state.cursor;
    if (!state.items.length) showEmpty(state.source || state.kind || state.q ? 'No matching creations' : 'Your next creation starts here', state.source || state.kind || state.q ? 'Try a different studio, asset type or search term.' : 'Generate a script, image, narration or video in any studio. Your saved creations will appear here automatically.');
    document.querySelectorAll('[data-thumbnail]').forEach(image => {
      const cached = thumbnails.get(image.dataset.thumbnail);
      if (cached) { image.src = cached; image.hidden = false; }
      else if (observer) observer.observe(image.parentElement); else loadThumbnail(image);
    });
  }
  async function assetBlob(item, signal) {
    const response = await authFetch(contentUrl(item), { signal });
    if (response.status === 401) { redirectLogin(); throw new Error('Your session expired. Please sign in again.'); }
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || 'This asset could not be opened (HTTP ' + response.status + ').'); }
    return response.blob();
  }
  async function loadThumbnail(image) {
    const id = image.dataset.thumbnail, item = state.items.find(value => value.id === id);
    if (!item || thumbnailRequests.has(id)) return;
    const controller = new AbortController(); thumbnailRequests.set(id, controller);
    try {
      const blob = await assetBlob(item, controller.signal);
      if (controller.signal.aborted || !state.items.some(value => value.id === id)) return;
      const url = URL.createObjectURL(blob); thumbnails.set(id, url);
      const liveImage = Array.from(document.querySelectorAll('[data-thumbnail]')).find(value => value.dataset.thumbnail === id);
      if (liveImage) { liveImage.src = url; liveImage.hidden = false; }
    } catch (_) { /* The preview action reports any asset-level error. */ }
    finally { if (thumbnailRequests.get(id) === controller) thumbnailRequests.delete(id); }
  }
  const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => entries.forEach(entry => { if (entry.isIntersecting) { observer.unobserve(entry.target); const image = entry.target.querySelector('[data-thumbnail]'); if (image) loadThumbnail(image); } }), { rootMargin: '120px' }) : null;
  function cleanupPreview() {
    if (previewController) previewController.abort(); previewController = null;
    $('previewBody').querySelectorAll('video,audio').forEach(media => { media.pause(); media.removeAttribute('src'); media.load(); });
    $('previewBody').replaceChildren();
    if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; currentItem = null;
  }
  async function openPreview(item) {
    cleanupPreview(); currentItem = item;
    $('previewTitle').textContent = item.title || item.filename || 'Untitled asset';
    $('previewKind').textContent = (sources[item.source] || 'STUDIO') + ' / ' + (kinds[item.kind] || 'FILE');
    $('previewMeta').textContent = [item.filename, sizeLabel(item.size_bytes), dateLabel(item.created_at), 'Expires ' + dateLabel(item.expires_at)].filter(Boolean).join(' · ');
    $('previewBody').innerHTML = '<p role="status">Loading preview…' + (item.kind === 'video' ? ' Large videos may take a moment.' : '') + '</p>';
    $('previewDownload').disabled = false;
    if (!$('preview').open) $('preview').showModal();
    const controller = new AbortController(); previewController = controller;
    try {
      const blob = await assetBlob(item, controller.signal);
      if (controller.signal.aborted) return;
      let element;
      if (item.kind === 'script' || /json|text\//i.test(item.mime_type || '')) {
        const text = await blob.text(); if (controller.signal.aborted) return;
        element = document.createElement('pre');
        try { element.textContent = /json/i.test(item.mime_type || '') ? JSON.stringify(JSON.parse(text), null, 2) : text; } catch (_) { element.textContent = text; }
      } else if (['image', 'audio', 'video'].includes(item.kind)) {
        previewUrl = URL.createObjectURL(blob); element = document.createElement(item.kind === 'image' ? 'img' : item.kind);
        element.src = previewUrl;
        if (item.kind === 'image') element.alt = item.title || item.filename || 'Generated image';
        else { element.controls = true; element.preload = 'metadata'; if (item.kind === 'video') element.playsInline = true; }
        element.addEventListener('error', () => { $('previewBody').innerHTML = '<p>This browser cannot preview this file. You can still download the original.</p>'; }, { once: true });
      } else { element = document.createElement('p'); element.textContent = 'A preview is unavailable for this file type. Download the original to open it.'; }
      $('previewBody').replaceChildren(element);
    } catch (error) { if (error.name !== 'AbortError') { $('previewBody').replaceChildren(); const message = document.createElement('p'); message.textContent = error.message; $('previewBody').appendChild(message); } }
  }
  async function download(item, button) {
    const original = button.textContent; button.disabled = true; button.textContent = 'Downloading…';
    try {
      const blob = await assetBlob(item); const url = URL.createObjectURL(blob); downloadUrls.add(url);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = item.filename || 'vault-' + item.id; document.body.appendChild(anchor); anchor.click(); anchor.remove();
      setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 60000);
      toast('Download started.');
    } catch (error) { toast(error.message || 'Download failed. Please try again.'); }
    finally { button.disabled = false; button.textContent = original; }
  }
  async function deleteItem(item, button) {
    if (!confirm('Delete “' + (item.title || item.filename || 'this asset') + '” from your vault? This permanently removes the saved copy.')) return;
    button.disabled = true;
    try {
      await jsonRequest('/api/vault/' + encodeURIComponent(item.id), { method: 'DELETE' });
      if (currentItem && currentItem.id === item.id) $('preview').close();
      const pending = thumbnailRequests.get(item.id); if (pending) pending.abort();
      const url = thumbnails.get(item.id); if (url) URL.revokeObjectURL(url); thumbnails.delete(item.id);
      state.items = state.items.filter(value => value.id !== item.id); await load(false); toast('Asset deleted. Storage freed.');
    } catch (error) { button.disabled = false; toast(error.message || 'Could not delete this asset.'); }
  }
  $('assets').addEventListener('click', event => {
    const button = event.target.closest('button[data-action]'); if (!button) return;
    const card = button.closest('[data-id]'); const item = state.items.find(value => value.id === card.dataset.id); if (!item) return;
    if (button.dataset.action === 'preview') openPreview(item);
    else if (button.dataset.action === 'download') download(item, button);
    else if (button.dataset.action === 'delete') deleteItem(item, button);
  });
  document.querySelectorAll('button[data-source]').forEach(button => button.onclick = () => { clearTimeout(searchTimer); state.q = $('search').value.trim(); state.source = button.dataset.source; updateFilters(); load(false); });
  $('kind').onchange = () => { clearTimeout(searchTimer); state.q = $('search').value.trim(); state.kind = $('kind').value; updateFilters(); load(false); };
  $('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.q = $('search').value.trim(); updateFilters(); load(false); }, 300); };
  $('refresh').onclick = () => load(false); $('loadMore').onclick = () => load(true);
  $('closePreview').onclick = () => $('preview').close(); $('preview').addEventListener('close', cleanupPreview);
  $('preview').addEventListener('click', event => { if (event.target === $('preview')) { const rect = $('preview').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('preview').close(); } });
  $('previewDownload').onclick = () => { if (currentItem) download(currentItem, $('previewDownload')); };
  $('btnLogout').onclick = () => SBAuth.logout();
  window.addEventListener('pagehide', () => { clearThumbnails(); cleanupPreview(); downloadUrls.forEach(url => URL.revokeObjectURL(url)); downloadUrls.clear(); });
  updateFilters();
  (async function init() {
    try {
      const session = await SBAuth.me();
      if (session.unauth) { redirectLogin(); return; }
      if (!session.user) { $('assets').setAttribute('aria-busy', 'false'); $('resultsCount').textContent = 'Sign-in check unavailable'; showError('Could not confirm your session. Retry when your connection is restored.'); return; }
      $('authName').textContent = session.user.name || session.user.email; $('authName').hidden = false; $('btnLogout').hidden = false;
      await load(false);
    } catch (error) { showError(error.message || 'Could not open your vault.'); }
  })();
})();
