// mask.js — hides identity numbers and contact details in FREE TEXT.
//
// Where it runs: on the caller's words, voice transcripts and AI summaries,
// BEFORE they go to Gemini and BEFORE they reach any hospital.
//
// Two engines:
//   1. Presidio (open source, runs as a separate service) when PRESIDIO_URL is
//      set and answers within 3 s — then the built-in rules as a second pass.
//   2. These built-in rules otherwise. Every result says which engine ran, so
//      the app never claims Presidio when it was not used.
//
// HONEST LIMITS of the built-in rules: they catch numbers and emails well;
// they catch addresses only partly; they do not catch names at all. Masking is
// not anonymisation: masked text can still identify a person in context.

// ---- Verhoeff checksum: the check-digit scheme Aadhaar numbers use --------
const D = [
  [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],
  [4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],
  [8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0],
];
const P = [
  [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],
  [9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8],
];
function verhoeffValid(digits) {
  let c = 0;
  const rev = digits.split('').reverse().map(Number);
  for (let i = 0; i < rev.length; i++) c = D[c][P[i % 8][rev[i]]];
  return c === 0;
}

// Order matters: longer, more specific patterns first.
const RULES = [
  { type: 'EMAIL',   re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: 'AADHAAR', re: /\b[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    label: (m) => (verhoeffValid(m.replace(/\D/g, '')) ? 'AADHAAR' : 'ID NUMBER') },
  { type: 'NUMBER',  re: /\b(?:\d[\s-]?){13,19}\b/g },               // card-like long numbers
  { type: 'PAN',     re: /\b[A-Z]{5}\d{4}[A-Z]\b/gi },
  { type: 'PHONE',   re: /(?:\+?91[\s-]?|\b0)?\b[6-9]\d{4}[\s-]?\d{5}\b/g }, // Indian mobiles
  { type: 'PHONE',   re: /\b0\d{2,4}[\s-]?\d{6,8}\b/g },               // landlines with STD code
  { type: 'PINCODE', re: /\b[1-9]\d{5}\b/g },
  { type: 'ADDRESS', re: /\b(?:house|h\.?\s?no\.?|flat|plot|door)\s*(?:no\.?|number|#)?\s*[\w/-]+/gi },
];

function maskBuiltin(text) {
  let out = String(text || '');
  const found = [];
  for (const rule of RULES) {
    out = out.replace(rule.re, (m) => {
      const label = rule.label ? rule.label(m) : rule.type;
      found.push(label);
      return `[${label}]`;
    });
  }
  return { text: out, engine: 'builtin', found };
}

// ---- Presidio (optional) ---------------------------------------------------
// Presidio is Microsoft's open-source PII detector. It runs as its OWN small
// service (not inside this app). If PRESIDIO_URL is set, we ask it first:
//   POST {PRESIDIO_URL}/analyze   {"text": "...", "language": "en"}
//   -> [{ entity_type, start, end, score }, ...]
// Its big win over our rules: it can spot PERSON NAMES and places.
// Times and dates are kept (a doctor needs "started 20 minutes ago").
// If Presidio is slow (>3 s), down, or not set, the built-in rules run alone —
// and the result says so. The built-in rules ALWAYS run as a second pass,
// because they know Indian formats (Aadhaar checksum, PAN, +91 mobiles).
const KEEP = new Set(['DATE_TIME', 'NRP']);
const MIN_SCORE = 0.5;

// What the app can truthfully say about Presidio right now.
const status = { lastOk: null, lastError: null, okCount: 0, failCount: 0 };
const presidioBase = () => (process.env.PRESIDIO_URL || '').replace(/\/+$/, '');
const TIMEOUT_MS = () => Math.max(500, Number(process.env.PRESIDIO_TIMEOUT_MS) || 4000);
function presidioStatus() {
  return { configured: !!presidioBase(), ...status };
}
// A free host puts an idle service to sleep. A quiet ping every few minutes
// keeps the first real emergency from waiting for it to wake up.
function keepPresidioWarm() {
  // Off unless PRESIDIO_WARM_SECONDS is set: on a free host, pinging all day uses up the monthly free hours.
  if (!presidioBase() || !process.env.PRESIDIO_WARM_SECONDS) return;
  const ping = async () => {
    try { await mask('Keep warm. Call 9876543210 for Anita.'); } catch { /* status already records it */ }
  };
  ping();
  const every = Math.max(60, Number(process.env.PRESIDIO_WARM_SECONDS)) * 1000;
  setInterval(ping, every).unref();
}

async function presidioSpans(text) {
  const base = presidioBase();
  if (!base || !text) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS());
  try {
    const res = await fetch(base + '/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.PRESIDIO_KEY ? { 'x-api-key': process.env.PRESIDIO_KEY } : {}) },
      body: JSON.stringify({ text, language: 'en' }), signal: ctl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const arr = await res.json();
    if (!Array.isArray(arr)) throw new Error('unexpected reply');
    status.lastOk = new Date().toISOString(); status.okCount++;
    return arr.filter((r) => r && Number.isInteger(r.start) && Number.isInteger(r.end) && r.end > r.start
      && (r.score ?? 1) >= MIN_SCORE && !KEEP.has(r.entity_type));
  } catch (err) {
    console.error('[mask] Presidio not used:', err.message);
    status.lastError = `${new Date().toISOString()} ${err.name === 'AbortError' ? 'too slow (timeout)' : err.message}`; status.failCount++;
    return null;
  } finally { clearTimeout(t); }
}

function applySpans(text, spans) {
  // longest first, then drop overlaps, then replace from the end so positions stay valid
  const chosen = [];
  for (const s of [...spans].sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    if (!chosen.some((c) => s.start < c.end && c.start < s.end)) chosen.push(s);
  }
  let out = text;
  for (const s of chosen.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + `[${String(s.entity_type).replace(/_/g, ' ')}]` + out.slice(s.end);
  }
  return { text: out, found: chosen.map((s) => String(s.entity_type).replace(/_/g, ' ')) };
}

async function mask(text) {
  const src = String(text || '');
  const spans = await presidioSpans(src);
  if (!spans) return maskBuiltin(src);
  const first = applySpans(src, spans);
  const second = maskBuiltin(first.text);
  return { text: second.text, engine: 'presidio+builtin', found: [...first.found, ...second.found] };
}

module.exports = { mask, maskBuiltin, verhoeffValid, presidioStatus, keepPresidioWarm };
