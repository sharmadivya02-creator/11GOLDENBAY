// lab-reference.js — the ground truth the AI gets checked against.
//
// THIS FILE IS THE POINT OF THE WHOLE FEATURE.
//
// Gemini reads a lab report and tells us what it saw. We do not believe it.
// Every value it claims gets checked against the tables below: is that a real
// test, is the unit right for it, is the number physically possible, does the
// range printed on the report match what we know the range to be.
//
// That is the difference between "an AI read my report" and "an AI read my
// report and here is how sure we are, and why".

// ---------------------------------------------------------------------------
// 1) Reference ranges — the common Indian panels
//    aliases: labs name the same test half a dozen ways
//    critical: past this, it is not "abnormal", it is "see a doctor today"
// ---------------------------------------------------------------------------

const TESTS = [
  // ---- Kidney (KFT / RFT) ----
  { key: 'creatinine', name: 'Creatinine',
    aliases: ['s. creatinine', 'sr creatinine', 'serum creatinine', 'creat', 's creatinine'],
    unit: 'mg/dL', altUnits: ['mg/dl', 'mgdl'],
    range: { male: [0.7, 1.3], female: [0.6, 1.1] },
    possible: [0.1, 20], criticalHigh: 2.0,
    means: 'how well the kidneys are filtering' },

  { key: 'urea', name: 'Blood Urea',
    aliases: ['urea', 'b. urea', 'blood urea'],
    unit: 'mg/dL', altUnits: ['mg/dl'],
    range: { all: [15, 40] }, possible: [2, 300], criticalHigh: 100,
    means: 'a waste product the kidneys clear' },

  { key: 'egfr', name: 'eGFR',
    aliases: ['gfr', 'estimated gfr', 'e-gfr'],
    unit: 'mL/min/1.73m2', altUnits: ['ml/min', 'ml/min/1.73m²'],
    range: { all: [90, 200] }, possible: [1, 200], criticalLow: 30,
    means: 'overall kidney function score' },

  { key: 'uric_acid', name: 'Uric Acid',
    aliases: ['s. uric acid', 'serum uric acid'],
    unit: 'mg/dL', altUnits: ['mg/dl'],
    range: { male: [3.4, 7.0], female: [2.4, 6.0] }, possible: [0.5, 25], criticalHigh: 12,
    means: 'linked to gout and kidney stones' },

  // ---- Liver (LFT) ----
  { key: 'alt', name: 'ALT (SGPT)',
    aliases: ['sgpt', 'alt', 'alt (sgpt)', 'sgpt (alt)', 'alanine aminotransferase'],
    unit: 'U/L', altUnits: ['iu/l', 'u/l'],
    range: { male: [0, 50], female: [0, 35] }, possible: [1, 5000], criticalHigh: 200,
    means: 'liver stress or damage' },

  { key: 'ast', name: 'AST (SGOT)',
    aliases: ['sgot', 'ast', 'ast (sgot)', 'sgot (ast)', 'aspartate aminotransferase'],
    unit: 'U/L', altUnits: ['iu/l'],
    range: { male: [0, 40], female: [0, 32] }, possible: [1, 5000], criticalHigh: 200,
    means: 'liver stress or damage' },

  { key: 'alp', name: 'Alkaline Phosphatase',
    aliases: ['alp', 'alk phos', 'alkaline phosphatase'],
    unit: 'U/L', altUnits: ['iu/l'],
    range: { all: [40, 130] }, possible: [5, 2000], criticalHigh: 400,
    means: 'liver and bone' },

  { key: 'bilirubin_total', name: 'Total Bilirubin',
    aliases: ['t. bilirubin', 'total bilirubin', 'bilirubin total', 'bilirubin (total)'],
    unit: 'mg/dL', altUnits: ['mg/dl'],
    range: { all: [0.2, 1.2] }, possible: [0.05, 50], criticalHigh: 3,
    means: 'jaundice marker' },

  { key: 'albumin', name: 'Albumin',
    aliases: ['s. albumin', 'serum albumin'],
    unit: 'g/dL', altUnits: ['g/dl', 'gm/dl'],
    range: { all: [3.5, 5.2] }, possible: [0.5, 8], criticalLow: 2.0,
    means: 'protein the liver makes' },

  // ---- Sugar ----
  { key: 'glucose_fasting', name: 'Fasting Blood Sugar',
    aliases: ['fbs', 'fasting glucose', 'glucose fasting', 'blood sugar fasting', 'fasting blood glucose'],
    unit: 'mg/dL', altUnits: ['mg/dl'],
    range: { all: [70, 99] }, possible: [20, 800], criticalHigh: 250, criticalLow: 55,
    means: 'blood sugar after not eating' },

  { key: 'glucose_pp', name: 'Post-Prandial Blood Sugar',
    aliases: ['ppbs', 'pp glucose', 'post prandial', 'glucose pp', 'blood sugar pp'],
    unit: 'mg/dL', altUnits: ['mg/dl'],
    range: { all: [70, 140] }, possible: [20, 900], criticalHigh: 300,
    means: 'blood sugar two hours after eating' },

  { key: 'hba1c', name: 'HbA1c',
    aliases: ['hba1c', 'glycated haemoglobin', 'glycosylated hemoglobin', 'a1c'],
    unit: '%', altUnits: ['percent'],
    range: { all: [4.0, 5.6] }, possible: [2, 20], criticalHigh: 9.0,
    means: 'average blood sugar over three months' },

  // ---- Lipids ----
  { key: 'cholesterol_total', name: 'Total Cholesterol',
    aliases: ['total cholesterol', 'cholesterol total', 's. cholesterol', 'cholesterol'],
    unit: 'mg/dL', altUnits: ['mg/dl'],
    range: { all: [0, 200] }, possible: [50, 800], criticalHigh: 300,
    means: 'total fat in the blood' },

  { key: 'ldl', name: 'LDL Cholesterol',
    aliases: ['ldl', 'ldl cholesterol', 'ldl-c'],
    unit: 'mg/dL', altUnits: ['mg/dl'],
    range: { all: [0, 100] }, possible: [10, 600], criticalHigh: 190,
    means: 'the cholesterol that clogs arteries' },

  { key: 'hdl', name: 'HDL Cholesterol',
    aliases: ['hdl', 'hdl cholesterol', 'hdl-c'],
    unit: 'mg/dL', altUnits: ['mg/dl'],
    range: { male: [40, 90], female: [50, 95] }, possible: [5, 150], criticalLow: 25,
    means: 'the protective cholesterol' },

  { key: 'triglycerides', name: 'Triglycerides',
    aliases: ['tg', 'triglyceride', 's. triglycerides'],
    unit: 'mg/dL', altUnits: ['mg/dl'],
    range: { all: [0, 150] }, possible: [20, 3000], criticalHigh: 500,
    means: 'another blood fat' },

  // ---- Blood count (CBC) ----
  { key: 'haemoglobin', name: 'Haemoglobin',
    aliases: ['hb', 'hgb', 'hemoglobin', 'haemoglobin'],
    unit: 'g/dL', altUnits: ['g/dl', 'gm/dl', 'gm%'],
    range: { male: [13.0, 17.0], female: [12.0, 15.0] },
    possible: [2, 25], criticalLow: 7.0,
    means: 'oxygen-carrying capacity of the blood' },

  { key: 'wbc', name: 'WBC Count',
    aliases: ['tlc', 'total leucocyte count', 'wbc', 'white blood cells', 'total wbc'],
    unit: 'cells/cumm', altUnits: ['/cumm', 'cells/µl', '10^3/µl', 'thousand/cumm'],
    range: { all: [4000, 11000] }, possible: [200, 200000],
    criticalHigh: 30000, criticalLow: 2000,
    means: 'infection-fighting cells' },

  { key: 'platelets', name: 'Platelet Count',
    aliases: ['platelet', 'plt', 'platelet count'],
    unit: 'cells/cumm', altUnits: ['/cumm', 'lakhs/cumm', '10^3/µl'],
    range: { all: [150000, 410000] }, possible: [5000, 1500000],
    criticalLow: 50000,
    means: 'clotting cells — low means bleeding risk' },

  // ---- Thyroid ----
  { key: 'tsh', name: 'TSH',
    aliases: ['tsh', 'thyroid stimulating hormone', 's. tsh'],
    unit: 'µIU/mL', altUnits: ['uiu/ml', 'miu/l', 'µiu/ml'],
    range: { all: [0.4, 4.5] }, possible: [0.005, 200], criticalHigh: 20,
    means: 'thyroid control hormone' },

  { key: 't3', name: 'T3',
    aliases: ['t3', 'total t3', 'triiodothyronine'],
    unit: 'ng/dL', altUnits: ['ng/dl'],
    range: { all: [80, 200] }, possible: [10, 800],
    means: 'thyroid hormone' },

  { key: 't4', name: 'T4',
    aliases: ['t4', 'total t4', 'thyroxine'],
    unit: 'µg/dL', altUnits: ['ug/dl', 'µg/dl'],
    range: { all: [5.0, 12.0] }, possible: [0.5, 40],
    means: 'thyroid hormone' },

  // ---- Electrolytes ----
  { key: 'sodium', name: 'Sodium',
    aliases: ['na', 'na+', 's. sodium', 'serum sodium'],
    unit: 'mEq/L', altUnits: ['mmol/l', 'meq/l'],
    range: { all: [135, 145] }, possible: [90, 200],
    criticalLow: 125, criticalHigh: 155,
    means: 'salt balance' },

  { key: 'potassium', name: 'Potassium',
    aliases: ['k', 'k+', 's. potassium', 'serum potassium'],
    unit: 'mEq/L', altUnits: ['mmol/l', 'meq/l'],
    range: { all: [3.5, 5.1] }, possible: [1, 10],
    criticalLow: 2.8, criticalHigh: 6.0,
    means: 'affects the heart rhythm directly' },

  { key: 'calcium', name: 'Calcium',
    aliases: ['ca', 's. calcium', 'serum calcium', 'total calcium'],
    unit: 'mg/dL', altUnits: ['mg/dl'],
    range: { all: [8.6, 10.3] }, possible: [3, 20],
    criticalLow: 7.0, criticalHigh: 13,
    means: 'bones, nerves and muscle' },

  // ---- Other common ones ----
  { key: 'vitamin_d', name: 'Vitamin D',
    aliases: ['vit d', '25-oh vitamin d', 'vitamin d3', '25 hydroxy vitamin d'],
    unit: 'ng/mL', altUnits: ['ng/ml'],
    range: { all: [30, 100] }, possible: [1, 200], criticalLow: 10,
    means: 'very commonly low in India' },

  { key: 'vitamin_b12', name: 'Vitamin B12',
    aliases: ['b12', 'vit b12', 'cobalamin'],
    unit: 'pg/mL', altUnits: ['pg/ml'],
    range: { all: [200, 900] }, possible: [30, 3000], criticalLow: 100,
    means: 'nerve and blood health' },

  { key: 'crp', name: 'CRP',
    aliases: ['crp', 'c-reactive protein', 'hs-crp'],
    unit: 'mg/L', altUnits: ['mg/l'],
    range: { all: [0, 5] }, possible: [0, 500], criticalHigh: 100,
    means: 'inflammation anywhere in the body' },

  { key: 'inr', name: 'INR',
    aliases: ['inr', 'pt inr', 'prothrombin inr'],
    unit: 'ratio', altUnits: [''],
    range: { all: [0.8, 1.2] }, possible: [0.4, 12], criticalHigh: 4.5,
    means: 'how fast blood clots' },
];

