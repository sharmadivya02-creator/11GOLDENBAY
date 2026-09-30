// ai.js — every Gemini call in GoldenBay goes through this file.
//
// Gemini's jobs (see the roadmap, "Gemini and the agent"):
//   1. understandEmergency   — messy words + button taps -> structured picture
//   2+4. planAndHandover     — the agent's next actions + the ER handover note
//   3. draftProfileFromImage — prescription photo -> draft profile fields
//   5. add-ons               — lab report reading, CPR scene description
//
// RULES THAT HOLD FOR EVERY JOB
//   - Gemini organises information. It never diagnoses, recommends treatment,
//     chooses a hospital, or accepts/declines for one.
//   - Every output is checked by code before anyone sees it.
//   - Identity details (names, phone numbers, Aadhaar) are not sent: callers'
//     words are masked first, and only medical fields of a profile are sent.
//   - Any failure (no key, network, quota, 12 s timeout) falls back to plain
//     rules, so the product still works without Gemini.

const { SERVICES, URGENCY, EMERGENCY_TYPES } = require('../shared/emergency');

// GEMINI_BASE_URL exists only so the automated test can point at a fake Gemini.
const GEMINI_URL = (model) =>
  `${process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'}/v1beta/models/${model}:generateContent`;

// Google's API keys now come in two shapes: the old "AIza..." ones and the
// newer "AQ...." ones. The newer keys are REJECTED if you put them in the URL
// as ?key=... — they must go in the x-goog-api-key header. Sending the header
// works for both kinds, so we always use the header.
function apiKey() {
  return (process.env.GEMINI_API_KEY || '').trim();
}

// Remembers why the last Gemini call failed, so we can show it in the browser
// at /v1/ai-status instead of making you dig through the terminal.
let lastError = null;
function noteError(where, err) {
  lastError = { where, message: err.message, at: new Date().toISOString() };
  console.error(`[ai] ${where} failed → using mock:`, err.message);
}
function getLastError() { return lastError; }

// Makes one real call right now and reports exactly what happened.
async function selfTest() {
  const key = apiKey();
  const info = {
    keyPresent: !!key,
    keyLength: key.length,
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    mockAiSetting: process.env.MOCK_AI || '(not set)',
    geminiEnabled: geminiEnabled(),
    lastError,
  };
  if (!info.geminiEnabled) {
    info.result = 'DISABLED — either no key, or MOCK_AI=true';
    return info;
  }
  try {
    const out = await callGemini([
      { text: 'Return JSON exactly: {"status":"working"}' },
    ]);
    info.result = 'SUCCESS ✅';
    info.reply = out;
  } catch (err) {
    info.result = 'FAILED ❌';
    info.error = err.message;
  }
  return info;
}

function geminiEnabled() {
  const key = apiKey();
  const mock = String(process.env.MOCK_AI || '').toLowerCase() === 'true';
  return !mock && !!key && !key.startsWith('paste-');
}

// Google sometimes answers 503 "model is experiencing high demand" (or 429).
// Try once more after a short pause — on GEMINI_FALLBACK_MODEL if you set one,
// otherwise on the same model. Hospitals are already being asked while this
// runs, so a slow or failed answer never delays the search.
async function callGemini(parts) {
  const main = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  try {
    return await callGeminiOnce(parts, main);
  } catch (err) {
    if (!/HTTP (503|429|500)/.test(String(err.message))) throw err;
    await new Promise((r) => setTimeout(r, 800));
    return callGeminiOnce(parts, process.env.GEMINI_FALLBACK_MODEL || main);
  }
}

