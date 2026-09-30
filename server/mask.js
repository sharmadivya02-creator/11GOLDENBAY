// mask.js — hides identity numbers and contact details in FREE TEXT.
//
// Where it runs: on the caller's words, voice transcripts and AI summaries,
// BEFORE they go to Gemini and BEFORE they reach any hospital.
//
// HONEST LIMITS of these built-in rules: they catch numbers and emails well;
// they catch addresses only partly; they do NOT catch names at all. Masking is
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

// Kept async so callers can `await mask(...)`.
async function mask(text) {
  return maskBuiltin(String(text || ''));
}

module.exports = { mask, maskBuiltin, verhoeffValid };
