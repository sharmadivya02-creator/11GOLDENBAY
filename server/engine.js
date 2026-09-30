// engine.js — the Dispatch Agent's core: ask hospitals, first yes wins,
// widen the search if nobody answers, never leave the family in silence.
//
// EVERY DECISION HERE IS A FIXED RULE, on purpose: who gets asked, when to
// widen, when to tell the family. Gemini's output can only ADD services
// (which reorders hospitals) and RAISE urgency; it can never remove a hospital
// from the list or lower urgency. Hospitals decide whether they accept.
//
// Nothing in this file knows about beds, cath-lab status or ambulances.
// GoldenBay never has that data; the hospital's own "Accept" replaces it.

const crypto = require('crypto');
const store = require('./store');
const hub = require('./hub');
const ai = require('./ai');
const { mask } = require('./mask');
const { distanceKm, round1 } = require('./geo');
const views = require('./views');
const { EMERGENCY_TYPES, URGENCY, DECLINE_REASONS, SERVICE_LABELS } = require('../shared/emergency');

// Offer timings approved by Divya. Can be overridden with env vars for testing.
const ROUND_SECONDS = () => Number(process.env.OFFER_ROUND_SECONDS || 30);   // approved: 30 s per round
const HEAD_START_SECONDS = () => Number(process.env.COST_HEAD_START_SECONDS || 20);
const RADII_KM = [5, 10, 15];
// DEMO ONLY: if no person at a hospital answers within this many seconds, the
// one of the hospitals that was asked (at random) "accepts" automatically, and the app says it
// was simulated. Set DEMO_AUTO_ACCEPT_SECONDS=0 to switch this off.
const AUTO_ACCEPT_SECONDS = () => Number(process.env.DEMO_AUTO_ACCEPT_SECONDS ?? 8);
const who = (e) => views.firstName((store.find('profiles', e.profileId) || {}).fullName);
const shortH = (name) => String(name).split(' ').slice(0, 2).join(' ');                                                 // approved: 5, 10, 15 km
const ACTIVE = ['SEARCHING', 'NO_ACCEPT_YET', 'ACCEPTED', 'DIVERTED'];

const timers = new Map(); // emergencyId -> [timeouts]
function clearTimers(id) { (timers.get(id) || []).forEach(clearTimeout); timers.delete(id); }
function addTimer(id, ms, fn) { const t = setTimeout(fn, ms); (timers.get(id) || timers.set(id, []).get(id)).push(t); }

// ---------------------------------------------------------------------------
// publishing + the agent log (every step is visible, with its reason)
// ---------------------------------------------------------------------------
function save(e, changes) { return store.update('emergencies', e.id, changes); }

// `reason` = the full technical explanation (kept for the export and for judges).
// `say`    = the same step in everyday words — this is what the family sees.
function log(e, tool, args, reason, say) {
  const cur = store.find('emergencies', e.id) || e;            // always append to the latest log
  const entry = { at: new Date().toISOString(), step: (cur.log || []).length + 1, tool, args: args || {}, reason, say: say || reason };
  const logArr = [...(cur.log || []), entry].slice(-200);
  save(cur, { log: logArr });
  hub.publish(`family:${e.familyId}`, 'agent:action', { emergencyId: e.id, ...entry });
  return entry;
}

function broadcast(e) {
  e = store.find('emergencies', e.id);
  hub.publish(`family:${e.familyId}`, 'emergency:update', views.familyView(e));
  hub.publish(`share:${e.id}`, 'share:update', views.shareView(e));
  if (e.receivingHospitalId) hub.publish(`hospital:${e.receivingHospitalId}`, 'patient:update', { emergencyId: e.id, status: e.status });
}

// ---------------------------------------------------------------------------
// who can be asked
// ---------------------------------------------------------------------------
function costMatch(h, pref) {
  if (pref === 'government') return h.type === 'government';
  if (pref === 'pmjay') return (h.schemes || []).includes('pmjay');
  if (pref === 'private-insurance') return h.type === 'private';
  return false;
}

function blockedIds(e) {
  const offers = store.all('offers').filter((o) => o.emergencyId === e.id);
  return new Set([
    ...(e.excludedHospitalIds || []),
    ...offers.filter((o) => ['pending', 'declined', 'cancelled'].includes(o.status)).map((o) => o.hospitalId),
  ]);
}

