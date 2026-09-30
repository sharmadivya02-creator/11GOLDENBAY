// views.js — exactly what each person is allowed to see. Nothing else leaves
// the server. If a field is not built here, no screen can show it.
//
//   level1Card  — every capable hospital that is ASKED. No name, no location.
//   level2      — ONLY the hospital receiving the patient. Every read is logged.
//   familyView  — the family's own phones.
//   shareView   — relatives with the private link: where and how, no medical data.

const store = require('./store');
const { distanceKm, navigateUrl, round1 } = require('./geo');
const { EMERGENCY_TYPES, SERVICE_LABELS } = require('../shared/emergency');

const STALE_DAYS = 180; // [Design choice] profile older than this gets a warning

function ageRange(age) {
  if (age == null || !Number.isFinite(+age)) return 'age unknown';
  const a = +age;
  if (a < 18) return a < 5 ? 'under 5' : a < 10 ? '5–9' : a < 15 ? '10–14' : '15–17';
  if (a >= 80) return '80+';
  const lo = Math.floor(a / 10) * 10;
  return `${lo}–${lo + 9}`;
}
const firstName = (full) => String(full || 'Patient').replace(/\s*\(DEMO\)\s*/i, '').trim().split(/\s+/)[0];
const typeLabels = (ids) => EMERGENCY_TYPES.filter((t) => (ids || []).includes(t.id)).map((t) => t.label);
const serviceLabels = (ids) => (ids || []).map((s) => SERVICE_LABELS[s] || s);
const daysSince = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : null);

const CONSENT_LABEL = {
  self: 'Confirmed by the patient',
  parental: 'Declared by a parent or guardian (child)',
  'on-behalf': 'Added by a relative — not yet confirmed by the patient',
};

// ---------------------------------------------------------------------------
function level1Card(emergency, offer, hospital) {
  const p = store.find('profiles', emergency.profileId) || {};
  return {
    offerId: offer.id,
    ref: emergency.id.slice(0, 6).toUpperCase(),
    ageRange: ageRange(p.age),
    sex: p.sex || 'not recorded',
    reported: typeLabels(emergency.types),
    suspectedCategory: emergency.picture?.suspectedCategory || null,
    urgency: emergency.urgency,
    needs: serviceLabels(emergency.needs?.required),
    alsoUseful: serviceLabels(emergency.needs?.preferred),
    distanceKm: round1(distanceKm(emergency.location, hospital)),
    round: offer.round,
    sentAt: offer.createdAt,
    status: offer.status,
  };
}

// Template handover (SBAR structure, without the "Recommendation" part —
// GoldenBay never recommends treatment). Built by code from the profile.
// Gemini's note (ai.planAndHandover) is shown BESIDE it, never instead of it.
function templateHandover(emergency, p) {
  return {
    situation: `${p.age ?? '?'}${p.sex ? ' ' + p.sex : ''} · ${typeLabels(emergency.types).join(', ') || emergency.picture?.suspectedCategory || 'emergency'} · urgency ${emergency.urgency}`,
    background: [
      p.bloodGroup ? `Blood group ${p.bloodGroup}` : 'Blood group not recorded',
      (p.allergies || []).length ? `Allergies: ${p.allergies.join(', ')}` : 'No allergies recorded',
      (p.medications || []).length ? `Medicines: ${p.medications.join('; ')}` : 'No medicines recorded',
      (p.conditions || []).length ? `Conditions: ${p.conditions.join(', ')}` : 'No conditions recorded',
      ...((p.pastEvents || []).length ? [`History: ${p.pastEvents.join('; ')}`] : []),
    ],
    assessment: emergency.picture?.suspectedCategory || 'Not assessed',
    source: 'template',
  };
}

