import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY, WATCH_REGION } from './config.js';

// Streaming services offered as one-tap choices. `match` maps TMDB/JustWatch provider names onto them.
const SERVICES = [
  { name: 'Netflix', match: /^netflix/i },
  { name: 'HBO Max', match: /hbo max|^max\b/i },
  { name: 'Hulu', match: /^hulu/i },
  { name: 'Disney+', match: /disney/i },
  { name: 'Prime Video', match: /amazon prime|prime video/i },
  { name: 'Apple TV', match: /^apple tv/i },
  { name: 'Peacock', match: /^peacock/i },
  { name: 'Paramount+', match: /paramount/i },
  { name: 'YouTube TV', match: /^youtube tv/i },
];
const OTHER = 'Other';
const STATUS_LABELS = { watching: 'Watching', plan: 'Up next', finished: 'Finished' };
const TMDB_IMG = 'https://image.tmdb.org/t/p/w185';
const TMDB_API = 'https://api.themoviedb.org/3';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  user: null,
  titles: [],
  tab: 'watching',
  serviceFilter: null,
  text: '',
  tmdbToken: null,
  editing: null, // the row being edited, or a draft for a new one
  signUpMode: false,
};

let supabase;

// ---------- Startup ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_KEY.startsWith('YOUR-')) {
  show('setup-screen');
} else {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  wireUi();
  supabase.auth.onAuthStateChange((_event, session) => {
    // Defer so Supabase calls made inside don't deadlock the auth callback.
    setTimeout(() => setUser(session?.user ?? null), 0);
  });
}

function show(id) {
  for (const s of ['setup-screen', 'auth-screen', 'app-screen']) $('#' + s).hidden = s !== id;
}

async function setUser(user) {
  // Skip repeat events for the same person (e.g. token refresh), but always handle the first one.
  if (state.authReady && user?.id === state.user?.id) return;
  state.authReady = true;
  state.user = user;
  if (!user) {
    state.titles = [];
    state.tmdbToken = null;
    show('auth-screen');
    return;
  }
  $('#account-initial').textContent = (user.email || '?')[0];
  $('#account-email').textContent = user.email;
  show('app-screen');

  // Paint the last saved list right away, then refresh from the server.
  state.titles = readCache();
  render();
  await loadTitles();
  loadTmdbToken();
}

// ---------- Data ----------

const cacheKey = () => `couchlist:titles:${state.user.id}`;

function readCache() {
  try { return JSON.parse(localStorage.getItem(cacheKey())) || []; } catch { return []; }
}

function writeCache() {
  try { localStorage.setItem(cacheKey(), JSON.stringify(state.titles)); } catch {}
}

async function loadTitles() {
  const { data, error } = await supabase.from('titles').select('*').order('updated_at', { ascending: false });
  $('#offline-banner').hidden = !error;
  if (error) return;
  state.titles = data;
  writeCache();
  render();
}

// The TMDB token lives in Supabase (readable only by signed-in users) so it isn't in the public repo.
async function loadTmdbToken() {
  const { data } = await supabase.from('app_config').select('value').eq('key', 'tmdb_token').maybeSingle();
  state.tmdbToken = data?.value || null;
}

