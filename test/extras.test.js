// extras.test.js — Phases G + H: lock-screen QR, CPR coach feed, lab reader.
// Run: npm test   (starts its own server; mock AI; no internet needed)

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert/strict');

const PORT = 6000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-extra-'));
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
    env: { ...process.env, PORT: String(PORT), DATA_DIR, MOCK_AI: 'true', GEMINI_API_KEY: '', DEMO_AUTO_ACCEPT_SECONDS: '0', OFFER_ROUND_SECONDS: '30', HOSPITAL_DEMO_PIN: '2468' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = ''; srv.stdout.on('data', (d) => (srvLog += d)); srv.stderr.on('data', (d) => (srvLog += d));
  for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/v1/health'); break; } catch { await sleep(100); } }

  const F = { 'x-family-token': (await api('POST', '/v1/families/join', { joinCode: 'SHARMA-DEMO', memberLabel: 't' })).body.token };
  const other = { 'x-family-token': (await api('POST', '/v1/families', { name: 'Other', memberLabel: 'o' })).body.token };
  const H = async (id) => ({ 'x-hospital-token': (await api('POST', '/v1/hospital/login', { hospitalId: id, pin: '2468' })).body.token });
  const H1 = await H('hosp-1'), H2 = await H('hosp-2');

  results.push('Phase G — lock-screen QR');
  let qrPath;
  await check('a QR can be made for a confirmed profile; the public page shows only first name, blood group, allergies', async () => {
    const r = await api('POST', '/v1/profiles/demo-rajesh/qr', { printOnWallpaper: false }, F);
    assert.equal(r.status, 200); qrPath = r.body.qr.path;
    const pub = await api('GET', '/v1' + qrPath);
    assert.equal(pub.status, 200);
    assert.equal(pub.body.firstName, 'Rajesh'); assert.equal(pub.body.bloodGroup, 'B+');
    const txt = JSON.stringify(pub.body);
    for (const bad of ['Sharma', 'Statins', 'Hypertension', 'Star Health', '91700', 'fam-sharma']) assert.ok(!txt.includes(bad), `QR page leaks ${bad}`);
  });
  await check('the family number appears only after a tap, and both are listed in "Who viewed my data"', async () => {
    const c = await api('POST', `/v1${qrPath}/contact`);
    assert.equal(c.body.phone, '+91 91700 40198');
    const log = (await api('GET', '/v1/profiles/demo-rajesh/access-log', null, F)).body.entries.map((x) => x.what).join(' | ');
    assert.match(log, /lock-screen QR page/); assert.match(log, /phone number shown/);
  });
  await check('turning the QR off makes the old link stop working', async () => {
    await api('DELETE', '/v1/profiles/demo-rajesh/qr', null, F);
    assert.equal((await api('GET', '/v1' + qrPath)).status, 404);
  });
  await check('no QR for a profile the person has not confirmed; no QR for another family\'s profile', async () => {
    assert.equal((await api('POST', '/v1/profiles/demo-mridula/qr', {}, F)).status, 400);
    assert.equal((await api('POST', '/v1/profiles/demo-rajesh/qr', {}, other)).status, 404);
  });
  await check('the /q/ page itself loads', async () => {
    const r = await api('POST', '/v1/profiles/demo-aisha/qr', {}, F);
    const res = await fetch(BASE + r.body.qr.path);
    assert.equal(res.status, 200); assert.match(await res.text(), /Emergency info/);
  });

  results.push('Phase H — CPR coach + lab reader');
  await check('before any hospital accepts, CPR pictures are not sent anywhere', async () => {
    const e = (await api('POST', '/v1/emergencies', { profileId: 'demo-rajesh', patientConfirmed: true, types: ['cant_breathe'], useDemoLocation: true }, F)).body.emergency;
    const r = await api('POST', `/v1/emergencies/${e.id}/cpr-frame`, { jpeg: 'data:image/jpeg;base64,AAAA', stats: { rate: 110 } }, F);
    assert.equal(r.body.sent, false);
    await api('POST', `/v1/emergencies/${e.id}/cancel`, {}, F);
  });
  await check('after Sunrise accepts, CPR pictures go to Sunrise ONLY — Yamuna (also asked) gets nothing', async () => {
    const s1 = stream((await api('POST', '/v1/stream-ticket', {}, H1)).body.ticket);
    const s2 = stream((await api('POST', '/v1/stream-ticket', {}, H2)).body.ticket);
    await sleep(200);
    const e = (await api('POST', '/v1/emergencies', { profileId: 'demo-rajesh', patientConfirmed: true, types: ['cant_breathe'], useDemoLocation: true }, F)).body.emergency;
    await sleep(300);
    const offer = (await api('GET', '/v1/hospital/offers', null, H1)).body.pending.find((o) => o.ref === e.ref);
    await api('POST', `/v1/hospital/offers/${offer.offerId}/accept`, {}, H1);
    const r = await api('POST', `/v1/emergencies/${e.id}/cpr-frame`, { jpeg: 'data:image/jpeg;base64,AAAA', stats: { rate: 108, count: 30, handsOk: true, seconds: 17 } }, F);
    assert.equal(r.body.sent, true);
    await sleep(300);
    const got1 = s1.events.filter((x) => x.event === 'cpr:frame');
    const got2 = s2.events.filter((x) => x.event === 'cpr:frame');
    s1.close(); s2.close();
    assert.equal(got1.length, 1); assert.equal(got1[0].data.stats.rate, 108);
    assert.equal(got2.length, 0, 'Yamuna must not see CPR pictures');
    assert.equal((await api('POST', `/v1/emergencies/${e.id}/cpr-frame`, { stats: {} }, other)).status, 404, 'another family cannot send frames');
  });
  await check('lab reader: demo history + a new report are saved for this family only', async () => {
    await api('POST', '/v1/labs/demo-history', { profileId: 'demo-rajesh' }, F);
    const a = await api('POST', '/v1/labs/analyze', { profileId: 'demo-rajesh', imageBase64: 'AAAA', mimeType: 'image/jpeg' }, F);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.ok(Array.isArray(a.body.analysis.values));
    const list = (await api('GET', '/v1/labs/demo-rajesh', null, F)).body.reports;
    assert.ok(list.length >= 2);
    assert.equal((await api('GET', '/v1/labs/demo-rajesh', null, other)).status, 404);
    assert.equal((await api('GET', '/v1/labs/demo-rajesh')).status, 401);
  });
  await check('the CPR and lab pages load', async () => {
    for (const p of ['/cpr', '/labs', '/common/copilot.js', '/common/labs.js', '/shared/qr.js']) assert.equal((await fetch(BASE + p)).status, 200, p);
  });

  srv.kill();
  console.log(results.join('\n'));
  console.log(`\n${passed} of ${results.filter((x) => /✔|✘/.test(x)).length} checks passed`);
  if (process.exitCode) console.log('\n--- server log ---\n' + srvLog.slice(-3000));
})();
