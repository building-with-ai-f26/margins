/* Margins: story bible, versions, and a tabbed continuity report.
 * Data is saved to the author's own account (private to them) when available,
 * otherwise in this browser. AI work is done by Claude through the page's "sample" capability. */
(() => {
'use strict';

// ---------- helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const countWords = (t) => (String(t || '').match(/\S+/g) || []).length;
const when = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clone = (o) => JSON.parse(JSON.stringify(o));
const AI_LIMIT = 60000; // characters sent to the AI per run (~10,000 words)

const track = (ev, props) => { try { if (window.posthog && window.posthog.capture) window.posthog.capture(ev, props || {}); } catch (_) {} };
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---------- storage ----------
// Where work is saved, best first: the author's Claude account (db) → the local server (server.py, saves on
// this computer) → this browser (localStorage) → memory. Every path is prefixed with the signed-in email,
// so each person only sees their own manuscripts, Glossary and history.
// Live site: Supabase handles sign-in (email + password), saving (docs table, locked per account by row-level
// security) and AI (the smart-task function, 30 requests per person per day). These two values are public by design.
const SUPABASE_URL = 'https://gchfavopupbaacjbrcoh.supabase.co';
const SUPABASE_KEY = 'sb_publishable_H014YhcL-dqnGwVhql4O8w_KEtEqjYK';
const AI_FN = 'smart-task';
const isCloud = () => Store.mode === 'cloud' || (S.demo && Store.realMode === 'cloud');
const emailKey = (email) => String(email).trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, '-');
const Store = {
  mode: 'memory', db: null, uid: null, mem: {}, ns: '',
  async init() {
    try {
      if (window.claude && claude.use) {
        const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
        const id = db && user ? await user.id() : null;
        if (id) { this.db = db; this.uid = id; this.mode = 'account'; return; }
      }
    } catch (_) { /* fall through */ }
    try {
      if (window.supabase && supabase.createClient && /^https?:/.test(location.protocol)) {
        this.sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
        this.mode = 'cloud'; return;
      }
    } catch (_) { /* fall through */ }
    try {
      if (!/^https?:/.test(location.protocol)) throw 0;
      const h = await fetch('/api/health', { cache: 'no-store' });
      const j = h.ok ? await h.json() : null;
      if (j && j.store) { this.mode = 'server'; return; }
    } catch (_) { /* no local server */ }
    try { localStorage.setItem('margins:test', '1'); localStorage.removeItem('margins:test'); this.mode = 'browser'; } catch (_) { this.mode = 'memory'; }
  },
  setUser(email) { if (this.mode === 'cloud') { this.ns = ''; return; } this.ns = email ? 'accounts/' + emailKey(email) + '/' : ''; },
  full(p) { return 'data/users/' + this.uid + '/' + p; },
  async api(url, body) {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Couldn’t reach the Margins server. Is python3 server.py still running?');
    return d;
  },
  // raw* work on full paths; get/set/list add the signed-in user's prefix.
  async rawGet(p) {
    if (this.mode === 'account') { const s = await this.db.doc(this.full(p)).get(); return s.exists ? clone(s.data()) : null; }
    if (this.mode === 'cloud') { const { data, error } = await this.sb.from('docs').select('data').eq('user_id', this.uid).eq('path', p).maybeSingle(); if (error) throw new Error(error.message); return data ? data.data : null; }
    if (this.mode === 'server') return (await this.api('/api/store?path=' + encodeURIComponent(p))).data || null;
    const raw = this.mode === 'browser' ? localStorage.getItem('margins:' + p) : this.mem[p];
    return raw ? JSON.parse(raw) : null;
  },
  async rawSet(p, data) {
    if (this.mode === 'account') return this.db.doc(this.full(p)).set(data);
    if (this.mode === 'cloud') { const { error } = await this.sb.from('docs').upsert({ user_id: this.uid, path: p, data, updated_at: new Date().toISOString() }, { onConflict: 'user_id,path' }); if (error) throw new Error('Couldn’t save to your account: ' + error.message); return; }
    if (this.mode === 'server') return this.api('/api/store', { path: p, data });
    const raw = JSON.stringify(data);
    if (this.mode === 'browser') localStorage.setItem('margins:' + p, raw); else this.mem[p] = raw;
  },
  async rawList(col) {
    if (this.mode === 'account') { const q = await this.db.collection(this.full(col)).get(); return q.docs.map((d) => ({ ...clone(d.data()), id: d.id })); }
    if (this.mode === 'cloud') {
      const pre = col + '/';
      const { data, error } = await this.sb.from('docs').select('path,data').eq('user_id', this.uid).like('path', pre.replace(/[%_]/g, '\\$&') + '%');
      if (error) throw new Error(error.message);
      return (data || []).filter((r) => !r.path.slice(pre.length).includes('/')).map((r) => ({ ...r.data, id: r.path.slice(pre.length) }));
    }
    if (this.mode === 'server') return (await this.api('/api/store/list?col=' + encodeURIComponent(col))).items || [];
    const keys = this.mode === 'browser' ? Object.keys(localStorage).filter((k) => k.startsWith('margins:')).map((k) => k.slice(8)) : Object.keys(this.mem);
    const pre = col + '/';
    return keys.filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map((k) => ({ ...JSON.parse(this.mode === 'browser' ? localStorage.getItem('margins:' + k) : this.mem[k]), id: k.slice(pre.length) }));
  },
  get(p) { return this.rawGet(this.ns + p); },
  set(p, data) { return this.rawSet(this.ns + p, data); },
  list(col) { return this.rawList(this.ns + col); },
};

// Remembered sign-in for this browser (no password in this MVP).
const Who = {
  get() { try { return localStorage.getItem('margins:user') || ''; } catch (_) { return ''; } },
  set(email) { try { email ? localStorage.setItem('margins:user', email) : localStorage.removeItem('margins:user'); } catch (_) {} },
  recent() { try { return JSON.parse(localStorage.getItem('margins:recent') || '[]'); } catch (_) { return []; } },
  remember(email) { try { localStorage.setItem('margins:recent', JSON.stringify([email, ...this.recent().filter((e) => e !== email)].slice(0, 5))); } catch (_) {} },
};

// ---------- state ----------
const S = {
  meta: { title: '', currentDraftId: null },
  drafts: [], bible: { characters: [], plotlines: [] }, bibleSaved: '',
  history: [], reports: {}, text: '', reportId: null, reportTab: 'summary', reportFilter: 'open',
  busy: '', error: '', ai: null, aiSource: '', compare: null, loaded: false,
  mode: 'edit', cat: 'grammar', sel: null, showResolved: false,
  user: '', next: 'manuscript', legacy: false, demo: false,
  edits: [], gconf: { items: [] }, savedAt: 0,
};
const FRESH = JSON.stringify({ meta: S.meta, drafts: [], bible: S.bible, bibleSaved: '', history: [], reports: {}, text: '', reportId: null, compare: null, mode: 'edit', cat: 'grammar', sel: null, showResolved: false, edits: [], gconf: { items: [] } });
const currentDraft = () => S.drafts.find((d) => d.id === S.meta.currentDraftId) || S.drafts[S.drafts.length - 1] || null;
const textDirty = () => S.text !== (currentDraft()?.text ?? '');
const bibleDirty = () => JSON.stringify(S.bible) !== S.bibleSaved;

async function loadUser() {
  Object.assign(S, JSON.parse(FRESH));
  Store.setUser(S.user);
  try {
    S.meta = (await Store.get('meta')) || S.meta;
    S.drafts = (await Store.list('meta/drafts')).sort((a, b) => a.n - b.n);
    const b = await Store.get('bible');
    if (b) S.bible = { characters: b.characters || [], plotlines: b.plotlines || [] };
    S.bibleSaved = JSON.stringify(S.bible);
    S.history = (await Store.list('meta/history')).sort((a, b) => b.at - a.at);
    for (const r of await Store.list('meta/reports')) S.reports[r.id] = r;
    const w = await Store.get('working');
    S.text = w && typeof w.text === 'string' ? w.text : (currentDraft()?.text || '');
    S.edits = (w && w.edits) || [];
    S.gconf = (await Store.get('glossaryconflicts')) || { items: [] };
    S.reportId = latestReportId();
    // Work saved before sign-in existed: offer to move it into this account (only while this account is empty).
    const legacy = Store.mode !== 'cloud' && !S.drafts.length && !S.history.length && !!(await Store.rawGet('meta')) && !(await Store.rawGet('legacymoved'));
    if (legacy) return moveLegacy();
  } catch (e) {
    S.error = 'Couldn’t load your saved work. ' + (e.message || '');
  }
}

// Test run: try Margins with a sample before signing in. Kept in memory only, never saved.
function startDemo() {
  if (!S.demo) { Store.realMode = Store.mode; Store.mode = 'memory'; Store.mem = {}; }
  Object.assign(S, JSON.parse(FRESH));
  S.demo = true; S.user = ''; Store.setUser(''); setCloudAI();
  S.text = SAMPLE; S.meta.title = 'The Partner (sample)';
  track('demo_started');
  location.hash = '#manuscript'; render();
}
const DEMO_LIMIT = 1000;
const overLimit = () => S.demo && countWords(S.text) > DEMO_LIMIT;
// In the demo, over 1,000 words the review buttons become "Sign in to review more than 1,000 words".
function updateLimit() {
  const over = overLimit();
  document.querySelectorAll('[data-act="review"],[data-act="scan"],[data-limit]').forEach((b) => {
    if (!b.dataset.orig) { b.dataset.orig = b.dataset.act; b.dataset.label = b.textContent; }
    if (over) {
      b.dataset.limit = '1';
      if (b.dataset.orig === 'scan') { b.hidden = true; return; }
      b.dataset.act = 'go-signin'; b.textContent = `Sign in to review more than ${DEMO_LIMIT.toLocaleString()} words`; b.disabled = false;
    } else if (b.dataset.limit) {
      delete b.dataset.limit; b.hidden = false; b.dataset.act = b.dataset.orig; b.textContent = b.dataset.label;
      b.disabled = b.dataset.orig === 'review' ? !S.text.trim() : !(currentDraft() && S.ai);
    }
  });
  const wc = $('#wc');
  if (wc) { wc.textContent = countWords(S.text).toLocaleString() + ' words' + (S.demo ? ` of ${DEMO_LIMIT.toLocaleString()} in this demo` : ''); wc.style.color = over ? 'var(--bad)' : ''; }
}
function endDemo() { if (S.demo) { Store.mode = Store.realMode; Store.mem = {}; S.demo = false; } }

// Live site AI: only for signed-in people, through the smart-task function (it checks sign-in and the daily limit).
function setCloudAI() {
  if (!isCloud()) return;
  if (!S.user || S.demo) { S.ai = null; S.aiSource = ''; return; }
  S.aiSource = 'gpt-4o-mini' + (S.aiUsed != null ? ` · ${S.aiUsed} of ${S.aiLimit} today` : '');
  S.ai = async (prompt) => {
    const { data, error } = await Store.sb.functions.invoke(AI_FN, { body: { prompt } });
    if (error) {
      let msg = 'The AI request failed.';
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (_) {}
      throw new Error(msg);
    }
    S.aiUsed = data.used; S.aiLimit = data.limit; S.aiSource = `gpt-4o-mini · ${data.used} of ${data.limit} today`;
    track('ai_call', { model: data.model, tokens_in: data.tokens_in, tokens_out: data.tokens_out, cost_usd: data.cost_usd, seconds: data.seconds });
    return { text: data.text };
  };
}
const authMsg = (e) => {
  const m = String((e && e.message) || e || '');
  if (/invalid login/i.test(m)) return 'That email and password don’t match. Check them, or choose “Create account” if you’re new.';
  if (/already registered|already exists/i.test(m)) return 'There’s already an account with this email. Choose “Sign in” instead.';
  if (/password/i.test(m) && /(least|short|weak|characters)/i.test(m)) return 'Please use a password with at least 6 characters.';
  if (/rate limit|too many/i.test(m)) return 'Too many tries. Wait a minute and try again.';
  return m || 'Sign-in didn’t work. Please try again.';
};

async function signIn(email, password, create) {
  const carry = S.demo ? { text: S.text, title: S.meta.title } : null;
  if (isCloud() && password !== undefined) {
    const sb = Store.sb, em = email.trim().toLowerCase();
    const { data, error } = create ? await sb.auth.signUp({ email: em, password }) : await sb.auth.signInWithPassword({ email: em, password });
    if (error) throw new Error(authMsg(error));
    if (!data.session) throw new Error('Your account was created, but email confirmation is turned on in Supabase. Turn off “Confirm email”, then sign in.');
    Store.uid = data.session.user.id;
    S.createMode = false;
    if (create) track('account_created');
  }
  endDemo();
  S.user = email.trim().toLowerCase();
  Who.set(S.user); Who.remember(S.user);
  await loadUser();
  setCloudAI();
  track('signed_in', { returning: S.drafts.length > 0, storage: Store.mode });
  if (carry && !S.drafts.length && !S.text.trim()) { S.text = carry.text; S.meta.title = S.meta.title || carry.title; }
  if (S.wantSample && !S.text.trim()) { S.text = SAMPLE; S.meta.title = S.meta.title || 'The Partner (sample)'; }
  S.wantSample = false;
  location.hash = '#' + (S.next || 'manuscript');
  render();
}
function signOut() {
  if (bibleDirty() && !S.confirmOut) { S.confirmOut = true; toast('You have unsaved Glossary edits. Click Sign out again to sign out anyway.'); setTimeout(() => (S.confirmOut = false), 5000); return; }
  S.confirmOut = false; S.user = ''; Who.set(''); Store.setUser('');
  if (Store.mode === 'cloud') { Store.sb.auth.signOut().catch(() => {}); Store.uid = null; }
  Object.assign(S, JSON.parse(FRESH));
  setCloudAI();
  track('signed_out');
  location.hash = '#home'; render();
}
async function moveLegacy() {
  const prev = Store.ns; Store.setUser('');
  const meta = await Store.get('meta'), bible = await Store.get('bible');
  const lists = {};
  for (const c of ['meta/drafts', 'meta/history', 'meta/reports']) lists[c] = await Store.list(c);
  Store.ns = prev;
  if (meta) await Store.set('meta', meta);
  if (bible) await Store.set('bible', bible);
  for (const [c, items] of Object.entries(lists)) for (const { id, ...body } of items) await Store.set(c + '/' + id, body);
  await Store.rawSet('legacymoved', { at: Date.now() });
  await loadUser();
}

const STORE_LABEL = { cloud: 'Saved to your Margins account', account: 'Saved to your Claude account', server: 'Saved on this computer', browser: 'Saved in this browser', memory: 'Not saved (storage unavailable)' };
async function load() {
  await Store.init();
  if (Store.mode === 'cloud') {
    // Signed in only if Supabase has a live session for this browser.
    try { const { data } = await Store.sb.auth.getSession(); const u = data.session && data.session.user; S.user = u ? u.email : ''; Store.uid = u ? u.id : null; } catch (_) { S.user = ''; }
    Who.set(S.user);
  } else S.user = Who.get();
  if (S.user) await loadUser();
  setCloudAI();
  if (Store.mode !== 'cloud') { try { S.ai = window.claude && claude.use ? await claude.use('sample') : null; if (S.ai) S.aiSource = 'Claude'; } catch (_) { S.ai = null; } }
  if (!S.ai && Store.mode !== 'cloud') {
    try {
      if (!/^https?:/.test(location.protocol)) throw 0;
      const h = await fetch('/api/health', { cache: 'no-store' });
      const j = h.ok ? await h.json() : null;
      if (j && j.ai) {
        S.aiSource = j.model;
        S.ai = async (prompt) => {
          const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || 'The AI request failed.');
          track('ai_call', { model: d.model, tokens_in: d.tokens_in, tokens_out: d.tokens_out, cost_usd: d.cost_usd, seconds: d.seconds });
          return { text: d.text };
        };
      }
    } catch (_) { /* not running locally: rule checks only */ }
  }
  S.loaded = true;
  render();
}
const latestReportId = () => Object.values(S.reports).sort((a, b) => b.createdAt - a.createdAt)[0]?.id || null;