async function tmdb(path, params = {}) {
  if (!state.tmdbToken) throw new Error('no-token');
  const url = new URL(TMDB_API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${state.tmdbToken}` } });
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

// ---------- Main list ----------

function render() {
  const counts = { watching: 0, plan: 0, finished: 0 };
  for (const t of state.titles) counts[t.status]++;
  for (const tab of $$('.tab')) {
    tab.classList.toggle('active', tab.dataset.status === state.tab);
    tab.querySelector('.count').textContent = counts[tab.dataset.status] || '';
  }

  renderServiceChips();

  const text = state.text.trim().toLowerCase();
  const rows = state.titles.filter((t) =>
    t.status === state.tab &&
    (!state.serviceFilter || t.service === state.serviceFilter) &&
    (!text || [t.name, t.notes, t.recommended_by, t.service].some((f) => f?.toLowerCase().includes(text))),
  );

  $('#title-list').innerHTML = rows.map(rowHtml).join('');

  const empty = $('#empty-state');
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    empty.innerHTML = state.titles.length === 0
      ? '<strong>Your list is empty</strong>Tap + to add something you\'re watching or want to watch.'
      : `<strong>Nothing here</strong>No ${STATUS_LABELS[state.tab].toLowerCase()} titles${state.serviceFilter || text ? ' match your filters' : ''}.`;
  }
}

function rowHtml(t) {
  const poster = t.poster_path
    ? `<img class="poster" src="${TMDB_IMG}${esc(t.poster_path)}" alt="" loading="lazy">`
    : `<div class="poster">${esc(t.name[0] || '?')}</div>`;
  const meta = [
    t.service ? `<span class="service-badge">${esc(t.service)}</span>` : '',
    `<span>${t.media_type === 'movie' ? 'Movie' : 'Show'}${t.year ? ' · ' + t.year : ''}</span>`,
    t.recommended_by ? `<span>· from ${esc(t.recommended_by)}</span>` : '',
  ].join('');
  return `<li><button class="title-row" data-id="${t.id}">
    ${poster}
    <div class="title-main">
      <p class="title-name">${esc(t.name)}</p>
      <div class="title-meta">${meta}</div>
      ${t.notes ? `<p class="title-note">${esc(t.notes)}</p>` : ''}
    </div>
  </button></li>`;
}

function renderServiceChips() {
  const used = [...new Set(state.titles.map((t) => t.service).filter(Boolean))].sort();
  if (state.serviceFilter && !used.includes(state.serviceFilter)) state.serviceFilter = null;
  const chips = $('#service-chips');
  chips.hidden = used.length < 2;
  chips.innerHTML = ['All', ...used].map((s) => {
    const active = s === 'All' ? !state.serviceFilter : state.serviceFilter === s;
    return `<button class="chip${active ? ' active' : ''}" data-service="${esc(s)}">${esc(s)}</button>`;
  }).join('');
}

// ---------- Add: search ----------

let searchTimer;
let searchSeq = 0;

function openSearch() {
  $('#search-input').value = '';
  $('#search-results').innerHTML = state.tmdbToken
    ? ''
    : '<li class="status-line">Title lookup isn\'t set up yet. You can still add titles manually.</li>';
  $('#search-sheet').showModal();
  $('#search-input').focus();
}

function onSearchInput() {
  clearTimeout(searchTimer);
  const q = $('#search-input').value.trim();
  if (q.length < 2) { $('#search-results').innerHTML = ''; return; }
  searchTimer = setTimeout(() => runSearch(q), 300);
}

async function runSearch(q) {
  const seq = ++searchSeq;
  const list = $('#search-results');
  list.innerHTML = '<li class="status-line">Searching…</li>';
  try {
    const data = await tmdb('/search/multi', { query: q, include_adult: 'false' });
    if (seq !== searchSeq) return;
    const hits = data.results.filter((r) => r.media_type === 'tv' || r.media_type === 'movie').slice(0, 12);
    list.innerHTML = hits.length
      ? hits.map((r, i) => {
          const name = r.name || r.title;
          const year = (r.first_air_date || r.release_date || '').slice(0, 4);
          const tracked = state.titles.some((t) => t.tmdb_id === r.id && t.media_type === r.media_type);
          const poster = r.poster_path
            ? `<img class="poster" src="${TMDB_IMG}${esc(r.poster_path)}" alt="" loading="lazy">`
            : `<div class="poster">${esc(name[0] || '?')}</div>`;
          return `<li><button class="title-row" data-index="${i}">
            ${poster}
            <div class="title-main">
              <p class="title-name">${esc(name)}</p>
              <div class="title-meta"><span>${r.media_type === 'movie' ? 'Movie' : 'Show'}${year ? ' · ' + year : ''}</span>
              ${tracked ? '<span class="service-badge">On your list</span>' : ''}</div>
            </div>
          </button></li>`;
        }).join('')
      : '<li class="status-line">No matches. Try another spelling, or add it manually.</li>';
    list._hits = hits;
  } catch (err) {
    if (seq !== searchSeq) return;
    list.innerHTML = err.message === 'no-token'
      ? '<li class="status-line">Title lookup isn\'t set up yet. Add it manually below.</li>'
      : '<li class="status-line">Couldn\'t reach the title database. Check your connection or add it manually.</li>';
  }
}

async function pickSearchResult(hit) {
  $('#search-sheet').close();
  openEditor({
    tmdb_id: hit.id,
    media_type: hit.media_type,
    name: hit.name || hit.title,
    year: parseInt((hit.first_air_date || hit.release_date || '').slice(0, 4), 10) || null,
    poster_path: hit.poster_path,
    service: null,
    status: 'plan',
    notes: '',
    recommended_by: '',
  });
  suggestServices(hit);
}

// Ask TMDB/JustWatch where it streams and highlight those services.
async function suggestServices(hit) {
  const hint = $('#provider-hint');
  try {
    const data = await tmdb(`/${hit.media_type}/${hit.id}/watch/providers`);
    if (state.editing?.tmdb_id !== hit.id) return;
    const region = data.results?.[WATCH_REGION];
    const names = [...(region?.flatrate || []), ...(region?.free || []), ...(region?.ads || [])].map((p) => p.provider_name);
    const matched = [...new Set(names.map(toServiceName))];
    if (!matched.length) {
      hint.textContent = 'Not on a subscription service right now.';
      hint.hidden = false;
      return;
    }
    hint.textContent = 'Streams on: ' + matched.join(', ');
    hint.hidden = false;
    state.suggested = matched;
    // Pre-select the service when there's only one sensible answer.
    if (matched.length === 1 && !state.editing.service) state.editing.service = matched[0];
    renderEditServices();
  } catch {
    // Suggestions are a nice-to-have; the form works without them.
  }
}

function toServiceName(providerName) {
  return SERVICES.find((s) => s.match.test(providerName))?.name || providerName;
}

// ---------- Add / edit details ----------

function openEditor(row) {
  state.editing = { ...row };
  state.suggested = [];
  const isNew = !row.id;
  $('#edit-heading').textContent = isNew ? 'Add to your list' : 'Details';
  $('#edit-name').value = row.name || '';
  $('#edit-recommended').value = row.recommended_by || '';
  $('#edit-notes').value = row.notes || '';
  $('#edit-delete').hidden = isNew;
  $('#edit-message').hidden = true;
  $('#provider-hint').hidden = true;
  const img = $('#edit-poster');
  img.hidden = !row.poster_path;
  if (row.poster_path) img.src = TMDB_IMG + row.poster_path;
  renderEditServices();
  renderSeg('#edit-type', row.media_type);
  renderSeg('#edit-status', row.status);
  $('#edit-sheet').showModal();
  if (isNew && !row.name) $('#edit-name').focus();
}

function renderSeg(sel, value) {
  for (const b of $$(sel + ' button')) b.classList.toggle('active', b.dataset.value === value);
}

function renderEditServices() {
  const current = state.editing.service;
  const known = SERVICES.map((s) => s.name);
  const isOther = state.editing.otherMode || (current && !known.includes(current));
  const suggested = state.suggested || [];
  $('#edit-services').innerHTML = [...known, OTHER].map((name) => {
    const active = name === OTHER ? isOther : current === name && !isOther;
    const cls = ['chip', active && 'active', suggested.includes(name) && 'suggested'].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-service="${esc(name)}">${esc(name)}</button>`;
  }).join('');
  const other = $('#edit-service-other');
  other.hidden = !isOther;
  if (isOther && document.activeElement !== other) other.value = known.includes(current) ? '' : current || '';
}

