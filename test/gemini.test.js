// gemini.test.js — proves the Phase E + F rules hold, using a FAKE Gemini and a
// FAKE Presidio (so it runs without a key, without internet, and gives the
// same answer every time). The fake Gemini deliberately answers with some
// good items and some bad ones; the test checks the code keeps the good ones
// and throws the bad ones away.
//
// Run: npm test   (or: node test/gemini.test.js)

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert/strict');

const PORT = 5000 + Math.floor(Math.random() * 1000);
const FAKE = PORT + 1000;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-gem-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); passed++; results.push(`  ✔ ${name}`); }
  catch (err) { results.push(`  ✘ ${name}\n      ${err.message}`); process.exitCode = 1; }
}
async function api(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------- fakes
const geminiBodies = [];
let geminiCalls = 0;
const reply = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });

const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    // ---- fake Presidio
    if (req.url === '/analyze') {
      const { text } = JSON.parse(body);
      const out = [];
      const i = text.indexOf('Ramesh Kumar');
      if (i >= 0) out.push({ entity_type: 'PERSON', start: i, end: i + 'Ramesh Kumar'.length, score: 0.85 });
      const j = text.indexOf('10 minutes');
      if (j >= 0) out.push({ entity_type: 'DATE_TIME', start: j, end: j + 10, score: 0.85 }); // must be KEPT
      return res.end(JSON.stringify(out));
    }
    // ---- fake Gemini
    geminiCalls++;
    geminiBodies.push(body);
    if (geminiCalls === 1) { res.statusCode = 503; return res.end('{"error":{"code":503,"message":"high demand"}}'); }
    if (body.includes('prepare a hospital emergency department')) {
      return res.end(JSON.stringify(reply({
        actions: [
          { type: 'add_service', service: 'cardiac', why: 'chest pain' },           // OK
          { type: 'add_service', service: 'helicopter', why: 'fast' },             // NOT on our list
          { type: 'ask_caller', question: 'Is he still sweating?' },               // OK
          { type: 'flag_for_hospital', note: 'Allergic to sulfa drugs', source: 'allergies' },   // OK
          { type: 'flag_for_hospital', note: 'Give aspirin 300 mg now', source: 'callerWords' }, // treatment advice
          { type: 'flag_for_hospital', note: 'On warfarin', source: 'medications' },             // never recorded
        ],
        handover: {
          situation: '55-year-old man with chest pain and sweating',
          keyPoints: [
            { text: 'Allergic to sulfa drugs and shellfish', source: 'allergies' },  // OK
            { text: 'Takes statins daily', source: 'medications' },                  // OK
            { text: 'Takes statins and warfarin', source: 'medications' },           // warfarin invented
          ],
          assessment: 'possible cardiac event',
        },
      })));
    }
    // understand-the-emergency prompt
    return res.end(JSON.stringify(reply({
      suspectedCategory: 'possible cardiac event', urgency: 'CRITICAL',
      services: ['icu', 'teleport'], risks: ['Allergy: Sulfa drugs'], questionsForCaller: ['When did this start?'],
    })));
  });
});

