// ai.js — every Gemini call in GoldenBay goes through this file.
//
// Gemini's jobs (see the roadmap, "Gemini and the agent"):
//   1. understandEmergency   — messy words + button taps -> structured picture
//   2. writeHandover         — the pre-arrival handover for the ER (Phase F)
//   3. draftProfileFromImage — prescription photo -> draft profile fields
//   4. agent reasoning       — tool calls inside the agent loop (Phase F)
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

const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

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

module.exports = {
  understandEmergency, validateUnderstanding, mockUnderstanding, medicalOnly,
  draftProfileFromImage, summarizeProfile, readScene, readLabReport,
  callGemini, geminiEnabled, selfTest, getLastError,
};