function onServiceChip(name) {
  const e = state.editing;
  if (name === OTHER) {
    e.otherMode = !e.otherMode;
    e.service = e.otherMode ? $('#edit-service-other').value.trim() || null : null;
    renderEditServices();
    if (e.otherMode) $('#edit-service-other').focus();
    return;
  }
  e.otherMode = false;
  e.service = e.service === name ? null : name;
  renderEditServices();
}

async function saveEditor(ev) {
  ev.preventDefault();
  const e = state.editing;
  const name = $('#edit-name').value.trim();
  if (!name) return;
  const row = {
    name,
    media_type: e.media_type || 'tv',
    status: e.status || 'plan',
    service: e.service || null,
    notes: $('#edit-notes').value.trim() || null,
    recommended_by: $('#edit-recommended').value.trim() || null,
    tmdb_id: e.tmdb_id || null,
    year: e.year || null,
    poster_path: e.poster_path || null,
    updated_at: new Date().toISOString(),
  };

  const btn = $('#edit-save');
  btn.disabled = true;
  const { data, error } = e.id
    ? await supabase.from('titles').update(row).eq('id', e.id).select().single()
    : await supabase.from('titles').insert(row).select().single();
  btn.disabled = false;

  if (error) {
    showMessage('#edit-message', navigator.onLine ? 'Couldn\'t save: ' + error.message : 'You\'re offline. Try again when connected.');
    return;
  }
  state.titles = [data, ...state.titles.filter((t) => t.id !== data.id)];
  state.tab = data.status;
  writeCache();
  render();
  $('#edit-sheet').close();
}

