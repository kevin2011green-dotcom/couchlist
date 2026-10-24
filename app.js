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

// Starter categories. People can add their own; those show up as choices once used.
const PRESET_CATEGORIES = [
  'Action', 'Comedy', 'Drama', 'Mystery', 'Thriller', 'Sci-Fi', 'Horror', 'Romance', 'Crime',
  'Holiday', 'Feel-good', 'Tearjerker', 'Family', 'Animated', 'Documentary', 'Reality',
];
// TMDB genre ids (movie and TV) mapped onto the starter categories, used to pre-tick new titles.
const GENRE_CATEGORIES = {
  28: 'Action', 12: 'Action', 10759: 'Action', 35: 'Comedy', 18: 'Drama', 9648: 'Mystery',
  53: 'Thriller', 878: 'Sci-Fi', 14: 'Sci-Fi', 10765: 'Sci-Fi', 27: 'Horror', 10749: 'Romance',
  80: 'Crime', 10751: 'Family', 10762: 'Family', 16: 'Animated', 99: 'Documentary', 10764: 'Reality',
};
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
  categoryFilter: null,
  text: '',
  tmdbToken: null,
  editing: null, // the row being edited, or a draft for a new one
  signUpMode: false,
  suggestions: [], // suggestions friends have sent me
  suggesting: null, // the title I'm about to suggest to a friend
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
    state.suggestions = [];
    state.tmdbToken = null;
    renderInboxBadge();
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
  loadProfile();
  loadSuggestions();
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
  const services = [...new Set(state.titles.map((t) => t.service).filter(Boolean))].sort();
  if (!services.includes(state.serviceFilter)) state.serviceFilter = null;
  const categories = usedCategories();
  if (!categories.includes(state.categoryFilter)) state.categoryFilter = null;
  renderFilterSelect('#service-filter', services, state.serviceFilter, 'All services');
  renderFilterSelect('#category-filter', categories, state.categoryFilter, 'All categories');

  // Filters apply across all tabs, so the tab counts show where matching titles are.
  const text = state.text.trim().toLowerCase();
  const filtered = state.titles.filter((t) =>
    (!state.serviceFilter || t.service === state.serviceFilter) &&
    (!state.categoryFilter || t.categories?.includes(state.categoryFilter)) &&
    (!text || [t.name, t.notes, t.recommended_by, t.service, ...(t.categories || [])].some((f) => f?.toLowerCase().includes(text))),
  );
  const counts = { watching: 0, plan: 0, finished: 0 };
  for (const t of filtered) counts[t.status]++;
  for (const tab of $$('.tab')) {
    tab.classList.toggle('active', tab.dataset.status === state.tab);
    tab.querySelector('.count').textContent = counts[tab.dataset.status] || '';
  }

  const rows = filtered.filter((t) => t.status === state.tab);
  $('#title-list').innerHTML = rows.map(rowHtml).join('');

  const empty = $('#empty-state');
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    const filteredOut = state.serviceFilter || state.categoryFilter || text;
    empty.innerHTML = state.titles.length === 0
      ? '<strong>Your list is empty</strong>Tap + to add something you\'re watching or want to watch.'
      : `<strong>Nothing here</strong>No ${STATUS_LABELS[state.tab].toLowerCase()} titles${filteredOut ? ' match your filters' : ''}.`;
  }
}

