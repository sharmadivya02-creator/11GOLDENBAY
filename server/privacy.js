// privacy.js — the parts of DPDP that are actually code.
//
// WHAT THIS FILE IS, AND IS NOT
//
//   It implements the obligations a developer can implement: notice, a recorded
//   consent, the right to get your data, the right to have it erased, and a
//   retention limit so nothing is kept forever.
//
//   It does NOT make GoldenBay "DPDP compliant". Compliance is a legal status.
//   It needs a named grievance officer, breach procedures, and an assessment of
//   the cross-border transfer that happens every time we call Gemini. Those are
//   not code problems and we do not pretend otherwise.

const store = require('./store');

// Bump this when the notice text changes — a consent given against an older
// notice is not consent to the new one.
const NOTICE_VERSION = '2026-09-1';

const PURPOSES = [
  { id: 'emergency', label: 'Emergency response',
    detail: 'So an ambulance and hospital can be chosen for you, and the hospital can prepare before you arrive.' },
  { id: 'profile', label: 'Keeping your health profile',
    detail: 'Allergies, medicines and conditions, so they are available in an emergency instead of in a folder at home.' },
  { id: 'labs', label: 'Reading lab reports',
    detail: 'To check the values on your reports and show how they have changed over time.' },
];

const RETENTION = {
  emergencies: 30,     // days — an emergency record is not needed after a month
  labReports: 1095,    // days (3 years) — your own results, kept until you delete them
};

// ---------------------------------------------------------------------------
// CONSENT — recorded against a specific version of the notice, with a timestamp
// ---------------------------------------------------------------------------
// consent.type says WHO agreed (fix #6):
//   'self'      the adult confirmed their own profile
//   'parental'  a parent/guardian declared it for a child (under 18)
//   'on-behalf' a relative added it; the adult has NOT confirmed it yet
// A parental declaration is NOT "verifiable consent" in the DPDP sense: the
// app cannot check that the person really is the parent. Said honestly below.
function recordConsent(profileId, { type, byMemberId, purposes } = {}) {
  const prev = store.find('profiles', profileId)?.consent || {};
  return store.update('profiles', profileId, {
    consent: {
      type: type || prev.type || 'on-behalf',
      byMemberId: byMemberId || prev.byMemberId || null,
      at: new Date().toISOString(),
      noticeVersion: NOTICE_VERSION,
      purposes: purposes && purposes.length ? purposes : PURPOSES.map((p) => p.id),
      withdrawnAt: null,
    },
  });
}

function withdrawConsent(profileId) {
  const prev = store.find('profiles', profileId)?.consent || {};
  return store.update('profiles', profileId, {
    consent: { ...prev, withdrawnAt: new Date().toISOString(), purposes: [] },
  });
}

function consentStatus(profile) {
  const c = profile?.consent;
  if (!c) return { ok: false, reason: 'never given' };
  if (c.withdrawnAt) return { ok: false, reason: 'withdrawn' };
  if (c.type === 'on-behalf') return { ok: false, reason: 'added by a relative; not yet confirmed by the person' };
  return { ok: true, type: c.type, at: c.at, purposes: c.purposes || PURPOSES.map((p) => p.id) };
}

// ---------------------------------------------------------------------------
// RIGHT TO ACCESS — everything we hold about one person, in one file
// ---------------------------------------------------------------------------
function exportEverything(profileId) {
  const profile = store.find('profiles', profileId);
  if (!profile) return null;

  const emergencies = store.all('emergencies').filter((e) => e.profileId === profileId);
  const labReports = store.all('labReports').filter((r) => r.profileId === profileId);
  const accessLog = store.all('accessLog').filter((a) => a.profileId === profileId);

  return {
    exportedAt: new Date().toISOString(),
    noticeVersion: NOTICE_VERSION,
    aboutThisFile:
      'Everything this GoldenBay demo holds about this person. ' +
      'Live video from the CPR coach is never stored, so it does not appear here.',
    profile,
    emergencies,
    labReports,
    whoViewedThisData: accessLog,
    counts: {
      emergencies: emergencies.length,
      labReports: labReports.length,
      documents: (profile.documents || []).length,
    },
  };
}

// ---------------------------------------------------------------------------
// RIGHT TO ERASURE — really gone, not flagged as deleted
// ---------------------------------------------------------------------------
function eraseEverything(profileId) {
  const profile = store.find('profiles', profileId);
  if (!profile) return null;

  const emergencies = store.all('emergencies').filter((e) => e.profileId === profileId);
  const labReports = store.all('labReports').filter((r) => r.profileId === profileId);

  for (const e of emergencies) {
    for (const o of store.all('offers').filter((x) => x.emergencyId === e.id)) store.remove('offers', o.id);
    store.remove('emergencies', e.id);
  }
  for (const a of store.all('accessLog').filter((x) => x.profileId === profileId)) store.remove('accessLog', a.id);
  for (const r of labReports) store.remove('labReports', r.id);
  store.remove('profiles', profileId);

  return {
    erasedAt: new Date().toISOString(),
    name: profile.fullName,
    removed: {
      profile: 1,
      emergencies: emergencies.length,
      labReports: labReports.length,
      documents: (profile.documents || []).length,
    },
  };
}

// ---------------------------------------------------------------------------
// RETENTION — nothing is kept forever. Runs on boot and hourly.
// ---------------------------------------------------------------------------
function purgeExpired() {
  const now = Date.now();
  const older = (item, days) => {
    const t = new Date(item.updatedAt || item.createdAt || 0).getTime();
    return t && (now - t) / 86400000 > days;
  };

  let emergencies = 0, labReports = 0;

  for (const e of [...store.all('emergencies')]) {
    if (older(e, RETENTION.emergencies)) { store.remove('emergencies', e.id); emergencies++; }
  }
  for (const r of [...store.all('labReports')]) {
    if (older(r, RETENTION.labReports)) { store.remove('labReports', r.id); labReports++; }
  }

  if (emergencies || labReports) {
    console.log(`[privacy] retention purge removed ${emergencies} emergencies, ${labReports} lab reports`);
  }
  return { emergencies, labReports, ranAt: new Date().toISOString() };
}

function startRetentionJob() {
  purgeExpired();
  setInterval(purgeExpired, 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// An honest status report. Note what it does NOT claim.
// ---------------------------------------------------------------------------
function status() {
  return {
    noticeVersion: NOTICE_VERSION,
    implemented: {
      notice: true,
      familyOnlyAccess: true,
      hospitalDetailsOnlyAfterAccept: true,
      whoViewedMyData: true,
      maskingBeforeAiAndHospitals: 'built-in rules (Presidio in Phase E)',
      consentRecorded: true,
      rightToAccess: true,
      rightToErasure: true,
      retentionLimits: RETENTION,
      encryptionAtRest: !!process.env.DATA_ENCRYPTION_KEY,
      videoNeverStored: true,
    },
    notImplemented: {
      grievanceOfficer: 'a named person is required — not code',
      breachNotification: 'an organisational process',
      crossBorderAssessment: 'AI calls send data to Google servers; this has not been assessed',
      childrensData: 'a parent\'s declaration is recorded, but the app cannot verify the person is really the parent (not "verifiable consent")',
      independentAudit: 'none',
    },
    claim: 'Designed to the DPDP Act 2023 and Rules 2025 (main duties phase in by 2027). NOT compliant, NOT certified. All demo data is synthetic.',
  };
}

module.exports = {
  NOTICE_VERSION, PURPOSES, RETENTION,
  recordConsent, withdrawConsent, consentStatus,
  exportEverything, eraseEverything,
  purgeExpired, startRetentionJob, status,
};