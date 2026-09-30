// labs.js — the Lab Report Agent.
//
// THE IDEA IN ONE LINE:
//   Gemini reads the report. We do not believe it. Every number it claims is
//   checked against real tables before a human ever sees it, and each one
//   carries its own confidence and the reason for that confidence.
//
// THE THREE CONFIDENCES (never mixed):
//   1. Did we READ it right?        → the gauntlet below. Can be very high.
//   2. Is it ABNORMAL?              → a table lookup. No AI involved. Certain.
//   3. Does it MATTER for you?      → reasoning. Lowest. Always "ask a doctor".
//
// The AI never decides anything. It reads, and it explains what the tables found.

const ref = require('./lab-reference');
const ai = require('./ai');

// ---------------------------------------------------------------------------
// What we ask Gemini for. Note: we ask for the range PRINTED ON THE REPORT too,
// because that gives us a free second opinion we can check its reading against.
// ---------------------------------------------------------------------------
const LAB_PROMPT = `You are reading a photograph or scan of a medical laboratory report, for a system that will VERIFY everything you say against reference tables.

Read ONLY what is actually printed. Never guess a number. If a row is blurred, say so instead of inventing a value — being honest about what you cannot read is more useful than being confident and wrong.

Return JSON exactly in this shape:
{
  "isLabReport": true|false,
  "documentType": string,              // what this document actually is, e.g. "pathology lab report", "electricity bill", "prescription", "selfie"
  "patientName": string|null,          // the name printed on the report
  "reportDate": string|null,           // ISO date YYYY-MM-DD if you can read it
  "labName": string|null,
  "values": [
    {
      "testName": string,              // exactly as printed, e.g. "S. Creatinine"
      "value": number|null,            // the numeric result; null if unreadable
      "unit": string|null,             // exactly as printed, e.g. "mg/dL"
      "printedRange": string|null,     // the normal range printed beside it, e.g. "0.7 - 1.3"
      "legible": "clear"|"partial"|"unreadable"
    }
  ],
  "unreadableSections": string[]       // parts of the page you could not read at all
}`;

function mockLabExtraction() {
  return {
    isLabReport: true,
    documentType: 'pathology lab report (mock)',
    patientName: null,
    reportDate: null,
    labName: null,
    values: [
      { testName: 'S. Creatinine', value: 1.8, unit: 'mg/dL', printedRange: '0.7 - 1.3', legible: 'clear' },
      { testName: 'Blood Urea', value: 46, unit: 'mg/dL', printedRange: '15 - 40', legible: 'clear' },
      { testName: 'HbA1c', value: 7.4, unit: '%', printedRange: '4.0 - 5.6', legible: 'clear' },
      { testName: 'Haemoglobin', value: 12.1, unit: 'g/dL', printedRange: '13.0 - 17.0', legible: 'clear' },
      { testName: 'Potassium', value: 5.4, unit: 'mEq/L', printedRange: '3.5 - 5.1', legible: 'partial' },
      { testName: 'S. Creatnine', value: 9.9, unit: 'kg', printedRange: null, legible: 'partial' },
    ],
    unreadableSections: ['bottom-left block (smudged)'],
    _source: 'mock',
  };
}

async function extractReport(base64, mimeType) {
  // ai.js already falls back to mock on any failure, but it does not know about
  // this prompt, so we call the underlying path through a tiny shim.
  return ai.readLabReport
    ? ai.readLabReport(base64, mimeType, LAB_PROMPT)
    : mockLabExtraction();
}

// ---------------------------------------------------------------------------
// THE GAUNTLET — six checks, each one verifiable, none of them an opinion.
// ---------------------------------------------------------------------------

const PENALTY = {
  unitWrong: 30,
  impossible: 40,
  readsDisagree: 35,
  printedRangeMismatch: 25,
  imageUnclear: 20,
};

function parsePrintedRange(text) {
  if (!text) return null;
  const m = String(text).match(/(-?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2])];
}