// mode: 'all'  = hospital declares every required service
//       'any'  = at least one required service (used only if 'all' finds nobody)
function candidates(e, radiusKm, mode) {
  const req = e.needs.required;
  const blocked = blockedIds(e);
  return store.all('hospitals')
    .filter((h) => h.joined && !h.unavailable && !blocked.has(h.id))
    .filter((h) => {
      const s = h.services || [];
      if (!s.includes('emergency')) return false;
      if (!req.length) return true;
      return mode === 'all' ? req.every((x) => s.includes(x)) : req.some((x) => s.includes(x));
    })
    .map((h) => ({ h, km: distanceKm(e.location, h) }))
    .filter((x) => x.km <= radiusKm)
    .sort((a, b) =>
      (costMatch(b.h, e.costPreference) - costMatch(a.h, e.costPreference)) ||
      (e.needs.preferred.filter((s) => b.h.services.includes(s)).length - e.needs.preferred.filter((s) => a.h.services.includes(s)).length) ||
      (a.km - b.km));
}

// ---------------------------------------------------------------------------
// the rounds
// ---------------------------------------------------------------------------
function sendOffers(e, list, note) {
  if (!list.length) return;
  for (const { h, km } of list) {
    const offer = store.insert('offers', { emergencyId: e.id, hospitalId: h.id, round: e.round, status: 'pending', distanceKm: round1(km) });
    hub.publish(`hospital:${h.id}`, 'offer:new', views.level1Card(store.find('emergencies', e.id), offer, h));
  }
  log(e, 'send_offers', { round: e.round, radiusKm: e.radiusKm, hospitals: list.map((x) => x.h.name) },
    note || `Asking ${list.length} hospital${list.length > 1 ? 's' : ''} within ${e.radiusKm} km that declare the needed services — all at once. The first to accept gets the patient's details.`,
    `Asked ${list.length} hospital${list.length > 1 ? 's' : ''} near you (within ${e.radiusKm} km): ${list.map((x) => shortH(x.h.name)).join(', ')}. Waiting for one to say yes.`);
}

function startRound(id, round) {
  let e = store.find('emergencies', id);
  if (!e || e.receivingHospitalId || !['SEARCHING', 'NO_ACCEPT_YET'].includes(e.status)) return;
  const radius = RADII_KM[round - 1];
  let mode = 'all';
  let list = candidates(e, radius, 'all');
  if (!list.length && e.needs.required.length > 1) { list = candidates(e, radius, 'any'); mode = 'any'; }

  if (!list.length) {
    if (round < RADII_KM.length) {
      e = save(e, { round, radiusKm: radius });
      log(e, 'widen_search', { fromKm: radius, toKm: RADII_KM[round] }, `No capable hospital on GoldenBay within ${radius} km. Widening to ${RADII_KM[round]} km.`,
        `No suitable hospital within ${radius} km, so we're looking up to ${RADII_KM[round]} km.`);
      return startRound(id, round + 1);
    }
    return tellFamily(id, 'No capable hospital on GoldenBay could be asked.');
  }

  e = save(e, { round, radiusKm: radius, status: e.status === 'NO_ACCEPT_YET' ? 'NO_ACCEPT_YET' : 'SEARCHING' });
  const note = mode === 'any' ? 'No single hospital declares every needed service, so asking hospitals that declare at least one.' : null;

  // Cost preference: in a non-critical case, matching hospitals get a short
  // head start. In a CRITICAL case everyone is asked at once — money never
  // costs minutes.
  const preferred = list.filter((x) => costMatch(x.h, e.costPreference));
  if (e.urgency !== 'CRITICAL' && e.costPreference !== 'any' && preferred.length && preferred.length < list.length) {
    sendOffers(e, preferred, `Asking ${preferred.length} hospital(s) that match the family's cost preference first (not life-threatening).`);
    addTimer(id, HEAD_START_SECONDS() * 1000, () => {
      const cur = store.find('emergencies', id);
      if (!cur || cur.receivingHospitalId || cur.round !== round) return;
      sendOffers(cur, list.filter((x) => !costMatch(x.h, cur.costPreference) && !blockedIds(cur).has(x.h.id)), note);
    });
  } else {
    sendOffers(e, list, note);
  }
  addTimer(id, ROUND_SECONDS() * 1000, () => onRoundTimeout(id, round));
  if (AUTO_ACCEPT_SECONDS() > 0) addTimer(id, AUTO_ACCEPT_SECONDS() * 1000, () => demoAutoAccept(id));
  broadcast(e);
}