(async () => {
  await new Promise((r) => fake.listen(FAKE, r));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR, MOCK_AI: 'false', GEMINI_API_KEY: 'test-key-not-real',
      GEMINI_BASE_URL: `http://localhost:${FAKE}`, PRESIDIO_URL: `http://localhost:${FAKE}`,
      OFFER_ROUND_SECONDS: '30', DEMO_AUTO_ACCEPT_SECONDS: '0', HOSPITAL_DEMO_PIN: '2468',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/v1/health'); break; } catch { await sleep(100); } }

  const fam = (await api('POST', '/v1/families/join', { joinCode: 'SHARMA-DEMO', memberLabel: 'test' })).body.token;
  const hosp = (await api('POST', '/v1/hospital/login', { hospitalId: 'hosp-1', pin: '2468' })).body.token;
  const F = { 'x-family-token': fam }, H = { 'x-hospital-token': hosp };

  const r = await api('POST', '/v1/emergencies', {
    profileId: 'demo-rajesh', patientConfirmed: true, types: ['cant_breathe'], useDemoLocation: true,
    description: 'Ramesh Kumar here, papa has chest pain since 10 minutes, sweating. Call 9876543210',
  }, F);
  const id = r.body.emergency.id;
  await sleep(2500); // understand (with one retry) + plan
  const offer = (await api('GET', '/v1/hospital/offers', null, H)).body.pending.find((o) => o.ref === r.body.emergency.ref);
  await api('POST', `/v1/hospital/offers/${offer.offerId}/accept`, {}, H);
  const patient = (await api('GET', `/v1/hospital/emergencies/${id}`, null, H)).body.patient;
  const fv = (await api('GET', `/v1/emergencies/${id}`, null, F)).body.emergency;

  results.push('\nPhase E — masking');
  await check('Presidio (fake) hides the person\'s name; built-in rules still hide the phone number', async () => {
    assert.ok(patient.callerWords.includes('[PERSON]'), patient.callerWords);
    assert.ok(!patient.callerWords.includes('Ramesh'), 'name leaked');
    assert.ok(patient.callerWords.includes('[PHONE]') && !patient.callerWords.includes('9876543210'), 'phone leaked');
  });
  await check('times are kept for the doctor ("10 minutes" is not masked)', async () => {
    assert.ok(patient.callerWords.includes('10 minutes'), patient.callerWords);
  });
  await check('the log says which engine really ran: presidio+builtin', async () => {
    const m = fv.log.find((l) => l.tool === 'mask');
    assert.equal(m.args.engine, 'presidio+builtin');
  });
  await check('nothing that identifies the family is ever sent to Gemini', async () => {
    const all = geminiBodies.join('\n');
    for (const bad of ['Ramesh', '9876543210', 'Rajesh', 'Sharma', 'Star Health', '91700']) assert.ok(!all.includes(bad), `sent to Gemini: ${bad}`);
  });

  results.push('Phase F — Gemini proposes, code decides');
  await check('Google "busy" (503) → one retry, then it works', async () => {
    assert.ok(geminiCalls >= 3, `calls: ${geminiCalls}`);
    assert.equal(fv.picture.source, 'gemini');
  });
  await check('a service not on our list ("teleport", "helicopter") is thrown away; a real one is kept', async () => {
    assert.ok(fv.needs.preferred.includes('Heart care'), JSON.stringify(fv.needs));
    const plan = fv.log.find((l) => l.tool === 'agent_plan');
    assert.ok(plan.args.rejected.some((x) => x.includes('helicopter')));
  });
  await check('Gemini\'s question for the family reaches the family', async () => {
    assert.ok(fv.picture.questionsForCaller.includes('Is he still sweating?'), JSON.stringify(fv.picture));
  });
  await check('a warning that matches the profile is kept; treatment advice and an invented drug are removed', async () => {
    const notes = patient.flags.map((f) => f.note).join(' | ');
    assert.ok(notes.includes('sulfa'), notes);
    assert.ok(!/aspirin|warfarin/i.test(notes), notes);
  });
  await check('handover note: checked points kept, the invented "warfarin" point removed, and it says so', async () => {
    const pts = patient.aiNote.keyPoints.map((k) => k.text);
    assert.ok(pts.includes('Takes statins daily'));
    assert.ok(!pts.some((t) => /warfarin/i.test(t)), pts.join(' | '));
    assert.ok(patient.aiNote.removed >= 1);
    assert.match(patient.aiNote.assessment, /unconfirmed/);
  });
  await check('the plain facts built by code are still shown beside Gemini\'s note', async () => {
    assert.equal(patient.handover.source, 'template');
    assert.ok(patient.handover.background.some((b) => b.includes('Sulfa')));
  });
  await check('the family sees it in everyday words', async () => {
    const plan = fv.log.find((l) => l.tool === 'agent_plan');
    assert.match(plan.say, /checked against Rajesh's profile/);
  });

  srv.kill(); fake.close();
  console.log(results.join('\n'));
  console.log(`\n${passed} of ${results.filter((x) => /✔|✘/.test(x)).length} checks passed`);
  if (process.exitCode) console.log('\n--- server log ---\n' + srvLog.slice(-3000));
})();
