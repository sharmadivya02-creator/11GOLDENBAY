// routes.js — every API endpoint, grouped by who may call it.
//
//   PUBLIC     health, hospital list (no patient data), notice, sign-in
//   FAMILY     needs x-family-token — only that family's own records
//   HOSPITAL   needs x-hospital-token — request cards; details only for the
//              hospital receiving the patient, and every read is logged

const store = require('./store');
const auth = require('./auth');
const hub = require('./hub');
const ai = require('./ai');
const engine = require('./engine');
const views = require('./views');
const privacy = require('./privacy');
const labs = require('./labs');
const { DEMO_CENTER, HOSPITALS } = require('./seed');
const { HttpError } = require('./http');
const { SERVICES, EMERGENCY_TYPES, DECLINE_REASONS, COST_PREFERENCES } = require('../shared/emergency');

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, max, maxLen) => (Array.isArray(v) ? v : String(v || '').split(','))
  .map((x) => str(String(x), maxLen)).filter(Boolean).slice(0, max);

function validLocation(loc) {
  return loc && Number.isFinite(+loc.lat) && Number.isFinite(+loc.lng) && Math.abs(+loc.lat) <= 90 && Math.abs(+loc.lng) <= 180;
}

const MEDICAL_FIELDS = ['bloodGroup', 'allergies', 'medications', 'conditions', 'pastEvents'];

// Only these fields can ever be written to a profile.
function profileFields(b) {
  const out = {};
  if ('fullName' in b) out.fullName = str(b.fullName, 80);
  if ('relation' in b) out.relation = str(b.relation, 30) || null;
  if ('age' in b) out.age = Number.isFinite(+b.age) && b.age !== '' ? Math.max(0, Math.min(120, Math.round(+b.age))) : null;
  if ('sex' in b) out.sex = ['F', 'M', 'Other'].includes(b.sex) ? b.sex : null;
  if ('bloodGroup' in b) out.bloodGroup = /^(A|B|AB|O)[+-]$/.test(str(b.bloodGroup, 4).toUpperCase()) ? str(b.bloodGroup, 4).toUpperCase() : null;
  if ('allergies' in b) out.allergies = list(b.allergies, 20, 80);
  if ('medications' in b) out.medications = list(b.medications, 30, 120);
  if ('conditions' in b) out.conditions = list(b.conditions, 20, 80);
  if ('pastEvents' in b) out.pastEvents = list(b.pastEvents, 20, 120);
  if ('insurance' in b) out.insurance = str(b.insurance, 60) || null;
  if ('preferredHospital' in b) out.preferredHospital = str(b.preferredHospital, 80) || null;
  if ('costPreference' in b) out.costPreference = COST_PREFERENCES.some((c) => c.id === b.costPreference) ? b.costPreference : 'any';
  if ('emergencyContacts' in b) {
    out.emergencyContacts = (Array.isArray(b.emergencyContacts) ? b.emergencyContacts : []).slice(0, 3)
      .map((c) => ({ name: str(c?.name, 40), relation: str(c?.relation, 30), phone: str(c?.phone, 20) })).filter((c) => c.name);
  }
  if ('documents' in b) out.documents = (Array.isArray(b.documents) ? b.documents : []).slice(0, 24);
  return out;
}

function profileForFamily(p) {
  const updated = p.medicalUpdatedAt || p.updatedAt || p.createdAt;
  const days = updated ? Math.floor((Date.now() - new Date(updated).getTime()) / 86400000) : null;
  return { ...p, lastMedicalUpdate: updated, stale: days != null && days > views.STALE_DAYS, daysSinceUpdate: days };
}

const ip = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

