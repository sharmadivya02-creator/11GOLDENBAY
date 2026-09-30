// shared/emergency.js — the fixed vocabulary every part of GoldenBay agrees on.
//
// Loaded by the server (require) AND by both browser apps (<script>), so the
// User App's buttons, the server's matching and the Hospital App's labels can
// never drift apart.
//
// [Design choice] The mapping from button to hospital services below is ours,
// written for the prototype. It must be reviewed by the doctors you spoke to
// before any real use.

(function (root) {
  // Services a hospital can declare. AI output is only accepted if it uses
  // words from this list — anything else is thrown away.
  const SERVICES = [
    'emergency',   // a 24x7 emergency department — every joined hospital declares this
    'cardiac', 'cathlab', 'icu', 'trauma', 'orthopedic',
    'neuro', 'stroke', 'burns', 'pediatric', 'maternity',
  ];

  const SERVICE_LABELS = {
    emergency: 'Emergency dept', cardiac: 'Heart care', cathlab: 'Cath lab', icu: 'ICU',
    trauma: 'Trauma', orthopedic: 'Orthopaedic', neuro: 'Neuro', stroke: 'Stroke unit',
    burns: 'Burns unit', pediatric: 'Children', maternity: 'Maternity',
  };

  // The quick buttons. `required` narrows which hospitals are asked (only a
  // person's tap can narrow the list). `preferred` only changes the order.
  // `critical` = life-threatening: cost preference never delays anyone.
  // `hi` = Hindi label, drafted by Claude: have a native speaker check it before
  // it is shown to anyone.
  const EMERGENCY_TYPES = [
    { id: 'chest_pain',        label: 'Chest pain',               hi: 'सीने में दर्द',      required: ['cardiac'],   preferred: ['cathlab', 'icu'],    critical: true },
    { id: 'cant_breathe',      label: "Can't breathe",            hi: 'सांस नहीं आ रही',    required: ['emergency'], preferred: ['icu'],               critical: true },
    { id: 'heavy_bleeding',    label: 'Heavy bleeding',           hi: 'बहुत खून बह रहा',   required: ['trauma'],    preferred: ['icu'],               critical: true },
    { id: 'unconscious',       label: 'Unconscious / fainted',    hi: 'बेहोश',              required: ['emergency'], preferred: ['icu', 'neuro'],      critical: true },
    { id: 'seizure',           label: 'Fits / seizure',           hi: 'दौरा',               required: ['neuro'],     preferred: ['icu'],               critical: true },
    { id: 'stroke_signs',      label: 'Stroke signs',             hi: 'लकवे के लक्षण',      required: ['stroke'],    preferred: ['neuro', 'icu'],      critical: true },
    { id: 'accident_fall',     label: 'Accident / fall',          hi: 'दुर्घटना / गिरना',   required: ['trauma'],    preferred: ['orthopedic', 'icu'], critical: false },
    { id: 'burns',             label: 'Burns',                    hi: 'जलना',               required: ['burns'],     preferred: ['icu'],               critical: false },
    { id: 'allergic_reaction', label: 'Severe allergic reaction', hi: 'गंभीर एलर्जी',       required: ['emergency'], preferred: ['icu'],               critical: true },
    { id: 'child_emergency',   label: 'Child emergency',          hi: 'बच्चे की इमरजेंसी',  required: ['pediatric'], preferred: [],                    critical: false },
    { id: 'pregnancy',         label: 'Pregnancy emergency',      hi: 'गर्भावस्था इमरजेंसी', required: ['maternity'], preferred: [],                    critical: true },
  ];

  const URGENCY = ['CRITICAL', 'HIGH', 'MODERATE'];

  const DECLINE_REASONS = [
    { id: 'no_specialist', label: 'No specialist on duty right now' },
    { id: 'no_icu_bed',    label: 'No ICU bed right now' },
    { id: 'cathlab_busy',  label: 'Cath lab not available right now' },
    { id: 'er_full',       label: 'Emergency department full right now' },
    { id: 'better_nearby', label: 'A better-equipped hospital is nearer' },
    { id: 'other',         label: 'Other' },
  ];

  const COST_PREFERENCES = [
    { id: 'any',               label: 'Any hospital' },
    { id: 'government',        label: 'Government hospitals first' },
    { id: 'pmjay',             label: 'Ayushman Bharat (PM-JAY) card' },
    { id: 'private-insurance', label: 'Private insurance' },
  ];

  const api = { SERVICES, SERVICE_LABELS, EMERGENCY_TYPES, URGENCY, DECLINE_REASONS, COST_PREFERENCES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GB = Object.assign(root.GB || {}, api);
})(typeof window !== 'undefined' ? window : globalThis);
