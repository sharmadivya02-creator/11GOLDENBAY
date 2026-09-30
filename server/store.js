// store.js — GoldenBay's tiny "database".
//
// For the hackathon demo we persist everything to one JSON file on disk.
// This module is deliberately shaped like a real database layer (get/insert/update
// by collection), so later we can swap it for PostgreSQL without touching the
// rest of the code. That boundary is called a "data access layer".

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// In-memory copy of the whole database. Reads are instant; writes are
// flushed to disk shortly after (debounced) so rapid updates don't hammer the disk.
// Collections. families/members = who may see a family's data; offers = the
// requests sent to hospitals; accessLog = every time a hospital opened details.
const COLLECTIONS = ['families', 'members', 'profiles', 'emergencies', 'hospitals', 'offers', 'accessLog', 'labReports'];
let db = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
let saveTimer = null;

// ---------------------------------------------------------------------------
// ENCRYPTION AT REST
//
// If DATA_ENCRYPTION_KEY is set in .env, the database file is written encrypted
// (AES-256-GCM) instead of plain text. Someone who copies db.json off the disk
// gets ciphertext, not a list of people's allergies.
//
// If no key is set it stores plain text and says so loudly at startup — better
// an honest warning than a silent false sense of safety.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const MAGIC = 'GBENC1:';

function encKey() {
  const raw = (process.env.DATA_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  // any passphrase becomes a proper 32-byte key
  return crypto.createHash('sha256').update(raw).digest();
}

function encrypt(plaintext) {
  const key = encKey();
  if (!key) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return MAGIC + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(raw) {
  if (!raw.startsWith(MAGIC)) return raw;            // an older plain-text file
  const key = encKey();
  if (!key) throw new Error('db.json is encrypted but DATA_ENCRYPTION_KEY is not set');
  const buf = Buffer.from(raw.slice(MAGIC.length), 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(decrypt(fs.readFileSync(DB_FILE, 'utf8')));
    } catch (err) {
      console.error('[store] could not read db.json, starting fresh:', err.message);
    }
  }
  console.log(encKey()
    ? '[store] encryption at rest: ON'
    : '[store] encryption at rest: OFF — set DATA_ENCRYPTION_KEY in .env to turn it on');
  for (const key of COLLECTIONS) {
    if (!Array.isArray(db[key])) db[key] = [];
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_FILE, encrypt(JSON.stringify(db, null, 2)), (err) => {
      if (err) console.error('[store] failed to save db.json:', err.message);
    });
  }, 200);
}

// crypto.randomUUID gives us globally-unique, non-guessable IDs.
const { randomUUID } = require('crypto');

module.exports = {
  load,
  COLLECTIONS,

  all(collection) {
    return db[collection];
  },

  find(collection, id) {
    return db[collection].find((item) => item.id === id) || null;
  },

  insert(collection, item) {
    const record = { id: randomUUID(), createdAt: new Date().toISOString(), ...item };
    db[collection].push(record);
    scheduleSave();
    return record;
  },

  update(collection, id, changes) {
    const record = this.find(collection, id);
    if (!record) return null;
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    scheduleSave();
    return record;
  },

  remove(collection, id) {
    const i = db[collection].findIndex((item) => item.id === id);
    if (i === -1) return false;
    db[collection].splice(i, 1);
    scheduleSave();
    return true;
  },

  // Replace an entire collection (used by seeding).
  setAll(collection, items) {
    db[collection] = items;
    scheduleSave();
  },
};