async function deleteEditing() {
  const e = state.editing;
  if (!confirm(`Remove "${e.name}" from your list?`)) return;
  const { error } = await supabase.from('titles').delete().eq('id', e.id);
  if (error) { showMessage('#edit-message', 'Couldn\'t delete: ' + error.message); return; }
  state.titles = state.titles.filter((t) => t.id !== e.id);
  writeCache();
  render();
  $('#edit-sheet').close();
}

// ---------- Auth ----------

function setAuthMode(signUp) {
  state.signUpMode = signUp;
  $('#auth-subtitle').textContent = signUp ? 'Create your account' : 'Sign in to your list';
  $('#auth-submit').textContent = signUp ? 'Create account' : 'Sign in';
  $('#auth-toggle').textContent = signUp ? 'Already have an account? Sign in' : 'New here? Create an account';
  $('#auth-password').autocomplete = signUp ? 'new-password' : 'current-password';
  $('#auth-message').hidden = true;
}

async function submitAuth(ev) {
  ev.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const btn = $('#auth-submit');
  btn.disabled = true;
  const { data, error } = state.signUpMode
    ? await supabase.auth.signUp({ email, password })
    : await supabase.auth.signInWithPassword({ email, password });
  btn.disabled = false;
  if (error) { showMessage('#auth-message', error.message); return; }
  if (state.signUpMode && !data.session) {
    setAuthMode(false);
    showMessage('#auth-message', 'Check your email to confirm your account, then sign in.', true);
  }
}

// ---------- Wiring ----------

function wireUi() {
  $('#auth-form').addEventListener('submit', submitAuth);
  $('#auth-toggle').addEventListener('click', () => setAuthMode(!state.signUpMode));

  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => { state.tab = tab.dataset.status; render(); });
  }
  $('#filter-text').addEventListener('input', (e) => { state.text = e.target.value; render(); });
  $('#service-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.serviceFilter = chip.dataset.service === 'All' ? null : chip.dataset.service;
    render();
  });
  $('#title-list').addEventListener('click', (e) => {
    const row = e.target.closest('.title-row');
    const title = row && state.titles.find((t) => t.id === row.dataset.id);
    if (title) openEditor(title);
  });

  $('#add-btn').addEventListener('click', openSearch);
  $('#search-input').addEventListener('input', onSearchInput);
  $('#search-results').addEventListener('click', (e) => {
    const row = e.target.closest('.title-row');
    if (row) pickSearchResult($('#search-results')._hits[row.dataset.index]);
  });
  $('#manual-add').addEventListener('click', () => {
    const typed = $('#search-input').value.trim();
    $('#search-sheet').close();
    openEditor({ name: typed, media_type: 'tv', status: 'plan', service: null });
  });

  $('#edit-form').addEventListener('submit', saveEditor);
  $('#edit-delete').addEventListener('click', deleteEditing);
  $('#edit-services').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) onServiceChip(chip.dataset.service);
  });
  $('#edit-service-other').addEventListener('input', (e) => { state.editing.service = e.target.value.trim() || null; });
  $('#edit-type').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { state.editing.media_type = b.dataset.value; renderSeg('#edit-type', b.dataset.value); }
  });
  $('#edit-status').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { state.editing.status = b.dataset.value; renderSeg('#edit-status', b.dataset.value); }
  });

  $('#account-btn').addEventListener('click', () => $('#account-sheet').showModal());
  $('#sign-out').addEventListener('click', async () => {
    $('#account-sheet').close();
    await supabase.auth.signOut();
  });

  // Close buttons, and tapping the dimmed backdrop, close any sheet.
  for (const dlg of $$('dialog')) {
    dlg.addEventListener('click', (e) => {
      const r = dlg.getBoundingClientRect();
      const outside = e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right;
      if ((e.target === dlg && outside) || e.target.closest('[data-close]')) dlg.close();
    });
  }

  window.addEventListener('online', loadTitles);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user) loadTitles();
  });
}

function showMessage(sel, text, ok = false) {
  const el = $(sel);
  el.textContent = text;
  el.classList.toggle('ok', ok);
  el.hidden = false;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
