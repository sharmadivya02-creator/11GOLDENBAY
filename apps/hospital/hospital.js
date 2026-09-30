// GoldenBay — Hospital App (for ER staff).
//
// What this screen does, in order:
//   1. Sign in (DEMO login: pick the hospital + one shared PIN — not real security).
//   2. A "no-name card" arrives: age range, what was reported, how far away.
//      No name, no location, no insurance. Accept or Decline (with a reason).
//   3. Accept -> this hospital (and only this one) can open the treatment details.
//      Every time they are opened, the family can see it ("Who viewed my data").
//   4. "Patient arrived" closes the case. "Can't take anymore" hands the patient
//      back and the agent asks the other hospitals again.
//
// The screen is refreshed by a live stream AND a light poll (see gb.js).

(() => {
  const { esc, toast, keep, makeApi, goLive, unlockSound, beep, mmss, secSince, chips, fmtDate } = GBX;
  const { SERVICES, SERVICE_LABELS, DECLINE_REASONS } = GB;
  const SOURCE_LABEL = { allergies: 'allergies', medications: 'medicines', conditions: 'conditions', pastEvents: 'history', bloodGroup: 'blood group', callerWords: "caller's words", buttons: 'buttons tapped' };

  const S = {
    token: keep.get('gb_hospital_token'),
    hospital: null,
    pending: [], incoming: [], recent: [],
    knownOffers: new Set(),
    detail: null,          // level-2 patient object of the case that is open
    declining: null,       // offerId whose decline reasons are showing
    handingBack: false,
    showSettings: false,
    live: null,
    publicHospitals: [],
  };
  const api = makeApi(() => (S.token ? { 'x-hospital-token': S.token } : {}));
  const $ = (sel) => document.querySelector(sel);
  const root = $('#app');

  // ------------------------------------------------------------------ login
  async function showLogin(msg) {
    if (S.live) { S.live.stop(); S.live = null; }
    let hospitals = [];
    try { hospitals = (await api('GET', '/v1/hospitals/public')).hospitals.filter((h) => h.joined); } catch { /* shown below */ }
    root.innerHTML = `
      <div class="topbar"><div class="logo">${icon('hospital', { size: 22 })}</div><div><div class="brand">GoldenBay</div><div class="sub">Hospital App</div></div></div>
      <div class="demo-banner">Demo login — one shared PIN. Not real security. Hospitals shown are fictional pilot partners.</div>
      <div class="shell"><div class="card stack" style="margin-top:18px">
        <h2>Sign in to your emergency department</h2>
        ${msg ? `<div class="note bad">${esc(msg)}</div>` : ''}
        <label class="field">Hospital
          <select id="hid">${hospitals.map((h) => `<option value="${esc(h.id)}">${esc(h.name)}</option>`).join('')}</select>
        </label>
        <label class="field">Demo PIN
          <input id="pin" type="password" inputmode="numeric" autocomplete="off" placeholder="Ask the demo host">
        </label>
        <button class="btn" id="go">Sign in</button>
        <p class="small muted">Signing in also switches on the alert sound for new requests.</p>
      </div></div>`;
    $('#go').onclick = async () => {
      unlockSound();
      try {
        const r = await api('POST', '/v1/hospital/login', { hospitalId: $('#hid').value, pin: $('#pin').value });
        S.token = r.token; keep.set('gb_hospital_token', r.token);
        S.hospital = r.hospital;
        await start();
      } catch (e) { showLogin(e.message); }
    };
    $('#pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#go').click(); });
  }

  function signOut() {
    S.token = null; keep.del('gb_hospital_token'); S.detail = null; S.knownOffers = new Set();
    showLogin();
  }

  // ------------------------------------------------------------------ main
  async function start() {
    try {
      S.hospital = (await api('GET', '/v1/hospital/me')).hospital;
    } catch { return showLogin(); }
    try { S.publicHospitals = (await api('GET', '/v1/hospitals/public')).hospitals; } catch { /* optional */ }
    drawShell();
    await refresh(true);
    S.live = goLive({
      api,
      events: ['offer:new', 'offer:update', 'offer:closed', 'patient:update', 'patient:released', 'patient:location', 'arrival:incoming'],
      onEvent: onEvent,
      onPoll: () => refresh(false),
    });
    setInterval(tickTimers, 1000);
  }

  function drawShell() {
    root.innerHTML = `
      <div class="topbar">
        <div class="logo">${icon('hospital', { size: 22 })}</div>
        <div class="grow"><div class="brand" id="hname"></div><div class="sub">Hospital App · demo login · fictional hospital</div></div>
        <button id="settingsBtn">Services</button>
        <button id="out">Sign out</button>
      </div>
      <div id="banner"></div>
      <div class="shell wide"><div class="cols">
        <div id="left"></div>
        <div><div id="right"></div><div id="settings"></div></div>
      </div></div>`;
    $('#out').onclick = signOut;
    $('#settingsBtn').onclick = () => { S.showSettings = !S.showSettings; drawSettings(); };
    drawHeader(); drawRight(); drawSettings();
  }

  function drawHeader() {
    $('#hname').textContent = S.hospital.name;
    $('#banner').innerHTML = S.hospital.unavailable
      ? `<div class="demo-banner">${icon('alertTriangle', { size: 18 })}<span>You are marked "temporarily unavailable" — new requests are not sent to you. ${esc(S.hospital.unavailableReason || '')}</span></div>`
      : '';
  }

  async function refresh(first) {
    if (!S.token) return;
    try {
      const r = await api('GET', '/v1/hospital/offers');
      let fresh = false;
      for (const o of r.pending) if (!S.knownOffers.has(o.offerId)) { S.knownOffers.add(o.offerId); if (!first) fresh = true; }
      S.pending = r.pending; S.incoming = r.incoming; S.recent = r.recent;
      if (fresh) { beep(); }
      // if the open case is no longer ours, close it
      if (S.detail && !S.incoming.some((x) => x.emergencyId === S.detail.emergencyId)) { S.detail = null; S.handingBack = false; drawRight(); }
      drawLeft(fresh);
    } catch (e) {
      if (e.status === 401) { toast('Signed out — please sign in again.'); signOut(); }
    }
  }

  function onEvent(name, data) {
    if (name === 'patient:location' && S.detail && S.detail.emergencyId === data.emergencyId) {
      S.detail.liveLocation = { distanceKm: data.distanceKm, at: data.at }; drawRight(); return;
    }
    if (name === 'patient:released') toast(`Patient released: ${data.reason}`);
    if (name === 'arrival:incoming') { beep(); toast('A patient is being brought to you (family chose this hospital).'); }
    refresh(false);
  }

  // ------------------------------------------------------------------ left column
  function drawLeft(flash) {
    const l = $('#left'); if (!l) return;
    const pend = S.pending.map((o) => offerCard(o, flash)).join('') ||
      `<div class="card muted">No new requests. Keep this screen open — a request arrives here with a sound.</div>`;
    const inc = S.incoming.map((x) => `
      <div class="card row spread" data-open="${esc(x.emergencyId)}" style="cursor:pointer;border-left:6px solid var(--ok)">
        <div><b>Patient on the way · #${esc(x.ref)}</b>
          <div class="small muted">${x.diverted ? 'Family chose this hospital' : x.simulated ? 'Accepted automatically (demo — no one answered in time)' : 'You accepted'} · ${esc(x.status)}</div></div>
        <button class="btn small ok" data-open="${esc(x.emergencyId)}">Open</button>
      </div>`).join('');
    const rec = S.recent.map((x) => `<div class="logline"><b>#${esc(x.ref)}</b> · ${esc(labelStatus(x))}</div>`).join('');
    l.innerHTML = `
      <div class="section-title">New requests (${S.pending.length})</div>${pend}
      ${S.incoming.length ? `<div class="section-title">Patients coming to you</div>${inc}` : ''}
      ${rec ? `<div class="section-title">Recent</div><div class="card">${rec}</div>` : ''}`;
    l.querySelectorAll('[data-open]').forEach((el) => el.onclick = (ev) => { ev.stopPropagation(); openCase(el.dataset.open); });
    l.querySelectorAll('[data-accept]').forEach((el) => el.onclick = () => accept(el.dataset.accept));
    l.querySelectorAll('[data-decline]').forEach((el) => el.onclick = () => { S.declining = S.declining === el.dataset.decline ? null : el.dataset.decline; drawLeft(); });
    l.querySelectorAll('[data-reason]').forEach((el) => el.onclick = () => decline(el.dataset.offer, el.dataset.reason));
  }

  function labelStatus(x) {
    const map = { accepted: 'you accepted', declined: `you declined${x.reason ? ` (${reasonLabel(x.reason)})` : ''}`, released: 'taken by another hospital — no action needed', cancelled: 'handed back' };
    return map[x.status] || x.status;
  }
  const reasonLabel = (id) => (DECLINE_REASONS.find((d) => d.id === id) || {}).label || id;

  function offerCard(o) {
    return `
      <div class="card offer stack" data-offer-card="${esc(o.offerId)}">
        <div class="row spread">
          <div class="row"><span class="tag crit">${esc(o.urgency)}</span><span class="small muted">#${esc(o.ref)}</span></div>
          <div class="timer" data-sent="${esc(o.sentAt)}">0:00</div>
        </div>
        <h2>${esc((o.reported || []).join(' · ') || o.suspectedCategory || 'Emergency')}</h2>
        <div>${esc(o.ageRange)} years · ${esc(o.sex)} · <b>${esc(o.distanceKm)} km</b> away</div>
        ${o.suspectedCategory ? `<div class="small muted">Suspected: ${esc(o.suspectedCategory)} (from the caller's report — not a diagnosis)</div>` : ''}
        <div><div class="small muted">Needs</div>${chips(o.needs, 'need')}${o.alsoUseful?.length ? `<div class="small muted" style="margin-top:6px">Also useful</div>${chips(o.alsoUseful)}` : ''}</div>
        <div class="small muted">No-name card: name, location, insurance and ID numbers are not shown until you accept.</div>
        ${S.declining === o.offerId
          ? `<div class="decline-list"><div class="small"><b>Why can't you take this patient?</b> (the agent uses this to send them somewhere better equipped)</div>
              ${DECLINE_REASONS.map((d) => `<button data-offer="${esc(o.offerId)}" data-reason="${esc(d.id)}">${esc(d.label)}</button>`).join('')}
              <button class="btn ghost small" style="margin-top:10px" data-decline="${esc(o.offerId)}">Back</button></div>`
          : `<div class="row"><button class="btn ok" data-accept="${esc(o.offerId)}">Accept — we can take this patient</button>
             <button class="btn ghost" style="width:auto;white-space:nowrap" data-decline="${esc(o.offerId)}">Decline</button></div>`}
      </div>`;
  }

  function tickTimers() {
    document.querySelectorAll('.timer[data-sent]').forEach((el) => { el.textContent = mmss(secSince(el.dataset.sent)); });
  }

  async function accept(offerId) {
    try {
      const r = await api('POST', `/v1/hospital/offers/${offerId}/accept`, {});
      toast('Accepted. The family has been told your hospital said yes.');
      await refresh(false);
      await openCase(r.emergencyId);
    } catch (e) { toast(e.message); await refresh(false); }
  }

  async function decline(offerId, reason) {
    try {
      await api('POST', `/v1/hospital/offers/${offerId}/decline`, { reason });
      S.declining = null; toast('Declined. Thank you — the agent will ask others.');
    } catch (e) { toast(e.message); }
    await refresh(false);
  }

  // ------------------------------------------------------------------ patient details (level 2)
  async function openCase(id) {
    try {
      const { patient } = await api('GET', `/v1/hospital/emergencies/${id}`);
      S.detail = patient; S.handingBack = false;
      drawRight();
      api('POST', `/v1/hospital/emergencies/${id}/seen`, {}).catch(() => {});
      $('#right').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { toast(e.message); }
  }

  function drawRight() {
    const r = $('#right'); if (!r) return;
    const p = S.detail;
    if (!p) { r.innerHTML = `<div class="card muted" style="margin-top:0">Patient details appear here after you accept. Only your hospital can open them, and the family can see when you do.</div>`; return; }
    const h = p.handover || {};
    r.innerHTML = `
      <div class="card stack">
        <div class="row spread"><div><span class="tag crit">${esc(p.urgency)}</span> <span class="small muted">#${esc(p.ref)} · ${esc(p.status)}</span></div>
          <button class="btn small ghost" id="closeDetail">Close</button></div>
        <h2>${esc(p.firstName)} · ${esc(p.age ?? '?')} yrs · ${esc(p.sex || '—')}${p.bloodGroup ? ` · ${esc(p.bloodGroup)}` : ''}</h2>
        <div class="note good">${esc(p.arrivalBy)}${p.liveLocation ? ` · <b>${esc(p.liveLocation.distanceKm)} km away</b> (live, updated ${esc(new Date(p.liveLocation.at).toLocaleTimeString())})` : ''}</div>

        ${(p.allergies || []).length ? `<div class="allergy">ALLERGIES: ${esc(p.allergies.join(', '))}</div>` : '<div class="note">No allergies recorded (family-reported)</div>'}

        <dl class="kv">
          <dt>Medicines</dt><dd>${(p.medications || []).length ? esc(p.medications.join('; ')) : '<span class="muted">none recorded</span>'}</dd>
          <dt>Conditions</dt><dd>${(p.conditions || []).length ? esc(p.conditions.join(', ')) : '<span class="muted">none recorded</span>'}</dd>
          <dt>History</dt><dd>${(p.pastEvents || []).length ? esc(p.pastEvents.join('; ')) : '<span class="muted">none recorded</span>'}</dd>
          <dt>Family contact</dt><dd>${p.emergencyContact ? `${esc(p.emergencyContact.name)} (${esc(p.emergencyContact.relation)}) · <a href="tel:${esc(p.emergencyContact.phone)}">${esc(p.emergencyContact.phone)}</a>` : '<span class="muted">none</span>'}</dd>
        </dl>

        <div class="sbar">
          <b>Situation</b><div>${esc(h.situation)}</div>
          <b>Background</b><ul>${(h.background || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          <b>Assessment (from the caller's report)</b><div>${esc(h.assessment)}</div>
          <div class="small muted" style="margin-top:6px">Handover format: SBAR without a Recommendation — GoldenBay never recommends treatment. Source: ${esc(h.source)}.</div>
        </div>

        ${p.flags?.length ? `<div><div class="small muted">Warnings (from the family's profile — checked by code)</div>${p.flags.map((f) => `<div class="allergy" style="margin-top:6px">⚠ ${esc(f.note)} <span class="small" style="font-weight:500">· from ${esc(SOURCE_LABEL[f.source] || f.source)}</span></div>`).join('')}</div>` : ''}
        ${p.aiNote ? `<div class="sbar" style="background:#fff">
            <div class="row spread"><b>Short note</b><span class="tag line">✦ Gemini · checked</span></div>
            ${p.aiNote.situation ? `<div style="margin-top:6px">${esc(p.aiNote.situation)}</div>` : ''}
            <ul>${(p.aiNote.keyPoints || []).map((k) => `<li>${esc(k.text)} <span class="small muted">(${esc(SOURCE_LABEL[k.source] || k.source)})</span></li>`).join('')}</ul>
            ${p.aiNote.assessment ? `<div><b>Assessment</b> ${esc(p.aiNote.assessment)}</div>` : ''}
            <div class="small muted" style="margin-top:6px">Every point was matched word-by-word to the family's profile or the caller's words${p.aiNote.removed ? `; ${esc(p.aiNote.removed)} point(s) that could not be matched were removed` : ''}. Not a diagnosis.</div></div>` : ''}
        ${p.callerWords ? `<div><div class="small muted">What the caller said (personal details masked)</div><div class="note">${esc(p.callerWords)}</div></div>` : ''}
        ${p.picture?.questionsForCaller?.length ? `<div><div class="small muted">Worth asking the caller</div>${p.picture.questionsForCaller.map((q) => `<div class="note" style="margin-top:6px">${esc(q)}</div>`).join('')}</div>` : ''}

        <div class="note ${p.profile.stale ? 'warn' : ''}">
          ${esc(p.profile.reportedBy)}. Last updated ${esc(fmtDate(p.profile.lastUpdated))}${p.profile.daysSinceUpdate != null ? ` (${esc(p.profile.daysSinceUpdate)} days ago)` : ''}.
          ${p.profile.stale ? '<b> This information may be out of date — check with the family.</b>' : ''}
          <div class="small" style="margin-top:4px">Consent: ${esc(p.profile.consent)}${p.patientConfirmedByCaller ? ' · caller confirmed the patient' : ''}</div>
        </div>

        ${S.handingBack
          ? `<div class="stack"><div class="note warn">Handing this patient back tells the family and asks the other hospitals again right away.</div>
              <label class="field">Reason (optional)<input type="text" id="backReason" maxlength="100" placeholder="e.g. cath lab went down"></label>
              <div class="row"><button class="btn dark" id="backConfirm">Yes, hand back</button><button class="btn ghost" id="backNo" style="width:auto">Keep patient</button></div></div>`
          : `<div class="row wrap"><button class="btn ok grow" id="arrived">Patient arrived</button>
              <button class="btn ghost grow" id="back">Can't take anymore</button></div>`}
      </div>`;
    $('#closeDetail').onclick = () => { S.detail = null; drawRight(); };
    const q = (id) => document.getElementById(id);
    if (q('arrived')) q('arrived').onclick = async () => {
      try { await api('POST', `/v1/hospital/emergencies/${p.emergencyId}/arrived`, {}); toast('Marked as arrived. Case closed.'); S.detail = null; drawRight(); refresh(false); } catch (e) { toast(e.message); }
    };
    if (q('back')) q('back').onclick = () => { S.handingBack = true; drawRight(); };
    if (q('backNo')) q('backNo').onclick = () => { S.handingBack = false; drawRight(); };
    if (q('backConfirm')) q('backConfirm').onclick = async () => {
      try { await api('POST', `/v1/hospital/emergencies/${p.emergencyId}/cancel`, { reason: q('backReason').value }); toast('Handed back. The others are being asked again.'); S.detail = null; S.handingBack = false; drawRight(); refresh(false); } catch (e) { toast(e.message); }
    };
  }

  // ------------------------------------------------------------------ services & availability
  function drawSettings() {
    const s = $('#settings'); if (!s) return;
    if (!S.showSettings) { s.innerHTML = ''; return; }
    const h = S.hospital;
    s.innerHTML = `
      <div class="card stack" style="margin-top:16px">
        <h3>What your hospital can handle</h3>
        <p class="small muted">You declare this yourself. GoldenBay does not verify it. Requests are only sent to hospitals that declare the service needed.</p>
        <div class="checks">${SERVICES.map((k) => `<label><input type="checkbox" data-svc="${k}" ${(h.services || []).includes(k) ? 'checked' : ''}> ${esc(SERVICE_LABELS[k])}</label>`).join('')}</div>
        <button class="btn small tan" id="saveSvc">Save services</button>
        <hr style="border:0;border-top:1px dashed var(--card-line);width:100%">
        <label class="switch"><input type="checkbox" id="unav" ${h.unavailable ? 'checked' : ''}> <b>Temporarily can't take patients</b></label>
        <label class="field">Reason (optional)<input type="text" id="unavWhy" maxlength="120" value="${esc(h.unavailableReason || '')}" placeholder="e.g. cath lab under maintenance"></label>
        <button class="btn small tan" id="saveUnav">Save</button>
      </div>`;
    $('#saveSvc').onclick = async () => {
      const services = [...s.querySelectorAll('[data-svc]')].filter((c) => c.checked).map((c) => c.dataset.svc);
      try { S.hospital = (await api('PUT', '/v1/hospital/me', { services })).hospital; toast('Services saved.'); } catch (e) { toast(e.message); }
    };
    $('#saveUnav').onclick = async () => {
      try {
        S.hospital = (await api('PUT', '/v1/hospital/me', { unavailable: $('#unav').checked, unavailableReason: $('#unavWhy').value })).hospital;
        drawHeader(); toast(S.hospital.unavailable ? 'You will not be sent new requests.' : 'You are receiving requests again.');
      } catch (e) { toast(e.message); }
    };
  }

  // ------------------------------------------------------------------ go
  if (S.token) start(); else showLogin();
})();