async function busy(label, fn) {
  if (S.busy) return;
  S.busy = label; S.error = ''; render();
  try { await fn(); } catch (e) { S.error = e.message || String(e); }
  S.busy = ''; render();
}

// ---------- versions ----------
// Drafts are saved only when the author clicks "Update history".
// Between drafts, the current text is auto-saved as a working copy, with a log of applied fixes for undo.
async function saveDraft(note) {
  const n = S.drafts.reduce((m, d) => Math.max(m, d.n), 0) + 1;
  const d = { n, note: note || '', text: S.text, words: countWords(S.text), createdAt: Date.now() };
  if (JSON.stringify(d).length > 240000) throw new Error('This draft is too large to save in one piece (about 40,000 words). Save one part or a few chapters at a time.');
  const id = newId();
  await Store.set('meta/drafts/' + id, d);
  S.drafts.push({ ...d, id });
  S.meta.currentDraftId = id;
  await Store.set('meta', S.meta);
  await saveWorking(true);
  return { ...d, id };
}

let workingTimer;
async function saveWorking(now) {
  clearTimeout(workingTimer);
  const write = async () => {
    try {
      await Store.set('working', { text: S.text, draftId: S.meta.currentDraftId || null, updatedAt: Date.now(), edits: S.edits.slice(0, 50) });
      S.savedAt = Date.now(); const el = $('#autosave'); if (el) el.textContent = 'Auto-saved';
    } catch (e) { const el = $('#autosave'); if (el) el.textContent = 'Couldn’t auto-save'; }
  };
  if (now) return write();
  const el = $('#autosave'); if (el) el.textContent = 'Saving…';
  workingTimer = setTimeout(write, 900);
}

async function commitBible(note, source) {
  const entry = { at: Date.now(), note: note || '', source, snapshot: clone(S.bible) };
  const id = newId();
  await Store.set('bible', S.bible);
  await Store.set('meta/history/' + id, entry);
  S.history.unshift({ ...entry, id });
  S.bibleSaved = JSON.stringify(S.bible);
}