function unitMatches(test, claimedUnit) {
  if (!claimedUnit) return null; // nothing to check
  const u = String(claimedUnit).toLowerCase().replace(/\s/g, '');
  const ok = [test.unit, ...(test.altUnits || [])]
    .map((x) => String(x).toLowerCase().replace(/\s/g, ''))
    .filter(Boolean);
  return ok.some((x) => x === u || u.includes(x) || x.includes(u));
}

// Runs one claimed value through every check and returns a verdict a human can read.
function verifyValue(claim, profile, secondRead) {
  const checks = [];
  let score = 100;

  // CHECK 1 — is this even a real test?
  const test = ref.findTest(claim.testName);
  if (!test) {
    return {
      testName: claim.testName,
      value: claim.value,
      unit: claim.unit,
      verdict: 'unknown-test',
      confidence: 0,
      checks: [{ name: 'Test name recognised', pass: false,
        detail: `"${claim.testName}" is not a test we have a reference range for` }],
      show: false,
    };
  }
  checks.push({ name: 'Test name recognised', pass: true, detail: test.name });

  if (claim.value === null || claim.value === undefined || Number.isNaN(Number(claim.value))) {
    return {
      key: test.key, testName: test.name, value: null, unit: claim.unit,
      verdict: 'unreadable', confidence: 0,
      checks: [...checks, { name: 'Value readable', pass: false, detail: 'no number could be read' }],
      show: true,
    };
  }
  const value = Number(claim.value);

  // CHECK 2 — is the unit right FOR THIS TEST?
  const unitOk = unitMatches(test, claim.unit);
  if (unitOk === false) {
    score -= PENALTY.unitWrong;
    checks.push({ name: 'Unit valid for this test', pass: false,
      detail: `read "${claim.unit}", expected ${test.unit}` });
  } else if (unitOk === true) {
    checks.push({ name: 'Unit valid for this test', pass: true, detail: claim.unit });
  } else {
    checks.push({ name: 'Unit valid for this test', pass: null, detail: 'no unit printed' });
  }

  // CHECK 3 — is the number physically possible in a living person?
  const [lo, hi] = test.possible;
  const possible = value >= lo && value <= hi;
  if (!possible) score -= PENALTY.impossible;
  checks.push({ name: 'Physically possible', pass: possible,
    detail: possible ? `${value} is within survivable limits` : `${value} is outside anything survivable (${lo}–${hi})` });

  // CHECK 4 — the free one. Does the range printed ON THE REPORT agree with ours?
  const printed = parsePrintedRange(claim.printedRange);
  const ours = ref.normalRange(test, profile?.sex);
  if (printed && ours) {
    const close = Math.abs(printed[0] - ours[0]) <= Math.max(0.5, ours[0] * 0.35) &&
                  Math.abs(printed[1] - ours[1]) <= Math.max(0.5, ours[1] * 0.35);
    if (!close) score -= PENALTY.printedRangeMismatch;
    checks.push({ name: "Report's own printed range agrees", pass: close,
      detail: close
        ? `report says ${printed[0]}–${printed[1]}, we expect ${ours[0]}–${ours[1]}`
        : `report says ${printed[0]}–${printed[1]} but we expect ${ours[0]}–${ours[1]} — one of them is misread` });
  } else {
    checks.push({ name: "Report's own printed range agrees", pass: null,
      detail: 'no range printed beside this value' });
  }

  // CHECK 5 — did a second independent read agree?
  if (secondRead) {
    const twin = secondRead.find((v) => ref.findTest(v.testName)?.key === test.key);
    const agree = twin && Number(twin.value) === value;
    if (!agree) score -= PENALTY.readsDisagree;
    checks.push({ name: 'Two separate reads agree', pass: !!agree,
      detail: agree ? `both reads said ${value}` : `first read ${value}, second read ${twin ? twin.value : 'nothing'}` });
  } else {
    checks.push({ name: 'Two separate reads agree', pass: null, detail: 'single-read mode' });
  }

  // CHECK 6 — was that part of the image actually clear?
  if (claim.legible === 'unreadable') score -= PENALTY.imageUnclear * 2;
  else if (claim.legible === 'partial') score -= PENALTY.imageUnclear;
  checks.push({ name: 'Image clear at this row', pass: claim.legible === 'clear',
    detail: claim.legible || 'unknown' });

  const confidence = Math.max(0, Math.min(100, score));
  const verdict = confidence >= 85 ? 'verified' : confidence >= 60 ? 'probable' : 'rejected';

  // --- CONFIDENCE 2: is it abnormal? Pure lookup. No AI. ---
  let status = 'normal', direction = null;
  if (verdict !== 'rejected' && ours) {
    if (value > ours[1]) { status = 'high'; direction = 'high'; }
    else if (value < ours[0]) { status = 'low'; direction = 'low'; }
    if (test.criticalHigh != null && value >= test.criticalHigh) status = 'critical-high';
    if (test.criticalLow != null && value <= test.criticalLow) status = 'critical-low';
  }

  return {
    key: test.key,
    testName: test.name,
    means: test.means,
    value,
    unit: claim.unit || test.unit,
    normalRange: ours,
    status,
    direction,
    verdict,
    confidence,
    checks,
    failedChecks: checks.filter((c) => c.pass === false).map((c) => c.name),
    show: true,
  };
}

