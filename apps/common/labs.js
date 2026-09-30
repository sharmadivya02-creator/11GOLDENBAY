// labs.js — the Lab Report screen.
//
// The hero of this page is ONE picture: the same test, across every report this
// family holds, with the normal range behind it. Nobody has ever seen their own
// results as a line — you get one sheet at a time, months apart, in a folder.

const $ = (id) => document.getElementById(id);

let profiles = [];
let currentProfileId = null;
let lastAnalysis = null;
let activeTrendKey = null;

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
(async function boot() {
  const data = await api('GET', '/v1/profiles');
  profiles = data.profiles || [];
  $('who').innerHTML = profiles
    .map((p) => `<option value="${p.id}">${esc(p.fullName)}</option>`)
    .join('') || '<option>No profiles</option>';
  // if we arrived from a person's profile page, preselect them
  const wanted = new URLSearchParams(location.search).get('p');
  currentProfileId = (wanted && profiles.some((p) => p.id === wanted)) ? wanted : (profiles[0]?.id || null);
  if (currentProfileId) $('who').value = currentProfileId;

  $('who').addEventListener('change', (e) => { currentProfileId = e.target.value; $('out').innerHTML = ''; });
  $('btnPick').addEventListener('click', () => $('file').click());
  $('file').addEventListener('change', (e) => e.target.files[0] && analyse(e.target.files[0]));
  $('btnHistory').addEventListener('click', loadHistory);

  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (f) analyse(f);
  });
})();

async function loadHistory() {
  if (!currentProfileId) return;
  $('btnHistory').disabled = true;
  $('btnHistory').textContent = 'Loading…';
  await api('POST', '/v1/labs/demo-history', { profileId: currentProfileId });
  $('btnHistory').textContent = '✓ 18 months loaded — now add a new report';
  setTimeout(() => { $('btnHistory').disabled = false; $('btnHistory').textContent = 'Load 18 months of history'; }, 4000);
}

// ---------------------------------------------------------------------------
// analyse — with the checks ticking through on screen, because watching a
// machine check its own work is the whole point of this feature
// ---------------------------------------------------------------------------
const STEPS = [
  'Reading the document…',
  'Checking every test name against the reference list…',
  'Checking units are valid for each test…',
  'Checking each value is physically possible…',
  "Comparing against the range printed on the report itself…",
  'Looking up previous reports for this person…',
  'Cross-checking against current medications…',
];