function level2(emergency, hospital) {
  const p = store.find('profiles', emergency.profileId) || {};
  const contact = (p.emergencyContacts || [])[0] || null;
  const updated = p.medicalUpdatedAt || p.updatedAt || p.createdAt;
  const live = emergency.liveLocation;
  return {
    emergencyId: emergency.id,
    ref: emergency.id.slice(0, 6).toUpperCase(),
    status: emergency.status,
    firstName: firstName(p.fullName),
    age: p.age ?? null, sex: p.sex || null,
    bloodGroup: p.bloodGroup || null,
    allergies: p.allergies || [], medications: p.medications || [],
    conditions: p.conditions || [], pastEvents: p.pastEvents || [],
    handover: templateHandover(emergency, p),                     // plain facts, built by code — always shown
    aiNote: emergency.handover || null,                           // Gemini's note, only the points that passed the code check
    flags: emergency.agentFlags || [],
    callerWords: emergency.descriptionMasked || '',
    picture: emergency.picture ? {
      suspectedCategory: emergency.picture.suspectedCategory, risks: emergency.picture.risks,
      questionsForCaller: emergency.picture.questionsForCaller, source: emergency.picture._source,
    } : null,
    urgency: emergency.urgency,
    emergencyContact: contact ? { name: contact.name, relation: contact.relation, phone: contact.phone } : null,
    profile: {
      reportedBy: 'Family — not verified by a clinician',
      lastUpdated: updated || null,
      daysSinceUpdate: daysSince(updated),
      stale: daysSince(updated) > STALE_DAYS,
      consent: CONSENT_LABEL[p.consent?.type] || 'Consent not recorded',
    },
    patientConfirmedByCaller: !!emergency.patientConfirmed,
    liveLocation: live ? { at: live.at, distanceKm: round1(distanceKm(live, hospital)) } : null,
    arrivalBy: emergency.divertedTo?.hospitalId === hospital.id ? 'Diverted here — arriving by ambulance or car' : emergency.simulatedAccept ? 'Accepted automatically (demo — no one at your desk answered in time)' : 'Accepted by your team',
  };
}

// ---------------------------------------------------------------------------
function hospitalBrief(h) {
  if (!h) return null;
  return {
    id: h.id, name: h.name, type: h.type, joined: h.joined, isDemo: !!h.isDemo,
    lat: h.lat, lng: h.lng, phone: h.phone, navigateUrl: navigateUrl(h),
  };
}

function familyView(e) {
  const offers = store.all('offers').filter((o) => o.emergencyId === e.id);
  const p = store.find('profiles', e.profileId) || {};
  const receiving = e.receivingHospitalId ? store.find('hospitals', e.receivingHospitalId) : null;
  return {
    id: e.id, ref: e.id.slice(0, 6).toUpperCase(), status: e.status,
    createdAt: e.createdAt, patient: { id: p.id, firstName: firstName(p.fullName), fullName: p.fullName },
    types: e.types, typeLabels: typeLabels(e.types), urgency: e.urgency,
    picture: e.picture ? { suspectedCategory: e.picture.suspectedCategory, questionsForCaller: e.picture.questionsForCaller, source: e.picture._source } : null,
    needs: { required: serviceLabels(e.needs?.required), preferred: serviceLabels(e.needs?.preferred) },
    asking: {
      round: e.round, radiusKm: e.radiusKm,
      asked: offers.length,
      declined: offers.filter((o) => o.status === 'declined').length,
      waiting: offers.filter((o) => o.status === 'pending').length,
    },
    hospital: hospitalBrief(receiving),
    divertedTo: e.divertedTo || null,
    fallback: e.fallback || null,
    timeToAcceptSec: e.timeToAcceptSec ?? null, simulatedAccept: !!e.simulatedAccept,
    acceptedAt: e.acceptedAt || null, arrivedAt: e.arrivedAt || null,
    sharePath: `/share/${e.shareToken}`,
    log: (e.log || []).slice(-60),
    location: e.location,
  };
}

function shareView(e) {
  const p = store.find('profiles', e.profileId) || {};
  const receiving = e.receivingHospitalId ? store.find('hospitals', e.receivingHospitalId) : null;
  return {
    ref: e.id.slice(0, 6).toUpperCase(), status: e.status, createdAt: e.createdAt,
    patientFirstName: firstName(p.fullName),
    hospital: hospitalBrief(receiving),
    divertedTo: e.divertedTo ? { name: e.divertedTo.name, joined: e.divertedTo.joined } : null,
    waitingForHospital: !receiving && !e.divertedTo,
    fallback: e.fallback ? { message: e.fallback.message } : null,
    liveLocation: e.liveLocation || null,
    acceptedAt: e.acceptedAt || null, arrivedAt: e.arrivedAt || null,
  };
}

module.exports = { level1Card, level2, familyView, shareView, hospitalBrief, ageRange, firstName, STALE_DAYS, CONSENT_LABEL };
