// auth.js — who is allowed to see what.
//
// FAMILIES: a family group has a join code. Each phone that joins gets its own
// secret token (only a hash of it is stored). Every profile and emergency
// belongs to one family; only that family's phones can read them.
//
// HOSPITALS (demo): staff pick their hospital and type ONE shared PIN.
// This is NOT real security and is labelled "Demo login" everywhere. The real
// version needs verified hospitals and a login per staff member.

const crypto = require('crypto');
const store = require('./store');
const { HttpError } = require('./http');

const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newToken = () => crypto.randomBytes(24).toString('base64url');

// ---- simple brute-force brake: max N attempts per IP per 10 minutes --------
const attempts = new Map();
function brake(key, max = 20) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 600_000);
  list.push(now);
  attempts.set(key, list);
  if (list.length > max) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'too many attempts — wait a few minutes');
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------
function newJoinCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // no 0/O/1/I confusion
  const pick = (n) => Array.from(crypto.randomBytes(n), (b) => A[b % A.length]).join('');
  return `GB-${pick(4)}-${pick(4)}`;
}

function addMember(familyId, label) {
  const token = newToken();
  const member = store.insert('members', { familyId, tokenHash: sha(token), label: String(label || 'Family phone').slice(0, 40), profileId: null });
  return { member, token };
}

function createFamily(name, memberLabel) {
  const family = store.insert('families', { name: String(name || 'My family').slice(0, 60), joinCode: newJoinCode() });
  return { family, ...addMember(family.id, memberLabel) };
}

function joinFamily(joinCode, memberLabel, ip) {
  brake(`join:${ip}`);
  const code = String(joinCode || '').trim().toUpperCase();
  const family = store.all('families').find((f) => f.joinCode === code);
  if (!family) throw new HttpError(404, 'NO_SUCH_FAMILY', 'join code not found');
  return { family, ...addMember(family.id, memberLabel) };
}

function requireFamily(req) {
  const token = req.headers['x-family-token'];
  if (!token) throw new HttpError(401, 'NOT_SIGNED_IN', 'family sign-in required');
  const member = store.all('members').find((m) => m.tokenHash === sha(token));
  if (!member) throw new HttpError(401, 'NOT_SIGNED_IN', 'family sign-in required');
  return member;
}

// A record is readable only by its own family. Unknown and not-yours look the
// same (404), so ids cannot be probed.
function ownRecord(collection, id, member) {
  const rec = store.find(collection, id);
  if (!rec || rec.familyId !== member.familyId) throw new HttpError(404, 'NOT_FOUND', 'not found');
  return rec;
}

// ---------------------------------------------------------------------------
// Hospitals (demo login)
// ---------------------------------------------------------------------------
const DEMO_PIN = () => String(process.env.HOSPITAL_DEMO_PIN || '2468');
const sessions = new Map();          // token -> { hospitalId, at }
const SESSION_MS = 12 * 60 * 60 * 1000;

function loginHospital(hospitalId, pin, ip) {
  brake(`hlogin:${ip}`, 30);
  const h = store.find('hospitals', hospitalId);
  if (!h || !h.joined) throw new HttpError(404, 'NOT_A_MEMBER_HOSPITAL', 'this hospital is not on GoldenBay');
  if (String(pin) !== DEMO_PIN()) throw new HttpError(401, 'WRONG_PIN', 'wrong PIN');
  const token = newToken();
  sessions.set(token, { hospitalId: h.id, at: Date.now() });
  return { token, hospital: h };
}

function requireHospital(req) {
  const token = req.headers['x-hospital-token'];
  const s = token && sessions.get(token);
  if (!s || Date.now() - s.at > SESSION_MS) throw new HttpError(401, 'NOT_SIGNED_IN', 'hospital sign-in required');
  const hospital = store.find('hospitals', s.hospitalId);
  if (!hospital) throw new HttpError(401, 'NOT_SIGNED_IN', 'hospital sign-in required');
  return hospital;
}

module.exports = {
  createFamily, joinFamily, requireFamily, ownRecord, addMember,
  loginHospital, requireHospital, newToken, sha,
};