async function callGeminiOnce(parts, model) {

  // Fail fast instead of hanging: if Gemini doesn't respond within 12s,
  // abort and let the caller fall back to the mock response. Without this,
  // a stalled (not erroring) network call could leave a screen spinning
  // forever instead of degrading gracefully like every other failure mode.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  let res;
  try {
    res = await fetch(GEMINI_URL(model), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey(),
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        // NOTE: we deliberately do NOT set maxOutputTokens. On thinking models
        // the reasoning tokens count against that budget, so a cap that looks
        // generous can still cut the answer off mid-JSON. The default is large.
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Gemini timed out after 12s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const replyParts = candidate?.content?.parts || [];

  // Gemini 3.x models THINK before answering, and their thinking comes back as
  // extra parts in the same response. Taking parts[0] blindly gets you the
  // model's reasoning instead of the answer — which is not JSON, so parsing
  // explodes. So: skip anything flagged as a thought, and join the real text.
  const text = replyParts
    .filter((p) => p && typeof p.text === 'string' && p.thought !== true)
    .map((p) => p.text)
    .join('')
    .trim();

  if (!text) {
    throw new Error(
      `no usable text (finishReason=${candidate?.finishReason || 'unknown'}, ` +
      `parts=${replyParts.length})`
    );
  }

  // Some models wrap JSON in a ```json fence even when asked not to.
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`bad JSON from Gemini: ${cleaned.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// 1) Prescription photo → draft profile fields
// ---------------------------------------------------------------------------

const PROFILE_PROMPT = `You are an information-extraction assistant for GoldenBay, an emergency-preparedness app.
Read this photo of a medical document (often a handwritten Indian prescription or a lab/discharge report).
Extract ONLY what is actually legible. Never guess or invent values. Use [] or null for anything unclear.
Return JSON exactly in this shape:
{
  "fullName": string|null,
  "age": number|null,
  "bloodGroup": string|null,
  "allergies": string[],
  "medications": string[],        // include dose/frequency if written
  "conditions": string[],         // conditions explicitly named in the document
  "notes": string|null,           // anything important that fits nowhere else
  "confidence": "high"|"medium"|"low",
  "illegibleParts": string[]      // what you could NOT read, so a human checks
}`;

function mockProfileDraft() {
  return {
    fullName: null,
    age: null,
    bloodGroup: null,
    allergies: ['Penicillin (mock extraction)'],
    medications: ['Metformin 500mg twice daily (mock extraction)', 'Telmisartan 40mg morning (mock extraction)'],
    conditions: ['Type 2 Diabetes (mock extraction)', 'Hypertension (mock extraction)'],
    notes: 'MOCK MODE: no Gemini key configured — these are sample values to demonstrate the flow.',
    confidence: 'low',
    illegibleParts: [],
    _source: 'mock',
  };
}

async function draftProfileFromImage(base64Data, mimeType) {
  if (geminiEnabled()) {
    try {
      const result = await callGemini([
        { text: PROFILE_PROMPT },
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Data } },
      ]);
      return { ...result, _source: 'gemini' };
    } catch (err) {
      noteError('profile draft', err);
      return { ...mockProfileDraft(), _fallbackReason: err.message };
    }
  }
  return mockProfileDraft();
}

// ---------------------------------------------------------------------------
// JOB 1 — understand the emergency
//
// Input: the caller's words (already masked), the quick buttons tapped, and
// the patient's MEDICAL fields only (no name, no contacts, no insurance).
// Output: a structured picture. It drives which hospitals are asked, but only
// through rules in engine.js: AI services may ADD to the buttons' choice and
// reorder hospitals; they can never remove a hospital from the list.
// ---------------------------------------------------------------------------

const UNDERSTAND_PROMPT = (input) => `You organise information for GoldenBay, an emergency app in India.
A family member or bystander reported an emergency, possibly in panicked English, Hindi or Hinglish.
You must NOT diagnose and must NOT recommend treatment. You only organise what is said.

Buttons tapped by the caller: ${JSON.stringify(input.typeLabels)}
Caller's words (identity details already removed): "${input.words}"
Patient medical background (no identity): ${JSON.stringify(input.patient)}

Return JSON exactly in this shape:
{
  "suspectedCategory": string,     // short, e.g. "possible cardiac event"; always end with "— unconfirmed"
  "urgency": "CRITICAL"|"HIGH"|"MODERATE",
  "services": string[],            // hospital services this may need, ONLY from: ${SERVICES.join(', ')}
  "risks": string[],               // max 4: facts from the background that matter now (allergies, blood thinners...). Never invent.
  "questionsForCaller": string[]   // max 3 short, simple questions a family member can answer
}`;

function cleanStrings(arr, max, maxLen) {
  return (Array.isArray(arr) ? arr : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim().slice(0, maxLen))
    .slice(0, max);
}

// Code check on whatever the model returned. Anything outside the rules is dropped.
function validateUnderstanding(raw) {
  const out = {
    suspectedCategory: typeof raw?.suspectedCategory === 'string' ? raw.suspectedCategory.trim().slice(0, 90) : null,
    urgency: URGENCY.includes(raw?.urgency) ? raw.urgency : null,
    services: [...new Set(cleanStrings(raw?.services, 11, 20).map((x) => x.toLowerCase()))].filter((x) => SERVICES.includes(x)),
    risks: cleanStrings(raw?.risks, 4, 140),
    questionsForCaller: cleanStrings(raw?.questionsForCaller, 3, 120),
  };
  if (out.suspectedCategory && !/unconfirmed/i.test(out.suspectedCategory)) out.suspectedCategory += ' — unconfirmed';
  out.rejected = cleanStrings(raw?.services, 20, 20).filter((x) => !SERVICES.includes(x.toLowerCase()));
  return out;
}

// Plain-rules fallback: buttons first, then keywords (English, Hinglish, Hindi).
function mockUnderstanding(input) {
  const d = (input.words || '').toLowerCase();
  const types = input.typeIds || [];
  const kw = [
    { re: /(chest|heart|seene|seena|छाती|सीने)/, services: ['cardiac', 'cathlab'], cat: 'possible cardiac event', urgency: 'CRITICAL' },
    { re: /(breath|saans|सांस)/, services: ['icu'], cat: 'breathing difficulty', urgency: 'CRITICAL' },
    { re: /(stroke|slur|face droop|lakwa|लकवा)/, services: ['stroke', 'neuro'], cat: 'possible stroke', urgency: 'CRITICAL' },
    { re: /(faint|behosh|बेहोश|unconscious)/, services: ['icu', 'neuro'], cat: 'loss of consciousness', urgency: 'CRITICAL' },
    { re: /(fell|fall|gir|accident|bike|blood|khoon|खून)/, services: ['trauma', 'orthopedic'], cat: 'injury', urgency: 'HIGH' },
    { re: /(burn|jal|जल)/, services: ['burns'], cat: 'burn injury', urgency: 'HIGH' },
    { re: /(fit|seizure|daura|दौरा)/, services: ['neuro'], cat: 'possible seizure', urgency: 'CRITICAL' },
  ];
  const hit = kw.find((k) => k.re.test(d));
  const typeDefs = EMERGENCY_TYPES.filter((t) => types.includes(t.id));
  const services = [...new Set([...(hit?.services || []), ...typeDefs.flatMap((t) => t.preferred)])];
  const critical = typeDefs.some((t) => t.critical);
  const p = input.patient || {};
  return {
    suspectedCategory: `${hit?.cat || typeDefs[0]?.label || 'medical emergency'} — unconfirmed`,
    urgency: critical ? 'CRITICAL' : hit?.urgency || 'HIGH',
    services,
    risks: [
      ...(p.allergies || []).map((a) => `Allergy: ${a}`),
      ...(p.medications || []).filter((m) => /(warfarin|apixaban|rivaroxaban|clopidogrel|aspirin|insulin)/i.test(m)).map((m) => `Takes ${m}`),
    ].slice(0, 4),
    questionsForCaller: ['Is the patient awake and breathing?', 'When did this start?', 'Any bleeding?'],
    rejected: [],
  };
}

async function understandEmergency(input) {
  if (geminiEnabled()) {
    try {
      const raw = await callGemini([{ text: UNDERSTAND_PROMPT(input) }]);
      return { ...validateUnderstanding(raw), _source: 'gemini' };
    } catch (err) {
      noteError('understand emergency', err);
      return { ...mockUnderstanding(input), _source: 'mock', _fallbackReason: err.message };
    }
  }
  return { ...mockUnderstanding(input), _source: 'mock' };
}

// ---------------------------------------------------------------------------
// 3) Profile → plain-language medical summary (shown under the profile's
//    "Medical summary" tab, next to Insurance — a fast, readable overview
//    for anyone (family, a new doctor, an insurer) who needs the picture
//    without reading every individual field).
// ---------------------------------------------------------------------------

const SUMMARY_PROMPT = (profile) => `You are the information organiser for GoldenBay, a family medical-preparedness app.
Turn this person's stored health profile into a short, plain-language medical summary — the kind a family member could read aloud to a new doctor, or attach when filing an insurance claim. You must NOT diagnose, predict, or recommend treatment — only organise what's already recorded.

Patient profile (JSON): ${JSON.stringify(profile)}

Return JSON exactly in this shape:
{
  "summary": string,          // 3-5 plain sentences: who they are, key conditions, what matters most for their care
  "keyPoints": string[],      // short, scannable highlights — allergies first, then critical medications/conditions
  "insuranceNote": string     // one sentence: insurer + preferred hospital, phrased for a claims or admissions desk
}`;

function mockProfileSummary(profile) {
  const name = profile?.fullName || 'This person';
  const first = name.split(' ')[0];
  const age = profile?.age != null ? `, age ${profile.age}` : '';
  const bg = profile?.bloodGroup ? ` Blood group ${profile.bloodGroup}.` : '';
  const allergies = profile?.allergies || [];
  const meds = profile?.medications || [];
  const conditions = profile?.conditions || [];
  const pastEvents = profile?.pastEvents || [];

  const summary =
    `${name}${age}.${bg} ` +
    (conditions.length ? `Ongoing conditions: ${conditions.join(', ')}. ` : 'No ongoing conditions recorded. ') +
    (meds.length ? `Currently takes ${meds.join('; ')}. ` : 'No regular medications on file. ') +
    (allergies.length ? `Known allergies: ${allergies.join(', ')} — flag before any new medication or contrast dye.` : 'No known allergies on file.');

  const keyPoints = [
    ...allergies.map((a) => `ALLERGY — ${a}`),
    ...meds.map((m) => `Medication — ${m}`),
    ...conditions.map((c) => `Condition — ${c}`),
    ...pastEvents.map((e) => `Past event — ${e}`),
  ];

  const insuranceNote = profile?.insurance
    ? `Insured with ${profile.insurance}${profile.preferredHospital ? `; prefers ${profile.preferredHospital} for admission` : ''} — verify policy details directly with the insurer before relying on this for a claim.`
    : `No insurer on file for ${first} — confirm coverage separately before admission.`;

  return { summary, keyPoints, insuranceNote, _source: 'mock' };
}

// Only medical fields ever go to Gemini — never name, phone, contacts or IDs.
function medicalOnly(p) {
  return {
    age: p?.age ?? null, sex: p?.sex ?? null, bloodGroup: p?.bloodGroup ?? null,
    allergies: p?.allergies || [], medications: p?.medications || [],
    conditions: p?.conditions || [], pastEvents: p?.pastEvents || [],
  };
}

async function summarizeProfile(profile) {
  if (geminiEnabled()) {
    try {
      const result = await callGemini([{ text: SUMMARY_PROMPT(medicalOnly(profile)) }]);
      return { ...result, _source: 'gemini' };
    } catch (err) {
      noteError('profile summary', err);
      return { ...mockProfileSummary(profile), _fallbackReason: err.message };
    }
  }
  return mockProfileSummary(profile);
}

// ---------------------------------------------------------------------------
// 4) A frame from the CPR Co-Pilot camera → what the ER can see from here
//
// This is DESCRIPTION, not diagnosis. We ask only for things a person could
// see by looking: is someone doing compressions, is there visible bleeding,
// is the patient on a hard surface, are there hazards around. The ER uses it
// to prepare; it never decides anything on its own.
// ---------------------------------------------------------------------------

const SCENE_PROMPT = `You are looking at one still frame from a bystander's phone at the scene of a medical emergency, sent to a hospital emergency department so they can prepare.

Describe ONLY what is visibly true in this image. Do not diagnose. Do not guess at anything you cannot see. If you cannot tell, say so.

Return JSON exactly in this shape:
{
  "cprInProgress": true|false|null,        // is someone visibly pressing on a chest?
  "patientPosition": string|null,          // e.g. "on their back on a hard floor", "slumped against a wall", "unclear"
  "visibleBleeding": "none visible"|"minor"|"significant"|"cannot tell",
  "surface": "hard"|"soft"|"cannot tell",  // CPR needs a hard surface — the ER wants to know
  "peopleHelping": number|null,            // how many people are visibly assisting
  "environment": string|null,              // e.g. "roadside, daylight, traffic nearby", "indoor room"
  "hazards": string[],                     // anything visibly dangerous: traffic, fire, water, crowd
  "notesForER": string,                    // one short sentence a doctor can read in 2 seconds
  "cannotSee": string[]                    // important things this frame does NOT show
}`;

function mockScene() {
  return {
    cprInProgress: true,
    patientPosition: 'on their back on a flat surface',
    visibleBleeding: 'none visible',
    surface: 'hard',
    peopleHelping: 1,
    environment: 'indoor, well lit (mock mode)',
    hazards: [],
    notesForER: 'MOCK MODE: one rescuer giving compressions, patient flat, no visible bleeding.',
    cannotSee: ['face', 'airway', 'lower body'],
    _source: 'mock',
  };
}

async function readScene(base64Jpeg, mimeType) {
  if (geminiEnabled()) {
    try {
      const result = await callGemini([
        { text: SCENE_PROMPT },
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Jpeg } },
      ]);
      return { ...result, _source: 'gemini' };
    } catch (err) {
      noteError('scene read', err);
      return { ...mockScene(), _fallbackReason: err.message };
    }
  }
  return mockScene();
}

// ---------------------------------------------------------------------------
// 5) A lab report photo → the raw values it claims to see.
//
// The prompt lives in labs.js, because everything this returns is going to be
// checked against reference tables before a human sees it. This function's only
// job is to hand over what the model claims. It is not trusted.
// ---------------------------------------------------------------------------
async function readLabReport(base64Data, mimeType, prompt) {
  if (geminiEnabled()) {
    try {
      const result = await callGemini([
        { text: prompt },
        { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Data } },
      ]);
      return { ...result, _source: 'gemini' };
    } catch (err) {
      noteError('lab report read', err);
      const { mockLabExtraction } = require('./labs');
      return { ...mockLabExtraction(), _fallbackReason: err.message };
    }
  }
  const { mockLabExtraction } = require('./labs');
  return mockLabExtraction();
}

// ---------------------------------------------------------------------------
// JOBS 2 + 4 — the agent's next actions, and the handover note for the ER
//
// One Gemini call, two outputs:
//   actions  — chosen ONLY from a fixed menu. Code checks every action and
//              throws away anything outside the rules (this is the agent's
//              "tool use": Gemini proposes, code decides and does).
//                add_service       one of our service words; can only ADD a
//                                  preference, never remove a hospital
//                ask_caller        one short question for the family
//                flag_for_hospital a warning that must come from the profile
//                                  or the caller's words (fact-checked)
//   handover — Situation, key points, Assessment. Every key point names its
//              source; code checks the point really matches that source.
//              No Recommendation section: GoldenBay never suggests treatment.
// ---------------------------------------------------------------------------

const SOURCES = ['allergies', 'medications', 'conditions', 'pastEvents', 'bloodGroup', 'callerWords', 'buttons'];

const PLAN_PROMPT = (input) => `You help GoldenBay, an emergency app in India, prepare a hospital emergency department BEFORE the patient arrives.
You must NOT diagnose, NOT recommend or mention any treatment, drug to give, or dose. You only organise facts that are given below.

Buttons tapped: ${JSON.stringify(input.typeLabels)}
Caller's words (identity removed): "${input.words}"
Patient (no identity): ${JSON.stringify(input.patient)}
Services already needed: ${JSON.stringify(input.alreadyNeeded)}

Return JSON exactly in this shape:
{
  "actions": [                       // at most 5
    {"type": "add_service", "service": one of [${SERVICES.join(', ')}], "why": string},
    {"type": "ask_caller", "question": string},              // short, simple, a scared relative can answer
    {"type": "flag_for_hospital", "note": string, "source": one of [${SOURCES.join(', ')}]}
  ],
  "handover": {
    "situation": string,             // one sentence: age, sex, what happened
    "keyPoints": [{"text": string, "source": one of [${SOURCES.join(', ')}]}],   // at most 5, most important first; copy facts exactly
    "assessment": string             // e.g. "possible cardiac event — unconfirmed"
  }
}`;

// words that would turn a note into treatment advice — never allowed through
const TREATMENT_WORDS = /\b(give|given|administer|inject|prescribe|recommend|should (take|get|receive)|start (on|with)|dose of|mg of|ml of)\b/i;

// Does `text` really come from `source`? STRICT: every meaningful word in the
// point must appear in what was recorded (or in the caller's words). Only a
// small list of linking words is allowed on top ("allergic", "known", "takes"...).
// So "Takes statins" passes; "Takes statins and warfarin" fails if warfarin
// was never recorded. Paraphrases also fail — that is on purpose: safer to drop
// a point than to show one we cannot check. The plain profile facts are always
// shown to the hospital next to Gemini's note anyway.
const LINKING = new Set(['allergic', 'allergy', 'allergies', 'known', 'history', 'takes', 'taking', 'on', 'medicine', 'medicines',
  'medication', 'medications', 'tablet', 'tablets', 'reported', 'reports', 'says', 'caller', 'family', 'patient', 'severe', 'mild',
  'condition', 'conditions', 'past', 'previous', 'blood', 'group', 'with', 'from', 'daily', 'since', 'also', 'recorded', 'noted',
  'sudden', 'started', 'currently', 'regular', 'regularly']);
const words = (t) => String(t || '').toLowerCase().match(/[a-z\u0900-\u097f]{3,}/g) || [];

function factCheck(text, source, facts) {
  if (typeof text !== 'string' || !text.trim()) return false;
  if (TREATMENT_WORDS.test(text)) return false;
  const low = text.toLowerCase();
  if (source === 'bloodGroup') return !!facts.bloodGroup && low.includes(String(facts.bloodGroup).toLowerCase());
  let pool;
  if (source === 'callerWords') pool = [facts.callerWords];
  else if (source === 'buttons') pool = facts.buttons;
  else if (['allergies', 'medications', 'conditions', 'pastEvents'].includes(source)) pool = facts[source];
  else return false;
  const known = new Set((pool || []).flatMap(words));
  const content = words(text).filter((w) => !LINKING.has(w) && !['and', 'the', 'for', 'has', 'have', 'had', 'was', 'his', 'her', 'who', 'are', 'not'].includes(w));
  return content.length > 0 && content.every((w) => known.has(w));
}

function validatePlan(raw, input) {
  const facts = { ...input.patient, callerWords: input.words, buttons: input.typeLabels };
  const rejected = [];
  const actions = [];
  const seenServices = new Set(input.alreadyNeeded || []);
  let questions = 0;
  for (const a of (Array.isArray(raw?.actions) ? raw.actions : []).slice(0, 8)) {
    if (a?.type === 'add_service') {
      const s = String(a.service || '').toLowerCase();
      if (!SERVICES.includes(s)) { rejected.push(`service "${String(a.service).slice(0, 30)}" is not on our list`); continue; }
      if (seenServices.has(s)) continue;
      seenServices.add(s);
      actions.push({ type: 'add_service', service: s, why: String(a.why || '').slice(0, 140) });
    } else if (a?.type === 'ask_caller') {
      const q = String(a.question || '').trim().slice(0, 120);
      if (!q || questions >= 2 || TREATMENT_WORDS.test(q)) { rejected.push('question not allowed'); continue; }
      questions++; actions.push({ type: 'ask_caller', question: q });
    } else if (a?.type === 'flag_for_hospital') {
      const note = String(a.note || '').trim().slice(0, 160);
      if (!SOURCES.includes(a.source) || !factCheck(note, a.source, facts)) { rejected.push(`flag "${note.slice(0, 60)}" could not be matched to the ${a.source || 'profile'}`); continue; }
      actions.push({ type: 'flag_for_hospital', note, source: a.source });
    } else rejected.push(`unknown action "${String(a?.type).slice(0, 30)}"`);
  }
  const h = raw?.handover || {};
  const keyPoints = [];
  for (const k of (Array.isArray(h.keyPoints) ? h.keyPoints : []).slice(0, 8)) {
    const text = String(k?.text || '').trim().slice(0, 160);
    if (SOURCES.includes(k?.source) && factCheck(text, k.source, facts)) keyPoints.push({ text, source: k.source });
    else rejected.push(`handover point "${text.slice(0, 60)}" could not be matched to the ${k?.source || 'profile'}`);
  }
  const situation = typeof h.situation === 'string' && !TREATMENT_WORDS.test(h.situation) ? h.situation.trim().slice(0, 200) : null;
  let assessment = typeof h.assessment === 'string' && !TREATMENT_WORDS.test(h.assessment) ? h.assessment.trim().slice(0, 90) : null;
  if (assessment && !/unconfirmed/i.test(assessment)) assessment += ' — unconfirmed';
  return {
    actions: actions.slice(0, 5),
    handover: situation || keyPoints.length ? { situation, keyPoints: keyPoints.slice(0, 5), assessment } : null,
    rejected,
  };
}

// Returns null when Gemini is off or fails: the engine then keeps the plain
// template handover and takes no extra actions. Nothing breaks.
async function planAndHandover(input) {
  if (!geminiEnabled()) return null;
  try {
    const raw = await callGemini([{ text: PLAN_PROMPT(input) }]);
    return { ...validatePlan(raw, input), _source: 'gemini' };
  } catch (err) {
    noteError('agent plan + handover', err);
    return null;
  }
}

module.exports = {
  understandEmergency, validateUnderstanding, mockUnderstanding, medicalOnly,
  planAndHandover, validatePlan, factCheck,
  draftProfileFromImage, summarizeProfile, readScene, readLabReport,
  callGemini, geminiEnabled, selfTest, getLastError,
};