function onRoundTimeout(id, round) {
  const e = store.find('emergencies', id);
  if (!e || e.receivingHospitalId || e.round !== round || !['SEARCHING', 'NO_ACCEPT_YET'].includes(e.status)) return;
  if (round < RADII_KM.length) {
    log(e, 'widen_search', { fromKm: RADII_KM[round - 1], toKm: RADII_KM[round] }, `Nobody accepted within ${ROUND_SECONDS()} seconds. Asking capable hospitals up to ${RADII_KM[round]} km as well.`,
    `No answer yet, so we're also asking hospitals a little further away (up to ${RADII_KM[round]} km).`);
    return startRound(id, round + 1);
  }
  tellFamily(id, `Nobody accepted within ${ROUND_SECONDS()} seconds.`);
}

// Never leave the family in silence: name a concrete next step.
function tellFamily(id, why) {
  let e = store.find('emergencies', id);
  if (!e || e.receivingHospitalId) return;
  const req = e.needs.required;
  const all = store.all('hospitals').map((h) => ({ h, km: distanceKm(e.location, h) })).sort((a, b) => a.km - b.km);
  const capable = all.find(({ h }) => h.joined && (!req.length || req.every((x) => (h.services || []).includes(x))));
  const nearestListed = all.find(({ h }) => !h.joined);
  const pick = capable || nearestListed || null;
  const where = pick ? `${pick.h.name} (${round1(pick.km)} km${pick.h.joined ? '' : ', listed — services not confirmed'})` : 'the nearest hospital';
  e = save(e, {
    status: 'NO_ACCEPT_YET',
    fallback: {
      at: new Date().toISOString(),
      message: `No hospital has confirmed yet. Call 112 now, or go to ${where}. We keep asking in the background.`,
      hospital: pick ? views.hospitalBrief(pick.h) : null,
    },
  });
  log(e, 'tell_family', { suggested: pick?.h.name || null }, `${why} Telling the family exactly what to do instead of waiting. Requests stay open in case a hospital accepts late.`,
    `No hospital has said yes yet. Call 112 now${pick ? `, or go to ${pick.h.name}` : ''}. We'll keep asking.`);
  broadcast(e);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
async function startEmergency({ member, profile, types, description, location }) {
  const typeDefs = EMERGENCY_TYPES.filter((t) => types.includes(t.id));
  const masked = await mask(description);
  const required = [...new Set(typeDefs.flatMap((t) => t.required))];
  const preferred = [...new Set(typeDefs.flatMap((t) => t.preferred))].filter((s) => !required.includes(s));

  let e = store.insert('emergencies', {
    familyId: member.familyId, profileId: profile.id, createdByMemberId: member.id,
    patientConfirmed: true,
    types: typeDefs.map((t) => t.id),
    description: String(description || '').slice(0, 2000),       // family only
    descriptionMasked: masked.text.slice(0, 2000), maskEngine: masked.engine, maskFound: masked.found,
    location,
    status: 'SEARCHING', round: 0, radiusKm: null,
    urgency: typeDefs.some((t) => t.critical) ? 'CRITICAL' : 'HIGH',
    needs: { required, preferred },
    costPreference: profile.costPreference || 'any',
    picture: null, receivingHospitalId: null, excludedHospitalIds: [],
    shareToken: crypto.randomBytes(18).toString('base64url'),
    log: [],
  });

  log(e, 'goal', {}, `Goal: get ${views.firstName(profile.fullName)} to a hospital that has said yes, with their details there before they arrive. Never leave the family waiting without a next step.`,
    `Looking for a hospital that will say yes for ${views.firstName(profile.fullName)}.`);
  if (masked.found.length) log(e, 'mask', { engine: masked.engine, removed: masked.found }, `Removed ${masked.found.join(', ')} from the caller's words before anything left the phone's family.`,
    'Phone numbers, ID numbers and emails in what you typed were hidden by our own rules. Names are not hidden.');

  startRound(e.id, 1);             // ask hospitals now — do not wait for the AI
  understand(e.id, profile);        // enrich in the background
  return store.find('emergencies', e.id);
}

async function understand(id, profile) {
  const e0 = store.find('emergencies', id);
  const input = {
    words: e0.descriptionMasked,
    typeIds: e0.types,
    typeLabels: EMERGENCY_TYPES.filter((t) => e0.types.includes(t.id)).map((t) => t.label),
    patient: { ageRange: views.ageRange(profile.age), ...ai.medicalOnly(profile) },
  };
  const picture = await ai.understandEmergency(input);
  let e = store.find('emergencies', id);
  if (!e) return;

  // AI may ADD services (they reorder / enrich) and RAISE urgency. Never less.
  const added = (picture.services || []).filter((s) => !e.needs.required.includes(s) && !e.needs.preferred.includes(s));
  const urgency = picture.urgency && URGENCY.indexOf(picture.urgency) < URGENCY.indexOf(e.urgency) ? picture.urgency : e.urgency;
  e = save(e, { picture, urgency, needs: { required: e.needs.required, preferred: [...e.needs.preferred, ...added] } });
  log(e, 'understand', { source: picture._source, suspectedCategory: picture.suspectedCategory, added, rejected: picture.rejected || [] },
    picture._source === 'gemini'
      ? `Gemini organised the report${added.length ? ` and suggested also looking for: ${added.join(', ')}` : ''}. Checked by code: only known service names kept${(picture.rejected || []).length ? ` (dropped: ${picture.rejected.join(', ')})` : ''}.`
      : `Used plain rules to organise the report (Gemini unavailable${picture._fallbackReason ? ': ' + picture._fallbackReason : ''}).`,
    'Read what you told us, so the hospital can get ready.');

  // refresh the cards hospitals are looking at
  for (const o of store.all('offers').filter((x) => x.emergencyId === id && x.status === 'pending')) {
    const h = store.find('hospitals', o.hospitalId);
    hub.publish(`hospital:${h.id}`, 'offer:update', views.level1Card(e, o, h));
  }
  broadcast(e);
  await plan(id, input);
}

// Gemini jobs 2 + 4: the agent proposes next actions from a fixed menu and
// writes the handover note. Code checks each one (ai.validatePlan) — here we
// only carry out what passed. Without Gemini this does nothing and the plain
// template handover is used.
async function plan(id, input) {
  let e = store.find('emergencies', id);
  if (!e) return;
  const out = await ai.planAndHandover({ ...input, alreadyNeeded: [...e.needs.required, ...e.needs.preferred] });
  e = store.find('emergencies', id);
  if (!out || !e) return;
  const added = out.actions.filter((a) => a.type === 'add_service').map((a) => a.service)
    .filter((s) => !e.needs.required.includes(s) && !e.needs.preferred.includes(s));
  const questions = out.actions.filter((a) => a.type === 'ask_caller').map((a) => a.question);
  const flags = out.actions.filter((a) => a.type === 'flag_for_hospital').map((a) => ({ note: a.note, source: a.source }));
  const picture = { ...(e.picture || {}), questionsForCaller: [...questions, ...((e.picture && e.picture.questionsForCaller) || [])].slice(0, 4) };
  e = save(e, {
    picture,
    needs: { required: e.needs.required, preferred: [...e.needs.preferred, ...added] },
    agentFlags: flags,
    handover: out.handover ? { ...out.handover, source: 'gemini', checkedByCode: true, removed: out.rejected.length } : null,
  });
  const did = [
    added.length ? `prefer hospitals with ${added.map((x) => SERVICE_LABELS[x] || x).join(', ')}` : null,
    questions.length ? `${questions.length} question(s) for the family` : null,
    flags.length ? `${flags.length} warning(s) for the hospital` : null,
    out.handover ? 'a handover note' : null,
  ].filter(Boolean);
  log(e, 'agent_plan', { actions: out.actions, rejected: out.rejected },
    `Gemini proposed ${out.actions.length + out.rejected.length} step(s); code kept ${out.actions.length}${out.rejected.length ? ` and removed ${out.rejected.length} (${out.rejected.join('; ')})` : ''}. Kept: ${did.join('; ') || 'nothing'}.`,
    `Prepared ${did.length ? did.join(', ') : 'nothing extra'} — every point checked against ${views.firstName((store.find('profiles', e.profileId) || {}).fullName)}'s profile.`);
  for (const o of store.all('offers').filter((x) => x.emergencyId === id && x.status === 'pending')) {
    const h = store.find('hospitals', o.hospitalId);
    hub.publish(`hospital:${h.id}`, 'offer:update', views.level1Card(e, o, h));
  }
  broadcast(e);
}

// ---------------------------------------------------------------------------
// hospital actions
// ---------------------------------------------------------------------------
const { HttpError } = require('./http');

function ownOffer(offerId, hospital) {
  const o = store.find('offers', offerId);
  if (!o || o.hospitalId !== hospital.id) throw new HttpError(404, 'NOT_FOUND', 'request not found');
  return o;
}

function releasePending(e, reason, exceptOfferId) {
  for (const o of store.all('offers').filter((x) => x.emergencyId === e.id && x.status === 'pending' && x.id !== exceptOfferId)) {
    store.update('offers', o.id, { status: 'released', closedReason: reason });
    hub.publish(`hospital:${o.hospitalId}`, 'offer:closed', { offerId: o.id, reason });
  }
}

function accept(offerId, hospital, opts = {}) {
  const o = ownOffer(offerId, hospital);
  let e = store.find('emergencies', o.emergencyId);
  if (o.status !== 'pending' || !e || e.receivingHospitalId || !['SEARCHING', 'NO_ACCEPT_YET'].includes(e.status)) {
    throw new HttpError(409, 'TAKEN', 'This patient has already been taken by another hospital, or the request is closed.');
  }
  // Node runs this synchronously, so two taps cannot both get past the check above.
  store.update('offers', o.id, { status: 'accepted', respondedAt: new Date().toISOString() });
  const secs = Math.round((Date.now() - new Date(e.createdAt).getTime()) / 1000);
  clearTimers(e.id);
  e = save(e, { status: 'ACCEPTED', receivingHospitalId: hospital.id, acceptedAt: new Date().toISOString(), timeToAcceptSec: secs, fallback: null, simulatedAccept: !!opts.simulated });
  releasePending(e, 'taken');
  log(e, 'accepted', { hospital: hospital.name, seconds: secs, simulated: !!opts.simulated },
    opts.simulated
      ? `DEMO ONLY: no person at a hospital answered within ${AUTO_ACCEPT_SECONDS()} seconds, so a simulated staff member at ${hospital.name} (picked at random from the best-equipped hospitals asked) pressed Accept. All other hospitals were told "no action needed".`
      : `${hospital.name} accepted after ${secs} seconds. Its team can now open the patient's details. All other hospitals were told "no action needed".`,
    `${hospital.name} said YES in ${secs} seconds${opts.simulated ? ' (demo — automatic)' : ''}. Go there now. Their team can already see ${who(e)}'s details.`);
  broadcast(e);
  return e;
}

// DEMO ONLY — see AUTO_ACCEPT_SECONDS. Picks one of the hospitals still waiting, at random.
function demoAutoAccept(id) {
  const e = store.find('emergencies', id);
  if (!e || e.receivingHospitalId || !['SEARCHING', 'NO_ACCEPT_YET'].includes(e.status)) return;
  // Pick from the BEST-EQUIPPED hospitals asked (most of the needed services
  // declared), at random among equals — so a children's hospital never
  // "accepts" an adult when a better-equipped hospital was also asked, and the
  // demo does not show the same hospital every time.
  const needs = [...e.needs.required, ...e.needs.preferred];
  const pending = store.all('offers').filter((x) => x.emergencyId === id && x.status === 'pending')
    .map((o) => ({ o, score: needs.filter((s) => (store.find('hospitals', o.hospitalId)?.services || []).includes(s)).length }));
  const best = Math.max(...pending.map((x) => x.score));
  const top = pending.filter((x) => x.score === best);
  const o = top.length ? top[Math.floor(Math.random() * top.length)].o : null;
  if (!o) return;
  const h = store.find('hospitals', o.hospitalId);
  try { accept(o.id, h, { simulated: true }); } catch { /* someone accepted a moment earlier */ }
}

function decline(offerId, hospital, reasonId, note) {
  const o = ownOffer(offerId, hospital);
  if (o.status !== 'pending') throw new HttpError(409, 'CLOSED', 'this request is already closed');
  store.update('offers', o.id, { status: 'declined', declineReason: reasonId || 'other', declineNote: String(note || '').slice(0, 200), respondedAt: new Date().toISOString() });
  const e = store.find('emergencies', o.emergencyId);
  const why = (DECLINE_REASONS.find((d) => d.id === reasonId) || {}).label;
  log(e, 'offer_declined', { hospital: hospital.name, reason: reasonId || 'other' }, `${hospital.name} declined (${reasonId || 'other'}). Declining here means "send them somewhere better equipped" — it does not remove any duty to treat a patient who arrives.`,
    `${shortH(hospital.name)} can't take ${who(e)} right now${why ? ` (${why.replace(/ right now$/, '').toLowerCase()})` : ''}. Still asking the others.`);
  // if everyone asked in this round has answered no, move on now instead of waiting
  const roundOffers = store.all('offers').filter((x) => x.emergencyId === e.id && x.round === e.round);
  if (!e.receivingHospitalId && roundOffers.every((x) => x.status !== 'pending')) {
    clearTimers(e.id);
    onRoundTimeout(e.id, e.round);
  } else broadcast(e);
}

function hospitalCancel(emergencyId, hospital, reason) {
  let e = store.find('emergencies', emergencyId);
  if (!e || e.receivingHospitalId !== hospital.id || e.status !== 'ACCEPTED') throw new HttpError(409, 'NOT_YOURS', 'only the accepting hospital can hand a patient back');
  const o = store.all('offers').find((x) => x.emergencyId === e.id && x.hospitalId === hospital.id && x.status === 'accepted');
  if (o) store.update('offers', o.id, { status: 'cancelled', closedReason: reason || 'cannot take anymore' });
  e = save(e, { receivingHospitalId: null, status: 'SEARCHING', excludedHospitalIds: [...(e.excludedHospitalIds || []), hospital.id] });
  hub.publish(`hospital:${hospital.id}`, 'patient:released', { emergencyId: e.id, reason: 'you handed this patient back' });
  log(e, 'hospital_cancelled', { hospital: hospital.name, reason: reason || null }, `${hospital.name} can no longer take the patient. Asking the other hospitals again right away, without them.`,
    `${hospital.name} can no longer take ${who(e)}. Asking other hospitals again now.`);
  startRound(e.id, 1);
  return store.find('emergencies', e.id);
}

function arrived(emergencyId, hospital) {
  let e = store.find('emergencies', emergencyId);
  if (!e || e.receivingHospitalId !== hospital.id) throw new HttpError(409, 'NOT_YOURS', 'this patient is not coming to your hospital');
  clearTimers(e.id);
  e = save(e, { status: 'ARRIVED', arrivedAt: new Date().toISOString() });
  log(e, 'arrived', { hospital: hospital.name }, `${hospital.name} marked the patient as arrived. Case closed.`,
    `${hospital.name} says ${who(e)} has arrived.`);
  broadcast(e);
  return e;
}

function markSeen(emergencyId, hospital) {
  const e = store.find('emergencies', emergencyId);
  if (!e || e.receivingHospitalId !== hospital.id) throw new HttpError(409, 'NOT_YOURS', 'not your patient');
  log(e, 'hospital_seen', { hospital: hospital.name }, `${hospital.name} has seen the arrival alert.`,
    `${hospital.name} has seen that you're coming.`);
  return e;
}

// ---------------------------------------------------------------------------
// family actions
// ---------------------------------------------------------------------------
function divert(emergencyId, member, hospitalId) {
  let e = store.find('emergencies', emergencyId);
  if (!e || e.familyId !== member.familyId) throw new HttpError(404, 'NOT_FOUND', 'not found');
  if (!ACTIVE.includes(e.status)) throw new HttpError(409, 'CLOSED', 'this emergency is closed');
  const target = store.find('hospitals', hospitalId);
  if (!target) throw new HttpError(404, 'NOT_FOUND', 'hospital not found');

  clearTimers(e.id);
  if (e.receivingHospitalId && e.receivingHospitalId !== target.id) {
    const prev = store.all('offers').find((x) => x.emergencyId === e.id && x.hospitalId === e.receivingHospitalId && x.status === 'accepted');
    if (prev) store.update('offers', prev.id, { status: 'released', closedReason: 'family going elsewhere' });
    hub.publish(`hospital:${e.receivingHospitalId}`, 'patient:released', { emergencyId: e.id, reason: 'the family is going to a different hospital' });
  }
  releasePending(e, 'patient going to a different hospital');

  e = save(e, {
    status: 'DIVERTED',
    receivingHospitalId: target.joined ? target.id : null,
    divertedTo: { hospitalId: target.id, name: target.name, joined: !!target.joined, at: new Date().toISOString() },
    fallback: null,
  });
  if (target.joined) {
    hub.publish(`hospital:${target.id}`, 'arrival:incoming', { emergencyId: e.id, ref: e.id.slice(0, 6).toUpperCase(), urgency: e.urgency });
    log(e, 'divert', { to: target.name, joined: true }, `The family says the patient is going to ${target.name}. It is on GoldenBay, so it gets an arrival alert and the patient's details now.`,
      `You're going to ${target.name}. We've told them and sent ${who(e)}'s details.`);
  } else {
    log(e, 'divert', { to: target.name, joined: false }, `The family says the patient is going to ${target.name}. It is not on GoldenBay, so nothing can be sent ahead — the family's phone shows a "Show to doctor" screen instead.`,
      `You're going to ${target.name}. It isn't on GoldenBay, so show the doctor ${who(e)}'s details from your phone.`);
  }
  broadcast(e);
  return e;
}

function familyCancel(emergencyId, member) {
  let e = store.find('emergencies', emergencyId);
  if (!e || e.familyId !== member.familyId) throw new HttpError(404, 'NOT_FOUND', 'not found');
  clearTimers(e.id);
  releasePending(e, 'cancelled by the family');
  if (e.receivingHospitalId) hub.publish(`hospital:${e.receivingHospitalId}`, 'patient:released', { emergencyId: e.id, reason: 'cancelled by the family' });
  e = save(e, { status: 'CANCELLED' });
  log(e, 'cancelled', {}, 'The family cancelled this emergency.', 'You cancelled this. Hospitals have been told.');
  broadcast(e);
  return e;
}

function updateLocation(emergencyId, member, loc) {
  let e = store.find('emergencies', emergencyId);
  if (!e || e.familyId !== member.familyId) throw new HttpError(404, 'NOT_FOUND', 'not found');
  if (!ACTIVE.includes(e.status)) throw new HttpError(409, 'CLOSED', 'this emergency is closed');
  e = save(e, { liveLocation: { lat: loc.lat, lng: loc.lng, accuracy: loc.accuracy ?? null, at: new Date().toISOString() } });
  if (e.receivingHospitalId) {
    const h = store.find('hospitals', e.receivingHospitalId);
    hub.publish(`hospital:${h.id}`, 'patient:location', { emergencyId: e.id, distanceKm: round1(distanceKm(e.liveLocation, h)), at: e.liveLocation.at });
  }
  hub.publish(`share:${e.id}`, 'share:update', views.shareView(e));
  return e;
}

// After a restart, open searches get their round timer back.
function resumeOpenSearches() {
  for (const e of store.all('emergencies').filter((x) => x.status === 'SEARCHING' && x.round > 0 && !x.receivingHospitalId)) {
    addTimer(e.id, ROUND_SECONDS() * 1000, () => onRoundTimeout(e.id, e.round));
  }
}

module.exports = {
  startEmergency, accept, decline, hospitalCancel, arrived, markSeen,
  divert, familyCancel, updateLocation, resumeOpenSearches,
  _candidates: candidates, RADII_KM,
};