// ---------- AI ----------
function parseJSON(text) {
  try { return JSON.parse(text); } catch (_) { /* try to find the object */ }
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* fall through */ } }
  throw new Error('The AI reply couldn’t be read. Please try again.');
}
async function askAI(prompt) {
  if (!S.ai) throw new Error('AI isn’t available on this page right now. The free rule checks still work.');
  try {
    const res = await S.ai(prompt, { modelTier: 'default' });
    return parseJSON(res.text);
  } catch (e) {
    if (e && e.code === 'not_granted') { S.ai = null; throw new Error('AI access wasn’t allowed, so Margins used its free rule checks only.'); }
    if (e && e.code === 'rate_limited') throw new Error('The AI is busy. Wait a minute and try again.');
    throw e instanceof Error ? e : new Error(e?.message || 'The AI request failed.');
  }
}
const clip = (t) => (t.length > AI_LIMIT ? t.slice(0, AI_LIMIT) : t);
const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Find a quote in the text, ignoring case, spacing and curly quotes. Returns the exact text or null.
function locate(text, quote) {
  if (!quote) return null;
  if (text.includes(quote)) return quote;
  const norm = (s) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  const ws = norm(quote).split(/\s+/).filter(Boolean).map(reEsc);
  if (!ws.length) return null;
  const T = norm(text);
  const hit = (words) => { const m = new RegExp(words.join('\\s+'), 'i').exec(T); return m ? text.slice(m.index, m.index + m[0].length) : null; };
  const whole = hit(ws); if (whole) return whole;
  // AI quotes are sometimes slightly off: trim quote marks and ellipses, then try the longest matching run of 4+ words.
  const w2 = norm(quote).replace(/^[\s"'.…]+|[\s"'.…]+$/g, '').split(/\s+/).filter(Boolean).map(reEsc);
  for (let len = w2.length; len >= 4; len--) for (let i = 0; i + len <= w2.length; i++) { const r = hit(w2.slice(i, i + len)); if (r) return r; }
  return null;
}

// ---------- applying fixes to the text, with undo ----------
// A fix is { find, replace } (first match) or { find, replace, all: true } (every whole-word match).
// Each change is recorded as { at, old, new } so it can be undone exactly.
function applyFixes(fixes) {
  const ops = [];
  for (const fx of fixes || []) {
    if (!fx || !fx.find || fx.find === fx.replace) continue;
    if (fx.all) {
      const re = new RegExp('\\b' + reEsc(fx.find) + '\\b', 'g');
      let cursor = 0, m;
      while ((re.lastIndex = cursor, m = re.exec(S.text))) {
        S.text = S.text.slice(0, m.index) + fx.replace + S.text.slice(m.index + m[0].length);
        ops.push({ at: m.index, old: m[0], new: fx.replace });
        cursor = m.index + fx.replace.length;
      }
    } else {
      const exact = locate(S.text, fx.find); if (!exact) continue;
      const at = S.text.indexOf(exact);
      // keep the author's capitalisation at the start of the replaced words
      let rep = String(fx.replace);
      if (/^[A-Z]/.test(exact) && /^[a-z]/.test(rep) && exact.toLowerCase().startsWith(rep.slice(0, 1).toLowerCase())) rep = rep[0].toUpperCase() + rep.slice(1);
      S.text = S.text.slice(0, at) + rep + S.text.slice(at + exact.length);
      ops.push({ at, old: exact, new: rep });
    }
  }
  return ops;
}
function recordEdit(title, ops, link) {
  const ed = { id: newId(), at: Date.now(), title, ops, link: link || null };
  S.edits.unshift(ed); S.edits = S.edits.slice(0, 50);
  return ed;
}
function undoEdit(eid) {
  const ed = S.edits.find((x) => x.id === eid); if (!ed) return false;
  let ok = true;
  for (const op of [...ed.ops].reverse()) {
    let at = S.text.substr(op.at, op.new.length) === op.new ? op.at : S.text.indexOf(op.new, Math.max(0, op.at - 300));
    if (at < 0) at = S.text.indexOf(op.new);
    if (at < 0) { ok = false; continue; }
    S.text = S.text.slice(0, at) + op.old + S.text.slice(at + op.new.length);
  }
  S.edits = S.edits.filter((x) => x.id !== eid);
  // the suggestion this change came from goes back to open
  const f = findItem(ed.link); if (f) { f.status = 'open'; delete f.chosen; persistItems(f); }
  return ok;
}

// ---------- Glossary scan ----------
const GFIELDS = ['role', 'age', 'eyes', 'hair'];
async function scanBible() {
  if (overLimit()) throw new Error(`In the demo you can scan up to ${DEMO_LIMIT.toLocaleString()} words. Sign in to scan more.`);
  if (!S.text.trim()) throw new Error('Add your manuscript first.');
  const text = S.text;
  const scan = await askAI(`You are building a Glossary for a fiction manuscript: its characters and plotlines.
Only use facts stated in the text. Leave a field as "" if the text doesn't say. At most 25 characters and 10 plotlines. Notes: one short sentence.
Also list CONFLICTS: a character fact (age, eyes, hair, role) that the text states in two different ways, or that differs from the existing Glossary below.
For each conflict give one option per version, each with the value and the exact words from the text that state it ("quote", copied character for character; use "" for a value that comes only from the existing Glossary).
Do not list a fact as a conflict if it is only stated once and agrees with the Glossary.
Reply with JSON only, exactly this shape:
{"characters":[{"name":"","aliases":[],"role":"","age":"","eyes":"","hair":"","notes":""}],
 "plotlines":[{"title":"","summary":"","status":"open","keyEvents":[""]}],
 "conflicts":[{"name":"character name","field":"age|eyes|hair|role","title":"short heading","options":[{"value":"","quote":""}]}]}
status is "open" or "resolved".

Existing Glossary:
${JSON.stringify(S.bible)}

Manuscript:
"""
${clip(text)}
"""`);

  // 1. conflicts (checked first, so conflicting fields are not filled in yet)
  const items = [];
  const blocked = new Set();
  for (const c of scan.conflicts || []) {
    if (!c || !c.name || !GFIELDS.includes(c.field)) continue;
    const opts = (c.options || []).map((o) => ({ value: String(o.value || '').trim(), quote: o.quote ? locate(text, String(o.quote)) : null })).filter((o) => o.value);
    const values = [...new Set(opts.map((o) => o.value.toLowerCase()))];
    if (values.length < 2) continue;
    blocked.add(c.name.toLowerCase() + '|' + c.field);
    items.push(glossaryConflict(c.name, c.field, opts, c.title));
  }
  // 2. merge characters and plotlines; a scanned value that differs from the Glossary is also a conflict
  let added = 0, filled = 0;
  for (const c of scan.characters || []) {
    if (!c || !c.name) continue;
    const ex = findChar(c.name) || (c.aliases || []).map(findChar).find(Boolean);
    if (!ex) {
      const nc = normChar(c);
      for (const f of GFIELDS) if (blocked.has(nc.name.toLowerCase() + '|' + f)) nc[f] = '';
      S.bible.characters.push(nc); added++; continue;
    }
    for (const f of [...GFIELDS, 'notes']) {
      const v = String(c[f] || '').trim(); if (!v) continue;
      if (blocked.has(ex.name.toLowerCase() + '|' + f) || blocked.has(String(c.name).toLowerCase() + '|' + f)) continue;
      if (!ex[f]) { ex[f] = v; filled++; }
      else if (f !== 'notes' && ex[f].toLowerCase() !== v.toLowerCase() && !ex[f].toLowerCase().includes(v.toLowerCase())) {
        items.push(glossaryConflict(ex.name, f, [{ value: ex[f], quote: null, glossary: true }, { value: v, quote: null }], null));
      }
    }
    ex.aliases = [...new Set([...(ex.aliases || []), ...(c.aliases || []).map(String)])].filter((a) => a && a.toLowerCase() !== ex.name.toLowerCase());
  }
  for (const p of scan.plotlines || []) {
    if (!p || !p.title) continue;
    const ex = S.bible.plotlines.find((x) => x.title.toLowerCase() === String(p.title).toLowerCase());
    if (!ex) { S.bible.plotlines.push(normPlot(p)); added++; continue; }
    if (!ex.summary && p.summary) { ex.summary = String(p.summary); filled++; }
  }
  await commitBible(`Scan to Add to Glossary${text.length > AI_LIMIT ? ' (first ~10,000 words)' : ''}: ${added} added, ${filled} details filled${items.length ? `, ${items.length} conflict${items.length === 1 ? '' : 's'} to resolve` : ''}`, 'Scan');
  S.gconf = { items };
  await Store.set('glossaryconflicts', S.gconf);
  track('glossary_scanned', { added, filled, conflicts: items.length });
  if (items.length) {
    toast(`Glossary updated. ${items.length === 1 ? '1 conflict needs' : items.length + ' conflicts need'} your choice.`);
    S.cat = 'glossary'; S.mode = 'review'; S.sel = items[0].id; location.hash = '#manuscript';
  } else {
    toast(`Glossary updated: ${added} new, ${filled} details filled.`);
    location.hash = '#glossary';
  }
}
// A Glossary conflict: choosing an option sets the Glossary field and updates the other places in the text.
function glossaryConflict(name, field, opts, title) {
  const options = opts.map((o) => ({
    label: (o.glossary ? 'Glossary: ' : '') + o.value, value: o.value,
    fixes: opts.filter((x) => x !== o && x.quote).map((x) => ({ find: x.quote, replace: swapValue(x.quote, x.value, o.value) })).filter((fx) => fx.replace !== fx.find),
  }));
  return { id: newId(), source: 'Glossary scan', category: 'glossary', title: title || `${name}'s ${field}`, severity: 'high',
    explanation: `${name}'s ${field} is given as ${opts.map((o) => `"${o.value}"${o.glossary ? ' (Glossary)' : ''}`).join(' and ')}. Choose the correct one: it is saved to the Glossary and the text is updated to match.`,
    quotes: opts.map((o) => o.quote).filter(Boolean), options, target: { name, field }, status: 'open' };
}
const findChar = (name) => S.bible.characters.find((x) => [x.name, ...(x.aliases || [])].some((n) => n && n.toLowerCase() === String(name).toLowerCase()));
const normChar = (c) => ({ id: newId(), name: String(c.name || 'New character'), aliases: (c.aliases || []).map(String), role: String(c.role || ''), age: String(c.age || ''), eyes: String(c.eyes || ''), hair: String(c.hair || ''), notes: String(c.notes || '') });
const normPlot = (p) => ({ id: newId(), title: String(p.title || 'New plotline'), summary: String(p.summary || ''), status: p.status === 'resolved' ? 'resolved' : 'open', keyEvents: (p.keyEvents || []).map(String).filter(Boolean) });

// ---------- numbers and values inside a quote ----------
const W1 = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const W10 = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const toWords = (n) => (n < 20 ? W1[n] : W10[Math.floor(n / 10)] + (n % 10 ? '-' + W1[n % 10] : ''));
// Replace one value with another inside a quote: works for words ("blue" → "green") and ages (36 → 34, "thirty-six" → "thirty-four").
function swapValue(quote, from, to) {
  const f = String(from).trim(), t = String(to).trim();
  if (/^\d{1,2}$/.test(f) && /^\d{1,2}$/.test(t)) {
    if (new RegExp('\\b' + f + '\\b').test(quote)) return quote.replace(new RegExp('\\b' + f + '\\b'), t);
    const wf = toWords(+f), wt = toWords(+t);
    const m = new RegExp('\\b' + reEsc(wf).replace('-', '[- ]') + '\\b', 'i').exec(quote);
    if (m) return quote.slice(0, m.index) + (/^[A-Z]/.test(m[0]) ? wt[0].toUpperCase() + wt.slice(1) : wt) + quote.slice(m.index + m[0].length);
    return quote;
  }
  const re = new RegExp('\\b' + reEsc(f) + '\\b', 'i');
  const m = re.exec(quote);
  if (!m) return quote;
  const out = /^[A-Z]/.test(m[0]) ? t[0].toUpperCase() + t.slice(1) : t;
  return quote.slice(0, m.index) + out + quote.slice(m.index + m[0].length);
}

// ---------- review ----------
const RULE_CAT = { 'place-visit': 'timeline', 'never-met': 'characters', 'after-death': 'timeline', 'eye-colour': 'characters', 'hair-colour': 'characters', age: 'characters', 'only-child': 'characters', 'name-spelling': 'details' };
// Turn a rule-check finding into a suggestion with "which one is correct?" options where possible.
function ruleItem(f, text) {
  const quotes = f.spans.map((s) => text.slice(s.start, s.end));
  let options = null;
  if (f.rule === 'eye-colour' || f.rule === 'hair-colour') {
    const [a, b] = f.spans.map((s) => s.label);
    const feat = f.rule === 'eye-colour' ? 'eyes' : 'hair';
    options = [[a, b, 1], [b, a, 0]].map(([keep, drop, i]) => ({ label: `${keep[0].toUpperCase() + keep.slice(1)} ${feat}`, fixes: [{ find: quotes[i], replace: swapValue(quotes[i], drop, keep) }] }));
  } else if (f.rule === 'age') {
    const [a, b] = f.spans.map((s) => s.label.replace('age ', ''));
    options = [[a, b, 1], [b, a, 0]].map(([keep, drop, i]) => ({ label: `Age ${keep}`, fixes: [{ find: quotes[i], replace: swapValue(quotes[i], drop, keep) }] }));
  } else if (f.rule === 'name-spelling') {
    const common = f.spans[0].label, rare = f.spans[f.spans.length - 1].label;
    options = [{ label: `Spell it "${common}"`, fixes: [{ find: rare, replace: common, all: true }] }, { label: `Spell it "${rare}"`, fixes: [{ find: common, replace: rare, all: true }] }];
  }
  if (options) options = options.filter((o) => o.fixes.every((fx) => fx.find !== fx.replace));
  return { id: newId(), source: 'Rule check', category: RULE_CAT[f.rule] || 'details', title: f.title, explanation: f.explanation,
    severity: f.confidence === 'likely' ? 'high' : 'medium', quotes, options: options && options.length >= 2 ? options : null, status: 'open' };
}

async function runReview() {
  if (!S.text.trim()) throw new Error('Add your manuscript first.');
  if (overLimit()) throw new Error(`In the demo you can review up to ${DEMO_LIMIT.toLocaleString()} words. Sign in to review more.`);
  const text = S.text;
  let items = window.MarginsChecker.analyze(text).map((f) => ruleItem(f, text));
  let aiUsed = false, dropped = 0, aiNote = '';
  if (S.ai) {
    try {
      // Two focused requests at once: grammar, and story conflicts (a small model skips conflicts when asked for both).
      const MS = `Manuscript:\n"""\n${clip(text)}\n"""`;
      const [gr, cf] = await Promise.all([
        askAI(`You are a careful copy editor for fiction. List spelling, grammar and punctuation errors in the manuscript below.
Give the exact wrong words in "find" (short, with just enough context to be unique, copied character for character) and the corrected words in "replace". Respect the author's voice: do not change dialect in dialogue, deliberate fragments, or style choices. At most 15 items.
Reply with JSON only: {"items":[{"category":"grammar","title":"","explanation":"","find":"","replace":""}]}

${MS}`).catch((e) => ({ items: [], err: e.message })),
        askAI(`You are a continuity editor for fiction. Find CONFLICTS: places in the manuscript below that cannot all be true at once, or text that contradicts the author's Glossary.
Work through this checklist and compare every mention across the whole text:
- characters: ages, birth order (older/younger sibling), relationships, appearance (eyes, hair, height, scars), jobs, who is alive or dead
- timeline: years and dates, "X years ago" against stated years, times of day, the order of events, durations
- plot: events that happen twice or contradict each other, objects or facts that change, things a character couldn't know
- details: names spelled two ways, places, numbers, colours, weather
Do arithmetic when needed (e.g. "twelve years" away but a visit in 2018 described as the last one).
Do NOT report spelling or grammar, a fact stated only once, something merely unexplained, or a style opinion.
For each conflict: "category" (characters, plot, timeline or details), a short "title", a one-sentence "explanation", "severity" (high, medium or low), "quotes" (the two or more conflicting passages, each copied character for character, 3 to 15 words), and "options": one per version of the truth, each with a short "label" and "fixes" ({"find": exact words from the text, "replace": corrected words}) that make the text agree with that option.
At most 15 items. If there are none, return {"items":[]}.
Reply with JSON only: {"items":[{"category":"","title":"","explanation":"","severity":"","quotes":["",""],"options":[{"label":"","fixes":[{"find":"","replace":""}]}]}]}

Glossary (facts the author has confirmed):
${JSON.stringify(S.bible)}

${MS}`).catch((e) => ({ items: [], err: e.message })),
      ]);
      if (gr.err && cf.err) throw new Error(cf.err);
      const out = { items: [...(gr.items || []), ...(cf.items || [])] };
      const ai = [];
      for (const f of out.items || out.findings || []) {
        const c0 = String(f.category || '').toLowerCase().trim();
        const cat = ({ plotlines: 'plot', plotline: 'plot', character: 'characters', detail: 'details', names: 'details', name: 'details' })[c0] || c0;
        if (cat === 'grammar') {
          const find = locate(text, String(f.find || ''));
          if (!find || !f.replace || find === f.replace) { dropped++; continue; }
          ai.push({ id: newId(), source: 'AI', category: 'grammar', title: String(f.title || 'Grammar or punctuation'), explanation: String(f.explanation || ''),
            severity: 'low', quotes: [find], fix: { find, replace: String(f.replace) }, status: 'open' });
          continue;
        }
        if (!['characters', 'plot', 'timeline', 'details'].includes(cat)) { dropped++; continue; }
        const quotes = [...new Set((f.quotes || []).map((q) => locate(text, String(q))).filter(Boolean))];
        const options = (f.options || []).map((o) => ({ label: String(o.label || '').slice(0, 80), fixes: (o.fixes || []).map((fx) => ({ find: locate(text, String(fx.find || '')), replace: String(fx.replace ?? '') })).filter((fx) => fx.find && fx.find !== fx.replace) })).filter((o) => o.label);
        // only real conflicts: two places in the text, or one place against the Glossary with a choice to make
        if (!quotes.length || (quotes.length < 2 && options.length < 2)) { dropped++; continue; }
        ai.push({ id: newId(), source: 'AI', category: cat, title: String(f.title || 'Possible conflict'), explanation: String(f.explanation || ''),
          severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium', quotes, options: options.length >= 2 ? options : null, status: 'open' });
      }
      // if the AI found the same conflict as a rule check, keep the AI version (it has richer options)
      items = items.filter((r) => !ai.some((x) => x.category !== 'grammar' && x.quotes.some((q) => r.quotes.some((rq) => q.includes(rq) || rq.includes(q)))));
      items = items.concat(ai);
      aiUsed = true;
    } catch (e) { aiNote = e.message; }
  } else aiNote = 'AI wasn’t available, so this review uses the free rule checks only (no grammar or plot suggestions).';
  const pos = (f) => { const i = text.indexOf(f.quotes[0]); return i < 0 ? 1e9 : i; };
  items.sort((a, b) => pos(a) - pos(b));
  const d = currentDraft();
  const report = { draftN: d ? d.n : null, createdAt: Date.now(), findings: items, aiUsed, dropped, aiNote, truncated: text.length > AI_LIMIT, words: countWords(text) };
  const id = newId();
  await Store.set('meta/reports/' + id, report);
  S.reports[id] = { ...report, id };
  S.reportId = id; S.showResolved = false; S.mode = 'review';
  S.cat = TABS.map(([k]) => k).find((k) => tabItems(k).some((x) => x.status === 'open')) || 'grammar';
  S.sel = visibleFindings()[0]?.id || null;
  track('review_run', { findings: items.length, ai: aiUsed, dropped, words: report.words });
  toast(items.length ? `Review done: ${items.length} suggestion${items.length === 1 ? '' : 's'}.` : 'Review done: no conflicts found.');
  location.hash = '#manuscript';
}

// ---------- acting on suggestions ----------
function findItem(id) {
  if (!id) return null;
  return (S.gconf.items || []).find((x) => x.id === id) || curReport()?.findings.find((x) => x.id === id) || null;
}
function persistItems(f) {
  if (f.category === 'glossary') return Store.set('glossaryconflicts', S.gconf);
  const r = curReport(); if (!r) return;
  const { id, ...body } = r;
  return Store.set('meta/reports/' + id, body);
}
function nextOpen(fid) {
  const all = tabItems(S.cat), at = all.findIndex((x) => x.id === fid);
  const nx = all.slice(at + 1).find((x) => x.status === 'open') || all.find((x) => x.status === 'open' && x.id !== fid);
  S.sel = nx ? nx.id : null;
}
// After a fix, other open suggestions whose quoted text is gone from the manuscript are settled too.
async function autoResolve(exceptId) {
  const changed = new Set();
  for (const x of [...(curReport()?.findings || []), ...(S.gconf.items || [])]) {
    if (x.id === exceptId || x.status !== 'open' || !x.quotes?.length) continue;
    const found = spansOf(x).length;
    if (found < Math.min(2, x.quotes.length)) { x.status = 'resolved'; x.autoResolved = true; changed.add(x.category === 'glossary' ? 'g' : 'r'); }
  }
  if (changed.has('g')) await Store.set('glossaryconflicts', S.gconf);
  if (changed.has('r')) { const r = curReport(); const { id, ...body } = r; await Store.set('meta/reports/' + id, body); }
}
// Author chose option k (or accepted a grammar fix): change the text, record it for undo, auto-save.
async function chooseOption(fid, k) {
  const f = findItem(fid); if (!f) return;
  const fixes = f.fix ? [f.fix] : (f.options?.[k]?.fixes || []);
  const label = f.fix ? `"${f.fix.find}" → "${f.fix.replace}"` : f.options[k].label;
  track('option_chosen', { category: catOf(f), source: f.source || '', grammar: !!f.fix });
  const ops = applyFixes(fixes);
  if (fixes.length && !ops.length) { toast('That text has changed since the review, so the fix couldn’t be applied. Run the review again.'); return; }
  if (ops.length) recordEdit(`${f.title}: ${label}`, ops, f.id);
  f.status = 'fixed'; f.chosen = f.fix ? 0 : k;
  if (f.category === 'glossary' && f.target) {
    let c = findChar(f.target.name);
    if (!c) { c = normChar({ name: f.target.name }); S.bible.characters.push(c); }
    c[f.target.field] = f.options[k].value;
    await commitBible(`Conflict resolved: ${f.target.name} · ${f.target.field} = ${f.options[k].value}`, 'Conflict resolved');
  }
  await persistItems(f);
  await autoResolve(f.id);
  await saveWorking(true);
  track(f.category === 'grammar' ? 'grammar_fix_applied' : 'conflict_resolved', { source: f.source, category: f.category, changes: ops.length });
  toast(ops.length ? `Updated ${ops.length} place${ops.length === 1 ? '' : 's'} in your text.` + (f.category === 'glossary' ? ' Saved to the Glossary.' : '') : 'Marked as resolved.');
  nextOpen(fid);
  render();
}
async function setStatus(fid, status) {
  const f = findItem(fid); if (!f) return;
  track('suggestion_' + status, { category: catOf(f), source: f.source || '' });
  if (status === 'open' && f.status === 'fixed') {
    const ed = S.edits.find((x) => x.link === fid);
    if (ed) { undoEdit(ed.id); await saveWorking(true); toast('Change undone.'); render(); return; }
  }
  f.status = status;
  await persistItems(f);
  track(status === 'dismissed' ? 'finding_dismissed' : status === 'resolved' ? 'finding_resolved' : 'finding_reopened', { source: f.source, category: f.category });
  toast(status === 'dismissed' ? 'Marked as not an issue.' : status === 'resolved' ? 'Marked as resolved.' : 'Moved back to open.');
  if (status !== 'open') nextOpen(fid);
  render();
}

// ---------- compare ----------
function diffParas(a, b) {
  const A = String(a || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const B = String(b || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (A.length * B.length > 4e6) return null;
  const L = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0, j = 0, same = 0;
  const flush = () => { if (same) { out.push({ t: 'same', n: same }); same = 0; } };
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { same++; i++; j++; }
    else if (j < B.length && (i >= A.length || L[i][j + 1] >= L[i + 1][j])) { flush(); out.push({ t: 'add', s: B[j++] }); }
    else { flush(); out.push({ t: 'del', s: A[i++] }); }
  }
  flush();
  return out;
}
function bibleChanges(prev, next) {
  const out = [];
  const key = (x) => (x.name || x.title || '').toLowerCase();
  for (const [kind, label, fields] of [['characters', 'Character', ['role', 'age', 'eyes', 'hair', 'notes']], ['plotlines', 'Plotline', ['summary', 'status']]]) {
    const P = new Map((prev?.[kind] || []).map((x) => [key(x), x])), N = new Map((next?.[kind] || []).map((x) => [key(x), x]));
    for (const [k, x] of N) {
      const o = P.get(k);
      if (!o) { out.push(`<div class="add">${label} added: <b>${esc(x.name || x.title)}</b></div>`); continue; }
      for (const f of fields) if ((o[f] || '') !== (x[f] || '')) out.push(`<div class="add">${esc(x.name || x.title)} · ${f}: <s>${esc(o[f] || '—')}</s> → <b>${esc(x[f] || '—')}</b></div>`);
    }
    for (const [k, x] of P) if (!N.has(k)) out.push(`<div class="del">${label} removed: ${esc(x.name || x.title)}</div>`);
  }
  return out.join('') || '<div class="same">No differences.</div>';
}

// ---------- views ----------
const QUILL = '<svg class="hero-quill" viewBox="0 0 64 64" aria-hidden="true"><use href="#none"/><defs><linearGradient id="qh" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e3d9ff"/><stop offset=".5" stop-color="#7b5cff"/><stop offset="1" stop-color="#3f6dff"/></linearGradient></defs><path d="M56 6C38 8 22 20 16 38c-2 6-3 11-3 15l4-4c3-1 8-2 13-6 8-6 14-15 18-25-4 3-9 5-13 6 6-5 12-11 21-18z" fill="url(#qh)"/><path d="M50 13C38 22 26 35 17 51" stroke="#120f2b" stroke-width="1.2" fill="none" stroke-linecap="round"/><path d="M13 53l-6 6" stroke="#cdbdff" stroke-width="2" stroke-linecap="round"/></svg>';

function viewHome() {
  return `
  <section class="hero">
    <div>
      <span class="pill">For emerging &amp; self-publishing authors</span>
      <h1 style="margin-top:14px">Keep your story consistent, from the first page to the last.</h1>
      <p class="lead">Margins reads your manuscript, builds a Glossary of your characters and plotlines, and finds grammar slips and places where your story contradicts itself. It only changes your text when you choose a fix.</p>
      <div class="row">
        ${S.user ? `<a class="btn" href="#manuscript">Open your manuscript →</a>` : `<button class="btn" data-act="go-signin">Sign in →</button>
        <button class="btn sec" data-act="test-run">See how it works</button>`}
      </div>
    </div>
    ${QUILL}
  </section>
  <div class="grid" style="margin-bottom:20px">
    <div class="card feature"><h3><span class="ic">✦</span>Glossary</h3><p class="muted small">Characters and plotlines pulled from your manuscript by AI. Conflicts are flagged for you to settle, and every change is kept.</p></div>
    <div class="card feature"><h3><span class="ic">⟲</span>Version history</h3><p class="muted small">Save drafts as you revise, see exactly what changed, and restore any earlier version.</p></div>
    <div class="card feature"><h3><span class="ic">▤</span>Tabbed suggestions</h3><p class="muted small">Grammar &amp; punctuation, Characters, Plot, Timeline and Details &amp; names, each with the quoted evidence.</p></div>
    <div class="card feature"><h3><span class="ic">✓</span>You choose the fix</h3><p class="muted small">Green eyes or blue? Pick the right version and Margins updates your text. Every change can be undone.</p></div>
  </div>
  <div class="card" id="how">
    <h2>How Margins works</h2>
    <ol class="steps">
      <li><b>Sign in and add your manuscript.</b> <span class="muted">Sign in with your email. Then, on the Manuscript tab, upload a .docx or .txt file or paste your text and click <i>Update history</i> to save it as a draft.</span></li>
      <li><b>Build your Glossary.</b> <span class="muted">Click <i>Scan to Add to Glossary</i>. Characters and plotlines are added automatically; any conflicts appear in a Glossary conflicts tab for you to settle.</span></li>
      <li><b>Run a review.</b> <span class="muted">Margins checks grammar and looks for places where your story contradicts itself or your Glossary. Each one is highlighted in your text.</span></li>
      <li><b>Work through the suggestions.</b> <span class="muted">The Suggestions panel has tabs for Grammar &amp; punctuation, Characters, Plot, Timeline and Details &amp; names. Choose a tab, step through with the arrows, and pick the correct version: your text is updated for you. Or mark it Not an issue.</span></li>
      <li><b>Revise and track.</b> <span class="muted">Your work auto-saves as you go, and Recent changes lets you undo any fix. Click <i>Update history</i> to save a new draft; History shows every draft and Glossary change, with restore.</span></li>
    </ol>
    <p class="muted small" style="margin:0">Want to look around first? <b>See how it works</b> opens a sample you can review without signing in (up to 1,000 words, nothing is saved). This site uses PostHog analytics, which may record visits to help improve Margins.</p>
  </div>`;
}

// ---------- workspace (3 panes) ----------
const CHAPTER_RE = /^\s*(#{1,3}\s+.+|(chapter|part|prologue|epilogue|act)\b.{0,60})\s*$/i;
function chapters(text) {
  const out = []; let off = 0;
  for (const line of String(text || '').split('\n')) { if (line.trim() && line.length < 80 && CHAPTER_RE.test(line)) out.push({ title: line.replace(/^#+\s*/, '').trim(), at: off }); off += line.length + 1; }
  return out;
}
const curReport = () => S.reports[S.reportId] || null;
const TABS = [['grammar', 'Grammar & punctuation'], ['characters', 'Characters'], ['plot', 'Plot'], ['timeline', 'Timeline'], ['details', 'Details & names'], ['glossary', 'Glossary conflicts']];
// Old reports used "plotlines" for plot.
const catOf = (f) => (f.category === 'plotlines' ? 'plot' : f.category);
function tabItems(cat) {
  if (cat === 'glossary') return S.gconf.items || [];
  const r = curReport(); return r ? r.findings.filter((f) => catOf(f) === cat) : [];
}
function visibleFindings() {
  return tabItems(S.cat).filter((f) => S.showResolved || f.status === 'open');
}
// Where a suggestion's quotes are in the current text (the text may have changed since the review).
function spansOf(f) {
  const out = [];
  for (const q of f.quotes || []) { const i = S.text.indexOf(q); if (i >= 0) out.push([i, i + q.length]); }
  return out;
}

function viewWorkspace() {
  const d = currentDraft(), dirty = textDirty();
  const chs = chapters(S.text);
  const edits = S.edits.slice(0, 8);
  const left = `<aside class="pane side">
    <div class="side-h">Manuscript</div>
    <input type="text" id="title" class="title-in" value="${esc(S.meta.title)}" placeholder="Untitled manuscript" />
    <p class="side-meta">${d ? `Draft ${d.n} · saved ${when(d.createdAt)}` : 'No drafts saved yet'}<span id="dirty" style="color:var(--warn)">${dirty && d ? ' · edited since' : ''}</span></p>
    <p class="side-meta" id="autosave">${S.demo ? 'Demo · not saved' : S.text.trim() ? 'Auto-saved' : ''}</p>
    <div class="side-h small-h">Chapters</div>
    <div class="chlist">${chs.length ? chs.map((c, i) => `<button class="ch" data-act="goto-ch" data-id="${c.at}"><span>${i + 1}</span>${esc(c.title)}</button>`).join('') : '<p class="side-meta">No chapter headings found. Lines like “Chapter One” appear here.</p>'}</div>
    <div class="side-h small-h" style="display:flex;justify-content:space-between;align-items:center">Recent changes ${S.edits.length ? `<button class="linkbtn" data-act="undo-last">Undo last</button>` : ''}</div>
    <div class="edits">${edits.length ? edits.map((x) => `<div class="edit"><div><span>${esc(x.title)}</span><small>${when(x.at)} · ${x.ops.length} place${x.ops.length === 1 ? '' : 's'}</small></div><button class="linkbtn" data-act="undo-edit" data-id="${x.id}">Undo</button></div>`).join('') : '<p class="side-meta">Fixes you apply from Suggestions appear here, each with Undo.</p>'}</div>
    <div class="side-foot">
      <div class="row"><button class="btn sec small" data-act="upload">Upload .docx / .txt</button><button class="btn sec small" data-act="sample">Sample</button></div>
      <label class="f" for="vnote">Save as a new draft</label>
      <input type="text" id="vnote" placeholder="What changed?" />
      <button class="btn small" style="width:100%;margin-top:6px" data-act="save-version" ${S.text.trim() && dirty ? '' : 'disabled'}>Update history (save Draft ${S.drafts.length ? S.drafts[S.drafts.length - 1].n + 1 : 1})</button>
      <p class="side-meta" id="wc" style="text-align:center;margin-top:10px">${countWords(S.text).toLocaleString()} words</p>
    </div>
  </aside>`;

  const hasItems = !!curReport() || (S.gconf.items || []).length > 0;
  const paper = S.mode === 'review' && hasItems ? annotated()
    : `<textarea id="text" class="paper-edit" placeholder="Paste your manuscript here, or drop a .docx / .txt file…&#10;&#10;Tip: start chapters on their own line, e.g. “Chapter One”, so they show in the chapter list.">${esc(S.text)}</textarea>`;
  const center = `<section class="pane center">
    <div class="center-bar">
      <b class="doc-title">${esc(S.meta.title || 'Untitled manuscript')}</b>
      <div class="seg"><button class="${S.mode === 'edit' ? 'on' : ''}" data-act="mode" data-id="edit">Edit</button><button class="${S.mode === 'review' ? 'on' : ''}" data-act="mode" data-id="review" ${hasItems ? '' : 'disabled'}>Review highlights</button></div>
    </div>
    <div class="paper-wrap" id="paper-wrap"><div class="paper dropzone" id="drop">${paper}</div></div>
  </section>`;

  return `<div class="workspace">${left}${center}${suggestionsPane()}</div>`;
}

// The current text, with every open suggestion's quotes highlighted (the selected one stands out).
function annotated() {
  const text = S.text;
  const items = [...(curReport()?.findings || []), ...(S.gconf.items || [])];
  const spans = [];
  for (const f of items) if (f.status === 'open' || f.id === S.sel) for (const [a, b] of spansOf(f)) spans.push({ a, b, f });
  const lines = text.split('\n'); let off = 0, html = '';
  for (const line of lines) {
    const end = off + line.length;
    if (!line.trim()) { off = end + 1; continue; }
    const inl = spans.filter((s) => s.a < end && s.b > off);
    const cuts = new Set([off, end]); inl.forEach((s) => { cuts.add(Math.max(s.a, off)); cuts.add(Math.min(s.b, end)); });
    const pts = [...cuts].sort((x, y) => x - y); let body = '';
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1], piece = esc(text.slice(p, q));
      const cov = inl.filter((s) => s.a <= p && s.b >= q);
      if (!cov.length) { body += piece; continue; }
      const ids = [...new Set(cov.map((s) => s.f.id))];
      const sel = ids.includes(S.sel) ? cov.find((s) => s.f.id === S.sel).f : cov[0].f;
      body += `<mark data-f="${ids.join(' ')}" class="${ids.includes(S.sel) ? 'sel' : ''} ${sel.severity} c-${catOf(sel)}">${piece}</mark>`;
    }
    const isCh = line.length < 80 && CHAPTER_RE.test(line);
    html += isCh ? `<h2 class="chap" data-at="${off}">${body}</h2>` : `<p data-at="${off}">${body}</p>`;
    off = end + 1;
  }
  return `<div class="paper-read" id="read">${html || '<p class="muted">Nothing to show.</p>'}</div>`;
}

function suggestionCard(f) {
  const status = f.status === 'fixed' ? `<span class="pill approved">${f.fix ? 'Fixed' : 'Fixed: ' + esc(f.options?.[f.chosen]?.label || '')}</span>`
    : f.status === 'resolved' ? `<span class="pill approved">${f.autoResolved ? 'Settled by another fix' : 'Resolved'}</span>` : f.status === 'dismissed' ? '<span class="pill dismissed">Not an issue</span>' : '';
  let body = '';
  if (f.fix) {
    body = `<div class="gfix"><div><small>Original</small><span class="old">${esc(f.fix.find)}</span></div><div><small>Suggested</small><span class="new">${esc(f.fix.replace)}</span></div></div>`;
  } else {
    body = f.quotes.map((q, k) => `<button class="squote" data-act="goto-q" data-id="${f.id}" data-k="${k}">“${esc(q)}”</button>`).join('');
  }
  let actions = '';
  if (f.status === 'open') {
    if (f.fix) actions = `<button class="btn ok small" data-act="choose" data-id="${f.id}" data-k="0">✓ Accept fix</button><button class="btn sec small" data-act="dismiss" data-id="${f.id}">Not an issue</button>`;
    else if (f.options) actions = `<p class="choose-h">Which is correct? Your text will be updated to match.</p><div class="opts">${f.options.map((o, k) => `<button class="opt" data-act="choose" data-id="${f.id}" data-k="${k}"><span class="radio"></span>${esc(o.label)}${o.fixes?.length ? '' : ' <small>(no text change)</small>'}</button>`).join('')}</div>
        <div class="row" style="margin-top:8px"><button class="btn sec small" data-act="resolve" data-id="${f.id}">I'll fix it myself</button><button class="btn sec small" data-act="dismiss" data-id="${f.id}">Not an issue</button></div>`;
    else actions = `<button class="btn ok small" data-act="resolve" data-id="${f.id}">✓ Mark resolved</button><button class="btn sec small" data-act="dismiss" data-id="${f.id}">Not an issue</button>`;
  } else actions = `<button class="btn sec small" data-act="reopen" data-id="${f.id}">Undo</button>`;
  return `<div class="scard ${f.status}">
      <div class="row" style="gap:6px"><span class="pill ${f.severity}">${f.severity}</span><span class="pill">${esc(f.source)}</span>${status}</div>
      <h3 style="margin-top:8px">${esc(f.title)}</h3>
      <p class="side-meta" style="font-size:14px">${esc(f.explanation)}</p>
      ${body}
      <div class="${f.options && f.status === 'open' ? '' : 'row'}" style="margin-top:10px">${actions}</div>
    </div>`;
}

function suggestionsPane() {
  const r = curReport(), g = (S.gconf.items || []).length > 0;
  const actions = `<div class="row" style="margin-bottom:8px">
      <button class="btn small" data-act="review" ${S.text.trim() ? '' : 'disabled'}>Run review</button>
      <button class="btn sec small" data-act="scan" ${S.text.trim() && S.ai ? '' : 'disabled'}>Scan to Add to Glossary</button></div>
    <p class="side-meta" style="margin:0 0 12px">${S.ai ? `AI ready (${esc(S.aiSource)}) · plus free rule checks` : 'AI not available here · free rule checks only'}</p>`;
  if (!r && !g) return `<aside class="pane sugg"><div class="sugg-h"><b>Suggestions</b></div>${actions}
    <div class="empty-s"><p><b>No review yet.</b></p><p class="side-meta">Run a review to find grammar slips and places where your story contradicts itself. Each one appears here, highlighted in your text, with a choice of fixes.</p></div></aside>`;
  const tabs = TABS.filter(([k]) => k !== 'glossary' || g);
  if (!tabs.some(([k]) => k === S.cat)) S.cat = tabs[0][0];
  const all = [...(r?.findings || []), ...(S.gconf.items || [])], done = all.filter((f) => f.status !== 'open').length, pct = all.length ? Math.round((done / all.length) * 100) : 100;
  const list = visibleFindings();
  if (!list.some((f) => f.id === S.sel)) S.sel = list[0]?.id || null;
  const i = list.findIndex((f) => f.id === S.sel), f = list[i];
  const tabHtml = tabs.map(([k, l]) => { const n = tabItems(k).filter((x) => x.status === 'open').length; return `<button class="tab6 ${S.cat === k ? 'on' : ''} ${k === 'glossary' ? 'tab-g' : ''}" data-act="cat" data-id="${k}"><span>${l}</span><span class="tn ${n ? '' : 'zero'}">${n}</span></button>`; }).join('');
  return `<aside class="pane sugg">
    <div class="sugg-h"><b>Suggestions</b><span class="side-meta">${r ? `${r.draftN ? 'Draft ' + r.draftN + ' · ' : ''}${when(r.createdAt)}` : ''}</span></div>
    ${actions}
    <div class="tabs6">${tabHtml}</div>
    <div class="spread side-meta"><span>${done} of ${all.length} handled</span><span>${pct}%</span></div>
    <div class="progress" style="margin:4px 0 10px"><div style="width:${pct}%"></div></div>
    <div class="pager"><button class="iconbtn" data-act="prev" ${i > 0 ? '' : 'disabled'} title="Previous">‹</button><span>${list.length ? `${i + 1} of ${list.length}` : 'Nothing here'}</span><button class="iconbtn" data-act="next" ${i >= 0 && i < list.length - 1 ? '' : 'disabled'} title="Next">›</button></div>
    ${f ? suggestionCard(f) : `<div class="empty-s"><p><b>${tabItems(S.cat).length ? 'All done in this tab. 🎉' : 'No conflicts found here.'}</b></p></div>`}
    <div class="slist">${list.filter((x) => x.id !== S.sel).map((x) => `<button class="srow" data-act="pick" data-id="${x.id}"><span class="dot ${x.severity}"></span><span>${esc(x.title)}</span>${x.status !== 'open' ? `<span class="pill ${x.status === 'dismissed' ? 'dismissed' : 'approved'}" style="margin-left:auto">${x.status === 'dismissed' ? '—' : '✓'}</span>` : ''}</button>`).join('')}</div>
    <div class="spread" style="margin-top:12px">
      <label class="side-meta" style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" data-act="resolved" ${S.showResolved ? 'checked' : ''}/> Show handled</label>
      <button class="btn sec small" data-act="copy-report">Copy report</button>
    </div>
    ${r && (r.dropped || r.truncated || (!r.aiUsed && r.aiNote)) ? `<p class="side-meta" style="margin-top:10px">${!r.aiUsed && r.aiNote ? esc(r.aiNote) + ' ' : ''}${r.dropped ? `${r.dropped} AI suggestion(s) were left out because they weren't real conflicts or didn't match your text. ` : ''}${r.truncated ? 'The AI read the first ~10,000 words.' : ''}</p>` : ''}
  </aside>`;
}

// Scroll the manuscript to a suggestion's highlight (or a chapter).
function scrollToMark(fid, k) {
  const f = findItem(fid); if (!f) return;
  const sp = spansOf(f)[k || 0] || spansOf(f)[0];
  let target = [...document.querySelectorAll('#read mark')].find((m) => m.dataset.f.split(' ').includes(fid));
  if (sp) target = [...document.querySelectorAll('#read [data-at]')].filter((p) => +p.dataset.at <= sp[0]).pop()?.querySelector(`mark[data-f~="${fid}"]`) || target;
  if (target) { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash'); }
}
function gotoChapter(at) {
  if (S.mode === 'review' && $('#read')) { const el = [...document.querySelectorAll('#read [data-at]')].find((p) => +p.dataset.at >= at); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const ta = $('#text'); if (!ta) return;
  ta.focus(); ta.setSelectionRange(at, at);
  const before = S.text.slice(0, at).split('\n').length, total = S.text.split('\n').length;
  ta.scrollTop = Math.max(0, (before / total) * ta.scrollHeight - 40);
}
function select(fid, k) { S.sel = fid; if (S.mode !== 'review') S.mode = 'review'; render(); requestAnimationFrame(() => scrollToMark(fid, k)); }
function field(kind, id, f, label, val, ph) {
  return `<div><label class="f">${label}</label><input type="text" data-bind="${kind}:${id}:${f}" value="${esc(val)}" placeholder="${ph || ''}" /></div>`;
}
function viewBible() {
  const b = S.bible, dirty = bibleDirty();
  const chars = b.characters.map((c) => `
    <div class="bcard"><button class="x" data-act="del-char" data-id="${c.id}" title="Remove">×</button>
      <div class="two">${field('c', c.id, 'name', 'Name', c.name)}${field('c', c.id, 'role', 'Role', c.role, 'e.g. protagonist')}</div>
      <div class="three">${field('c', c.id, 'age', 'Age', c.age)}${field('c', c.id, 'eyes', 'Eyes', c.eyes)}${field('c', c.id, 'hair', 'Hair', c.hair)}</div>
      ${field('c', c.id, 'aliases', 'Also called', (c.aliases || []).join(', '), 'comma separated')}
      ${field('c', c.id, 'notes', 'Notes', c.notes)}
    </div>`).join('');
  const plots = b.plotlines.map((p) => `
    <div class="bcard"><button class="x" data-act="del-plot" data-id="${p.id}" title="Remove">×</button>
      <div class="two">${field('p', p.id, 'title', 'Plotline', p.title)}
        <div><label class="f">Status</label><select data-bind="p:${p.id}:status"><option value="open" ${p.status !== 'resolved' ? 'selected' : ''}>Open</option><option value="resolved" ${p.status === 'resolved' ? 'selected' : ''}>Resolved</option></select></div></div>
      ${field('p', p.id, 'summary', 'Summary', p.summary)}
      <label class="f">Key events (one per line)</label><textarea rows="3" data-bind="p:${p.id}:keyEvents">${esc((p.keyEvents || []).join('\n'))}</textarea>
    </div>`).join('');
  return `
  <div class="card">
    <div class="spread"><div><h2 style="margin:0">Glossary</h2><p class="muted small" style="margin:0">The characters and plotlines of your story. Reviews check your text against them.</p></div>
      <button class="btn" data-act="scan" ${S.text.trim() && S.ai ? '' : 'disabled'}>Scan to Add to Glossary</button></div>
  </div>
  ${(S.gconf.items || []).some((x) => x.status === 'open') ? `<div class="card" style="border-color:var(--warn)"><div class="spread"><span><b>${S.gconf.items.filter((x) => x.status === 'open').length} conflict(s)</b> found in the last scan need your choice before they're added.</span><button class="btn small" data-act="go-gconf">Resolve conflicts →</button></div></div>` : ''}
  <div class="card" style="position:sticky;top:64px;z-index:3">
    <div class="row">
      <span class="small" style="color:${dirty ? 'var(--warn)' : 'var(--muted)'}">${dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
      <input type="text" id="bnote" style="flex:1;min-width:200px" placeholder="What changed? e.g. Mara is now 29" ${dirty ? '' : 'disabled'} />
      <button class="btn" data-act="save-bible" ${dirty ? '' : 'disabled'}>Update history</button>
      <button class="btn sec" data-act="discard-bible" ${dirty ? '' : 'disabled'}>Discard</button>
    </div>
  </div>
  <div class="card"><div class="spread"><h2>Characters (${b.characters.length})</h2><button class="btn sec small" data-act="add-char">+ Add character</button></div>
    ${chars ? `<div class="grid">${chars}</div>` : '<p class="muted">No characters yet. Click Scan to Add to Glossary, or add one.</p>'}</div>
  <div class="card"><div class="spread"><h2>Plotlines (${b.plotlines.length})</h2><button class="btn sec small" data-act="add-plot">+ Add plotline</button></div>
    ${plots ? `<div class="grid">${plots}</div>` : '<p class="muted">No plotlines yet. Click Scan to Add to Glossary, or add one.</p>'}</div>`;
}

function viewHistory() {
  const items = [
    ...S.drafts.map((d) => ({ t: 'draft', at: d.createdAt, d })),
    ...S.history.map((h) => ({ t: 'bible', at: h.at, h })),
  ].sort((a, b) => b.at - a.at);
  const cmp = S.compare;
  let panel = '';
  if (cmp?.t === 'draft') {
    const d = S.drafts.find((x) => x.id === cmp.id), prev = S.drafts.filter((x) => x.n < d.n).pop();
    const df = diffParas(prev?.text || '', d.text);
    panel = `<div class="card"><div class="spread"><h2>Draft ${d.n} compared with ${prev ? 'Draft ' + prev.n : 'nothing (first draft)'}</h2><button class="btn sec small" data-act="close-compare">Close</button></div>
      <p class="muted small"><span style="color:var(--ok)">Green</span> = added · <span style="color:var(--bad)">red</span> = removed</p>
      <div class="diff">${df ? df.map((x) => x.t === 'same' ? `<div class="same">… ${x.n} unchanged paragraph${x.n > 1 ? 's' : ''} …</div>` : `<div class="${x.t}">${esc(x.s)}</div>`).join('') : '<div class="same">Too large to compare here.</div>'}</div></div>`;
  } else if (cmp?.t === 'bible') {
    const i = S.history.findIndex((x) => x.id === cmp.id), h = S.history[i], prev = S.history[i + 1];
    panel = `<div class="card"><div class="spread"><h2>Glossary changes: ${esc(h.note || h.source)}</h2><button class="btn sec small" data-act="close-compare">Close</button></div>
      <div class="diff" style="font-family:inherit">${bibleChanges(prev?.snapshot, h.snapshot)}</div></div>`;
  }
  return `${panel}<div class="card"><h2>History</h2>
    <p class="muted small">Every saved draft and Glossary update, newest first. Fixes applied since your last draft are under Recent changes on the Manuscript tab.</p>
    ${items.length ? `<div class="tl">${items.map((x) => x.t === 'draft'
      ? `<div class="item"><div class="spread"><div><b>Draft ${x.d.n}</b> <span class="pill">Manuscript</span>${x.d.id === S.meta.currentDraftId ? ' <span class="pill approved">current</span>' : ''}<br><span class="muted small">${when(x.at)} · ${x.d.words.toLocaleString()} words${x.d.note ? ' · ' + esc(x.d.note) : ''}</span></div>
          <div class="row"><button class="btn sec small" data-act="cmp-draft" data-id="${x.d.id}">What changed</button><button class="btn sec small" data-act="open-draft" data-id="${x.d.id}">Open</button>${x.d.id === S.meta.currentDraftId ? '' : `<button class="btn sec small" data-act="restore-draft" data-id="${x.d.id}">Restore as new version</button>`}</div></div></div>`
      : `<div class="item bible"><div class="spread"><div><b>${esc(x.h.note || 'Glossary update')}</b> <span class="pill">Glossary · ${esc(x.h.source)}</span><br><span class="muted small">${when(x.at)} · ${x.h.snapshot.characters.length} characters, ${x.h.snapshot.plotlines.length} plotlines</span></div>
          <div class="row"><button class="btn sec small" data-act="cmp-bible" data-id="${x.h.id}">What changed</button><button class="btn sec small" data-act="restore-bible" data-id="${x.h.id}">Restore this version</button></div></div></div>`).join('')}</div>`
    : '<p class="muted">Nothing saved yet. Save a draft or update your Glossary to start your history.</p>'}</div>`;
}

function viewSignin() {
  if (isCloud()) return viewSigninCloud();
  const where = { account: 'to your Claude account', server: 'on this computer (in the margins-data folder)', browser: 'in this browser', memory: 'only until you close this page' }[Store.mode];
  const recent = Who.recent();
  return `<div class="signin"><div class="card signin-card">
    ${QUILL.replace('hero-quill', 'signin-quill')}
    <h2 style="text-align:center;margin-bottom:6px">Sign in to Margins</h2>
    <p class="muted" style="text-align:center">Enter your email to open your manuscripts, Glossary and version history.</p>
    <form id="signin-form" novalidate>
      <label class="f" for="email">Email</label>
      <input type="text" id="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${esc(S.user || recent[0] || '')}" />
      <p class="small" id="email-err" style="color:var(--bad);margin:6px 0 0" hidden>Please enter a valid email address.</p>
      <button class="btn" type="submit" style="width:100%;margin-top:14px">Continue →</button>
    </form>
    ${recent.length > 1 ? `<p class="small muted" style="margin:16px 0 6px">Recently used on this device</p><div class="row">${recent.map((e) => `<button class="btn sec small" data-act="quick-signin" data-id="${esc(e)}">${esc(e)}</button>`).join('')}</div>` : ''}
    <p class="small muted" style="margin:18px 0 0">New email? A fresh workspace is created. Your work is saved ${where}.</p>
    <p class="small muted" style="margin:6px 0 0"><b>Early version:</b> there's no password yet, so anyone who types your email on the same device or site can open your work. Avoid confidential manuscripts.</p>
  </div></div>`;
}

function viewSigninCloud() {
  const create = !!S.createMode, recent = Who.recent();
  return `<div class="signin"><div class="card signin-card">
    ${QUILL.replace('hero-quill', 'signin-quill')}
    <h2 style="text-align:center;margin-bottom:6px">${create ? 'Create your Margins account' : 'Sign in to Margins'}</h2>
    <p class="muted" style="text-align:center">Your manuscript, Glossary and version history are private to your account.</p>
    <form id="signin-form" novalidate>
      <label class="f" for="email">Email</label>
      <input type="text" id="email" inputmode="email" autocomplete="email" autocapitalize="off" placeholder="you@example.com" value="${esc(S.prefill || recent[0] || '')}" />
      <label class="f" for="pw" style="margin-top:12px">Password</label>
      <input type="password" id="pw" autocomplete="${create ? 'new-password' : 'current-password'}" placeholder="${create ? 'At least 6 characters' : 'Your password'}" />
      <p class="small" id="email-err" style="color:var(--bad);margin:6px 0 0" hidden></p>
      <button class="btn" type="submit" style="width:100%;margin-top:14px">${create ? 'Create account →' : 'Sign in →'}</button>
    </form>
    <p class="small" style="text-align:center;margin:14px 0 0">${create ? 'Already have an account?' : 'New to Margins?'} <a href="#signin" data-act="toggle-create">${create ? 'Sign in' : 'Create an account'}</a></p>
    ${recent.length ? `<p class="small muted" style="margin:16px 0 6px">Recently used on this device</p><div class="row">${recent.map((e) => `<button class="btn sec small" data-act="prefill" data-id="${esc(e)}">${esc(e)}</button>`).join('')}</div>` : ''}
    <p class="small muted" style="margin:18px 0 0">Signed-in accounts get AI reviews (30 a day). Your data is locked to your account: nobody else can read or change it.</p>
  </div></div>`;
}

const VIEWS = { home: viewHome, signin: viewSignin, manuscript: viewWorkspace, glossary: viewBible, history: viewHistory };
const PRIVATE = ['manuscript', 'glossary', 'history'];
const route = () => {
  let h = location.hash.slice(1); if (h === 'report') h = 'manuscript'; if (h === 'story-bible') h = 'glossary';
  if (!VIEWS[h]) return 'home';
  if (PRIVATE.includes(h) && !S.user && !S.demo) { S.next = h; return 'signin'; }
  return h;
};

function render() {
  const v = route();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.v === v));
  $('#store').textContent = S.demo ? 'Demo · not saved' : STORE_LABEL[Store.mode];
  $('#who').innerHTML = S.demo
    ? `<button class="btn small" data-act="go-signin">Sign in to save</button>`
    : S.user
    ? `<span class="who-email" title="${esc(S.user)}">${esc(S.user)}</span><button class="btn sec small" data-act="signout">Sign out</button>`
    : (v === 'signin' ? '' : `<button class="btn small" data-act="go-signin">Sign in</button>`);
  const banner = (S.busy ? `<div class="banner"><span class="spin"></span>${esc(S.busy)}</div>` : '') + (S.error ? `<div class="banner err">${esc(S.error)}</div>` : '');
  const keepScroll = window.scrollY;
  const keep = {}; document.querySelectorAll('.pane, #paper-wrap, #text').forEach((el, i) => (keep[i] = el.scrollTop));
  document.body.classList.toggle('ws', v === 'manuscript');
  $('#view').innerHTML = (v === 'home' || v === 'manuscript' ? '' : '<div style="height:24px"></div>') + (v === 'manuscript' ? `<div class="ws-banner">${banner}</div>` : banner) + (S.loaded ? VIEWS[v]() : '<p class="muted" style="padding:40px 0">Loading your work…</p>');
  if (S.busy) document.querySelectorAll('#view button').forEach((b) => (b.disabled = true));
  document.querySelectorAll('.pane, #paper-wrap, #text').forEach((el, i) => { if (keep[i]) el.scrollTop = keep[i]; });
  window.scrollTo(0, keepScroll);
  updateLimit();
}

// ---------- sample ----------
const SAMPLE = `Chapter One

Katherine Moore had green eyes that caught the light whenever she laughed. Katherine was thirty-four, the youngest partner the firm had ever made, and she had never been to London.

Her grandmother Ruth died the winter Katherine turned twelve. Katherine was an only child, raised in the quiet house on Elm Street.

Chapter Two

The train slowed into King's Cross. It was the same route she had taken on her trip to London last summer, past the café where she used to meet Daniel.

At the station, Katherine's sister waved from the platform. Katherine's blue eyes narrowed. "You're late," Kathrine said.

Ruth smiled from the bench by the ticket office and held out a scarf.

Chapter Three

The profile ran on Sunday and described her simply: Katherine, 36, a lawyer who never lost a case she cared about. Nobody mentioned the missing letter again.`;

// ---------- files ----------
let mammothLoading;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve();
  return (mammothLoading ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
    s.onload = ok; s.onerror = () => fail(new Error('Couldn’t load the Word reader. Save the file as .txt and try again.'));
    document.head.append(s);
  }));
}
async function readFile(file) {
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) throw new Error('That file is too large. Try one part of the book at a time.');
  let text;
  if (/\.docx$/i.test(file.name)) { await loadMammoth(); text = (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value; }
  else if (/\.(txt|md|text)$/i.test(file.name) || file.type.startsWith('text/')) text = await file.text();
  else throw new Error('Please upload a .docx or .txt file.');
  S.text = text.replace(/\r\n/g, '\n').trim();
  saveWorking();
  if (!S.meta.title) S.meta.title = file.name.replace(/\.[^.]+$/, '');
  S.mode = 'edit'; location.hash = '#manuscript'; render();
  track('file_uploaded', { type: file.name.split('.').pop() });
  toast(`Loaded ${file.name}. Click Update history to save it as a draft.`);
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const mk = e.target.closest('#read mark'); if (mk) { S.sel = mk.dataset.f.split(' ')[0]; render(); return; }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const id = a.dataset.id;
  switch (a.dataset.act) {
    case 'sample':
      if (!S.user && !S.demo) { startDemo(); return; }
      if (S.text.trim() && S.text !== SAMPLE && !S.confirmSample) { S.confirmSample = true; toast('This replaces your current text. Click Sample again to continue, or save a draft first.'); setTimeout(() => (S.confirmSample = false), 5000); return; }
      S.confirmSample = false; S.text = SAMPLE; saveWorking(); S.mode = 'edit'; if (!S.meta.title) S.meta.title = 'The Partner (sample)'; track('sample_loaded'); location.hash = '#manuscript'; render(); toast('Sample loaded. Run a review or scan it into the Glossary.'); break;
    case 'upload': $('#file').click(); break;
    case 'go-signin': S.next = 'manuscript'; location.hash = '#signin'; break;
    case 'test-run': startDemo(); break;
    case 'toggle-create': e.preventDefault(); S.createMode = !S.createMode; render(); break;
    case 'prefill': S.prefill = id; render(); setTimeout(() => $('#pw')?.focus(), 0); break;
    case 'quick-signin': busy('Opening your workspace…', () => signIn(id)); break;
    case 'signout': signOut(); break;
    case 'save-version': busy('Saving version…', async () => { const d = await saveDraft($('#vnote')?.value.trim()); track('version_saved', { draft: d.n, words: d.words }); toast(`Saved as Draft ${d.n}.`); }); break;
    case 'scan': busy('Reading your manuscript and building the Glossary…', scanBible); break;
    case 'review': busy('Reviewing grammar and checking your story for conflicts…', runReview); break;
    case 'add-char': S.bible.characters.push(normChar({ name: 'New character' })); render(); break;
    case 'add-plot': S.bible.plotlines.push(normPlot({ title: 'New plotline' })); render(); break;
    case 'del-char': S.bible.characters = S.bible.characters.filter((c) => c.id !== id); render(); break;
    case 'del-plot': S.bible.plotlines = S.bible.plotlines.filter((p) => p.id !== id); render(); break;
    case 'save-bible': busy('Saving your Glossary…', async () => { await commitBible($('#bnote')?.value.trim() || 'Edited by author', 'Author edit'); toast('Glossary saved to history.'); }); break;
    case 'discard-bible': S.bible = JSON.parse(S.bibleSaved); render(); break;
    case 'mode': S.mode = id; render(); if (id === 'review' && S.sel) requestAnimationFrame(() => scrollToMark(S.sel)); break;
    case 'cat': S.cat = id; S.sel = null; if (S.mode !== 'review' && (curReport() || S.gconf.items.length)) S.mode = 'review'; render(); if (S.sel) requestAnimationFrame(() => scrollToMark(S.sel)); break;
    case 'prev': case 'next': { const l = visibleFindings(), j = l.findIndex((x) => x.id === S.sel) + (a.dataset.act === 'next' ? 1 : -1); if (l[j]) select(l[j].id); break; }
    case 'pick': select(id); break;
    case 'goto-q': select(id, +a.dataset.k); break;
    case 'goto-ch': gotoChapter(+id); break;
    case 'resolved': S.showResolved = a.checked; render(); break;
    case 'choose': busy('Updating your text…', () => chooseOption(id, +a.dataset.k)); break;
    case 'resolve': busy('Saving…', () => setStatus(id, 'resolved')); break;
    case 'undo-edit': case 'undo-last': {
      const eid = a.dataset.act === 'undo-last' ? S.edits[0]?.id : id; if (!eid) break;
      const ok = undoEdit(eid); saveWorking(true); toast(ok ? 'Change undone.' : 'Undone where possible: part of that text had been edited since.'); render(); break;
    }
    case 'go-gconf': S.cat = 'glossary'; S.mode = 'review'; S.sel = null; location.hash = '#manuscript'; break;
    case 'dismiss': busy('Saving…', () => setStatus(id, 'dismissed')); break;
    case 'reopen': busy('Saving…', () => setStatus(id, 'open')); break;
    case 'copy-report': copyReport(); break;
    case 'cmp-draft': S.compare = { t: 'draft', id }; render(); window.scrollTo(0, 0); break;
    case 'cmp-bible': S.compare = { t: 'bible', id }; render(); window.scrollTo(0, 0); break;
    case 'close-compare': S.compare = null; render(); break;
    case 'open-draft': {
      if (textDirty() && !S.confirmOpen) { S.confirmOpen = true; toast('Your edits since the last draft will be replaced. Click Open again to continue, or save a new draft first.'); setTimeout(() => (S.confirmOpen = false), 5000); return; }
      S.confirmOpen = false; S.meta.currentDraftId = id; S.text = S.drafts.find((d) => d.id === id).text; S.edits = []; S.mode = 'edit';
      busy('Opening…', async () => { await Store.set('meta', S.meta); await saveWorking(true); }); location.hash = '#manuscript'; break;
    }
    case 'restore-draft': busy('Restoring…', async () => { const d = S.drafts.find((x) => x.id === id); S.text = d.text; const nd = await saveDraft(`Restored from Draft ${d.n}`); toast(`Draft ${d.n} restored as Draft ${nd.n}.`); }); break;
    case 'restore-bible': busy('Restoring…', async () => { const h = S.history.find((x) => x.id === id); S.bible = clone(h.snapshot); await commitBible(`Restored: ${h.note || h.source}`, 'Restore'); toast('Glossary restored.'); }); break;
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'text') { S.text = t.value; const wc = $('#wc'); if (wc) wc.textContent = countWords(S.text).toLocaleString() + ' words'; updateSaveButton(); updateLimit(); const dm = $('#dirty'); if (dm) dm.textContent = textDirty() && currentDraft() ? ' · edited since' : ''; saveWorking(); return; }
  if (t.id === 'title') { S.meta.title = t.value; clearTimeout(t._t); t._t = setTimeout(() => Store.set('meta', S.meta).catch(() => {}), 800); return; }
  const b = t.dataset.bind; if (!b) return;
  const [kind, id, f] = b.split(':');
  const item = (kind === 'c' ? S.bible.characters : S.bible.plotlines).find((x) => x.id === id); if (!item) return;
  item[f] = f === 'aliases' ? t.value.split(',').map((s) => s.trim()).filter(Boolean) : f === 'keyEvents' ? t.value.split('\n').map((s) => s.trim()).filter(Boolean) : t.value;
  updateBibleBar();
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.bind) e.target.dispatchEvent(new Event('input', { bubbles: true }));
});
function updateSaveButton() {
  const btn = document.querySelector('[data-act="save-version"]'); if (btn) btn.disabled = !(S.text.trim() && textDirty());
  const rv = document.querySelector('[data-act="review"]'); if (rv) rv.disabled = !S.text.trim();
}
function updateBibleBar() {
  const dirty = bibleDirty();
  ['#bnote', '[data-act="save-bible"]', '[data-act="discard-bible"]'].forEach((s) => { const el = document.querySelector(s); if (el) el.disabled = !dirty; });
  const msg = document.querySelector('#bnote')?.previousElementSibling;
  if (msg) { msg.textContent = dirty ? 'You have unsaved changes.' : 'All changes saved.'; msg.style.color = dirty ? 'var(--warn)' : 'var(--muted)'; }
}
async function copyReport() {
  const lines = [`Margins review · ${S.meta.title || 'Untitled'} · ${when(Date.now())}`, ''];
  for (const [k, l] of TABS) {
    const fs = tabItems(k); if (!fs.length) continue;
    lines.push(`== ${l} ==`);
    for (const f of fs) {
      const st = { open: 'OPEN', fixed: 'FIXED', resolved: 'RESOLVED', dismissed: 'NOT AN ISSUE' }[f.status] || f.status.toUpperCase();
      lines.push(`[${st}] ${f.title}`, `  ${f.explanation}`);
      if (f.fix) lines.push(`  "${f.fix.find}" → "${f.fix.replace}"`); else lines.push(...f.quotes.map((q) => `  "${q}"`));
      if (f.options) lines.push(`  Options: ${f.options.map((o) => o.label).join(' / ')}`);
      lines.push('');
    }
  }
  try { await navigator.clipboard.writeText(lines.join('\n')); toast('Report copied.'); } catch (_) { toast('Couldn\u2019t copy. Select the text and copy it instead.'); }
}
$('#file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; busy('Reading your file…', () => readFile(f)); });
document.addEventListener('dragover', (e) => { if (e.target.closest('#drop')) { e.preventDefault(); $('#drop').classList.add('drag'); } });
document.addEventListener('dragleave', (e) => { if (e.target.closest('#drop')) $('#drop').classList.remove('drag'); });
document.addEventListener('drop', (e) => { const z = e.target.closest('#drop'); if (!z) return; e.preventDefault(); z.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) busy('Reading your file…', () => readFile(f)); });
document.addEventListener('submit', (e) => {
  if (e.target.id !== 'signin-form') return;
  e.preventDefault();
  const v = $('#email').value.trim(), err = $('#email-err');
  const bad = (m, el) => { err.textContent = m; err.hidden = false; el.focus(); };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return bad('Please enter a valid email address.', $('#email'));
  if (!$('#pw')) { busy('Opening your workspace…', () => signIn(v)); return; }
  const pw = $('#pw').value;
  if (pw.length < 6) return bad('Please use a password with at least 6 characters.', $('#pw'));
  S.prefill = v;
  busy(S.createMode ? 'Creating your account…' : 'Signing in…', () => signIn(v, pw, !!S.createMode));
});
window.addEventListener('hashchange', () => { S.compare = null; S.error = ''; render(); window.scrollTo(0, 0); });
window.addEventListener('beforeunload', (e) => { if (bibleDirty()) { e.preventDefault(); e.returnValue = ''; } });

render();
load();
})();