function register(r) {
  // ------------------------------------------------------------------ PUBLIC
  r.get('/v1/health', () => ({ ok: true, ai: ai.geminiEnabled() ? 'gemini' : 'mock', version: '0.2.0', demoCenter: DEMO_CENTER }));
  r.get('/v1/ai-status', async () => ai.selfTest());

  r.get('/v1/hospitals/public', () => ({
    hospitals: store.all('hospitals').map((h) => ({
      id: h.id, name: h.name, type: h.type, joined: !!h.joined, isDemo: !!h.isDemo,
      lat: h.lat, lng: h.lng, schemes: h.schemes || [], services: h.joined ? h.services : [],
      unavailable: !!h.unavailable,
    })),
  }));

  r.get('/v1/vocabulary', () => ({ SERVICES, EMERGENCY_TYPES, DECLINE_REASONS, COST_PREFERENCES }));

  r.get('/v1/privacy/notice', () => ({
    noticeVersion: privacy.NOTICE_VERSION, purposes: privacy.PURPOSES, retention: privacy.RETENTION, status: privacy.status(),
  }));

  r.post('/v1/families', (req) => {
    const { family, token } = auth.createFamily(req.body.name, req.body.memberLabel);
    return { status: 201, body: { family: { id: family.id, name: family.name, joinCode: family.joinCode }, token } };
  });

  r.post('/v1/families/join', (req) => {
    const { family, token } = auth.joinFamily(req.body.joinCode, req.body.memberLabel, ip(req));
    return { family: { id: family.id, name: family.name, joinCode: family.joinCode }, token };
  });

  r.post('/v1/hospital/login', (req) => {
    const { token, hospital } = auth.loginHospital(req.body.hospitalId, req.body.pin, ip(req));
    return { token, hospital, demoLogin: true, note: 'Demo login: one shared PIN. Not real security.' };
  });

  // one-time ticket to open the live stream (see hub.js for why)
  r.post('/v1/stream-ticket', (req) => {
    if (req.headers['x-family-token']) {
      const m = auth.requireFamily(req);
      return { ticket: hub.issueTicket([`family:${m.familyId}`]) };
    }
    if (req.headers['x-hospital-token']) {
      const h = auth.requireHospital(req);
      return { ticket: hub.issueTicket([`hospital:${h.id}`]) };
    }
    const e = req.body.shareToken && store.all('emergencies').find((x) => x.shareToken === req.body.shareToken);
    if (e) return { ticket: hub.issueTicket([`share:${e.id}`]) };
    throw new HttpError(401, 'NOT_SIGNED_IN', 'sign-in required');
  });

  r.get('/v1/share/:token', (req) => {
    const e = store.all('emergencies').find((x) => x.shareToken === req.params.token);
    if (!e) throw new HttpError(404, 'NOT_FOUND', 'this link is not valid');
    return { emergency: views.shareView(e) };
  });

  // ------------------------------------------------------------------ FAMILY
  r.get('/v1/family', (req) => {
    const m = auth.requireFamily(req);
    const f = store.find('families', m.familyId);
    return {
      family: { id: f.id, name: f.name, joinCode: f.joinCode, isDemo: !!f.isDemo },
      me: { id: m.id, label: m.label, profileId: m.profileId },
      members: store.all('members').filter((x) => x.familyId === f.id).map((x) => ({ id: x.id, label: x.label, profileId: x.profileId, createdAt: x.createdAt })),
    };
  });

  r.get('/v1/profiles', (req) => {
    const m = auth.requireFamily(req);
    return { profiles: store.all('profiles').filter((p) => p.familyId === m.familyId).map(profileForFamily) };
  });

  r.post('/v1/profiles', (req) => {
    const m = auth.requireFamily(req);
    const fields = profileFields(req.body || {});
    if (!fields.fullName) throw new HttpError(400, 'VALIDATION_FAILED', 'full name is required');
    const consentType = req.body.consentType;
    if (fields.age != null && fields.age < 18 && consentType !== 'parental') {
      throw new HttpError(400, 'PARENT_REQUIRED', "a parent or guardian must declare a child's profile");
    }
    if (!['self', 'parental', 'on-behalf'].includes(consentType)) {
      throw new HttpError(400, 'CONSENT_REQUIRED', 'say whose profile this is: yours, your child\'s, or a relative\'s');
    }
    let p = store.insert('profiles', {
      allergies: [], medications: [], conditions: [], pastEvents: [], emergencyContacts: [], documents: [],
      costPreference: 'any', ...fields, familyId: m.familyId, medicalUpdatedAt: new Date().toISOString(),
    });
    p = privacy.recordConsent(p.id, { type: consentType, byMemberId: m.id });
    if (consentType === 'self') store.update('members', m.id, { profileId: p.id });
    return { status: 201, body: { profile: profileForFamily(p) } };
  });

  r.put('/v1/profiles/:id', (req) => {
    const m = auth.requireFamily(req);
    auth.ownRecord('profiles', req.params.id, m);
    const fields = profileFields(req.body || {});
    if (fields.fullName === '') delete fields.fullName;
    if (MEDICAL_FIELDS.some((k) => k in fields)) fields.medicalUpdatedAt = new Date().toISOString();
    return { profile: profileForFamily(store.update('profiles', req.params.id, fields)) };
  });

  // "This is me" — the adult confirms a profile a relative created (fix #6)
  r.post('/v1/profiles/:id/confirm', (req) => {
    const m = auth.requireFamily(req);
    const p = auth.ownRecord('profiles', req.params.id, m);
    if (p.age != null && p.age < 18) throw new HttpError(400, 'CHILD_PROFILE', "a child's profile is declared by a parent");
    store.update('members', m.id, { profileId: p.id });
    return { profile: profileForFamily(privacy.recordConsent(p.id, { type: 'self', byMemberId: m.id })) };
  });

  r.get('/v1/profiles/:id/access-log', (req) => {
    const m = auth.requireFamily(req);
    auth.ownRecord('profiles', req.params.id, m);
    return { entries: store.all('accessLog').filter((a) => a.profileId === req.params.id).sort((a, b) => (a.at < b.at ? 1 : -1)) };
  });

  r.post('/v1/profiles/draft-from-image', async (req) => {
    auth.requireFamily(req);
    if (!req.body.imageBase64) throw new HttpError(400, 'VALIDATION_FAILED', 'imageBase64 is required');
    return { draft: await ai.draftProfileFromImage(req.body.imageBase64, req.body.mimeType) };
  });

  r.get('/v1/profiles/:id/summary', async (req) => {
    const m = auth.requireFamily(req);
    const p = auth.ownRecord('profiles', req.params.id, m);
    const summary = await ai.summarizeProfile(p);
    // insurance never goes to Gemini — this line is written by plain code
    summary.insuranceNote = p.insurance
      ? `Insured with ${p.insurance} — verify the policy with the insurer before relying on it.`
      : 'No insurer on file.';
    return { summary };
  });

  r.post('/v1/emergencies', async (req) => {
    const m = auth.requireFamily(req);
    const b = req.body || {};
    const profile = auth.ownRecord('profiles', b.profileId, m);
    // fix #3: the caller must confirm who the patient is before anything is sent
    if (b.patientConfirmed !== true) throw new HttpError(400, 'CONFIRM_PATIENT', `confirm the patient first: is this ${views.firstName(profile.fullName)}?`);
    // approved rule: a profile a relative added cannot be sent until that adult confirms it
    if (profile.consent?.type === 'on-behalf') {
      throw new HttpError(400, 'PROFILE_NOT_CONFIRMED', `${views.firstName(profile.fullName)} has not confirmed this profile yet, so it cannot be sent to hospitals. Call 112 now.`);
    }
    const types = list(b.types, 11, 30).filter((t) => EMERGENCY_TYPES.some((x) => x.id === t));
    const description = str(b.description, 2000);
    if (!types.length && !description) throw new HttpError(400, 'VALIDATION_FAILED', 'tap a button or describe what happened');
    const location = validLocation(b.location) && !b.useDemoLocation
      ? { lat: +b.location.lat, lng: +b.location.lng, accuracy: b.location.accuracy ?? null, isDemoLocation: false }
      : { lat: DEMO_CENTER.lat + 0.01, lng: DEMO_CENTER.lng + 0.005, accuracy: null, isDemoLocation: true };
    const e = await engine.startEmergency({ member: m, profile, types, description, location });
    return { status: 201, body: { emergency: views.familyView(e) } };
  });

  r.get('/v1/emergencies', (req) => {
    const m = auth.requireFamily(req);
    return {
      emergencies: store.all('emergencies').filter((e) => e.familyId === m.familyId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(views.familyView),
    };
  });

  r.get('/v1/emergencies/:id', (req) => {
    const m = auth.requireFamily(req);
    return { emergency: views.familyView(auth.ownRecord('emergencies', req.params.id, m)) };
  });

  r.post('/v1/emergencies/:id/divert', (req) => {
    const m = auth.requireFamily(req);
    return { emergency: views.familyView(engine.divert(req.params.id, m, req.body.hospitalId)) };
  });

  r.post('/v1/emergencies/:id/location', (req) => {
    const m = auth.requireFamily(req);
    if (!validLocation(req.body)) throw new HttpError(400, 'VALIDATION_FAILED', 'lat and lng required');
    engine.updateLocation(req.params.id, m, { lat: +req.body.lat, lng: +req.body.lng, accuracy: req.body.accuracy });
    return { ok: true };
  });

  r.post('/v1/emergencies/:id/cancel', (req) => {
    const m = auth.requireFamily(req);
    return { emergency: views.familyView(engine.familyCancel(req.params.id, m)) };
  });

  // ------------------------------------------------------------ LOCK-SCREEN QR
  // The QR on the lock-screen wallpaper opens a small public page. It shows
  // ONLY: first name, blood group, allergies, and a "call family" button whose
  // number appears only after a tap. Every opening is written to the access log
  // ("Who viewed my data"). The family can switch it off at any time — the old
  // link then stops working, even on a printed wallpaper.
  r.post('/v1/profiles/:id/qr', (req) => {
    const m = auth.requireFamily(req);
    const p = auth.ownRecord('profiles', req.params.id, m);
    if (p.consent?.type === 'on-behalf') throw new HttpError(400, 'PROFILE_NOT_CONFIRMED', `${views.firstName(p.fullName)} has to confirm this profile before a QR can be made.`);
    const token = auth.newToken().slice(0, 22);
    const qr = { token, enabled: true, createdAt: new Date().toISOString(), printOnWallpaper: !!req.body.printOnWallpaper };
    store.update('profiles', p.id, { qr });
    return { qr: { path: `/q/${token}`, printOnWallpaper: qr.printOnWallpaper } };
  });
  r.delete('/v1/profiles/:id/qr', (req) => {
    const m = auth.requireFamily(req);
    const p = auth.ownRecord('profiles', req.params.id, m);
    store.update('profiles', p.id, { qr: null });
    return { ok: true };
  });
  const qrProfile = (req, what) => {
    auth.brake(`qr:${ip(req)}`, 60);
    const p = store.all('profiles').find((x) => x.qr?.enabled && x.qr.token === req.params.token);
    if (!p) throw new HttpError(404, 'NOT_FOUND', 'This QR code has been switched off or is not valid.');
    store.insert('accessLog', {
      profileId: p.id, familyId: p.familyId, hospitalId: null,
      hospitalName: 'Someone who scanned the lock-screen QR', what, at: new Date().toISOString(),
    });
    return p;
  };
  r.get('/v1/q/:token', (req) => {
    const p = qrProfile(req, 'lock-screen QR page: blood group and allergies');
    return {
      firstName: views.firstName(p.fullName), bloodGroup: p.bloodGroup || null, allergies: p.allergies || [],
      hasContact: !!(p.emergencyContacts || [])[0]?.phone,
      note: 'Entered by the family — not verified by a clinician.',
    };
  });
  r.post('/v1/q/:token/contact', (req) => {
    const p = qrProfile(req, 'lock-screen QR: family phone number shown');
    const c = (p.emergencyContacts || [])[0];
    if (!c?.phone) throw new HttpError(404, 'NO_CONTACT', 'No family contact was added.');
    return { name: c.name, relation: c.relation, phone: c.phone };
  });

  // ------------------------------------------------------------ LAB REPORT READER
  // Family-only. Reports belong to one profile of the signing-in family.
  const ownLabs = (m, profileId) => store.all('labReports').filter((r) => r.profileId === profileId && r.familyId === m.familyId)
    .sort((a, b) => new Date(a.reportDate || a.createdAt) - new Date(b.reportDate || b.createdAt));
  r.get('/v1/labs/:profileId', (req) => {
    const m = auth.requireFamily(req);
    auth.ownRecord('profiles', req.params.profileId, m);
    return { reports: ownLabs(m, req.params.profileId) };
  });
  r.post('/v1/labs/analyze', async (req) => {
    const m = auth.requireFamily(req);
    const profile = auth.ownRecord('profiles', req.body.profileId, m);
    if (!req.body.imageBase64) throw new HttpError(400, 'VALIDATION_FAILED', 'imageBase64 is required');
    const analysis = await labs.analyseReport({
      base64: req.body.imageBase64, mimeType: req.body.mimeType, profile,
      previousReports: ownLabs(m, profile.id),
    });
    let saved = null;
    if (analysis.values?.length) {
      saved = store.insert('labReports', {
        profileId: profile.id, familyId: m.familyId,
        reportDate: analysis.reportDate || new Date().toISOString().slice(0, 10),
        labName: analysis.labName || null, values: analysis.values, source: analysis.source,
      });
    }
    return { analysis, savedId: saved?.id || null };
  });
  // DEMO SAFETY: two older SYNTHETIC reports, so the trend line has history.
  r.post('/v1/labs/demo-history', (req) => {
    const m = auth.requireFamily(req);
    const profile = auth.ownRecord('profiles', req.body.profileId, m);
    for (const x of store.all('labReports').filter((x) => x.profileId === profile.id && x.isDemo)) store.remove('labReports', x.id);
    const mk = (monthsAgo, creat, hba1c, hb, k) => {
      const d = new Date(); d.setMonth(d.getMonth() - monthsAgo);
      const v = (key, testName, value, unit, normalRange, status, means) => ({ key, testName, value, unit, normalRange, status, verdict: 'verified', confidence: 95, checks: [], means });
      return store.insert('labReports', {
        profileId: profile.id, familyId: m.familyId, isDemo: true, reportDate: d.toISOString().slice(0, 10),
        labName: 'Demo Diagnostics (synthetic)', source: 'demo',
        values: [
          v('creatinine', 'Creatinine', creat, 'mg/dL', [0.7, 1.3], creat > 1.3 ? 'high' : 'normal', 'how well the kidneys are filtering'),
          v('hba1c', 'HbA1c', hba1c, '%', [4.0, 5.6], hba1c > 5.6 ? 'high' : 'normal', 'average blood sugar over three months'),
          v('haemoglobin', 'Haemoglobin', hb, 'g/dL', [13.0, 17.0], hb < 13 ? 'low' : 'normal', 'oxygen-carrying capacity of the blood'),
          v('potassium', 'Potassium', k, 'mEq/L', [3.5, 5.1], k > 5.1 ? 'high' : 'normal', 'affects the heart rhythm directly'),
        ],
      });
    };
    const a = mk(18, 1.1, 6.1, 14.2, 4.4), b = mk(6, 1.4, 6.8, 13.1, 4.9);
    return { ok: true, created: [a.id, b.id] };
  });

  // ------------------------------------------------------------ CPR COACH FEED
  // The rescuer's phone sends a small picture + CPR numbers twice a second.
  // They go ONLY to the hospital receiving this patient (not to every hospital,
  // as the old app did) and are NOT stored. Every 20 s one frame may be shown
  // to Gemini to describe the scene (only when Gemini is on).
  const lastScene = new Map();
  r.post('/v1/emergencies/:id/cpr-frame', (req) => {
    const m = auth.requireFamily(req);
    const e = auth.ownRecord('emergencies', req.params.id, m);
    if (!['ACCEPTED', 'DIVERTED'].includes(e.status) || !e.receivingHospitalId) {
      return { sent: false, why: 'No hospital has accepted yet — the coach still works on this phone.' };
    }
    const jpeg = typeof req.body.jpeg === 'string' && req.body.jpeg.startsWith('data:image/jpeg;base64,') ? req.body.jpeg.slice(0, 400000) : null;
    const st = req.body.stats || {};
    const stats = { rate: Number.isFinite(+st.rate) ? Math.round(+st.rate) : null, count: Number.isFinite(+st.count) ? Math.round(+st.count) : null, handsOk: typeof st.handsOk === 'boolean' ? st.handsOk : null, seconds: Number.isFinite(+st.seconds) ? Math.round(+st.seconds) : null };
    hub.publish(`hospital:${e.receivingHospitalId}`, 'cpr:frame', { emergencyId: e.id, jpeg, stats, at: Date.now() });
    if (jpeg && ai.geminiEnabled() && Date.now() - (lastScene.get(e.id) || 0) > 20000) {
      lastScene.set(e.id, Date.now());
      ai.readScene(jpeg.split(',')[1], 'image/jpeg')
        .then((scene) => hub.publish(`hospital:${e.receivingHospitalId}`, 'cpr:scene', { emergencyId: e.id, scene, at: Date.now() }))
        .catch(() => {});
    }
    return { sent: true };
  });

  // DEMO ONLY: put the demo back to the start. Works only for the demo family.
  // Closes its open emergencies (hospitals are told) and restores every
  // fictional hospital's services and availability to the seed values.
  r.post('/v1/demo/reset', (req) => {
    const m = auth.requireFamily(req);
    const f = store.find('families', m.familyId);
    if (!f?.isDemo) throw new HttpError(403, 'NOT_DEMO', 'reset is only for the demo family');
    const open = store.all('emergencies').filter((e) => e.familyId === f.id && ['SEARCHING', 'NO_ACCEPT_YET', 'ACCEPTED', 'DIVERTED'].includes(e.status));
    for (const e of open) engine.familyCancel(e.id, m);
    for (const h of HOSPITALS) {
      if (store.find('hospitals', h.id)) store.update('hospitals', h.id, { services: h.services, unavailable: false, unavailableReason: null });
    }
    return { closed: open.length, hospitalsRestored: HOSPITALS.length };
  });

  // privacy rights — family-scoped (anyone could erase anyone before)
  r.post('/v1/privacy/consent/:profileId', (req) => {
    const m = auth.requireFamily(req);
    const p = auth.ownRecord('profiles', req.params.profileId, m);
    return { profile: privacy.recordConsent(p.id, { byMemberId: m.id, purposes: req.body.purposes }) };
  });
  r.post('/v1/privacy/withdraw/:profileId', (req) => {
    const m = auth.requireFamily(req);
    const p = auth.ownRecord('profiles', req.params.profileId, m);
    return { profile: privacy.withdrawConsent(p.id) };
  });
  r.get('/v1/privacy/export/:profileId', (req) => {
    const m = auth.requireFamily(req);
    const p = auth.ownRecord('profiles', req.params.profileId, m);
    return privacy.exportEverything(p.id);
  });
  r.delete('/v1/privacy/erase/:profileId', (req) => {
    const m = auth.requireFamily(req);
    const p = auth.ownRecord('profiles', req.params.profileId, m);
    return privacy.eraseEverything(p.id);
  });

  // ---------------------------------------------------------------- HOSPITAL
  r.get('/v1/hospital/me', (req) => ({ hospital: auth.requireHospital(req) }));

  // the hospital declares its own services and can switch itself off for a while
  r.put('/v1/hospital/me', (req) => {
    const h = auth.requireHospital(req);
    const changes = {};
    if (Array.isArray(req.body.services)) changes.services = [...new Set(req.body.services.filter((s) => SERVICES.includes(s)))];
    if ('unavailable' in req.body) {
      changes.unavailable = !!req.body.unavailable;
      changes.unavailableReason = changes.unavailable ? str(req.body.unavailableReason, 120) || null : null;
    }
    return { hospital: store.update('hospitals', h.id, changes) };
  });

  r.get('/v1/hospital/offers', (req) => {
    const h = auth.requireHospital(req);
    const mine = store.all('offers').filter((o) => o.hospitalId === h.id);
    const pending = mine.filter((o) => o.status === 'pending')
      .map((o) => views.level1Card(store.find('emergencies', o.emergencyId), o, h))
      .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1));
    const incoming = store.all('emergencies').filter((e) => e.receivingHospitalId === h.id && ['ACCEPTED', 'DIVERTED'].includes(e.status))
      .map((e) => ({ emergencyId: e.id, ref: e.id.slice(0, 6).toUpperCase(), status: e.status, urgency: e.urgency, diverted: e.divertedTo?.hospitalId === h.id, simulated: !!e.simulatedAccept, acceptedAt: e.acceptedAt || e.divertedTo?.at }));
    const recent = mine.filter((o) => o.status !== 'pending').slice(-20).reverse()
      .map((o) => ({ offerId: o.id, ref: o.emergencyId.slice(0, 6).toUpperCase(), status: o.status, reason: o.closedReason || o.declineReason || null }));
    return { pending, incoming, recent };
  });

  r.post('/v1/hospital/offers/:id/accept', (req) => {
    const h = auth.requireHospital(req);
    const e = engine.accept(req.params.id, h);
    return { emergencyId: e.id };
  });

  r.post('/v1/hospital/offers/:id/decline', (req) => {
    const h = auth.requireHospital(req);
    const reason = DECLINE_REASONS.some((d) => d.id === req.body.reason) ? req.body.reason : 'other';
    engine.decline(req.params.id, h, reason, req.body.note);
    return { ok: true };
  });

  // level 2 — only the receiving hospital; every read is logged for the family
  r.get('/v1/hospital/emergencies/:id', (req) => {
    const h = auth.requireHospital(req);
    const e = store.find('emergencies', req.params.id);
    if (!e || e.receivingHospitalId !== h.id) throw new HttpError(404, 'NOT_FOUND', 'details are only available to the hospital receiving this patient');
    store.insert('accessLog', {
      emergencyId: e.id, profileId: e.profileId, familyId: e.familyId,
      hospitalId: h.id, hospitalName: h.name, what: 'treatment details', at: new Date().toISOString(),
    });
    return { patient: views.level2(e, h) };
  });

  r.post('/v1/hospital/emergencies/:id/cancel', (req) => {
    const h = auth.requireHospital(req);
    engine.hospitalCancel(req.params.id, h, str(req.body.reason, 120));
    return { ok: true };
  });
  r.post('/v1/hospital/emergencies/:id/seen', (req) => {
    const h = auth.requireHospital(req);
    engine.markSeen(req.params.id, h);
    return { ok: true };
  });
  r.post('/v1/hospital/emergencies/:id/arrived', (req) => {
    const h = auth.requireHospital(req);
    engine.arrived(req.params.id, h);
    return { ok: true };
  });
}

module.exports = { register };