// Categories on my titles, in starter-list order, then my own ones alphabetically.
function usedCategories() {
  const used = new Set(state.titles.flatMap((t) => t.categories || []));
  const custom = [...used].filter((c) => !PRESET_CATEGORIES.includes(c)).sort();
  return [...PRESET_CATEGORIES.filter((c) => used.has(c)), ...custom];
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
      ${t.categories?.length ? `<p class="title-cats">${t.categories.map(esc).join(' · ')}</p>` : ''}
      ${t.notes ? `<p class="title-note">${esc(t.notes)}</p>` : ''}
    </div>
  </button></li>`;
}

// A filter dropdown; the first option ("All ...") clears the filter. Hidden until there's something to filter by.
function renderFilterSelect(sel, values, active, allLabel) {
  const select = $(sel);
  select.hidden = values.length < 2 && !active;
  select.innerHTML = [
    `<option value="">${allLabel}</option>`,
    ...values.map((v) => `<option value="${esc(v)}"${v === active ? ' selected' : ''}>${esc(v)}</option>`),
  ].join('');
  select.classList.toggle('active', !!active);
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
    categories: [...new Set((hit.genre_ids || []).map((g) => GENRE_CATEGORIES[g]).filter(Boolean))],
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
  state.editing = { ...row, categories: [...(row.categories || [])] };
  state.suggested = [];
  const isNew = !row.id;
  $('#edit-heading').textContent = isNew ? 'Add to your list' : 'Details';
  $('#edit-name').value = row.name || '';
  $('#edit-recommended').value = row.recommended_by || '';
  $('#edit-notes').value = row.notes || '';
  $('#edit-delete').hidden = isNew;
  $('#edit-suggest').hidden = isNew;
  $('#edit-message').hidden = true;
  $('#provider-hint').hidden = true;
  const img = $('#edit-poster');
  img.hidden = !row.poster_path;
  if (row.poster_path) img.src = TMDB_IMG + row.poster_path;
  renderEditServices();
  toggleCategoryPanel(false);
  renderEditCategories();
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

function renderEditCategories() {
  const picked = state.editing.categories;
  const mine = usedCategories().filter((c) => !PRESET_CATEGORIES.includes(c));
  const extra = picked.filter((c) => !PRESET_CATEGORIES.includes(c) && !mine.includes(c));
  $('#edit-categories').innerHTML = [...PRESET_CATEGORIES, ...mine, ...extra]
    .map((c) => `<label class="check"><input type="checkbox" value="${esc(c)}"${picked.includes(c) ? ' checked' : ''}>${esc(c)}</label>`)
    .join('');
  renderCategorySummary();
}

function renderCategorySummary() {
  const summary = $('#cat-summary');
  const picked = state.editing.categories;
  summary.textContent = picked.length ? picked.join(', ') : 'None, tap to choose';
  summary.classList.toggle('none', !picked.length);
}

function toggleCategoryPanel(open) {
  $('#cat-panel').hidden = !open;
  $('#cat-toggle').setAttribute('aria-expanded', String(open));
}

function onCategoryCheck(name, checked) {
  const picked = state.editing.categories.filter((c) => c !== name);
  state.editing.categories = checked ? [...picked, name] : picked;
  renderCategorySummary();
}

// Adds what's typed in the "New category" box, reusing an existing category if only the case differs.
function addNewCategory() {
  const input = $('#edit-category-new');
  const typed = input.value.trim().replace(/\s+/g, ' ');
  input.value = '';
  if (!typed) return;
  const known = [...PRESET_CATEGORIES, ...usedCategories(), ...state.editing.categories];
  const name = known.find((c) => c.toLowerCase() === typed.toLowerCase()) || typed;
  if (!state.editing.categories.includes(name)) state.editing.categories.push(name);
  renderEditCategories();
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
    categories: e.categories,
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
  if (e.fromSuggestion) removeSuggestion(e.fromSuggestion);
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

// ---------- Profile ----------

async function loadProfile() {
  const { data } = await supabase.from('profiles').select('display_name').eq('id', state.user.id).maybeSingle();
  $('#profile-name').value = data?.display_name || '';
}

async function saveProfile(ev) {
  ev.preventDefault();
  const display_name = $('#profile-name').value.trim() || null;
  const { error } = await supabase.from('profiles').upsert({ id: state.user.id, display_name });
  showMessage('#profile-message', error ? 'Couldn\'t save: ' + error.message : 'Saved.', !error);
}

// ---------- Suggest to a friend ----------

const friendsKey = () => `couchlist:friends:${state.user.id}`;

function readFriends() {
  try { return JSON.parse(localStorage.getItem(friendsKey())) || []; } catch { return []; }
}

function rememberFriend(email) {
  const friends = [email, ...readFriends().filter((f) => f !== email)].slice(0, 8);
  try { localStorage.setItem(friendsKey(), JSON.stringify(friends)); } catch {}
}

function openSuggest() {
  const e = state.editing;
  state.suggesting = state.titles.find((t) => t.id === e.id) || e;
  $('#edit-sheet').close();
  $('#suggest-title').textContent = state.suggesting.name;
  $('#suggest-email').value = '';
  $('#suggest-note').value = '';
  $('#suggest-message').hidden = true;
  $('#suggest-friends').innerHTML = readFriends()
    .map((f) => `<button type="button" class="chip" data-email="${esc(f)}">${esc(f)}</button>`)
    .join('');
  $('#suggest-sheet').showModal();
}

async function sendSuggestion(ev) {
  ev.preventDefault();
  const t = state.suggesting;
  const email = $('#suggest-email').value.trim().toLowerCase();
  const btn = $('#suggest-send');
  btn.disabled = true;
  const { error } = await supabase.rpc('send_suggestion', {
    recipient_email: email,
    p_name: t.name,
    p_media_type: t.media_type,
    p_tmdb_id: t.tmdb_id || null,
    p_year: t.year || null,
    p_poster_path: t.poster_path || null,
    p_service: t.service || null,
    p_message: $('#suggest-note').value.trim() || null,
  });
  btn.disabled = false;
  if (error) {
    showMessage('#suggest-message', navigator.onLine ? error.message : 'You\'re offline. Try again when connected.');
    return;
  }
  rememberFriend(email);
  showMessage('#suggest-message', `Sent to ${email}.`, true);
  setTimeout(() => $('#suggest-sheet').close(), 1200);
}

// ---------- Suggestions inbox ----------

async function loadSuggestions() {
  const { data, error } = await supabase.from('suggestions').select('*').order('created_at', { ascending: false });
  if (error) return;
  state.suggestions = data;
  renderInboxBadge();
  if ($('#inbox-sheet').open) renderInbox();
}

function renderInboxBadge() {
  const n = state.suggestions.length;
  const badge = $('#inbox-badge');
  badge.hidden = n === 0;
  badge.textContent = n;
  $('#inbox-btn').classList.toggle('has-items', n > 0);
}

function onMyList(s) {
  return state.titles.some((t) =>
    (s.tmdb_id && t.tmdb_id === s.tmdb_id && t.media_type === s.media_type) ||
    t.name.toLowerCase() === s.name.toLowerCase(),
  );
}

function renderInbox() {
  const list = $('#inbox-list');
  if (!state.suggestions.length) {
    list.innerHTML = '<li class="status-line">No suggestions right now. When a friend suggests something, it shows up here.</li>';
    return;
  }
  list.innerHTML = state.suggestions.map((s) => {
    const poster = s.poster_path
      ? `<img class="poster" src="${TMDB_IMG}${esc(s.poster_path)}" alt="" loading="lazy">`
      : `<div class="poster">${esc(s.name[0] || '?')}</div>`;
    const meta = [
      s.service ? `<span class="service-badge">${esc(s.service)}</span>` : '',
      `<span>${s.media_type === 'movie' ? 'Movie' : 'Show'}${s.year ? ' · ' + s.year : ''}</span>`,
      onMyList(s) ? '<span>· already on your list</span>' : '',
    ].join('');
    return `<li class="suggestion" data-id="${s.id}">
      <div class="suggestion-top">
        ${poster}
        <div class="title-main">
          <p class="suggestion-from">From ${esc(s.sender_name)}</p>
          <p class="title-name">${esc(s.name)}</p>
          <div class="title-meta">${meta}</div>
          ${s.message ? `<p class="suggestion-msg">"${esc(s.message)}"</p>` : ''}
        </div>
      </div>
      <div class="suggestion-actions">
        <button class="secondary" data-action="decline">No thanks</button>
        <button class="primary" data-action="add">Add to my list</button>
      </div>
    </li>`;
  }).join('');
}

function openInbox() {
  renderInbox();
  $('#inbox-sheet').showModal();
  loadSuggestions();
}

function acceptSuggestion(s) {
  $('#inbox-sheet').close();
  openEditor({
    tmdb_id: s.tmdb_id,
    media_type: s.media_type,
    name: s.name,
    year: s.year,
    poster_path: s.poster_path,
    service: s.service,
    status: 'plan',
    notes: s.message || '',
    recommended_by: s.sender_name,
    fromSuggestion: s.id,
  });
  if (s.tmdb_id) suggestServices({ id: s.tmdb_id, media_type: s.media_type });
}

async function removeSuggestion(id) {
  const { error } = await supabase.from('suggestions').delete().eq('id', id);
  if (error) return false;
  state.suggestions = state.suggestions.filter((s) => s.id !== id);
  renderInboxBadge();
  if ($('#inbox-sheet').open) renderInbox();
  return true;
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
  $('#service-filter').addEventListener('change', (e) => { state.serviceFilter = e.target.value || null; render(); });
  $('#category-filter').addEventListener('change', (e) => { state.categoryFilter = e.target.value || null; render(); });
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
  $('#cat-toggle').addEventListener('click', () => toggleCategoryPanel($('#cat-panel').hidden));
  $('#edit-categories').addEventListener('change', (e) => onCategoryCheck(e.target.value, e.target.checked));
  $('#edit-category-new').addEventListener('keydown', (e) => {
    // Enter adds the category instead of submitting the whole form.
    if (e.key === 'Enter') { e.preventDefault(); addNewCategory(); }
  });
  $('#edit-category-new').addEventListener('blur', addNewCategory);
  $('#edit-type').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { state.editing.media_type = b.dataset.value; renderSeg('#edit-type', b.dataset.value); }
  });
  $('#edit-status').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) { state.editing.status = b.dataset.value; renderSeg('#edit-status', b.dataset.value); }
  });

  $('#edit-suggest').addEventListener('click', openSuggest);
  $('#suggest-form').addEventListener('submit', sendSuggestion);
  $('#suggest-friends').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (chip) $('#suggest-email').value = chip.dataset.email;
  });

  $('#inbox-btn').addEventListener('click', openInbox);
  $('#inbox-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    const s = btn && state.suggestions.find((x) => x.id === btn.closest('.suggestion').dataset.id);
    if (!s) return;
    if (btn.dataset.action === 'add') acceptSuggestion(s);
    else {
      btn.disabled = true;
      if (!(await removeSuggestion(s.id))) btn.disabled = false;
    }
  });

  $('#profile-form').addEventListener('submit', saveProfile);
  $('#account-btn').addEventListener('click', () => {
    $('#profile-message').hidden = true;
    $('#account-sheet').showModal();
  });
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

  const refresh = () => {
    if (!state.user) return;
    loadTitles();
    loadSuggestions();
  };
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
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