// ---------------------------------------------------------------------------
// Trend — the hero visual. Same test, across every report we hold.
// ---------------------------------------------------------------------------
function buildTrends(currentValues, previousReports, profile) {
  const trends = {};
  const series = {};

  const push = (key, date, value) => {
    if (!key || value == null) return;
    (series[key] ||= []).push({ date, value });
  };

  for (const r of previousReports || []) {
    for (const v of r.values || []) {
      if (v.verdict === 'rejected' || v.value == null) continue;
      push(v.key, r.reportDate || r.createdAt, v.value);
    }
  }
  for (const v of currentValues) {
    if (v.verdict === 'rejected' || v.value == null) continue;
    push(v.key, 'current', v.value);
  }

  for (const [key, pts] of Object.entries(series)) {
    if (pts.length < 2) continue;
    const test = ref.findTest(key);
    const range = ref.normalRange(test, profile?.sex);
    const first = pts[0].value, last = pts[pts.length - 1].value;
    const changePct = first ? Math.round(((last - first) / first) * 100) : 0;

    let movement = 'steady';
    if (Math.abs(changePct) >= 10) movement = changePct > 0 ? 'rising' : 'falling';

    // is it moving TOWARDS trouble, or away from it?
    let worsening = false;
    if (range) {
      if (last > range[1] && changePct > 0) worsening = true;
      if (last < range[0] && changePct < 0) worsening = true;
    }

    trends[key] = {
      key, testName: test?.name || key, unit: test?.unit,
      points: pts, range,
      criticalHigh: test?.criticalHigh ?? null,
      criticalLow: test?.criticalLow ?? null,
      changePct, movement, worsening,
      span: pts.length,
    };
  }
  return trends;
}

