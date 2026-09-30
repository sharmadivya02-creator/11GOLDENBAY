// seed.js — demo data, loaded on every boot.
//
// EVERYTHING here is fictional. Hospital names are invented so the demo never
// makes claims about a real institution. On stage these hospitals stand in for
// "pilot partner hospitals" — and you say so out loud.
//
// Every demo phone number is the one Divya chose for the demo: 9170040198.

const store = require('./store');

const DEMO_CENTER = { lat: 28.6139, lng: 77.209 }; // New Delhi
const DEMO_PHONE = '+91 91700 40198';               // chosen by Divya for the demo

// joined: true  = this hospital uses the Hospital App (fictional pilot partner)
// joined: false = only "listed" (stands in for the government Hospital Directory);
//                 GoldenBay cannot ask it anything — the family gets a call button.
// services = what the hospital DECLARED about itself. Never verified by us.
const HOSPITALS = [
  { id: 'hosp-1', name: 'Sunrise Multispeciality Hospital', lat: 28.6318, lng: 77.2205, type: 'private',    schemes: ['pmjay'], services: ['emergency', 'cardiac', 'cathlab', 'icu', 'trauma', 'stroke'] },
  { id: 'hosp-2', name: 'Yamuna Valley Institute of Medical Sciences', lat: 28.5955, lng: 77.244, type: 'government', schemes: ['pmjay'], services: ['emergency', 'trauma', 'orthopedic', 'icu', 'burns'] },
  { id: 'hosp-3', name: 'Lotus Heart Centre', lat: 28.5672, lng: 77.21, type: 'private',    schemes: [],        services: ['emergency', 'cardiac', 'cathlab', 'icu'] },
  { id: 'hosp-4', name: 'Ashoka General Hospital', lat: 28.6448, lng: 77.1734, type: 'government', schemes: ['pmjay'], services: ['emergency', 'pediatric', 'maternity'] },
  { id: 'hosp-5', name: 'Silverline Neuro & Stroke Institute', lat: 28.588, lng: 77.166, type: 'private',    schemes: ['pmjay'], services: ['emergency', 'stroke', 'neuro', 'icu'] },
  { id: 'hosp-6', name: "Greenfield Children's Hospital", lat: 28.653, lng: 77.231, type: 'private',    schemes: [],        services: ['emergency', 'pediatric'] },
  // ~13 km out: only reached when the agent widens the search to 20 km
  { id: 'hosp-7', name: 'Riverbend Heart & Trauma Hospital', lat: 28.7439, lng: 77.209, type: 'government', schemes: ['pmjay'], services: ['emergency', 'cardiac', 'cathlab', 'trauma', 'icu', 'orthopedic'] },
  // listed only — not on GoldenBay
  { id: 'hosp-8', name: 'Kalindi District Hospital', lat: 28.63, lng: 77.19, type: 'government', schemes: [], services: [], joined: false },
  { id: 'hosp-9', name: 'Meadowbrook Nursing Home', lat: 28.6, lng: 77.23, type: 'private', schemes: [], services: [], joined: false },
].map((h) => ({
  joined: true, unavailable: false, unavailableReason: null,
  phone: DEMO_PHONE, ...h, isDemo: true,
}));

