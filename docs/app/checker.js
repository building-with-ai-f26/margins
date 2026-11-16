/*
 * Margins continuity checker (rule-based, runs entirely in the browser).
 *
 * analyze(text) returns a list of findings. Each finding looks like:
 *   {
 *     id:          unique id for this run, e.g. "f3"
 *     key:         stable signature (same text → same key), used for "dismiss"
 *     rule:        which check produced it, e.g. "place-visit"
 *     title:       short heading shown to the author
 *     explanation: one or two sentences in plain English
 *     confidence:  "likely" (strong signal) or "check" (worth a look)
 *     spans:       [{ start, end, label }] character ranges in the original text
 *   }
 *
 * Every rule is a small function that takes the text and returns findings.
 * To add a check: write a function, then add it to RULES at the bottom.
 * This file has no dependencies and also loads in Node (see tests/).
 */
(function (root) {
  'use strict';

  // ---------- helpers ----------

  // A character name: "Sarah", "O'Brien", "Mary-Jane". Optional surname handled per rule.
  const NAME = "[A-Z][a-z]+(?:['’-][A-Z]?[a-z]+)?";
  const POSS = "['’]s"; // possessive, straight or curly apostrophe

  // Capitalised words that are usually not character names.
  const NOT_NAMES = new Set((
    'The A An And But Or So Then When While After Before Because If Though Although ' +
    'She He It They We You I His Her Their Our My Your Its This That These Those There Here ' +
    'What Who Why How Where Which Yes No Not Now Just Still Even Only Once Later Soon ' +
    'Outside Inside Behind Above Below Across Around Through Over Under Again Maybe Perhaps ' +
    'Mr Mrs Ms Dr Miss Sir Lady Lord Aunt Uncle Grandma Grandpa Mom Dad Mum Mother Father ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday ' +
    'January February March April May June July August September October November December ' +
    'Chapter Part Book Street Road Avenue Station Hotel Hospital School Church God Christmas'
  ).split(' '));

  const isName = (w) => w && !NOT_NAMES.has(w);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Every match of a regex (must have the g flag), from an optional start index.
  function allMatches(re, text, from = 0) {
    re.lastIndex = 0;
    const out = [];
    for (const m of text.matchAll(re)) if (m.index >= from) out.push(m);
    return out;
  }

  const span = (m, label) => ({ start: m.index, end: m.index + m[0].length, label });

  // ---------- numbers written as words (for ages) ----------

  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const ONES_ALT = ONES.slice().sort((a, b) => b.length - a.length).join('|');
  const NUMBER = `(?:\\d{1,3}|(?:${TENS.filter(Boolean).join('|')})(?:[- ](?:${ONES.slice(1, 10).join('|')}))?|${ONES_ALT})`;

  function toNumber(s) {
    s = s.toLowerCase();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const [t, o] = s.split(/[- ]/);
    if (TENS.includes(t)) return TENS.indexOf(t) * 10 + (o ? ONES.indexOf(o) : 0);
    return ONES.indexOf(t);
  }

  // ---------- rule 1: "never been to X" … later "trip to X" ----------

  function placeVisits(text) {
    const findings = [];
    const PLACE = "(?:the\\s+)?([A-Z][\\w'’-]*(?:\\s+[A-Z][\\w'’-]*)*)";
    const neverRe = new RegExp(
      `\\b(?:had\\s+)?never\\s+(?:been\\s+to|visited|set\\s+foot\\s+in|travel(?:l)?ed\\s+to|gone\\s+to)\\s+${PLACE}`, 'g');
    const seen = new Set();
    for (const first of allMatches(neverRe, text)) {
      const place = first[1];
      if (!isName(place.split(/\s+/)[0]) || seen.has(place)) continue;
      const P = esc(place);
      const after = first.index + first[0].length;
      // Strong signals that the character has been there before.
      const strong = new RegExp(
        `\\b(?:trip\\s+to|been\\s+to|back\\s+in|returned\\s+to|lived\\s+in|grew\\s+up\\s+in|holiday\\s+in|vacation\\s+in|last\\s+time\\s+(?:she|he|they|I|we)\\s+(?:was|were)\\s+in)\\s+(?:the\\s+)?${P}\\b`, 'gi');
      // Weaker signals: could be the current visit, so only "worth a look".
      const weak = new RegExp(`\\b(?:visited|remembered|recogni[sz]ed)\\s+(?:the\\s+)?${P}\\b`, 'gi');
      const s = allMatches(strong, text, after)[0];
      const w = s ? null : allMatches(weak, text, after)[0];
      const later = s || w;
      if (!later) continue;
      seen.add(place);
      findings.push({
        rule: 'place-visit',
        title: `Earlier visit to ${place}?`,
        explanation: `The text says the character has never been to ${place}, but later suggests a previous visit.`,
        confidence: s ? 'likely' : 'check',
        spans: [span(first, 'never visited'), span(later, 'earlier visit')],
      });
    }
    return findings;
  }

  // ---------- rule 2: "never met X" … later "X again" ----------

  function neverMet(text) {
    const findings = [];
    const re = new RegExp(`\\b(?:had\\s+)?never\\s+(?:met|seen)\\s+(${NAME})(?!${POSS})\\b`, 'g');
    const seen = new Set();
    for (const first of allMatches(re, text)) {
      const who = first[1];
      if (!isName(who) || seen.has(who)) continue;
      const W = esc(who);
      const later = new RegExp(
        `\\b(?:${W}\\s+again|remembered\\s+(?:meeting\\s+)?${W}|(?:met|seen|saw)\\s+${W}\\s+(?:before|last|once|years|at\\s+the|when))\\b`, 'gi');
      const m = allMatches(later, text, first.index + first[0].length)[0];
      if (!m) continue;
      seen.add(who);
      findings.push({
        rule: 'never-met',
        title: `Has the character met ${who} before?`,
        explanation: `${who} is described as someone the character has never met, but a later line implies they already know each other.`,
        confidence: 'likely',
        spans: [span(first, 'never met'), span(m, 'met before')],
      });
    }
    return findings;
  }

  // ---------- rule 3: eye and hair colour changes ----------

  // Each colour belongs to one or more "families"; two colours conflict if they share none.
  const EYE = { blue: ['blue'], green: ['green'], brown: ['brown'], hazel: ['hazel', 'brown', 'green'],
    grey: ['grey'], gray: ['grey'], silver: ['grey'], amber: ['amber'], black: ['dark'], dark: ['dark', 'brown'],
    violet: ['violet'] };
  const HAIR = { blond: ['blond'], blonde: ['blond'], golden: ['blond'], fair: ['blond'],
    red: ['red'], ginger: ['red'], auburn: ['red', 'brown'], copper: ['red'],
    black: ['dark'], dark: ['dark', 'brown'], raven: ['dark'], brown: ['brown'], chestnut: ['brown'],
    grey: ['grey'], gray: ['grey'], silver: ['grey'], white: ['grey'] };

  function featureColours(text, feature, table, label) {
    const C = Object.keys(table).join('|');
    const patterns = [
      // "Sarah's blue eyes", "Sarah's bright blue eyes"
      new RegExp(`\\b(${NAME})${POSS}\\s+(?:[a-z]+\\s+)?(${C})\\s+${feature}`, 'g'),
      // "Sarah had blue eyes", "Sarah Moore has long red hair"
      new RegExp(`\\b(${NAME})(?:\\s+[A-Z][a-z]+)?\\s+(?:had|has)\\s+(?:[a-z]+\\s+)?(${C})\\s+${feature}`, 'g'),
    ];
    const byName = new Map();
    for (const re of patterns) {
      for (const m of allMatches(re, text)) {
        if (!isName(m[1])) continue;
        if (!byName.has(m[1])) byName.set(m[1], []);
        byName.get(m[1]).push({ m, colour: m[2].toLowerCase() });
      }
    }
    const findings = [];
    for (const [who, list] of byName) {
      list.sort((a, b) => a.m.index - b.m.index);
      const first = list[0];
      const clash = list.find((x) => !table[x.colour].some((f) => table[first.colour].includes(f)));
      if (!clash) continue;
      findings.push({
        rule: `${label}-colour`,
        title: `${who}'s ${label} colour changes`,
        explanation: `${who} is described with ${first.colour} ${feature} and later with ${clash.colour} ${feature}.`,
        confidence: 'likely',
        spans: [span(first.m, first.colour), span(clash.m, clash.colour)],
      });
    }
    return findings;
  }

  const eyeColour = (t) => featureColours(t, 'eyes', EYE, 'eye');
  const hairColour = (t) => featureColours(t, 'hair', HAIR, 'hair');

  // ---------- rule 4: a character's age changes ----------

  function ages(text) {
    const N = NUMBER;
    const patterns = [
      // "Katherine, 36," / "Katherine (36)"
      new RegExp(`\\b(${NAME}),\\s+(\\d{1,3}),`, 'g'),
      new RegExp(`\\b(${NAME})\\s+\\((\\d{1,3})\\)`, 'g'),
      // "Katherine was thirty-four," / "Tom is 12 years old"
      new RegExp(`\\b(${NAME})(?:\\s+[A-Z][a-z]+)?\\s+(?:was|is|had\\s+just\\s+turned|turned)\\s+(${N})(?=\\s+years?\\s+old|\\s*[,.;!?—])`, 'gi'),
      // "thirty-four-year-old Katherine"
      new RegExp(`\\b(${N})[- ]years?[- ]old\\s+(${NAME})`, 'gi'),
    ];
    const byName = new Map();
    patterns.forEach((re, i) => {
      for (const m of allMatches(re, text)) {
        const [who, num] = i === 3 ? [m[2], m[1]] : [m[1], m[2]];
        if (!/^[A-Z]/.test(who) || !isName(who)) continue;
        const age = toNumber(num);
        if (!(age >= 0)) continue;
        if (!byName.has(who)) byName.set(who, []);
        byName.get(who).push({ m, age });
      }
    });
    const findings = [];
    for (const [who, list] of byName) {
      list.sort((a, b) => a.m.index - b.m.index);
      const other = list.find((x) => x.age !== list[0].age);
      if (!other) continue;
      findings.push({
        rule: 'age',
        title: `${who}'s age doesn't match`,
        explanation: `${who} is ${list[0].age} in one place and ${other.age} in another. Fine if time passes between them; otherwise worth fixing.`,
        confidence: 'check',
        spans: [span(list[0].m, `age ${list[0].age}`), span(other.m, `age ${other.age}`)],
      });
    }
    return findings;
  }

  // ---------- rule 5: only child … later has a brother/sister ----------

  function onlyChild(text) {
    const findings = [];
    const re = new RegExp(
      `\\b(${NAME})(?:\\s+[A-Z][a-z]+)?\\s+(?:was|is)\\s+an\\s+only\\s+child|\\b(${NAME})(?:\\s+[A-Z][a-z]+)?\\s+(?:had|has)\\s+no\\s+(?:siblings|brothers?\\s+or\\s+sisters?)`, 'g');
    for (const first of allMatches(re, text)) {
      const who = first[1] || first[2];
      if (!isName(who)) continue;
      const after = first.index + first[0].length;
      const SIB = '(?:older\\s+|younger\\s+|little\\s+|big\\s+|baby\\s+|twin\\s+)?(?:brother|sister|siblings?)';
      const named = allMatches(new RegExp(`\\b${esc(who)}${POSS}\\s+${SIB}\\b`, 'g'), text, after)[0];
      // A pronoun ("his sister") is weaker evidence: it might refer to someone else.
      const pronoun = named ? null
        : allMatches(new RegExp(`\\b(?:his|her|their)\\s+${SIB}\\b`, 'gi'), text, after)
          .find((m) => m.index - after < 1500);
      const later = named || pronoun;
      if (!later) continue;
      findings.push({
        rule: 'only-child',
        title: `${who} is an only child, but has a sibling?`,
        explanation: named
          ? `${who} is described as an only child, then a sibling of ${who}'s appears.`
          : `${who} is described as an only child. Check whether "${later[0]}" refers to ${who}.`,
        confidence: named ? 'likely' : 'check',
        spans: [span(first, 'only child'), span(later, 'sibling')],
      });
    }
    return findings;
  }

  // ---------- rule 6: a character dies … then acts or speaks ----------

  function deadCharacter(text) {
    const findings = [];
    const deathRe = new RegExp(
      `\\b(${NAME})\\s+(?:had\\s+)?(?:died|passed\\s+away|was\\s+killed|was\\s+buried)\\b|\\b(${NAME})${POSS}\\s+(?:funeral|death|grave)\\b`, 'g');
    const seen = new Set();
    const VERBS = 'said|says|asked|replied|smiled|laughed|walked|called|nodded|whispered|shouted|waved|answered|grinned|winked|stood|sat';
    for (const d of allMatches(deathRe, text)) {
      const who = d[1] || d[2];
      if (!isName(who) || seen.has(who)) continue;
      const W = esc(who);
      const acts = new RegExp(`\\b${W}\\s+(?:${VERBS})\\b|\\b(?:said|asked|replied|whispered)\\s+${W}\\b`, 'g');
      const later = allMatches(acts, text, d.index + d[0].length)[0];
      if (!later) continue;
      seen.add(who);
      findings.push({
        rule: 'after-death',
        title: `${who} appears after dying`,
        explanation: `${who}'s death is mentioned, then ${who} acts or speaks later. Fine for a flashback or dream; otherwise a timeline slip.`,
        confidence: 'check',
        spans: [span(d, 'death'), span(later, 'acts later')],
      });
    }
    return findings;
  }

  // ---------- rule 7: name spelled two ways (Katherine / Kathrine) ----------

  // Edit distance with adjacent swaps, stopping early once it's clearly > 1.
  function nearlySame(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
      }
    }
    return d[a.length][b.length] === 1;
  }

  function nameVariants(text) {
    const words = new Map(); // word -> { count, mid, matches }
    for (const m of allMatches(/\b[A-Z][a-z]{3,}\b/g, text)) {
      const w = m[0];
      if (!isName(w)) continue;
      const before = text.slice(Math.max(0, m.index - 3), m.index);
      const startOfSentence = m.index === 0 || /(?:[.!?]["'”’]?\s+|\n\s*|^\s*["“'‘]|[.!?]\s*["“'‘])$/.test(before);
      if (!words.has(w)) words.set(w, { count: 0, mid: 0, matches: [] });
      const e = words.get(w);
      e.count++;
      if (!startOfSentence) e.mid++;
      e.matches.push(m);
    }
    const list = [...words.entries()];
    const findings = [];
    const flagged = new Set();
    for (const [common, c] of list) {
      if (c.mid === 0) continue; // must look like a real name (used mid-sentence)
      for (const [rare, r] of list) {
        if (rare === common || flagged.has(rare)) continue;
        if (r.count > 2 || c.count < r.count * 2) continue; // rare variant must be clearly rarer
        if (rare === common + 's' || common === rare + 's') continue; // plurals
        if (!nearlySame(common, rare)) continue;
        flagged.add(rare);
        findings.push({
          rule: 'name-spelling',
          title: `"${rare}" or "${common}"?`,
          explanation: `"${common}" appears ${c.count} times and "${rare}" ${r.count === 1 ? 'once' : r.count + ' times'}. If they're the same character, one is probably a typo.`,
          confidence: c.count >= 3 ? 'likely' : 'check',
          spans: [span(c.matches[0], common), ...r.matches.map((m) => span(m, rare))],
        });
      }
    }
    return findings;
  }

  // ---------- run everything ----------

  const RULES = [
    { fn: placeVisits, name: 'Places a character has "never" been, then visited before' },
    { fn: neverMet, name: 'People a character has "never met", then knows' },
    { fn: eyeColour, name: 'Eye colour that changes' },
    { fn: hairColour, name: 'Hair colour that changes' },
    { fn: ages, name: 'Ages that don’t match' },
    { fn: onlyChild, name: 'An "only child" who has a brother or sister' },
    { fn: deadCharacter, name: 'Characters who act or speak after dying' },
    { fn: nameVariants, name: 'Names spelled two different ways' },
  ];

  function analyze(text) {
    if (!text || !text.trim()) return [];
    const findings = [];
    for (const r of RULES) {
      try {
        findings.push(...r.fn(text));
      } catch (err) {
        // One broken rule should never stop the others.
        if (typeof console !== 'undefined') console.error('Margins rule failed:', r.name, err);
      }
    }
    findings.sort((a, b) => a.spans[0].start - b.spans[0].start);
    findings.forEach((f, i) => {
      f.id = 'f' + (i + 1);
      f.key = f.rule + ':' + f.spans.map((s) => text.slice(s.start, s.end)).join('|');
    });
    return findings;
  }

  const api = { analyze, RULE_NAMES: RULES.map((r) => r.name), _toNumber: toNumber, _nearlySame: nearlySame };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MarginsChecker = api;
})(typeof window !== 'undefined' ? window : globalThis);