// ---------------------------------------------------------------------------
// The whole job.
// ---------------------------------------------------------------------------
async function analyseReport({ base64, mimeType, profile, previousReports }) {
  const doubleRead = String(process.env.LAB_DOUBLE_READ || '').toLowerCase() === 'true';

  const first = await extractReport(base64, mimeType);
  const second = doubleRead ? (await extractReport(base64, mimeType))?.values : null;

  // --- DOCUMENT VALIDATION, five levels ---
  const docIssues = [];
  if (first.isLabReport === false) {
    docIssues.push({ level: 'wrong-document', severity: 'stop',
      message: `This does not look like a lab report — it looks like a ${first.documentType || 'different document'}.` });
  }
  if (first.reportDate) {
    const age = (Date.now() - new Date(first.reportDate).getTime()) / (1000 * 60 * 60 * 24 * 365);
    if (age > 2) docIssues.push({ level: 'expired', severity: 'warn',
      message: `This report is about ${Math.floor(age)} years old. Values may have changed since.` });
  }
  if (first.patientName && profile?.fullName) {
    const a = first.patientName.toLowerCase().replace(/[^a-z]/g, '');
    const b = profile.fullName.toLowerCase().replace(/[^a-z]/g, '').replace('demo', '');
    if (a && b && !a.includes(b.slice(0, 5)) && !b.includes(a.slice(0, 5))) {
      docIssues.push({ level: 'wrong-person', severity: 'stop',
        message: `The report says "${first.patientName}" but this profile is "${profile.fullName}". These may be two different people.` });
    }
  }
  if (first.unreadableSections?.length) {
    docIssues.push({ level: 'unreadable', severity: 'warn',
      message: `Could not read: ${first.unreadableSections.join(', ')}. Re-photograph those parts.` });
  }

  // --- verify every claimed value ---
  const all = (first.values || []).map((v) => verifyValue(v, profile, second));
  const values = all.filter((v) => v.show);
  const rejected = values.filter((v) => v.verdict === 'rejected' || v.verdict === 'unreadable');
  const usable = values.filter((v) => v.verdict === 'verified' || v.verdict === 'probable');

  if (usable.some((v) => v.confidence < 85)) {
    docIssues.push({ level: 'ambiguous', severity: 'warn',
      message: `${usable.filter((v) => v.confidence < 85).length} value(s) are probable but not confirmed — a human should check them.` });
  }

  // --- CONFIDENCE 3: does it matter for THIS person? drug rules, from a table ---
  const flags = [];
  for (const v of usable) {
    if (!v.direction) continue;
    for (const rule of ref.drugRulesFor(v.key, v.direction, profile?.medications)) {
      flags.push({
        testName: v.testName, value: v.value, unit: v.unit,
        drugs: rule.drugs.filter((d) => (profile?.medications || []).join(' ').toLowerCase().includes(d)),
        risk: rule.risk, action: rule.action,
      });
    }
  }

  const trends = buildTrends(usable, previousReports, profile);

  // the single most important thing on the page
  const criticals = usable.filter((v) => String(v.status).startsWith('critical'));
  const worsening = Object.values(trends).filter((t) => t.worsening);

  let headline = null;
  if (criticals.length) {
    headline = { tone: 'critical',
      text: `${criticals[0].testName} is at a level that needs a doctor today.` };
  } else if (flags.length) {
    headline = { tone: 'critical', text: flags[0].risk + ' ' + flags[0].action };
  } else if (worsening.length) {
    const t = worsening[0];
    headline = { tone: 'warn',
      text: `${t.testName} has been ${t.movement} across ${t.span} reports — ${t.changePct > 0 ? '+' : ''}${t.changePct}%.` };
  } else if (usable.some((v) => v.status !== 'normal')) {
    headline = { tone: 'warn', text: `${usable.filter((v) => v.status !== 'normal').length} value(s) are outside the normal range.` };
  } else if (usable.length) {
    headline = { tone: 'good', text: 'Everything we could verify is within the normal range.' };
  }

  return {
    source: first._source || 'mock',
    documentType: first.documentType,
    patientName: first.patientName,
    reportDate: first.reportDate,
    labName: first.labName,
    docIssues,
    values: usable,
    rejected,
    flags,
    trends,
    headline,
    summary: {
      read: values.length,
      verified: usable.filter((v) => v.verdict === 'verified').length,
      probable: usable.filter((v) => v.verdict === 'probable').length,
      refused: rejected.length,
      abnormal: usable.filter((v) => v.status !== 'normal').length,
    },
    disclaimer: 'GoldenBay organises and checks what the report says. It does not diagnose. Discuss anything flagged here with a doctor.',
  };
}

module.exports = { analyseReport, verifyValue, buildTrends, LAB_PROMPT, mockLabExtraction };