async function analyse(file) {
  const ticker = $('ticker');
  ticker.classList.remove('hidden');
  ticker.innerHTML = '';
  $('out').innerHTML = '';

  let i = 0;
  const tick = setInterval(() => {
    if (i >= STEPS.length) return;
    const el = document.createElement('div');
    el.className = 'line';
    el.textContent = '· ' + STEPS[i++];
    ticker.appendChild(el);
    [...ticker.children].forEach((c, n) => c.classList.toggle('done', n < ticker.children.length - 1));
  }, 260);

  try {
    const base64 = await fileToBase64(file);
    const { analysis } = await api('POST', '/v1/labs/analyze', {
      profileId: currentProfileId,
      imageBase64: base64,
      mimeType: file.type || 'image/jpeg',
    });
    clearInterval(tick);
    lastAnalysis = analysis;
    ticker.classList.add('hidden');
    render(analysis);
  } catch (err) {
    clearInterval(tick);
    ticker.innerHTML = `<div class="line done" style="color:var(--red)">Could not analyse: ${esc(err.message)}</div>`;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function render(a) {
  const trendKeys = Object.keys(a.trends || {});
  activeTrendKey = trendKeys.find((k) => a.trends[k].worsening) || trendKeys[0] || null;

  $('out').innerHTML = `
    ${a.headline ? headlineHTML(a.headline) : ''}
    ${a.docIssues?.length ? a.docIssues.map(issueHTML).join('') : ''}
    ${trendKeys.length ? trendSectionHTML(a, trendKeys) : ''}
    ${a.flags?.length ? `<h2 class="sec">Matters for this person</h2>${a.flags.map(flagHTML).join('')}` : ''}
    <h2 class="sec">What we read — and how sure we are</h2>
    <div class="tally">
      <span>${a.summary.read} values read</span>
      <span>${a.summary.verified} verified</span>
      <span>${a.summary.probable} probable</span>
      <span>${a.summary.refused} refused</span>
      <span>${a.source === 'gemini' ? '✦ Gemini' : 'mock AI'}</span>
    </div>
    ${a.values.map(valueHTML).join('')}
    ${a.rejected?.length ? `<h2 class="sec">Not guessed</h2>${a.rejected.map(refusedHTML).join('')}` : ''}
    <p class="footer-note" style="text-align:left;margin-top:18px">${esc(a.disclaimer)}</p>
  `;

  wireTrendTabs(a);
  drawTrend(a);
}

function headlineHTML(h) {
  const dot = '';
  return `<div class="headline ${h.tone}"><span class="dot">${dot}</span><span>${esc(h.text)}</span></div>`;
}

function issueHTML(i) {
  return `<div class="issue ${i.severity}">${esc(i.message)}</div>`;
}

function flagHTML(f) {
  return `
  <div class="flag">
    <div class="risk">${esc(f.testName)} ${f.value}${esc(f.unit || '')} — ${esc(f.risk)}</div>
    <div class="action">${esc(f.action)}</div>
    <div class="meds">Because this person takes: ${esc(f.drugs.join(', '))}</div>
  </div>`;
}

function valueHTML(v) {
  const range = v.normalRange ? `normal ${v.normalRange[0]}–${v.normalRange[1]}` : 'no reference range';
  const arrow = v.status === 'high' || v.status === 'critical-high' ? '▲'
              : v.status === 'low' || v.status === 'critical-low' ? '▼' : '';
  return `
  <div class="val">
    <div class="val-top">
      <span class="val-name">${esc(v.testName)}</span>
      <span class="conf ${v.verdict}">${v.verdict.toUpperCase()} · ${v.confidence}%</span>
      <span class="val-num ${v.status}">${arrow} ${v.value} <small style="font-size:12px;font-weight:600">${esc(v.unit || '')}</small></span>
    </div>
    <div class="val-meta">${range}${v.failedChecks?.length ? ` · failed: ${v.failedChecks.join(', ')}` : ''}</div>
    ${v.means ? `<div class="val-means">${esc(v.means)}</div>` : ''}
    ${v.checks?.length ? `
      <details class="checks">
        <summary>Show the ${v.checks.length} checks</summary>
        ${v.checks.map(checkHTML).join('')}
      </details>` : ''}
  </div>`;
}

function checkHTML(c) {
  const cls = c.pass === true ? 'pass' : c.pass === false ? 'fail' : 'skip';
  const mark = c.pass === true ? '✓' : c.pass === false ? '✕' : '–';
  return `<div class="check ${cls}"><span class="m">${mark}</span><span class="d"><b>${esc(c.name)}</b> — ${esc(c.detail)}</span></div>`;
}

function refusedHTML(v) {
  return `
  <div class="refused">
    <span class="val-name">${esc(v.testName)}</span>
    <span class="conf rejected" style="margin-left:8px">confidence ${v.confidence}%</span>
    <div class="why">${(v.checks || []).filter((c) => c.pass === false).map((c) => esc(c.detail)).join(' · ') || 'could not be read'}</div>
    <strong>Not going to guess. Re-photograph this row.</strong>
  </div>`;
}

// ---------------------------------------------------------------------------
// THE CHART
// One series, so no legend — the title names it. Normal range sits behind the
// line as a quiet band; anything past the critical threshold gets a red band.
// Only the last point is labelled. Everything else is recessive on purpose.
// ---------------------------------------------------------------------------
function trendSectionHTML(a, keys) {
  return `
  <div class="chart-card">
    <div class="chart-tabs" role="tablist">
      ${keys.map((k) => `
        <button class="chart-tab" role="tab" data-key="${k}"
          aria-selected="${k === activeTrendKey}">${esc(a.trends[k].testName)}${a.trends[k].worsening ? ' ⚠' : ''}</button>`).join('')}
    </div>
    <div id="chartHost"></div>
  </div>`;
}

function wireTrendTabs(a) {
  document.querySelectorAll('.chart-tab').forEach((b) =>
    b.addEventListener('click', () => {
      activeTrendKey = b.dataset.key;
      document.querySelectorAll('.chart-tab').forEach((x) =>
        x.setAttribute('aria-selected', String(x.dataset.key === activeTrendKey)));
      drawTrend(a);
    }));
}

function drawTrend(a) {
  const host = $('chartHost');
  if (!host || !activeTrendKey) return;
  const t = a.trends[activeTrendKey];
  if (!t) return;

  // The chart has to work on a 360px phone AND a laptop. An SVG scales, but its
  // TEXT scales with it — a 11px label on a 720-wide viewBox squeezed into 360px
  // renders at 5.5px and is unreadable. So on narrow screens we use a smaller
  // viewBox and larger type, which comes out the right size after scaling.
  const narrow = window.innerWidth < 640;

  const W = narrow ? 380 : 720;
  const H = narrow ? 230 : 250;
  const padL = narrow ? 40 : 52;
  const padR = narrow ? 34 : 60;
  const padT = 26;
  const padB = narrow ? 30 : 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const fs = {
    axis:  narrow ? 13 : 11,
    note:  narrow ? 12 : 10.5,
    value: narrow ? 19 : 16,
  };

  const values = t.points.map((p) => p.value);
  const lo0 = Math.min(...values, t.range ? t.range[0] : Infinity);
  const hi0 = Math.max(...values, t.range ? t.range[1] : -Infinity,
                       t.criticalHigh != null ? t.criticalHigh : -Infinity);
  const pad = (hi0 - lo0) * 0.18 || 1;
  const yMin = lo0 - pad, yMax = hi0 + pad;

  const x = (i) => padL + (t.points.length === 1 ? plotW / 2 : (plotW * i) / (t.points.length - 1));
  const y = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // bands
  let bands = '';
  if (t.range) {
    const yTop = y(t.range[1]), yBot = y(t.range[0]);
    bands += `<rect x="${padL}" y="${yTop}" width="${plotW}" height="${Math.max(0, yBot - yTop)}"
      fill="#2f8f5b" fill-opacity="0.07" />
      <line x1="${padL}" y1="${yTop}" x2="${padL + plotW}" y2="${yTop}"
        stroke="#2f8f5b" stroke-opacity="0.35" stroke-width="1" stroke-dasharray="4 4" />`;
  }
  if (t.criticalHigh != null && t.criticalHigh < yMax) {
    const yc = y(t.criticalHigh);
    bands += `<rect x="${padL}" y="${padT}" width="${plotW}" height="${Math.max(0, yc - padT)}"
        fill="#b3122c" fill-opacity="0.07" />
      <line x1="${padL}" y1="${yc}" x2="${padL + plotW}" y2="${yc}"
        stroke="#b3122c" stroke-opacity="0.5" stroke-width="1.5" stroke-dasharray="5 4" />
      <text x="${padL + plotW}" y="${yc - 6}" text-anchor="end"
        font-size="${fs.note}" fill="#b3122c" font-weight="700">needs a doctor above ${t.criticalHigh}</text>`;
  }

  // axis ticks — four, recessive
  let gridY = '';
  for (let k = 0; k <= 3; k++) {
    const v = yMin + ((yMax - yMin) * k) / 3;
    const yy = y(v);
    gridY += `<line x1="${padL}" y1="${yy}" x2="${padL + plotW}" y2="${yy}"
        stroke="#eae4dd" stroke-width="1" />
      <text x="${padL - 9}" y="${yy + 4}" text-anchor="end" font-size="${fs.axis}" fill="#918a83">${round(v)}</text>`;
  }

  const line = t.points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(' ');

  const dots = t.points.map((p, i) => {
    const out = t.range && (p.value > t.range[1] || p.value < t.range[0]);
    const crit = t.criticalHigh != null && p.value >= t.criticalHigh;
    const fill = crit ? '#b3122c' : out ? '#b3122c' : '#3a6fb0';
    const r = (i === t.points.length - 1 ? 6.5 : 5) * (narrow ? 1.25 : 1);
    return `<circle cx="${x(i)}" cy="${y(p.value)}" r="${r}" fill="${fill}"
      stroke="#ffffff" stroke-width="2"><title>${labelFor(p)} — ${p.value} ${esc(t.unit || '')}</title></circle>`;
  }).join('');

  // only the last point gets a number
  const last = t.points[t.points.length - 1];
  const lastOut = t.range && (last.value > t.range[1] || last.value < t.range[0]);
  const lastLabel = `<text x="${x(t.points.length - 1) + 12}" y="${y(last.value) + 5}"
      font-size="${fs.value}" font-weight="800" fill="${lastOut ? '#b3122c' : '#201a17'}">${last.value}</text>`;

  const showLabel = (i) => !narrow || i === 0 || i === t.points.length - 1;
  const xLabels = t.points.map((p, i) => showLabel(i)
    ? `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === t.points.length - 1 ? 'end' : 'middle'}" font-size="${fs.axis}" fill="#918a83">${esc(labelFor(p))}</text>`
    : ''
  ).join('');

  const deltaCls = t.worsening ? 'bad' : 'good';
  const deltaTxt = `${t.changePct > 0 ? '+' : ''}${t.changePct}% across ${t.span} reports`;

  host.innerHTML = `
    <p class="chart-title">${esc(t.testName)}${t.unit ? ` <span style="font-weight:600;color:var(--muted);font-size:13px">${esc(t.unit)}</span>` : ''}</p>
    <p class="chart-sub">
      ${t.range ? `Normal ${t.range[0]}–${t.range[1]} · ` : ''}
      <span class="chart-delta ${deltaCls}">${deltaTxt}</span>
    </p>
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img"
         aria-label="${esc(t.testName)} across ${t.span} reports, ${deltaTxt}">
      ${gridY}
      ${bands}
      <path d="${line}" fill="none" stroke="#3a6fb0" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
      ${lastLabel}
      ${xLabels}
      <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}"
            stroke="#ddd5cc" stroke-width="1" />
    </svg>
    <p class="chart-sub" style="margin-top:2px">
      Every point is a separate report. Nobody had put them side by side before.
    </p>`;
}

// redraw on rotate/resize so the phone and laptop layouts swap cleanly
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastAnalysis) drawTrend(lastAnalysis); }, 150);
});

function labelFor(p) {
  if (p.date === 'current') return 'this report';
  const d = new Date(p.date);
  if (Number.isNaN(d.getTime())) return String(p.date).slice(0, 10);
  return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
}

function round(v) {
  if (Math.abs(v) >= 1000) return Math.round(v);
  if (Math.abs(v) >= 10) return Math.round(v * 10) / 10;
  return Math.round(v * 100) / 100;
}