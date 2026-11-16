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
const CATS = [['characters', 'Characters'], ['plotlines', 'Plotlines'], ['timeline', 'Timeline'], ['details', 'Details & names']];

const track = (ev, props) => { try { if (window.posthog && window.posthog.capture) window.posthog.capture(ev, props || {}); } catch (_) {} };
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ---------- storage: account (db) → browser (localStorage) → memory ----------
const Store = {
  mode: 'memory', db: null, uid: null, mem: {},
  async init() {
    try {
      if (window.claude && claude.use) {
        const [db, user] = await Promise.all([claude.use('db'), claude.use('user')]);
        const id = db && user ? await user.id() : null;
        if (id) { this.db = db; this.uid = id; this.mode = 'account'; return; }
      }
    } catch (_) { /* fall through */ }
    try { localStorage.setItem('margins:test', '1'); localStorage.removeItem('margins:test'); this.mode = 'browser'; } catch (_) { this.mode = 'memory'; }
  },
  full(p) { return 'data/users/' + this.uid + '/' + p; },
  async get(p) {
    if (this.mode === 'account') { const s = await this.db.doc(this.full(p)).get(); return s.exists ? clone(s.data()) : null; }
    const raw = this.mode === 'browser' ? localStorage.getItem('margins:' + p) : this.mem[p];
    return raw ? JSON.parse(raw) : null;
  },
  async set(p, data) {
    if (this.mode === 'account') return this.db.doc(this.full(p)).set(data);
    const raw = JSON.stringify(data);
    if (this.mode === 'browser') localStorage.setItem('margins:' + p, raw); else this.mem[p] = raw;
  },
  async list(col) {
    if (this.mode === 'account') { const q = await this.db.collection(this.full(col)).get(); return q.docs.map((d) => ({ ...clone(d.data()), id: d.id })); }
    const keys = this.mode === 'browser' ? Object.keys(localStorage).map((k) => k.replace(/^margins:/, '')) : Object.keys(this.mem);
    const pre = col + '/';
    return keys.filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes('/')).map((k) => ({ ...JSON.parse(this.mode === 'browser' ? localStorage.getItem('margins:' + k) : this.mem[k]), id: k.slice(pre.length) }));
  },
};

// ---------- state ----------
const S = {
  meta: { title: '', currentDraftId: null },
  drafts: [], bible: { characters: [], plotlines: [] }, bibleSaved: '',
  history: [], reports: {}, text: '', reportId: null, reportTab: 'summary', reportFilter: 'open',
  busy: '', error: '', ai: null, aiSource: '', compare: null, loaded: false,
  mode: 'edit', cat: 'all', sel: null, showResolved: false,
};
const currentDraft = () => S.drafts.find((d) => d.id === S.meta.currentDraftId) || S.drafts[S.drafts.length - 1] || null;
const textDirty = () => S.text !== (currentDraft()?.text ?? '');
const bibleDirty = () => JSON.stringify(S.bible) !== S.bibleSaved;