// Fast lookup by any name a lab might print
const BY_ALIAS = new Map();
for (const t of TESTS) {
  BY_ALIAS.set(t.name.toLowerCase(), t);
  BY_ALIAS.set(t.key, t);
  for (const a of t.aliases) BY_ALIAS.set(a.toLowerCase(), t);
}

function findTest(name) {
  if (!name) return null;
  const clean = String(name).toLowerCase().trim()
    .replace(/[():]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (BY_ALIAS.has(clean)) return BY_ALIAS.get(clean);
  // try each word group — labs write "Serum Creatinine - Enzymatic"
  for (const [alias, test] of BY_ALIAS) {
    if (alias.length > 3 && clean.includes(alias)) return test;
  }
  return null;
}

function normalRange(test, sex) {
  if (!test) return null;
  const r = test.range;
  if (r.all) return r.all;
  const s = String(sex || '').toLowerCase();
  if (s.startsWith('f')) return r.female;
  if (s.startsWith('m')) return r.male;
  return r.male; // no sex recorded — use the wider adult range
}

// ---------------------------------------------------------------------------
// 2) Drug ↔ test rules. THIS is where "your number is high" becomes
//    "your number is high AND you take something that makes that dangerous".
//    All well-established, none invented.
// ---------------------------------------------------------------------------

const DRUG_RULES = [
  { drugs: ['metformin'], test: 'creatinine', when: 'high',
    risk: 'Metformin is cleared by the kidneys. Rising creatinine means it can build up.',
    action: 'Kidney function needs review before the next prescription.' },

  { drugs: ['metformin'], test: 'egfr', when: 'low',
    risk: 'Metformin is not safe when kidney function drops this far.',
    action: 'Dose review needed.' },

  { drugs: ['statin', 'atorvastatin', 'rosuvastatin', 'simvastatin'], test: 'alt', when: 'high',
    risk: 'Statins can raise liver enzymes.',
    action: 'Liver panel should be rechecked.' },

  { drugs: ['statin', 'atorvastatin', 'rosuvastatin', 'simvastatin'], test: 'ast', when: 'high',
    risk: 'Statins can raise liver enzymes.',
    action: 'Liver panel should be rechecked.' },

  { drugs: ['warfarin', 'acitrom', 'acenocoumarol'], test: 'inr', when: 'high',
    risk: 'INR above range on a blood thinner means a real bleeding risk.',
    action: 'Urgent — dose needs adjusting.' },

  { drugs: ['warfarin', 'acitrom', 'acenocoumarol'], test: 'inr', when: 'low',
    risk: 'INR below range means the blood thinner is not protecting against clots.',
    action: 'Dose review needed.' },

  { drugs: ['ace inhibitor', 'ramipril', 'enalapril', 'lisinopril', 'telmisartan', 'losartan'],
    test: 'potassium', when: 'high',
    risk: 'These medicines raise potassium, and high potassium affects the heart rhythm.',
    action: 'Needs a doctor promptly.' },

  { drugs: ['ace inhibitor', 'ramipril', 'enalapril', 'lisinopril', 'telmisartan', 'losartan'],
    test: 'creatinine', when: 'high',
    risk: 'These medicines can affect kidney function.',
    action: 'Kidney function should be rechecked.' },

  { drugs: ['diuretic', 'furosemide', 'lasix', 'hydrochlorothiazide', 'torsemide'],
    test: 'potassium', when: 'low',
    risk: 'Water tablets flush out potassium. Low potassium is commonly missed.',
    action: 'Needs review — potassium may need replacing.' },

  { drugs: ['diuretic', 'furosemide', 'lasix', 'hydrochlorothiazide', 'torsemide'],
    test: 'sodium', when: 'low',
    risk: 'Water tablets can drop sodium, which causes confusion and falls in older people.',
    action: 'Needs review.' },

  { drugs: ['aspirin', 'ecosprin', 'clopidogrel', 'ticagrelor'], test: 'haemoglobin', when: 'low',
    risk: 'On a blood thinner, falling haemoglobin can mean bleeding somewhere.',
    action: 'Should be investigated, not ignored.' },

  { drugs: ['aspirin', 'ecosprin', 'clopidogrel', 'ticagrelor'], test: 'platelets', when: 'low',
    risk: 'Low platelets plus a blood thinner is a compounded bleeding risk.',
    action: 'Needs a doctor.' },

  { drugs: ['thyroxine', 'eltroxin', 'levothyroxine', 'thyronorm'], test: 'tsh', when: 'high',
    risk: 'TSH still high means the thyroid dose is not yet enough.',
    action: 'Dose review.' },

  { drugs: ['thyroxine', 'eltroxin', 'levothyroxine', 'thyronorm'], test: 'tsh', when: 'low',
    risk: 'TSH pushed too low suggests the thyroid dose is too high.',
    action: 'Dose review.' },

  { drugs: ['insulin', 'glimepiride', 'gliclazide', 'glipizide'], test: 'glucose_fasting', when: 'low',
    risk: 'Low fasting sugar on diabetes medication is dangerous, especially overnight.',
    action: 'Dose review needed.' },
];

function drugRulesFor(testKey, direction, medications) {
  const meds = (medications || []).join(' ').toLowerCase();
  return DRUG_RULES.filter(
    (r) => r.test === testKey && r.when === direction && r.drugs.some((d) => meds.includes(d))
  );
}

module.exports = { TESTS, findTest, normalRange, DRUG_RULES, drugRulesFor };