// Plain placeholder "photos" of documents (clearly marked synthetic).
function demoDoc(id, category, title, subtitle, bg, fg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="380">
    <rect width="600" height="380" rx="18" fill="${bg}"/>
    <rect x="24" y="24" width="552" height="332" rx="12" fill="none" stroke="${fg}" stroke-opacity="0.35" stroke-width="2" stroke-dasharray="6 8"/>
    <text x="48" y="90" font-family="Arial, sans-serif" font-size="30" font-weight="700" fill="${fg}">${title}</text>
    <text x="48" y="122" font-family="Arial, sans-serif" font-size="16" fill="${fg}" fill-opacity="0.75">${subtitle}</text>
    ${[1, 2, 3, 4].map((i) => `<rect x="48" y="${150 + i * 34}" width="${i % 2 ? 420 : 320}" height="10" rx="5" fill="${fg}" fill-opacity="0.18"/>`).join('')}
    <text x="48" y="352" font-family="Arial, sans-serif" font-size="12" fill="${fg}" fill-opacity="0.5">SYNTHETIC DEMO DOCUMENT — not a real record</text>
  </svg>`;
  return { id, category, name: title, mimeType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg) };
}

const DEMO_FAMILY = { id: 'fam-sharma', name: 'Sharma family (DEMO)', joinCode: 'SHARMA-DEMO', isDemo: true };

// consent.type: 'self' = the adult confirmed their own profile;
//               'parental' = a parent/guardian declared it for a child;
//               'on-behalf' = added by a relative, NOT yet confirmed by the person.
// medicalUpdatedAt drives the "last updated" label hospitals see (fix #4).
const DEMO_PROFILES = [
  {
    id: 'demo-rajesh', fullName: 'Rajesh Sharma (DEMO)', relation: 'Husband', age: 55, sex: 'M', bloodGroup: 'B+',
    allergies: ['Sulfa drugs', 'Shellfish'], medications: ['Statins — daily', 'Ace inhibitors — daily'],
    conditions: ['Hypertension', 'Pre-diabetes'], pastEvents: [],
    insurance: 'Star Health', preferredHospital: null, costPreference: 'private-insurance',
    emergencyContacts: [{ name: 'Aisha', relation: 'Wife', phone: DEMO_PHONE }],
    consent: { type: 'self', at: '2026-08-03T10:00:00.000Z' }, medicalUpdatedAt: '2026-08-03T10:00:00.000Z',
    documents: [
      demoDoc('doc-demo-1', 'insurance', 'Policy card (DEMO)', 'Star Health · Member ID DEMO-8821', '#eaf1fb', '#3a6fb0'),
      demoDoc('doc-demo-2', 'prescription', 'Prescription (DEMO)', 'Statins + Ace inhibitors — daily', '#fbe9ec', '#7c0d20'),
    ],
  },
  {
    id: 'demo-aisha', fullName: 'Aisha Sharma (DEMO)', relation: 'Wife', age: 51, sex: 'F', bloodGroup: 'O+',
    allergies: ['Penicillin'], medications: ['Levothyroxine 50mcg — daily, morning'],
    conditions: ['Mild hypothyroidism'], pastEvents: ['Appendectomy, 2011'],
    insurance: 'Star Health', preferredHospital: null, costPreference: 'private-insurance',
    emergencyContacts: [{ name: 'Rajesh', relation: 'Husband', phone: DEMO_PHONE }],
    consent: { type: 'self', at: '2026-09-10T10:00:00.000Z' }, medicalUpdatedAt: '2026-09-10T10:00:00.000Z',
    documents: [demoDoc('doc-demo-5', 'prescription', 'Prescription (DEMO)', 'Levothyroxine 50mcg — daily, morning', '#fbe9ec', '#7c0d20')],
  },
  {
    id: 'demo-mridula', fullName: 'Mridula Sharma (DEMO)', relation: 'Mother', age: 79, sex: 'F', bloodGroup: 'A+',
    allergies: ['Aspirin'], medications: ['Calcium supplement — daily', 'Alendronate — weekly, Sunday morning'],
    conditions: ['Osteoporosis', 'Mild hearing loss'], pastEvents: ['Hip fracture, 2022'],
    insurance: null, preferredHospital: null, costPreference: 'pmjay',
    emergencyContacts: [{ name: 'Rajesh', relation: 'Son', phone: DEMO_PHONE }],
    // added by her son; she has not confirmed it herself yet — shown honestly
    consent: { type: 'on-behalf', at: '2025-11-20T10:00:00.000Z' }, medicalUpdatedAt: '2025-11-20T10:00:00.000Z',
    documents: [],
  },
  {
    id: 'demo-rohan', fullName: 'Rohan Sharma (DEMO)', relation: 'Son', age: 8, sex: 'M', bloodGroup: 'B+',
    allergies: ['Peanuts'], medications: ['Salbutamol inhaler — as needed for asthma'],
    conditions: ['Mild asthma'], pastEvents: ['Hospitalised for bronchitis, 2023'],
    insurance: 'Star Health', preferredHospital: null, costPreference: 'private-insurance',
    emergencyContacts: [{ name: 'Aisha', relation: 'Mother', phone: DEMO_PHONE }],
    consent: { type: 'parental', at: '2026-06-15T10:00:00.000Z' }, medicalUpdatedAt: '2026-06-15T10:00:00.000Z',
    documents: [],
  },
].map((p) => ({ ...p, familyId: DEMO_FAMILY.id, isDemo: true }));

// Every boot re-syncs demo records to what is written above, so a redeploy
// always shows the current demo data (Render's free tier wipes files anyway).
function upsert(collection, item) {
  if (store.find(collection, item.id)) store.update(collection, item.id, item);
  else store.insert(collection, item);
}

function seed() {
  HOSPITALS.forEach((h) => {
    const existing = store.find('hospitals', h.id);
    // keep what a hospital changed about itself during a demo (services, unavailable)
    if (existing) return;
    store.insert('hospitals', h);
  });
  upsert('families', DEMO_FAMILY);
  DEMO_PROFILES.forEach((p) => upsert('profiles', p));
  console.log(`[seed] ${HOSPITALS.length} fictional hospitals (${HOSPITALS.filter((h) => h.joined).length} joined), demo family with ${DEMO_PROFILES.length} profiles`);
}

module.exports = { seed, DEMO_CENTER, DEMO_FAMILY, HOSPITALS };