async function load() {
  await Store.init();
  try {
    S.meta = (await Store.get('meta')) || S.meta;
    S.drafts = (await Store.list('meta/drafts')).sort((a, b) => a.n - b.n);
    const b = await Store.get('bible');
    if (b) S.bible = { characters: b.characters || [], plotlines: b.plotlines || [] };
    S.bibleSaved = JSON.stringify(S.bible);
    S.history = (await Store.list('meta/history')).sort((a, b) => b.at - a.at);
    for (const r of await Store.list('meta/reports')) S.reports[r.id] = r;
    S.text = currentDraft()?.text || '';
    S.reportId = latestReportId();
  } catch (e) {
    S.error = 'Couldn’t load your saved work. ' + (e.message || '');
  }
  $('#store').textContent = { account: 'Saved to your account · private to you', browser: 'Saved in this browser only', memory: 'Not saved (storage unavailable)' }[Store.mode];
  try { S.ai = window.claude && claude.use ? await claude.use('sample') : null; if (S.ai) S.aiSource = 'Claude'; } catch (_) { S.ai = null; }
  if (!S.ai) {
    try {
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
async function saveDraft(note) {
  const n = S.drafts.reduce((m, d) => Math.max(m, d.n), 0) + 1;
  const d = { n, note: note || '', text: S.text, words: countWords(S.text), createdAt: Date.now() };
  if (JSON.stringify(d).length > 240000) throw new Error('This draft is too large to save in one piece (about 40,000 words). Save one part or a few chapters at a time.');
  const id = newId();
  await Store.set('meta/drafts/' + id, d);
  S.drafts.push({ ...d, id });
  S.meta.currentDraftId = id;
  await Store.set('meta', S.meta);
  return { ...d, id };
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

// Find a quote in the text, ignoring case, spacing and curly quotes. Returns the exact text or null.
function locate(text, quote) {
  if (!quote) return null;
  if (text.includes(quote)) return quote;
  const norm = (s) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  const ws = norm(quote).split(/\s+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!ws.length) return null;
  const m = new RegExp(ws.join('\\s+'), 'i').exec(norm(text));
  return m ? text.slice(m.index, m.index + m[0].length) : null;
}

async function scanBible() {
  const d = currentDraft();
  if (!d) throw new Error('Save your manuscript first.');
  const prompt = `You are building a story bible for a fiction manuscript. List its characters and plotlines.
Only use facts stated in the text. Leave a field as "" if the text doesn't say. At most 25 characters and 10 plotlines. Notes: one short sentence.
Reply with JSON only, exactly this shape:
{"characters":[{"name":"","aliases":[],"role":"","age":"","eyes":"","hair":"","notes":""}],
 "plotlines":[{"title":"","summary":"","status":"open","keyEvents":[""]}]}
status is "open" or "resolved".

Manuscript:
"""
${clip(d.text)}
"""`;
  const scan = await askAI(prompt);
  let added = 0, filled = 0;
  for (const c of scan.characters || []) {
    if (!c || !c.name) continue;
    const ex = findChar(c.name) || (c.aliases || []).map(findChar).find(Boolean);
    if (!ex) { S.bible.characters.push(normChar(c)); added++; continue; }
    for (const f of ['role', 'age', 'eyes', 'hair', 'notes']) if (!ex[f] && c[f]) { ex[f] = String(c[f]); filled++; }
    ex.aliases = [...new Set([...(ex.aliases || []), ...(c.aliases || []).map(String)])].filter((a) => a && a.toLowerCase() !== ex.name.toLowerCase());
  }
  for (const p of scan.plotlines || []) {
    if (!p || !p.title) continue;
    const ex = S.bible.plotlines.find((x) => x.title.toLowerCase() === String(p.title).toLowerCase());
    if (!ex) { S.bible.plotlines.push(normPlot(p)); added++; continue; }
    if (!ex.summary && p.summary) { ex.summary = String(p.summary); filled++; }
  }
  await commitBible(`AI scan of Draft ${d.n}${d.text.length > AI_LIMIT ? ' (first ~10,000 words)' : ''}: ${added} added, ${filled} details filled`, 'AI scan');
  toast(`Story Bible updated: ${added} new, ${filled} details filled.`);
  track('bible_scanned', { added, filled });
  location.hash = '#story-bible';
}
const findChar = (name) => S.bible.characters.find((x) => [x.name, ...(x.aliases || [])].some((n) => n && n.toLowerCase() === String(name).toLowerCase()));
const normChar = (c) => ({ id: newId(), name: String(c.name || 'New character'), aliases: (c.aliases || []).map(String), role: String(c.role || ''), age: String(c.age || ''), eyes: String(c.eyes || ''), hair: String(c.hair || ''), notes: String(c.notes || '') });
const normPlot = (p) => ({ id: newId(), title: String(p.title || 'New plotline'), summary: String(p.summary || ''), status: p.status === 'resolved' ? 'resolved' : 'open', keyEvents: (p.keyEvents || []).map(String).filter(Boolean) });

const RULE_CAT = { 'place-visit': 'timeline', 'never-met': 'timeline', 'after-death': 'timeline', 'eye-colour': 'characters', 'hair-colour': 'characters', age: 'characters', 'only-child': 'characters', 'name-spelling': 'details' };

async function runReview() {
  if (!S.text.trim()) throw new Error('Add your manuscript first.');
  if (textDirty()) await saveDraft('Saved before review');
  const d = currentDraft();
  const findings = window.MarginsChecker.analyze(d.text).map((f) => ({
    id: newId(), source: 'Rule check', category: RULE_CAT[f.rule] || 'details', title: f.title, explanation: f.explanation,
    severity: f.confidence === 'likely' ? 'high' : 'medium', quotes: f.spans.map((s) => d.text.slice(s.start, s.end)), bibleUpdate: null, status: 'open',
  }));
  let aiUsed = false, dropped = 0, aiNote = '';
  if (S.ai) {
    try {
      const out = await askAI(`You are a continuity editor for fiction. Compare the manuscript with the author's Story Bible (facts the author has confirmed) and with itself.
Find contradictions about characters (names, ages, appearance, family, relationships), plotlines (threads dropped, resolved twice, events out of order), timeline, and small details.
Do not comment on style, grammar or plot quality. Never rewrite the text. Do not invent problems. At most 15 findings.
Every finding must quote the exact conflicting words from the manuscript, copied character for character.
If approving the finding should record a fact in the Story Bible, give it in "bibleUpdate" (the value most consistent with the rest of the manuscript), otherwise null.
Reply with JSON only:
{"findings":[{"category":"characters|plotlines|timeline|details","title":"short heading","explanation":"one or two plain sentences","severity":"high|medium|low","quotes":["exact words"],
 "bibleUpdate":null}]}
bibleUpdate, when used, is {"kind":"character","name":"","field":"age|eyes|hair|role|notes","value":""} or {"kind":"plotline","title":"","field":"status|summary","value":""}.

Story Bible:
${JSON.stringify(S.bible)}

Manuscript:
"""
${clip(d.text)}
"""`);
      for (const f of out.findings || []) {
        const quotes = (f.quotes || []).map((q) => locate(d.text, String(q))).filter(Boolean);
        if (!quotes.length) { dropped++; continue; } // quote not in the text: likely invented, so drop it
        const cat = CATS.some(([k]) => k === f.category) ? f.category : 'details';
        const u = f.bibleUpdate && f.bibleUpdate.field && f.bibleUpdate.value ? f.bibleUpdate : null;
        findings.push({ id: newId(), source: 'AI', category: cat, title: String(f.title || 'Possible inconsistency'), explanation: String(f.explanation || ''),
          severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'medium', quotes, bibleUpdate: u, status: 'open' });
      }
      aiUsed = true;
    } catch (e) { aiNote = e.message; }
  } else aiNote = 'AI wasn’t available, so this report uses the free rule checks only.';
  for (const f of findings) f.pos = f.quotes.map((q) => { const i = d.text.indexOf(q); return i < 0 ? null : [i, i + q.length]; }).filter(Boolean);
  findings.sort((a, b) => ((a.pos[0] || [1e9])[0]) - ((b.pos[0] || [1e9])[0]));
  const report = { draftId: d.id, draftN: d.n, createdAt: Date.now(), findings, aiUsed, dropped, aiNote, truncated: d.text.length > AI_LIMIT };
  await Store.set('meta/reports/' + d.id, report);
  S.reports[d.id] = { ...report, id: d.id };
  S.reportId = d.id; S.cat = 'all'; S.showResolved = false; S.mode = 'review'; S.sel = visibleFindings()[0]?.id || null;
  track('review_run', { findings: findings.length, ai: aiUsed, dropped, words: d.words });
  toast(`Review done: ${findings.length} suggestion${findings.length === 1 ? '' : 's'}.`);
  location.hash = '#manuscript';
}

async function setStatus(fid, status) {
  const r = S.reports[S.reportId]; const f = r?.findings.find((x) => x.id === fid);
  if (!f) return;
  f.status = status;
  if (status === 'approved' && f.bibleUpdate && !f.applied) {
    applyUpdate(f.bibleUpdate);
    await commitBible(`Approved: ${f.title}`, 'Approved finding');
    f.applied = true;
    toast('Approved. Story Bible updated.');
  } else toast(status === 'approved' ? 'Approved.' : status === 'dismissed' ? 'Marked as not an issue.' : 'Moved back to open.');
  const { id, ...body } = r;
  await Store.set('meta/reports/' + id, body);
  track(status === 'approved' ? 'finding_approved' : status === 'dismissed' ? 'finding_dismissed' : 'finding_reopened', { source: f.source, category: f.category });
  if (status !== 'open') {
    const all = curReport().findings.filter((x) => S.cat === 'all' || x.category === S.cat), at = all.findIndex((x) => x.id === fid);
    const next = all.slice(at + 1).find((x) => x.status === 'open') || all.find((x) => x.status === 'open');
    S.sel = next ? next.id : null;
  }
  render();
}
function applyUpdate(u) {
  if (u.kind === 'plotline') {
    let p = S.bible.plotlines.find((x) => x.title.toLowerCase() === String(u.title || '').toLowerCase());
    if (!p) { p = normPlot({ title: u.title }); S.bible.plotlines.push(p); }
    p[u.field === 'status' ? 'status' : 'summary'] = u.field === 'status' ? (String(u.value).toLowerCase().includes('resolv') ? 'resolved' : 'open') : String(u.value);
  } else {
    let c = findChar(u.name || '');
    if (!c) { c = normChar({ name: u.name }); S.bible.characters.push(c); }
    const f = ['age', 'eyes', 'hair', 'role', 'notes'].includes(u.field) ? u.field : 'notes';
    c[f] = String(u.value);
  }
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
      <p class="lead">Margins reads your manuscript, builds a Story Bible of your characters and plotlines, and flags continuity slips in a clear report that you approve. It never rewrites your words.</p>
      <div class="row">
        <a class="btn" href="#manuscript">Start with your manuscript →</a>
        <button class="btn sec" data-act="sample">Try a sample manuscript</button>
      </div>
    </div>
    ${QUILL}
  </section>
  <div class="grid" style="margin-bottom:20px">
    <div class="card feature"><h3><span class="ic">✦</span>Story Bible</h3><p class="muted small">Characters and plotlines pulled from your manuscript by AI. Edit anything, and every change is kept.</p></div>
    <div class="card feature"><h3><span class="ic">⟲</span>Version history</h3><p class="muted small">Save drafts as you revise, see exactly what changed, and restore any earlier version.</p></div>
    <div class="card feature"><h3><span class="ic">▤</span>Tabbed report</h3><p class="muted small">Findings sorted into Characters, Plotlines, Timeline and Details, each with the quoted evidence.</p></div>
    <div class="card feature"><h3><span class="ic">✓</span>You approve</h3><p class="muted small">Approve or dismiss each finding. Approving can record the right fact in your Story Bible.</p></div>
  </div>
  <div class="card" id="how">
    <h2>How Margins works</h2>
    <ol class="steps">
      <li><b>Add your manuscript.</b> <span class="muted">On the Manuscript tab, upload a .docx or .txt file or paste your text. Click <i>Update history</i> to save it as a draft.</span></li>
      <li><b>Build your Story Bible.</b> <span class="muted">Click <i>Scan for characters &amp; plotlines</i>. Review and edit them, then click <i>Update history</i> to save your changes.</span></li>
      <li><b>Run a continuity review.</b> <span class="muted">Margins checks the manuscript against itself and your Story Bible, using AI plus free rule checks. Problems are highlighted in your text.</span></li>
      <li><b>Work through the suggestions.</b> <span class="muted">The Suggestions panel has tabs for Characters, Plotlines, Timeline and Details. Step through them with the arrows, and click ✓ to approve (and record the right fact) or ✕ if it's not an issue.</span></li>
      <li><b>Revise and track.</b> <span class="muted">Edit and save new versions. History shows every draft and Story Bible change, side by side, with restore.</span></li>
    </ol>
    <p class="muted small" style="margin:0">This site uses PostHog analytics, which may record visits (including session replays) to help improve Margins. ${Store.mode === 'account' ? 'Your work is saved to your account and only you can see it.' : 'Your work is saved in this browser.'} The AI reads up to about 10,000 words per run; review long books a few chapters at a time.</p>
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
function ensurePos(r) {
  for (const f of r.findings) if (!f.pos) { const d = S.drafts.find((x) => x.id === r.draftId); f.pos = d ? f.quotes.map((q) => { const i = d.text.indexOf(q); return i < 0 ? null : [i, i + q.length]; }).filter(Boolean) : []; }
}
function visibleFindings() {
  const r = curReport(); if (!r) return [];
  ensurePos(r);
  return r.findings.filter((f) => (S.cat === 'all' || f.category === S.cat) && (S.showResolved || f.status === 'open'));
}

function viewWorkspace() {
  const d = currentDraft(), dirty = textDirty();
  const chs = chapters(S.mode === 'review' && curReport() ? (S.drafts.find((x) => x.id === curReport().draftId)?.text || S.text) : S.text);
  const left = `<aside class="pane side">
    <div class="side-h">Manuscript</div>
    <input type="text" id="title" class="title-in" value="${esc(S.meta.title)}" placeholder="Untitled manuscript" />
    <p class="side-meta">${d ? `Draft ${d.n} · saved ${when(d.createdAt)}` : 'Not saved yet'}<span id="dirty" style="color:var(--warn)">${dirty ? ' · unsaved changes' : ''}</span></p>
    <div class="side-h small-h">Chapters</div>
    <div class="chlist">${chs.length ? chs.map((c, i) => `<button class="ch" data-act="goto-ch" data-id="${c.at}"><span>${i + 1}</span>${esc(c.title)}</button>`).join('') : '<p class="side-meta">No chapter headings found. Lines like “Chapter One” appear here.</p>'}</div>
    <div class="side-foot">
      <div class="row"><button class="btn sec small" data-act="upload">Upload .docx / .txt</button><button class="btn sec small" data-act="sample">Sample</button></div>
      <label class="f" for="vnote">Save a version</label>
      <input type="text" id="vnote" placeholder="What changed?" />
      <button class="btn small" style="width:100%;margin-top:6px" data-act="save-version" ${S.text.trim() && dirty ? '' : 'disabled'}>Update history (save Draft ${S.drafts.length ? S.drafts[S.drafts.length - 1].n + 1 : 1})</button>
      <p class="side-meta" id="wc" style="text-align:center;margin-top:10px">${countWords(S.text).toLocaleString()} words</p>
    </div>
  </aside>`;

  const r = curReport();
  let paper;
  if (S.mode === 'review' && r) {
    const rd = S.drafts.find((x) => x.id === r.draftId);
    const stale = rd && rd.text !== S.text;
    paper = (stale ? `<div class="stale">You've edited the text since this review. <button class="btn small" data-act="review">Review again</button></div>` : '') + annotated(rd ? rd.text : '', r);
  } else {
    paper = `<textarea id="text" class="paper-edit" placeholder="Paste your manuscript here, or drop a .docx / .txt file…&#10;&#10;Tip: start chapters on their own line, e.g. “Chapter One”, so they show in the chapter list.">${esc(S.text)}</textarea>`;
  }
  const center = `<section class="pane center">
    <div class="center-bar">
      <b class="doc-title">${esc(S.meta.title || 'Untitled manuscript')}</b>
      <div class="seg"><button class="${S.mode === 'edit' ? 'on' : ''}" data-act="mode" data-id="edit">Edit</button><button class="${S.mode === 'review' ? 'on' : ''}" data-act="mode" data-id="review" ${r ? '' : 'disabled'}>Review highlights</button></div>
    </div>
    <div class="paper-wrap" id="paper-wrap"><div class="paper dropzone" id="drop">${paper}</div></div>
  </section>`;

  return `<div class="workspace">${left}${center}${suggestionsPane()}</div>`;
}

function annotated(text, r) {
  const spans = [];
  for (const f of r.findings) if (S.showResolved || f.status === 'open' || f.id === S.sel) for (const [a, b] of f.pos || []) spans.push({ a, b, f });
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
      body += `<mark data-f="${ids.join(' ')}" class="${ids.includes(S.sel) ? 'sel' : ''} ${cov[0].f.severity}">${piece}</mark>`;
    }
    const isCh = line.length < 80 && CHAPTER_RE.test(line);
    html += isCh ? `<h2 class="chap" data-at="${off}">${body}</h2>` : `<p data-at="${off}">${body}</p>`;
    off = end + 1;
  }
  return `<div class="paper-read" id="read">${html || '<p class="muted">Nothing to show.</p>'}</div>`;
}

function suggestionsPane() {
  const r = curReport();
  const actions = `<div class="row" style="margin-bottom:10px">
      <button class="btn small" data-act="review" ${S.text.trim() ? '' : 'disabled'}>Run continuity review</button>
      <button class="btn sec small" data-act="scan" ${currentDraft() && S.ai ? '' : 'disabled'}>Scan Story Bible</button></div>
    <p class="side-meta" style="margin:0 0 12px">${S.ai ? `AI ready (${esc(S.aiSource)}) · plus free rule checks` : 'AI not available here · free rule checks only'}</p>`;
  if (!r) return `<aside class="pane sugg"><div class="sugg-h"><b>Suggestions</b></div>${actions}
    <div class="empty-s"><p><b>No review yet.</b></p><p class="side-meta">Add your manuscript, then run a continuity review. Suggestions appear here, and the matching words are highlighted in your text.</p></div></aside>`;
  ensurePos(r);
  const all = r.findings, done = all.filter((f) => f.status !== 'open').length, pct = all.length ? Math.round((done / all.length) * 100) : 100;
  const list = visibleFindings();
  if (!list.some((f) => f.id === S.sel)) S.sel = list[0]?.id || null;
  const i = list.findIndex((f) => f.id === S.sel), f = list[i];
  const cats = [['all', 'All'], ...CATS];
  const tabs = cats.map(([k, l]) => { const n = all.filter((x) => (k === 'all' || x.category === k) && x.status === 'open').length; return `<button class="${S.cat === k ? 'on' : ''}" data-act="cat" data-id="${k}">${l}<span class="n">${n}</span></button>`; }).join('');
  const card = f ? `<div class="scard ${f.status}">
      <div class="row" style="justify-content:space-between">
        <div class="row" style="gap:6px"><span class="pill ${f.severity}">${f.severity}</span><span class="pill">${esc(f.source)}</span>${f.status !== 'open' ? `<span class="pill ${f.status}">${f.status === 'approved' ? 'Approved' : 'Not an issue'}</span>` : ''}</div>
        ${f.status === 'open' ? `<div class="row" style="gap:6px"><button class="iconbtn ok" title="Approve" data-act="approve" data-id="${f.id}">✓</button><button class="iconbtn no" title="Not an issue" data-act="dismiss" data-id="${f.id}">✕</button></div>` : `<button class="btn sec small" data-act="reopen" data-id="${f.id}">Undo</button>`}
      </div>
      <h3 style="margin-top:8px">${esc(f.title)}</h3>
      <p class="side-meta" style="font-size:14px">${esc(f.explanation)}</p>
      ${f.quotes.map((q, k) => `<button class="squote" data-act="goto-q" data-id="${f.id}" data-k="${k}">“${esc(q)}”</button>`).join('')}
      ${f.bibleUpdate ? `<div class="upd">If approved, the Story Bible records <b>${esc(f.bibleUpdate.kind === 'plotline' ? f.bibleUpdate.title : f.bibleUpdate.name)}</b> · ${esc(f.bibleUpdate.field)} = <b>${esc(f.bibleUpdate.value)}</b>${f.applied ? ' ✓' : ''}</div>` : ''}
    </div>` : `<div class="empty-s"><p><b>${S.showResolved ? 'Nothing in this section.' : 'All done here. 🎉'}</b></p><p class="side-meta">${S.showResolved ? '' : 'Every suggestion in this section has been reviewed.'}</p></div>`;
  return `<aside class="pane sugg">
    <div class="sugg-h"><b>Suggestions</b><span class="side-meta">Draft ${r.draftN} · ${when(r.createdAt)}</span></div>
    ${actions}
    <div class="spread side-meta"><span>${done} of ${all.length} reviewed</span><span>${pct}%</span></div>
    <div class="progress" style="margin:4px 0 12px"><div style="width:${pct}%"></div></div>
    <div class="ctabs">${tabs}</div>
    <div class="pager"><button class="iconbtn" data-act="prev" ${i > 0 ? '' : 'disabled'} title="Previous">‹</button><span>${list.length ? `${i + 1} of ${list.length} suggestions` : '0 suggestions'}</span><button class="iconbtn" data-act="next" ${i >= 0 && i < list.length - 1 ? '' : 'disabled'} title="Next">›</button></div>
    ${card}
    <div class="slist">${list.filter((x) => x.id !== S.sel).map((x) => `<button class="srow" data-act="pick" data-id="${x.id}"><span class="dot ${x.severity}"></span><span>${esc(x.title)}</span>${x.status !== 'open' ? `<span class="pill ${x.status}" style="margin-left:auto">${x.status === 'approved' ? '✓' : '—'}</span>` : ''}</button>`).join('')}</div>
    <div class="spread" style="margin-top:12px">
      <label class="side-meta" style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" data-act="resolved" ${S.showResolved ? 'checked' : ''}/> Show resolved</label>
      <div class="row" style="gap:6px">${Object.keys(S.reports).length > 1 ? `<select id="pick-report" style="width:auto;padding:4px 6px;font-size:12px">${Object.values(S.reports).sort((a, b) => b.createdAt - a.createdAt).map((x) => `<option value="${x.id}" ${x.id === r.id ? 'selected' : ''}>Draft ${x.draftN}</option>`).join('')}</select>` : ''}<button class="btn sec small" data-act="copy-report">Copy report</button></div>
    </div>
    ${r.dropped || r.truncated || (!r.aiUsed && r.aiNote) ? `<p class="side-meta" style="margin-top:10px">${!r.aiUsed && r.aiNote ? esc(r.aiNote) + ' ' : ''}${r.dropped ? `${r.dropped} AI suggestion(s) dropped because the quoted words weren't in your text. ` : ''}${r.truncated ? 'The AI read the first ~10,000 words.' : ''}</p>` : ''}
  </aside>`;
}

// Scroll the manuscript to a finding's highlight (or a chapter).
function scrollToMark(fid, k) {
  const marks = [...document.querySelectorAll('#read mark')].filter((m) => m.dataset.f.split(' ').includes(fid));
  const r = curReport(); const f = r?.findings.find((x) => x.id === fid);
  let target = marks[0];
  if (f && f.pos && f.pos[k || 0]) {
    const want = f.pos[k || 0][0];
    target = [...document.querySelectorAll('#read [data-at]')].filter((p) => +p.dataset.at <= want).pop()?.querySelector(`mark[data-f~="${fid}"]`) || target;
  }
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
    <div class="spread"><div><h2 style="margin:0">Story Bible</h2><p class="muted small" style="margin:0">The facts of your story. Reviews check the manuscript against them.</p></div>
      <button class="btn sec" data-act="scan" ${currentDraft() && S.ai ? '' : 'disabled'}>Scan manuscript with AI</button></div>
  </div>
  <div class="card" style="position:sticky;top:64px;z-index:3">
    <div class="row">
      <span class="small" style="color:${dirty ? 'var(--warn)' : 'var(--muted)'}">${dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
      <input type="text" id="bnote" style="flex:1;min-width:200px" placeholder="What changed? e.g. Mara is now 29" ${dirty ? '' : 'disabled'} />
      <button class="btn" data-act="save-bible" ${dirty ? '' : 'disabled'}>Update history</button>
      <button class="btn sec" data-act="discard-bible" ${dirty ? '' : 'disabled'}>Discard</button>
    </div>
  </div>
  <div class="card"><div class="spread"><h2>Characters (${b.characters.length})</h2><button class="btn sec small" data-act="add-char">+ Add character</button></div>
    ${chars ? `<div class="grid">${chars}</div>` : '<p class="muted">No characters yet. Scan your manuscript or add one.</p>'}</div>
  <div class="card"><div class="spread"><h2>Plotlines (${b.plotlines.length})</h2><button class="btn sec small" data-act="add-plot">+ Add plotline</button></div>
    ${plots ? `<div class="grid">${plots}</div>` : '<p class="muted">No plotlines yet. Scan your manuscript or add one.</p>'}</div>`;
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
    panel = `<div class="card"><div class="spread"><h2>Story Bible changes: ${esc(h.note || h.source)}</h2><button class="btn sec small" data-act="close-compare">Close</button></div>
      <div class="diff" style="font-family:inherit">${bibleChanges(prev?.snapshot, h.snapshot)}</div></div>`;
  }
  return `${panel}<div class="card"><h2>History</h2>
    <p class="muted small">Every saved draft and Story Bible update, newest first.</p>
    ${items.length ? `<div class="tl">${items.map((x) => x.t === 'draft'
      ? `<div class="item"><div class="spread"><div><b>Draft ${x.d.n}</b> <span class="pill">Manuscript</span>${x.d.id === S.meta.currentDraftId ? ' <span class="pill approved">current</span>' : ''}<br><span class="muted small">${when(x.at)} · ${x.d.words.toLocaleString()} words${x.d.note ? ' · ' + esc(x.d.note) : ''}</span></div>
          <div class="row"><button class="btn sec small" data-act="cmp-draft" data-id="${x.d.id}">What changed</button><button class="btn sec small" data-act="open-draft" data-id="${x.d.id}">Open</button>${x.d.id === S.meta.currentDraftId ? '' : `<button class="btn sec small" data-act="restore-draft" data-id="${x.d.id}">Restore as new version</button>`}</div></div></div>`
      : `<div class="item bible"><div class="spread"><div><b>${esc(x.h.note || 'Story Bible update')}</b> <span class="pill">Story Bible · ${esc(x.h.source)}</span><br><span class="muted small">${when(x.at)} · ${x.h.snapshot.characters.length} characters, ${x.h.snapshot.plotlines.length} plotlines</span></div>
          <div class="row"><button class="btn sec small" data-act="cmp-bible" data-id="${x.h.id}">What changed</button><button class="btn sec small" data-act="restore-bible" data-id="${x.h.id}">Restore this version</button></div></div></div>`).join('')}</div>`
    : '<p class="muted">Nothing saved yet. Save your manuscript or update your Story Bible to start your history.</p>'}</div>`;
}

const VIEWS = { home: viewHome, manuscript: viewWorkspace, 'story-bible': viewBible, history: viewHistory };
const route = () => { const h = location.hash.slice(1); return h === 'report' ? 'manuscript' : VIEWS[h] ? h : 'home'; };

function render() {
  const v = route();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.v === v));
  const banner = (S.busy ? `<div class="banner"><span class="spin"></span>${esc(S.busy)}</div>` : '') + (S.error ? `<div class="banner err">${esc(S.error)}</div>` : '');
  const keepScroll = window.scrollY;
  const keep = {}; document.querySelectorAll('.pane, #paper-wrap, #text').forEach((el, i) => (keep[i] = el.scrollTop));
  document.body.classList.toggle('ws', v === 'manuscript');
  $('#view').innerHTML = (v === 'home' || v === 'manuscript' ? '' : '<div style="height:24px"></div>') + (v === 'manuscript' ? `<div class="ws-banner">${banner}</div>` : banner) + (S.loaded ? VIEWS[v]() : '<p class="muted" style="padding:40px 0">Loading your work…</p>');
  if (S.busy) document.querySelectorAll('#view button').forEach((b) => (b.disabled = true));
  document.querySelectorAll('.pane, #paper-wrap, #text').forEach((el, i) => { if (keep[i]) el.scrollTop = keep[i]; });
  window.scrollTo(0, keepScroll);
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
      if (S.text.trim() && textDirty()) { toast('Save or clear your current text first.'); return; }
      S.text = SAMPLE; S.mode = 'edit'; if (!S.meta.title) S.meta.title = 'The Partner (sample)'; track('sample_loaded'); location.hash = '#manuscript'; render(); toast('Sample loaded. Save it as a version, then scan or review.'); break;
    case 'upload': $('#file').click(); break;
    case 'save-version': busy('Saving version…', async () => { const d = await saveDraft($('#vnote')?.value.trim()); track('version_saved', { draft: d.n, words: d.words }); toast(`Saved as Draft ${d.n}.`); }); break;
    case 'scan': busy('Reading your manuscript and building the Story Bible…', scanBible); break;
    case 'review': busy('Reviewing your manuscript for continuity…', runReview); break;
    case 'add-char': S.bible.characters.push(normChar({ name: 'New character' })); render(); break;
    case 'add-plot': S.bible.plotlines.push(normPlot({ title: 'New plotline' })); render(); break;
    case 'del-char': S.bible.characters = S.bible.characters.filter((c) => c.id !== id); render(); break;
    case 'del-plot': S.bible.plotlines = S.bible.plotlines.filter((p) => p.id !== id); render(); break;
    case 'save-bible': busy('Saving your Story Bible…', async () => { await commitBible($('#bnote')?.value.trim() || 'Edited by author', 'Author edit'); toast('Story Bible saved to history.'); }); break;
    case 'discard-bible': S.bible = JSON.parse(S.bibleSaved); render(); break;
    case 'mode': S.mode = id; render(); if (id === 'review' && S.sel) requestAnimationFrame(() => scrollToMark(S.sel)); break;
    case 'cat': S.cat = id; S.sel = null; render(); if (S.mode === 'review' && S.sel) requestAnimationFrame(() => scrollToMark(S.sel)); break;
    case 'prev': case 'next': { const l = visibleFindings(), j = l.findIndex((x) => x.id === S.sel) + (a.dataset.act === 'next' ? 1 : -1); if (l[j]) select(l[j].id); break; }
    case 'pick': select(id); break;
    case 'goto-q': select(id, +a.dataset.k); break;
    case 'goto-ch': gotoChapter(+id); break;
    case 'resolved': S.showResolved = a.checked; render(); break;
    case 'approve': busy('Saving…', () => setStatus(id, 'approved')); break;
    case 'dismiss': busy('Saving…', () => setStatus(id, 'dismissed')); break;
    case 'reopen': busy('Saving…', () => setStatus(id, 'open')); break;
    case 'copy-report': copyReport(); break;
    case 'cmp-draft': S.compare = { t: 'draft', id }; render(); window.scrollTo(0, 0); break;
    case 'cmp-bible': S.compare = { t: 'bible', id }; render(); window.scrollTo(0, 0); break;
    case 'close-compare': S.compare = null; render(); break;
    case 'open-draft': {
      if (textDirty()) { toast('Save your current changes first (Manuscript tab).'); return; }
      S.meta.currentDraftId = id; S.text = S.drafts.find((d) => d.id === id).text; S.mode = 'edit';
      busy('Opening…', () => Store.set('meta', S.meta)); location.hash = '#manuscript'; break;
    }
    case 'restore-draft': busy('Restoring…', async () => { const d = S.drafts.find((x) => x.id === id); S.text = d.text; const nd = await saveDraft(`Restored from Draft ${d.n}`); toast(`Draft ${d.n} restored as Draft ${nd.n}.`); }); break;
    case 'restore-bible': busy('Restoring…', async () => { const h = S.history.find((x) => x.id === id); S.bible = clone(h.snapshot); await commitBible(`Restored: ${h.note || h.source}`, 'Restore'); toast('Story Bible restored.'); }); break;
  }
});
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'text') { S.text = t.value; const wc = $('#wc'); if (wc) wc.textContent = countWords(S.text).toLocaleString() + ' words'; updateSaveButton(); const dm = $('#dirty'); if (dm) dm.textContent = textDirty() ? ' · unsaved changes' : ''; return; }
  if (t.id === 'title') { S.meta.title = t.value; clearTimeout(t._t); t._t = setTimeout(() => Store.set('meta', S.meta).catch(() => {}), 800); return; }
  const b = t.dataset.bind; if (!b) return;
  const [kind, id, f] = b.split(':');
  const item = (kind === 'c' ? S.bible.characters : S.bible.plotlines).find((x) => x.id === id); if (!item) return;
  item[f] = f === 'aliases' ? t.value.split(',').map((s) => s.trim()).filter(Boolean) : f === 'keyEvents' ? t.value.split('\n').map((s) => s.trim()).filter(Boolean) : t.value;
  updateBibleBar();
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'pick-report') { S.reportId = e.target.value; S.reportTab = 'summary'; render(); }
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
  const r = S.reports[S.reportId]; if (!r) return;
  const lines = [`Margins continuity report · ${S.meta.title || 'Untitled'} · Draft ${r.draftN} · ${when(r.createdAt)}`, ''];
  for (const [k, l] of CATS) {
    const fs = r.findings.filter((f) => f.category === k); if (!fs.length) continue;
    lines.push(`== ${l} ==`);
    for (const f of fs) lines.push(`[${f.status === 'open' ? 'OPEN' : f.status === 'approved' ? 'APPROVED' : 'NOT AN ISSUE'}] (${f.severity}) ${f.title}`, `  ${f.explanation}`, ...f.quotes.map((q) => `  "${q}"`), '');
  }
  try { await navigator.clipboard.writeText(lines.join('\n')); toast('Report copied.'); } catch (_) { toast('Couldn’t copy. Select the text and copy it instead.'); }
}
$('#file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; busy('Reading your file…', () => readFile(f)); });
document.addEventListener('dragover', (e) => { if (e.target.closest('#drop')) { e.preventDefault(); $('#drop').classList.add('drag'); } });
document.addEventListener('dragleave', (e) => { if (e.target.closest('#drop')) $('#drop').classList.remove('drag'); });
document.addEventListener('drop', (e) => { const z = e.target.closest('#drop'); if (!z) return; e.preventDefault(); z.classList.remove('drag'); const f = e.dataTransfer.files[0]; if (f) busy('Reading your file…', () => readFile(f)); });
window.addEventListener('hashchange', () => { S.compare = null; S.error = ''; render(); window.scrollTo(0, 0); });
window.addEventListener('beforeunload', (e) => { if (textDirty() || bibleDirty()) { e.preventDefault(); e.returnValue = ''; } });

render();
load();
})();
