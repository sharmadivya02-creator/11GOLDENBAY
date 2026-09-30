// flow.test.js — proves phases A and B work, end to end, against a real server.
// Run: npm test   (starts its own server on a spare port with short timers)

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert/strict');

const PORT = 3000 + Math.floor(Math.random() * 1000) + 4000;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-test-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); passed++; results.push(`  ✔ ${name}`); }
  catch (err) { results.push(`  ✘ ${name}\n      ${err.message}`); process.exitCode = 1; }
}

async function api(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

// open an SSE stream and collect events
function stream(ticket) {
  const events = [];
  const req = http.get(`${BASE}/v1/stream?ticket=${ticket}`, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = chunk.match(/^event: (.*)$/m); const data = chunk.match(/^data: (.*)$/m);
        if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
      }
    });
  });
  return { events, close: () => req.destroy() };
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, MOCK_AI: 'true', OFFER_ROUND_SECONDS: '2', COST_HEAD_START_SECONDS: '1', HOSPITAL_DEMO_PIN: '2468', GEMINI_API_KEY: '', DEMO_AUTO_ACCEPT_SECONDS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/v1/health'); break; } catch { await sleep(100); } }

  const hospToken = {};
  const H = (id) => ({ 'x-hospital-token': hospToken[id] });
  let F, OTHER; // family tokens
  const fam = () => ({ 'x-family-token': F });
  const AADHAAR = '2345 6789 0124'; // passes the Aadhaar checksum; not a real person's number

  console.log('\nPhase A — data is locked down');

  await check('profiles, emergencies, export and erase refuse anyone without a family sign-in', async () => {
    for (const [m, u] of [['GET', '/v1/profiles'], ['GET', '/v1/emergencies'], ['GET', '/v1/privacy/export/demo-rajesh'], ['DELETE', '/v1/privacy/erase/demo-rajesh']]) {
      const r = await api(m, u);
      assert.equal(r.status, 401, `${m} ${u} gave ${r.status}`);
    }
  });

  await check('joining the demo family with its code gives that family\'s 4 profiles', async () => {
    const r = await api('POST', '/v1/families/join', { joinCode: 'sharma-demo', memberLabel: 'Test phone' });
    assert.equal(r.status, 200); F = r.body.token;
    const p = await api('GET', '/v1/profiles', null, fam());
    assert.equal(p.body.profiles.length, 4);
    assert.ok(p.body.profiles.find((x) => x.id === 'demo-mridula').stale, 'Mridula\'s profile should be flagged out of date');
  });

  await check('another family cannot read, export or erase the Sharmas\' data', async () => {
    const r = await api('POST', '/v1/families', { name: 'Other family' });
    OTHER = r.body.token;
    assert.equal((await api('GET', '/v1/profiles', null, { 'x-family-token': OTHER })).body.profiles.length, 0);
    assert.equal((await api('GET', '/v1/privacy/export/demo-rajesh', null, { 'x-family-token': OTHER })).status, 404);
    assert.equal((await api('DELETE', '/v1/privacy/erase/demo-rajesh', null, { 'x-family-token': OTHER })).status, 404);
    assert.equal((await api('GET', '/v1/profiles', null, fam())).body.profiles.length, 4, 'profile must still exist');
  });

  await check('a wrong join code is refused', async () => {
    assert.equal((await api('POST', '/v1/families/join', { joinCode: 'NOPE-0000' })).status, 404);
  });

  await check('a profile a relative added cannot be used for an SOS until that adult confirms it', async () => {
    const r = await api('POST', '/v1/emergencies', { profileId: 'demo-mridula', patientConfirmed: true, types: ['chest_pain'] }, fam());
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'PROFILE_NOT_CONFIRMED');
    assert.ok(/Call 112/.test(r.body.error.message));
  });

  await check('consent (#6): a child\'s profile needs a parent; an adult can confirm their own profile', async () => {
    const bad = await api('POST', '/v1/profiles', { fullName: 'Test Child', age: 6, consentType: 'on-behalf' }, fam());
    assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'PARENT_REQUIRED');
    const good = await api('POST', '/v1/profiles', { fullName: 'Test Child', age: 6, consentType: 'parental' }, fam());
    assert.equal(good.status, 201); assert.equal(good.body.profile.consent.type, 'parental');
    const conf = await api('POST', '/v1/profiles/demo-mridula/confirm', {}, fam());
    assert.equal(conf.body.profile.consent.type, 'self');
  });

  await check('hospital login: wrong PIN refused, right PIN works (demo login)', async () => {
    assert.equal((await api('POST', '/v1/hospital/login', { hospitalId: 'hosp-1', pin: '0000' })).status, 401);
    for (const id of ['hosp-1', 'hosp-2', 'hosp-3', 'hosp-4', 'hosp-5', 'hosp-6', 'hosp-7']) {
      const r = await api('POST', '/v1/hospital/login', { hospitalId: id, pin: '2468' });
      assert.equal(r.status, 200); hospToken[id] = r.body.token;
    }
    assert.equal((await api('POST', '/v1/hospital/login', { hospitalId: 'hosp-8', pin: '2468' })).status, 404, 'a listed-only hospital cannot log in');
  });

  console.log('\nPhase B — the offer flow');

  let e1;
  await check('fix #3: an SOS without confirming the patient is refused', async () => {
    const r = await api('POST', '/v1/emergencies', { profileId: 'demo-rajesh', types: ['chest_pain'] }, fam());
    assert.equal(r.status, 400); assert.equal(r.body.error.code, 'CONFIRM_PATIENT');
  });

  const t3 = await api('POST', '/v1/stream-ticket', {}, H('hosp-2'));
  const s3 = stream(t3.body.ticket);
  await sleep(200);

  await check("can't breathe (life-threatening): every emergency department within 5 km is asked at once, nobody farther", async () => {
    const r = await api('POST', '/v1/emergencies', {
      profileId: 'demo-rajesh', patientConfirmed: true, types: ['cant_breathe'],
      description: `Papa ko saans nahi aa rahi, sweating. Aadhaar ${AADHAAR}, call +91 98765 43210`, useDemoLocation: true,
    }, fam());
    assert.equal(r.status, 201); e1 = r.body.emergency;
    await sleep(300);
    const asked = (id) => api('GET', '/v1/hospital/offers', null, H(id)).then((x) => x.body.pending.length);
    for (const h of ['hosp-1', 'hosp-2', 'hosp-4', 'hosp-6']) assert.equal(await asked(h), 1, `${h} (within 5 km) should be asked`);
    for (const h of ['hosp-3', 'hosp-5', 'hosp-7']) assert.equal(await asked(h), 0, `${h} (farther than 5 km) should not be asked yet`);
  });

  await check('the hospital screen received the request live (stream)', async () => {
    assert.ok(s3.events.some((x) => x.event === 'offer:new'), 'no offer:new event on the stream');
  });

  await check('the request card has no name, no location, no insurance, no identity numbers', async () => {
    const card = (await api('GET', '/v1/hospital/offers', null, H('hosp-2'))).body.pending[0];
    const txt = JSON.stringify(card);
    for (const bad of ['Rajesh', 'Sharma', 'Star Health', '2345', '98765', 'lat', 'lng']) assert.ok(!txt.includes(bad), `card leaks "${bad}"`);
    assert.equal(card.ageRange, '50–59');
  });

  await check('no hospital can open treatment details before accepting', async () => {
    assert.equal((await api('GET', `/v1/hospital/emergencies/${e1.id}`, null, H('hosp-1'))).status, 404);
  });

  let offer1, offer3;
  await check('first Accept wins; the second hospital gets "already taken"', async () => {
    offer1 = (await api('GET', '/v1/hospital/offers', null, H('hosp-1'))).body.pending[0].offerId;
    offer3 = (await api('GET', '/v1/hospital/offers', null, H('hosp-2'))).body.pending[0].offerId;
    const [a, b] = await Promise.all([
      api('POST', `/v1/hospital/offers/${offer1}/accept`, {}, H('hosp-1')),
      api('POST', `/v1/hospital/offers/${offer3}/accept`, {}, H('hosp-2')),
    ]);
    const ok = [a, b].filter((x) => x.status === 200).length;
    const taken = [a, b].filter((x) => x.status === 409).length;
    assert.equal(ok, 1); assert.equal(taken, 1);
  });

  let winner, loser;
  await check('the other hospital is told "no action needed", live', async () => {
    const fv = (await api('GET', `/v1/emergencies/${e1.id}`, null, fam())).body.emergency;
    assert.equal(fv.status, 'ACCEPTED');
    winner = fv.hospital.id; loser = winner === 'hosp-1' ? 'hosp-2' : 'hosp-1';
    assert.ok(typeof fv.timeToAcceptSec === 'number');
    assert.ok(fv.hospital.navigateUrl.startsWith('https://www.google.com/maps/dir/?api=1&destination='));
    if (loser === 'hosp-2') { await sleep(100); assert.ok(s3.events.some((x) => x.event === 'offer:closed'), 'no offer:closed event'); }
  });

  await check('only the accepting hospital can open details; they show the patient, masked caller words and "last updated"', async () => {
    assert.equal((await api('GET', `/v1/hospital/emergencies/${e1.id}`, null, H(loser))).status, 404);
    const d = (await api('GET', `/v1/hospital/emergencies/${e1.id}`, null, H(winner))).body.patient;
    assert.equal(d.firstName, 'Rajesh'); assert.deepEqual(d.allergies, ['Sulfa drugs', 'Shellfish']);
    assert.ok(!d.callerWords.includes('2345') && d.callerWords.includes('[AADHAAR]'), 'Aadhaar not masked: ' + d.callerWords);
    assert.ok(!d.callerWords.includes('98765') && d.callerWords.includes('[PHONE]'), 'phone not masked');
    assert.ok(d.profile.lastUpdated && d.profile.reportedBy.includes('not verified'));
    assert.ok(!('insurance' in d), 'insurance must not be in treatment details');
  });

  await check('"Who viewed my data": the family sees which hospital opened the details', async () => {
    const log = (await api('GET', '/v1/profiles/demo-rajesh/access-log', null, fam())).body.entries;
    assert.ok(log.length >= 1 && log[0].hospitalId === winner);
  });

  await check('the accepting hospital hands the patient back → the others are asked again at once, without it', async () => {
    const r = await api('POST', `/v1/hospital/emergencies/${e1.id}/cancel`, { reason: 'cath lab team called away' }, H(winner));
    assert.equal(r.status, 200);
    await sleep(200);
    assert.equal((await api('GET', '/v1/hospital/offers', null, H(loser))).body.pending.length, 1, 'other hospital should be re-asked');
    assert.equal((await api('GET', '/v1/hospital/offers', null, H(winner))).body.pending.length, 0, 'the hospital that cancelled must not be re-asked');
  });

  await check('family says "we\'re going to a different hospital" (not on GoldenBay) → released, Show-to-doctor path', async () => {
    const pend = (await api('GET', '/v1/hospital/offers', null, H(loser))).body.pending[0];
    await api('POST', `/v1/hospital/offers/${pend.offerId}/accept`, {}, H(loser));
    const r = await api('POST', `/v1/emergencies/${e1.id}/divert`, { hospitalId: 'hosp-8' }, fam());
    assert.equal(r.body.emergency.status, 'DIVERTED'); assert.equal(r.body.emergency.divertedTo.joined, false);
    assert.equal(r.body.emergency.hospital, null);
    assert.equal((await api('GET', `/v1/hospital/emergencies/${e1.id}`, null, H(loser))).status, 404, 'released hospital keeps no access');
  });

  await check('divert to a hospital ON GoldenBay → it gets the alert and the details; arrival closes the case', async () => {
    const r = await api('POST', '/v1/emergencies', { profileId: 'demo-aisha', patientConfirmed: true, types: ['cant_breathe'], useDemoLocation: true }, fam());
    const id = r.body.emergency.id;
    const d = await api('POST', `/v1/emergencies/${id}/divert`, { hospitalId: 'hosp-7' }, fam());
    assert.equal(d.body.emergency.hospital.id, 'hosp-7');
    assert.equal((await api('GET', `/v1/hospital/emergencies/${id}`, null, H('hosp-7'))).status, 200);
    assert.equal((await api('POST', `/v1/hospital/emergencies/${id}/arrived`, {}, H('hosp-7'))).status, 200);
    assert.equal((await api('GET', `/v1/emergencies/${id}`, null, fam())).body.emergency.status, 'ARRIVED');
  });

  await check('chest pain: 5 km first (Sunrise), then 10 km (Lotus), then 15 km (Riverbend) as rounds pass unanswered', async () => {
    const r = await api('POST', '/v1/emergencies', { profileId: 'demo-rajesh', patientConfirmed: true, types: ['chest_pain'], useDemoLocation: true }, fam());
    const ref = r.body.emergency.ref;
    const has = async (h) => !!(await api('GET', '/v1/hospital/offers', null, H(h))).body.pending.find((x) => x.ref === ref);
    await sleep(300);
    assert.equal(await has('hosp-1'), true, 'Sunrise in round 1'); assert.equal(await has('hosp-3'), false, 'Lotus not yet');
    assert.equal(await has('hosp-6'), false, "children's hospital never (no heart care)");
    await sleep(2200);
    assert.equal(await has('hosp-3'), true, 'Lotus in round 2'); assert.equal(await has('hosp-7'), false, 'Riverbend not yet');
    await sleep(2200);
    assert.equal(await has('hosp-7'), true, 'Riverbend in round 3');
    await api('POST', `/v1/emergencies/${r.body.emergency.id}/cancel`, {}, fam());
  });

  await check('nobody answers → widen 5 → 10 → 15 km → then the family is told exactly what to do; a late Accept still works', async () => {
    const r = await api('POST', '/v1/emergencies', { profileId: 'demo-aisha', patientConfirmed: true, types: ['stroke_signs'], useDemoLocation: true }, fam());
    const id = r.body.emergency.id;
    await sleep(6800); // three 2-second rounds
    const fv = (await api('GET', `/v1/emergencies/${id}`, null, fam())).body.emergency;
    assert.equal(fv.status, 'NO_ACCEPT_YET'); assert.ok(/Call 112/.test(fv.fallback.message), fv.fallback?.message);
    assert.ok(fv.log.some((l) => l.tool === 'widen_search') && fv.log.some((l) => l.tool === 'tell_family'));
    const pend = (await api('GET', '/v1/hospital/offers', null, H('hosp-5'))).body.pending.find((x) => x.ref === fv.ref);
    assert.ok(pend, 'Silverline should still hold the open request');
    assert.equal((await api('POST', `/v1/hospital/offers/${pend.offerId}/accept`, {}, H('hosp-5'))).status, 200);
    assert.equal((await api('GET', `/v1/emergencies/${id}`, null, fam())).body.emergency.status, 'ACCEPTED');
  });

  await check('every asked hospital declines → the agent moves on immediately and tells the family', async () => {
    const r = await api('POST', '/v1/emergencies', { profileId: 'demo-rohan', patientConfirmed: true, types: ['child_emergency'], useDemoLocation: true }, fam());
    const id = r.body.emergency.id; await sleep(1400); // private first, government after the 1 s head start
    for (const h of ['hosp-4', 'hosp-6']) {
      const p = (await api('GET', '/v1/hospital/offers', null, H(h))).body.pending.find((x) => x.ref === r.body.emergency.ref);
      assert.ok(p, `${h} should have been asked`);
      await api('POST', `/v1/hospital/offers/${p.offerId}/decline`, { reason: 'no_specialist' }, H(h));
    }
    await sleep(200);
    const fv = (await api('GET', `/v1/emergencies/${id}`, null, fam())).body.emergency;
    assert.equal(fv.status, 'NO_ACCEPT_YET');
    assert.equal(fv.log.filter((l) => l.tool === 'offer_declined').length, 2);
  });

  await check('cost preference never delays anyone: every button is life-threatening, so all capable hospitals are asked at once', async () => {
    const r = await api('POST', '/v1/emergencies', { profileId: 'demo-rajesh', patientConfirmed: true, types: ['accident_fall'], useDemoLocation: true }, fam());
    const ref = r.body.emergency.ref; await sleep(250);
    const has = async (h) => !!(await api('GET', '/v1/hospital/offers', null, H(h))).body.pending.find((x) => x.ref === ref);
    assert.equal(await has('hosp-1'), true, 'private Sunrise asked');
    assert.equal(await has('hosp-2'), true, 'government Yamuna asked at the same moment (no head start)');
    assert.equal(r.body.emergency.urgency, 'CRITICAL');
    await api('POST', `/v1/emergencies/${r.body.emergency.id}/cancel`, {}, fam());
  });

  await check('a hospital marked "temporarily unavailable" is not asked; the search widens at once', async () => {
    await api('PUT', '/v1/hospital/me', { unavailable: true, unavailableReason: 'cath lab down' }, H('hosp-1'));
    const r = await api('POST', '/v1/emergencies', { profileId: 'demo-rajesh', patientConfirmed: true, types: ['chest_pain'], useDemoLocation: true }, fam());
    await sleep(300);
    const has = async (h) => !!(await api('GET', '/v1/hospital/offers', null, H(h))).body.pending.find((x) => x.ref === r.body.emergency.ref);
    assert.equal(await has('hosp-1'), false, 'unavailable Sunrise must not be asked');
    assert.equal(await has('hosp-3'), true, 'Lotus (10 km ring) asked straight away');
    await api('PUT', '/v1/hospital/me', { unavailable: false }, H('hosp-1'));
    await api('POST', `/v1/emergencies/${r.body.emergency.id}/cancel`, {}, fam());
  });

  await check('the private share link shows where and how — no medical details', async () => {
    const fv = (await api('GET', '/v1/emergencies', null, fam())).body.emergencies[0];
    const token = fv.sharePath.split('/').pop();
    const s = await api('GET', `/v1/share/${token}`);
    assert.equal(s.status, 200);
    const txt = JSON.stringify(s.body);
    for (const bad of ['allergies', 'Sulfa', 'bloodGroup', 'medications', 'Star Health']) assert.ok(!txt.includes(bad), `share link leaks ${bad}`);
    assert.equal((await api('GET', '/v1/share/not-a-real-token')).status, 404);
  });

  await check('live location from the phone riding with the patient reaches the receiving hospital', async () => {
    const r = await api('POST', '/v1/emergencies', { profileId: 'demo-aisha', patientConfirmed: true, types: ['burns'], useDemoLocation: true }, fam());
    const id = r.body.emergency.id; await sleep(250);
    const p = (await api('GET', '/v1/hospital/offers', null, H('hosp-2'))).body.pending.find((x) => x.ref === r.body.emergency.ref);
    await api('POST', `/v1/hospital/offers/${p.offerId}/accept`, {}, H('hosp-2'));
    await api('POST', `/v1/emergencies/${id}/location`, { lat: 28.60, lng: 77.24 }, fam());
    const d = (await api('GET', `/v1/hospital/emergencies/${id}`, null, H('hosp-2'))).body.patient;
    assert.ok(d.liveLocation && d.liveLocation.distanceKm < 2, JSON.stringify(d.liveLocation));
  });

  await check('the agent log explains every step in plain words', async () => {
    const fv = (await api('GET', `/v1/emergencies/${e1.id}`, null, fam())).body.emergency;
    const tools = fv.log.map((l) => l.tool);
    for (const t of ['goal', 'mask', 'send_offers', 'understand', 'accepted', 'hospital_cancelled', 'divert']) assert.ok(tools.includes(t), `missing ${t}`);
    assert.ok(fv.log.every((l) => typeof l.reason === 'string' && l.reason.length > 10));
    assert.ok(!JSON.stringify(fv.log).match(/bed|cath.?lab status|ambulance position/i), 'log mentions removed features');
  });

  s3.close();
  srv.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(results.join('\n'));
  console.log(`\n${passed} of ${results.length} checks passed`);
  if (process.exitCode) console.log('\n--- server log ---\n' + srvLog.slice(-3000));
})();
