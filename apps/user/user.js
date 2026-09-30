// GoldenBay — User App (family member or bystander).
//
// The one job: when someone collapses, the right hospital — one that has
// already said "yes" — knows who is coming BEFORE the patient arrives.
//
//   Emergency tab : tap what is happening (or say it), confirm who the patient is,
//                   send. The agent asks every capable hospital nearby at once.
//   Profiles tab  : the medical details hospitals see ONLY after they accept.
//   Family tab    : the join code, and honest privacy facts.
//
// "Call 112" is on every screen. GoldenBay never replaces it.

(() => {
  const { esc, toast, keep, makeApi, goLive, mmss, secSince, chips, fmtDate } = GBX;
  const { EMERGENCY_TYPES, COST_PREFERENCES } = GB;
  const ACTIVE = ['SEARCHING', 'NO_ACCEPT_YET', 'ACCEPTED', 'DIVERTED'];
  // Short, everyday headings for each step (the sentence under it comes from the server).
  const STEP_TITLE = {
    goal: 'Started', mask: 'Kept your details private', send_offers: 'Asking hospitals', widen_search: 'Looking a little further',
    tell_family: 'What to do now', understand: 'Read your message', accepted: 'A hospital said YES', offer_declined: 'A hospital said no',
    hospital_cancelled: 'A hospital pulled out', arrived: 'Arrived', hospital_seen: 'The hospital is ready', divert: 'Changed hospital', cancelled: 'Cancelled', agent_plan: 'Got the hospital ready',
  };

  const S = {
    token: keep.get('gb_family_token'),
    family: null, me: null, members: [],
    profiles: [],
    tab: 'home', ai: 'rules',
    // emergency form
    patientId: null, picked: new Set(), text: '', useDemoLocation: true,
    // active emergency
    em: null, showLog: false, hospitals: [], showDoctor: false,
    live: null, driveTimer: null, sending: false,
  };
  const api = makeApi(() => (S.token ? { 'x-family-token': S.token } : {}));
  const $ = (s) => document.querySelector(s);
  const root = $('#app');

  // ---- shared bits of the phone layout
  const initials = (n) => String(n || '?').replace(/\s*\(DEMO\)\s*/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const header = () => `<div class="hdr"><div class="logo">${icon('heartPulse', { size: 26 })}</div>
      <div class="grow"><div class="brand">GoldenBay<span class="ai-pill ${S.ai === 'gemini' ? 'on' : ''}">${S.ai === 'gemini' ? '✦ Gemini' : 'Rules mode'}</span></div><div class="tagline">Right hospital. Already prepared.</div></div>
      <a class="call112" href="tel:112">${icon('phone', { size: 16 })} 112</a></div>`;
  const banner = () => `<div class="demo-banner">${icon('alertTriangle', { size: 18 })}<span>Demo with synthetic data — not a real emergency service. In a real emergency in India, call <b>112</b>.</span></div>`;

  // =================================================================== sign in / join
  function showJoin(msg) {
    if (S.live) { S.live.stop(); S.live = null; }
    root.innerHTML = `<div class="phone">
      ${header()}${banner()}
      <div class="pad">
        <div class="card stack" style="margin-top:18px">
          <h2>Join your family</h2>
          ${msg ? `<div class="note bad">${esc(msg)}</div>` : ''}
          <label class="field">Your name (so the family knows which phone this is)<input type="text" id="who" maxlength="40" placeholder="e.g. Aisha's phone"></label>
          <label class="field">Family code<input type="text" id="code" maxlength="20" placeholder="e.g. SHARMA-DEMO" autocapitalize="characters"></label>
          <button class="btn" id="join">Join with this code</button>
          <button class="btn ghost" id="demo">Try the demo family (Sharma, made-up)</button>
        </div>
        <div class="card stack">
          <h3>New here? Start a family</h3>
          <label class="field">Family name<input type="text" id="fname" maxlength="40" placeholder="e.g. Verma family"></label>
          <button class="btn tan" id="create">Create family</button>
          <p class="small muted">You get a code to share with relatives. Each phone gets its own secret key — nobody else's family can see your records.</p>
        </div>
      </div></div>`;
    const go = async (p) => {
      try {
        const r = await api('POST', p.path, p.body);
        S.token = r.token; keep.set('gb_family_token', r.token);
        await boot();
      } catch (e) { showJoin(e.message); }
    };
    $('#join').onclick = () => go({ path: '/v1/families/join', body: { joinCode: $('#code').value, memberLabel: $('#who').value || 'A phone' } });
    $('#demo').onclick = () => go({ path: '/v1/families/join', body: { joinCode: 'SHARMA-DEMO', memberLabel: $('#who').value || 'Demo phone' } });
    $('#create').onclick = () => go({ path: '/v1/families', body: { name: $('#fname').value || 'My family', memberLabel: $('#who').value || 'My phone' } });
  }

  function signOut() {
    S.token = null; keep.del('gb_family_token'); S.em = null; stopDrive();
    showJoin();
  }

  // =================================================================== boot
  async function boot() {
    try {
      const f = await api('GET', '/v1/family');
      S.family = f.family; S.me = f.me; S.members = f.members;
      await loadProfiles();
      const list = (await api('GET', '/v1/emergencies')).emergencies;
      S.em = list.find((e) => ACTIVE.includes(e.status)) || null;
    } catch (e) { return e.status === 401 ? showJoin('Please join again.') : showJoin(e.message); }
    try { S.hospitals = (await api('GET', '/v1/hospitals/public')).hospitals; } catch { /* optional */ }
    try { S.ai = (await api('GET', '/v1/health')).ai === 'gemini' ? 'gemini' : 'rules'; } catch { /* optional */ }
    S.tab = S.em ? 'sos' : 'home';
    if (!S.patientId) S.patientId = (S.profiles.find((p) => p.id === S.me.profileId) || S.profiles[0] || {}).id || null;
    drawShell();
    if (!S.live) {
      S.live = goLive({
        api, events: ['emergency:update', 'agent:action'],
        onEvent: (name, data) => { if (name === 'emergency:update' && S.em && data.id === S.em.id) { setEm(data); } else if (name === 'agent:action') pollEm(); },
        onPoll: pollEm,
      });
    }
    setInterval(tickTimers, 1000);
  }

  async function loadProfiles() { S.profiles = (await api('GET', '/v1/profiles')).profiles; }

  async function pollEm() {
    if (!S.token || !S.em) return;
    const id = S.em.id;
    try {
      const e = (await api('GET', `/v1/emergencies/${id}`)).emergency;
      if (S.em && S.em.id === id) setEm(e);   // ignore a late answer for an emergency the user already closed
    } catch { /* try again next tick */ }
  }

  function setEm(e) {
    const before = S.em;
    S.em = e;
    if (before && before.status !== e.status && e.status === 'ACCEPTED') toast(`${e.hospital?.name || 'A hospital'} said yes.`);
    if (!ACTIVE.includes(e.status)) stopDrive();
    if (S.tab === 'sos') drawTab();
  }

  // =================================================================== shell & tabs
  function drawShell() {
    root.innerHTML = `<div class="phone">
      ${header()}${banner()}
      <div class="pad" id="tab"></div>
      <div class="tabbar">
        <button data-t="home">${icon('home')}<span>Home</span></button>
        <button data-t="profiles">${icon('users')}<span>Profiles</span></button>
        <button data-t="sos">${icon('heartPulse')}<span>Emergency</span></button>
        <button data-t="more">${icon('menu')}<span>More</span></button>
      </div></div>`;
    document.querySelectorAll('.tabbar button').forEach((b) => b.onclick = () => go(b.dataset.t));
    drawTab();
  }

  function go(tab) { S.tab = tab; drawTab(); window.scrollTo({ top: 0 }); }

  function drawTab() {
    const el = $('#tab'); if (!el) return;
    document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.t === S.tab));
    if (S.tab === 'home') return drawHome(el);
    if (S.tab === 'sos') return S.em ? drawActive(el) : drawSos(el);
    if (S.tab === 'profiles') return drawProfiles(el);
    return drawMore(el);
  }

  // =================================================================== HOME
  function drawHome(el) {
    const now = new Date(), h = now.getHours();
    const greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const p = S.profiles.find((x) => x.id === S.patientId) || S.profiles[0];
    const live = S.em && ACTIVE.includes(S.em.status);
    el.innerHTML = `
      <div style="margin-top:16px"><h1 class="h1">${greet}</h1>
        <div class="date">${esc(now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' }))}</div></div>
      ${live ? `<button class="card row" id="liveBanner" style="width:100%;margin-top:14px;border:2px solid var(--crimson);text-align:left">
          <span class="tag crit">IN PROGRESS</span><span class="grow"><b>${esc(S.em.patient.firstName)}'s emergency</b><br><span class="small muted">Tap to see where things stand</span></span>${icon('chevronRight')}</button>` : ''}
      <div style="margin-top:16px"><button class="sos-card" id="sosGo">
        <span class="ico">${icon('heartPulse', { size: 28 })}</span>
        <span class="grow"><b>Emergency SOS</b><span class="s">Ask nearby hospitals — the one that says yes gets the details first</span></span>
        ${icon('chevronRight')}</button></div>

      <div class="section-head"><div class="section-title">Active profile</div><button class="link" id="switch">Switch</button></div>
      ${p ? `<div class="card row" style="align-items:flex-start;gap:16px">
          <div class="avatar big av${S.profiles.indexOf(p) % 4}">${esc(initials(p.fullName))}</div>
          <div class="grow"><h3>${esc(p.fullName)}</h3><div class="small muted">${esc(p.relation || '')} · Age ${esc(p.age ?? '?')}</div>
            <div style="margin-top:8px">${(p.allergies || []).map((a) => `<span class="chip need">${icon('alertTriangle', { size: 14 })}${esc(a)}</span>`).join('')}
            ${(p.medications || []).slice(0, 1).map((m) => `<span class="chip">${icon('pill', { size: 14 })}${esc(m)}</span>`).join('')}</div></div></div>`
        : '<div class="card muted">No profile yet — add one in the Profiles tab.</div>'}

      <div class="section-head"><div class="section-title">Family</div><button class="link" id="seeAll">See all</button></div>
      <div class="list">${S.profiles.slice(0, 4).map((x, i) => `
        <button class="list-item" data-prof="${esc(x.id)}">
          <div class="avatar av${i % 4}">${esc(initials(x.fullName))}</div>
          <div><div class="name">${esc(x.fullName)}${x.id === S.patientId ? '<span class="badge-active">Active</span>' : ''}</div>
            <div class="meta">${esc(x.relation || '')}, Age ${esc(x.age ?? '?')}</div></div>
          <span class="chev">${icon('chevronRight')}</span></button>`).join('')}</div>`;
    $('#sosGo').onclick = () => go('sos');
    $('#seeAll').onclick = () => go('profiles');
    $('#switch').onclick = chooseActive;
    if ($('#liveBanner')) $('#liveBanner').onclick = () => go('sos');
    el.querySelectorAll('[data-prof]').forEach((b) => b.onclick = () => { S.patientId = b.dataset.prof; go('profiles'); });
  }

  function chooseActive() {
    const back = document.createElement('div'); back.className = 'sheet-back';
    back.innerHTML = `<div class="sheet stack"><h2>Who is the active profile?</h2>
      <p class="small muted">The Emergency tab starts with this person.</p>
      <div class="list">${S.profiles.map((x, i) => `<button class="list-item" data-pick="${esc(x.id)}"><div class="avatar av${i % 4}">${esc(initials(x.fullName))}</div><div><div class="name">${esc(x.fullName)}</div><div class="meta">${esc(x.relation || '')}, Age ${esc(x.age ?? '?')}</div></div></button>`).join('')}</div>
      <button class="btn ghost" id="close">Close</button></div>`;
    document.body.appendChild(back);
    $('#close').onclick = () => back.remove();
    back.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => { S.patientId = b.dataset.pick; back.remove(); drawTab(); });
  }

  function tickTimers() {
    document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = mmss(secSince(el.dataset.since)); });
  }

  // =================================================================== EMERGENCY: send
  function drawSos(el) {
    const p = S.profiles.find((x) => x.id === S.patientId);
    el.innerHTML = `
      <div class="note" style="margin-top:14px"><b>Life in danger? Call 112 first.</b> GoldenBay helps the right hospital get ready — it does not replace 112.</div>

      <div class="section-title">1 · Who needs help?</div>
      <div class="pat-pick">${S.profiles.map((x) => `<button data-pat="${esc(x.id)}" class="${x.id === S.patientId ? 'on' : ''}">${esc(shortName(x.fullName))}</button>`).join('') || '<span class="muted">Add a profile first (Profiles tab).</span>'}</div>
      ${p && p.consent?.type === 'on-behalf' ? `<div class="note bad" style="margin-top:8px">${esc(shortName(p.fullName))}'s profile has not been confirmed by them yet, so it cannot be sent to hospitals. <b>Call 112 now.</b></div>` : ''}
      ${p && p.stale ? `<div class="note warn" style="margin-top:8px">This profile was last updated ${esc(p.daysSinceUpdate)} days ago. Hospitals will see that.</div>` : ''}

      <div class="section-title">2 · What is happening? (tap all that apply)</div>
      <div class="types">${EMERGENCY_TYPES.map((t) => `<button data-type="${esc(t.id)}" class="${S.picked.has(t.id) ? 'on' : ''}">${esc(t.label)}</button>`).join('')}</div>

      <div class="section-title">3 · Anything else? (type or speak)</div>
      <div class="card stack">
        <textarea id="txt" maxlength="2000" placeholder="e.g. Papa has chest pain and is sweating">${esc(S.text)}</textarea>
        <div class="row"><button class="btn tan small" id="mic">🎤 Speak</button><span class="small muted" id="micnote">Your words are masked (phone numbers, ID numbers, addresses) before anything is analysed.</span></div>
      </div>

      <div class="section-title">Location</div>
      <div class="card">
        <label class="row"><input type="checkbox" id="demoLoc" ${S.useDemoLocation ? 'checked' : ''}> <span>Use the demo location (Delhi test area) — the fictional hospitals are placed around it</span></label>
        <p class="small muted" style="margin-top:6px">Untick to use this phone's real location. Only your real location is shared, and only while an emergency is open.</p>
      </div>

      <div style="margin-top:18px"><button class="btn huge" id="send" ${S.sending ? 'disabled' : ''}>Ask hospitals now</button></div>
      <p class="small muted" style="margin-top:8px">Nearby hospitals that can handle this will be asked at once. The first to say yes gets the details.</p>`;
    el.querySelectorAll('[data-pat]').forEach((b) => b.onclick = () => { S.patientId = b.dataset.pat; drawSos(el); });
    el.querySelectorAll('[data-type]').forEach((b) => b.onclick = () => { const id = b.dataset.type; S.picked.has(id) ? S.picked.delete(id) : S.picked.add(id); S.text = $('#txt').value; drawSos(el); });
    $('#txt').oninput = (e) => { S.text = e.target.value; };
    $('#demoLoc').onchange = (e) => { S.useDemoLocation = e.target.checked; };
    setupMic();
    $('#send').onclick = () => confirmPatient();
  }

  // "Chest pain, Can't breathe +3 more" instead of a long list
  const shortTypes = (labels) => { const l = labels || []; return !l.length ? 'emergency' : l.slice(0, 2).join(', ') + (l.length > 2 ? ` +${l.length - 2} more` : ''); };
  const shortName = (n) => String(n || '').replace(/\s*\(DEMO\)\s*/i, '').split(/\s+/)[0];

  function setupMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const btn = $('#mic');
    if (!SR) { btn.disabled = true; $('#micnote').textContent = 'Voice is not supported in this browser — please type.'; return; }
    btn.onclick = () => {
      const rec = new SR(); rec.lang = 'en-IN'; rec.interimResults = false;
      btn.textContent = 'Listening…';
      rec.onresult = (ev) => { S.text = ((S.text ? S.text + ' ' : '') + ev.results[0][0].transcript).trim(); $('#txt').value = S.text; };
      rec.onerror = () => toast('Could not hear that — please type instead.');
      rec.onend = () => { btn.textContent = '🎤 Speak'; };
      try { rec.start(); } catch { btn.textContent = '🎤 Speak'; }
    };
  }

  // Fix #3: the caller must confirm who the patient is before anything is sent.
  function confirmPatient() {
    S.text = ($('#txt') || {}).value || S.text;
    const p = S.profiles.find((x) => x.id === S.patientId);
    if (!p) return toast('Choose who needs help.');
    if (!S.picked.size && !S.text.trim()) return toast('Tap what is happening, or describe it.');
    const back = document.createElement('div');
    back.className = 'sheet-back';
    back.innerHTML = `<div class="sheet stack">
      <h2>Is this ${esc(shortName(p.fullName))}?</h2>
      <p>${esc(p.fullName.replace(/\s*\(DEMO\)/i, ''))}${p.age != null ? `, ${esc(p.age)} years` : ''}${p.bloodGroup ? ` · ${esc(p.bloodGroup)}` : ''}</p>
      <div class="note">If you send the wrong person's details, doctors could treat the wrong patient. Please check.</div>
      <button class="btn huge" id="yes">Yes — send now</button>
      <button class="btn ghost" id="no">No, go back</button></div>`;
    document.body.appendChild(back);
    $('#no').onclick = () => back.remove();
    $('#yes').onclick = async () => { back.remove(); await send(p); };
  }

  async function send(p) {
    S.sending = true;
    const body = { profileId: p.id, patientConfirmed: true, types: [...S.picked], description: S.text };
    try {
      if (S.useDemoLocation) body.useDemoLocation = true;
      else body.location = await getPosition();
      const r = await api('POST', '/v1/emergencies', body);
      S.em = r.emergency; S.picked = new Set(); S.text = ''; S.showLog = false; S.showDoctor = false;
    } catch (e) { toast(e.message, 6000); }
    S.sending = false;
    drawTab();
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('This phone cannot share its location. Tick "demo location", or call 112.'));
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
        () => reject(new Error('Location was not allowed. Allow it, tick "demo location", or call 112.')),
        { enableHighAccuracy: true, timeout: 8000 });
    });
  }

  // =================================================================== EMERGENCY: active
  function drawActive(el) {
    const e = S.em;
    const hospNotJoined = e.status === 'DIVERTED' && e.divertedTo && !e.divertedTo.joined;
    let box = '';
    if (e.status === 'SEARCHING') {
      box = `<div class="status-box"><h2>Asking hospitals…</h2>
        <div class="big-timer" data-since="${esc(e.createdAt)}">0:00</div>
        <p>${esc(e.asking.asked)} asked within ${esc(e.asking.radiusKm ?? '…')} km · ${esc(e.asking.waiting)} waiting · ${esc(e.asking.declined)} declined</p>
        <p class="small">Needs: ${esc((e.needs.required || []).join(', ') || 'emergency care')}. First hospital to say yes gets the details.</p></div>`;
    } else if (e.status === 'NO_ACCEPT_YET') {
      box = `<div class="status-box dark"><h2>No hospital has said yes yet</h2>
        <p>${esc(e.fallback?.message || 'Call 112 now.')}</p>
        <div class="row wrap" style="margin-top:12px"><a class="btn white small" href="tel:112">Call 112</a>
        ${e.fallback?.hospital?.navigateUrl ? `<a class="btn linew small" target="_blank" rel="noopener" href="${esc(e.fallback.hospital.navigateUrl)}">Navigate to ${esc(e.fallback.hospital.name)}</a>` : ''}</div>
        <p class="small" style="margin-top:10px">We keep asking in the background. If one says yes, this screen changes.</p></div>`;
    } else if (e.status === 'ACCEPTED') {
      const h = e.hospital;
      box = `<div class="status-box ok">${e.simulatedAccept ? '<span class="tag" style="background:rgba(255,255,255,.2);color:#fff;margin-bottom:8px">DEMO · AUTOMATIC ACCEPT</span>' : ''}<h2>✔ ${esc(h.name)} said yes</h2>
        <p>${e.timeToAcceptSec != null && e.timeToAcceptSec >= 1 ? 'Said yes in ' + esc(e.timeToAcceptSec) + ' seconds.' : 'Said yes right away.'} Their team can see ${esc(e.patient.firstName)}'s details now — go there.</p>
        <div class="row wrap" style="margin-top:12px">
          <a class="btn white ok-t small" target="_blank" rel="noopener" href="${esc(h.navigateUrl)}">Navigate</a>
          <a class="btn linew small" href="tel:${esc(h.phone)}">Call hospital</a></div></div>
        ${liveShareCard(h)}`;
    } else if (e.status === 'DIVERTED') {
      const d = e.divertedTo;
      box = d.joined
        ? `<div class="status-box ok"><h2>${esc(d.name)} has been alerted</h2><p>It is on GoldenBay, so it already has ${esc(e.patient.firstName)}'s details. It did not say yes in advance — please call to confirm.</p>
           <div class="row wrap" style="margin-top:12px">${e.hospital ? `<a class="btn white ok-t small" target="_blank" rel="noopener" href="${esc(e.hospital.navigateUrl)}">Navigate</a><a class="btn linew small" href="tel:${esc(e.hospital.phone)}">Call hospital</a>` : ''}</div></div>${e.hospital ? liveShareCard(e.hospital) : ''}`
        : `<div class="status-box wait"><h2>${esc(d.name)} is not on GoldenBay</h2><p>We cannot send anything ahead. Show the doctor ${esc(e.patient.firstName)}'s details from this phone when you arrive.</p>
           <button class="btn white wait-t" style="margin-top:12px" id="doctor">Show to doctor</button></div>`;
    } else if (e.status === 'ARRIVED') {
      box = `<div class="status-box ok"><h2>Arrived</h2><p>${esc(e.hospital?.name || 'The hospital')} marked ${esc(e.patient.firstName)} as arrived. This case is closed.</p></div>`;
    } else {
      box = `<div class="status-box dark"><h2>This emergency is closed</h2></div>`;
    }
    const open = ACTIVE.includes(e.status);
    el.innerHTML = `
      <div style="margin-top:14px" class="stack">
        <div class="row spread"><div><span class="tag crit">${esc(e.urgency)}</span> <b>${esc(e.patient.firstName)}</b> · ${esc(shortTypes(e.typeLabels))}</div><span class="small muted">#${esc(e.ref)}</span></div>
        ${box}
        ${e.picture?.questionsForCaller?.length ? `<div class="card"><h3>Good to find out</h3><p class="small muted">The hospital may ask you these.</p>${e.picture.questionsForCaller.map((q) => `<div class="note" style="margin-top:8px">${esc(q)}</div>`).join('')}</div>` : ''}
        <div class="card">
          <div class="row spread"><h3>What's happening</h3>${(e.log || []).length > 1 ? `<button class="link" id="togLog">${S.showLog ? 'Show less' : 'Show all steps'}</button>` : ''}</div>
          ${(S.showLog ? (e.log || []).slice().reverse() : (e.log || []).slice(-1)).map((l) => `<div class="logline"><span class="logtitle">${esc(STEP_TITLE[l.tool] || 'Update')}</span> <span class="small muted">${esc(new Date(l.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit' }))}</span><br>${esc(l.say || l.reason)}</div>`).join('')}
        </div>
        ${open ? `<button class="btn ghost" id="divert">We're going to a different hospital</button>
                  <button class="btn tan" id="cancel">${e.status === 'SEARCHING' ? 'Cancel this emergency' : 'Finish — start a new emergency'}</button>` : `<button class="btn" id="done">Back to start</button>`}
      </div>`;
    const q = (id) => document.getElementById(id);
    if (q('togLog')) q('togLog').onclick = () => { S.showLog = !S.showLog; drawActive(el); };
    if (q('doctor')) q('doctor').onclick = showDoctor;
    if (q('divert')) q('divert').onclick = chooseOther;
    if (q('cancel')) q('cancel').onclick = async () => {
      if (!confirm(e.status === 'SEARCHING' ? 'Cancel this emergency? Hospitals will be told to stand down.' : 'Close this emergency and start a new one? The hospital will be told.')) return;
      try { await api('POST', `/v1/emergencies/${e.id}/cancel`, {}); S.em = null; stopDrive(); go('sos'); toast('Closed. Ready for a new emergency.'); } catch (er) { toast(er.message); }
    };
    if (q('done')) q('done').onclick = () => { S.em = null; stopDrive(); go('sos'); };
    const ds = q('driveDemo'); if (ds) ds.onclick = () => startDrive(e);
    const rl = q('realLoc'); if (rl) rl.onclick = () => startReal(e);
    const sd = q('stopShare'); if (sd) sd.onclick = () => { stopDrive(); drawTab(); };
  }

  // Live location: the hospital sees how far away the patient is.
  function liveShareCard(h) {
    return `<div class="card stack"><h3>Let the hospital see how close you are</h3>
      <p class="small muted">Sends this phone's position to ${esc(h.name)} only, while this emergency is open.</p>
      <div class="row wrap">
        <button class="btn small" id="realLoc" ${S.driveTimer ? 'disabled' : ''}>Share my live location</button>
        <button class="btn small tan" id="driveDemo" ${S.driveTimer ? 'disabled' : ''}>Demo: simulate driving there</button>
        ${S.driveTimer ? '<button class="btn small ghost" id="stopShare">Stop sharing</button>' : ''}
      </div>
      ${S.driveTimer ? '<div class="note good">Sharing your position…</div>' : ''}</div>`;
  }
  let watchId = null;
  function stopDrive() {
    if (S.driveTimer) { clearInterval(S.driveTimer); S.driveTimer = null; }
    if (watchId != null && navigator.geolocation) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }
  function startReal(e) {
    if (!navigator.geolocation) return toast('This phone cannot share its location.');
    S.driveTimer = -1;
    watchId = navigator.geolocation.watchPosition(
      (pos) => api('POST', `/v1/emergencies/${e.id}/location`, { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }).catch(() => {}),
      () => { toast('Location was not allowed.'); stopDrive(); drawTab(); }, { enableHighAccuracy: true });
    drawTab();
  }
  // Clearly labelled DEMO: walks a fake position from the start point to the hospital.
  function startDrive(e) {
    const from = e.location, to = e.hospital; let i = 0; const steps = 20;
    S.driveTimer = setInterval(async () => {
      i++; const t = Math.min(1, i / steps);
      try { await api('POST', `/v1/emergencies/${e.id}/location`, { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t }); } catch { /* ignore */ }
      if (t >= 1) { stopDrive(); drawTab(); }
    }, 1500);
    drawTab();
  }

  function chooseOther() {
    const e = S.em;
    const hs = S.hospitals.map((h) => ({ ...h, km: dist(e.location, h) })).sort((a, b) => a.km - b.km);
    const back = document.createElement('div'); back.className = 'sheet-back';
    back.innerHTML = `<div class="sheet stack"><h2>Which hospital are you going to?</h2>
      <p class="small muted">If it is on GoldenBay it gets an alert and the details now. If not, you will get a "Show to doctor" screen.</p>
      ${hs.map((h) => `<button class="card row spread" style="width:100%;text-align:left;cursor:pointer" data-h="${esc(h.id)}"><span><b>${esc(h.name)}</b><br><span class="small muted">${h.km.toFixed(1)} km · ${esc(h.type)}</span></span><span class="tag ${h.joined ? 'ok' : 'line'}">${h.joined ? 'On GoldenBay' : 'Not on GoldenBay'}</span></button>`).join('')}
      <button class="btn ghost" id="close">Close</button></div>`;
    document.body.appendChild(back);
    $('#close').onclick = () => back.remove();
    back.querySelectorAll('[data-h]').forEach((b) => b.onclick = async () => {
      try { setEm((await api('POST', `/v1/emergencies/${e.id}/divert`, { hospitalId: b.dataset.h })).emergency); back.remove(); } catch (er) { toast(er.message); }
    });
  }
  function dist(a, b) {
    const R = 6371, rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // "Show to doctor" — the patient's details, big, on the family's own phone.
  function showDoctor() {
    const p = S.profiles.find((x) => x.id === S.em.patient.id);
    if (!p) return toast('Profile not found.');
    const c = (p.emergencyContacts || [])[0];
    const back = document.createElement('div'); back.className = 'sheet-back';
    back.innerHTML = `<div class="sheet"><div class="doctor-screen">
      <h2>${esc(p.fullName.replace(/\s*\(DEMO\)/i, ''))}</h2>
      <div class="v">${esc(p.age ?? '?')} years · ${esc(p.sex || '—')}${p.bloodGroup ? ` · Blood group ${esc(p.bloodGroup)}` : ''}</div>
      <div class="k">Allergies</div><div class="v" style="color:var(--dark)">${esc((p.allergies || []).join(', ') || 'none recorded')}</div>
      <div class="k">Medicines</div><div class="v">${esc((p.medications || []).join('; ') || 'none recorded')}</div>
      <div class="k">Conditions</div><div class="v">${esc((p.conditions || []).join(', ') || 'none recorded')}</div>
      ${(p.pastEvents || []).length ? `<div class="k">History</div><div class="v">${esc(p.pastEvents.join('; '))}</div>` : ''}
      ${c ? `<div class="k">Family contact</div><div class="v">${esc(c.name)} (${esc(c.relation)}) · ${esc(c.phone)}</div>` : ''}
      <div class="k">Source</div><div class="small">Entered by the family — not verified by a clinician. Last updated ${esc(fmtDate(p.lastMedicalUpdate))}.</div>
    </div><button class="btn ghost" style="margin-top:14px" id="close">Close</button></div>`;
    document.body.appendChild(back);
    $('#close').onclick = () => back.remove();
  }

  // =================================================================== PROFILES
  function drawProfiles(el) {
    el.innerHTML = `
      <div class="section-title">Profiles — what hospitals see only after they say yes</div>
      ${S.profiles.map((p) => profileCard(p)).join('') || '<div class="card muted">No profiles yet.</div>'}
      <div style="margin-top:14px"><button class="btn" id="add">Add a profile</button></div>
      <div id="logbox"></div>`;
    $('#add').onclick = () => profileForm(null);
    el.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => profileForm(S.profiles.find((p) => p.id === b.dataset.edit)));
    el.querySelectorAll('[data-confirm]').forEach((b) => b.onclick = async () => {
      if (!confirm('Confirm this is YOUR profile and that you agree to it being shown to a hospital in an emergency?')) return;
      try { await api('POST', `/v1/profiles/${b.dataset.confirm}/confirm`, {}); await loadProfiles(); toast('Confirmed.'); drawTab(); } catch (e) { toast(e.message); }
    });
    el.querySelectorAll('[data-viewed]').forEach((b) => b.onclick = () => showAccessLog(b.dataset.viewed));
    el.querySelectorAll('[data-export]').forEach((b) => b.onclick = () => exportProfile(b.dataset.export));
    el.querySelectorAll('[data-erase]').forEach((b) => b.onclick = async () => {
      if (!confirm('Delete this profile and every record linked to it? This cannot be undone.')) return;
      try { await api('DELETE', `/v1/privacy/erase/${b.dataset.erase}`); await loadProfiles(); toast('Erased.'); drawTab(); } catch (e) { toast(e.message); }
    });
  }

  const CONSENT = { self: 'Confirmed by the patient', parental: 'Declared by a parent or guardian', 'on-behalf': 'Added by a relative — not confirmed yet' };
  function profileCard(p) {
    const cType = p.consent?.type;
    return `<div class="card stack">
      <div class="row spread"><h3>${esc(p.fullName)}</h3><span class="tag line">${esc(p.relation || '')}</span></div>
      <div>${esc(p.age ?? '?')} yrs · ${esc(p.sex || '—')} · ${esc(p.bloodGroup || 'blood group unknown')}</div>
      <div>${p.allergies?.length ? chips(p.allergies.map((a) => 'Allergy: ' + a), 'need') : '<span class="muted small">No allergies recorded</span>'}</div>
      <div class="small">${esc(CONSENT[cType] || 'Consent not recorded')}</div>
      ${cType === 'on-behalf' ? `<div class="note bad">Cannot be sent to hospitals until this person confirms it.</div>` : ''}
      ${p.stale ? `<div class="note warn">Last medical update ${esc(p.daysSinceUpdate)} days ago — please review.</div>` : `<div class="small muted">Medical details updated ${esc(fmtDate(p.lastMedicalUpdate))}</div>`}
      <div class="row wrap">
        <button class="btn small tan" data-edit="${esc(p.id)}">Edit</button>
        ${cType === 'on-behalf' && (p.age == null || p.age >= 18) ? `<button class="btn small" data-confirm="${esc(p.id)}">This is me — confirm</button>` : ''}
        <button class="btn small ghost" data-viewed="${esc(p.id)}">Who viewed my data</button>
        <button class="btn small ghost" data-export="${esc(p.id)}">Download my data</button>
        <button class="btn small ghost" data-erase="${esc(p.id)}">Erase</button>
      </div></div>`;
  }

  async function showAccessLog(id) {
    try {
      const { entries } = await api('GET', `/v1/profiles/${id}/access-log`);
      const p = S.profiles.find((x) => x.id === id);
      const back = document.createElement('div'); back.className = 'sheet-back';
      back.innerHTML = `<div class="sheet stack"><h2>Who viewed ${esc(shortName(p.fullName))}'s data</h2>
        ${entries.length ? entries.map((a) => `<div class="card"><b>${esc(a.hospitalName)}</b><div class="small muted">${esc(a.what)} · ${esc(new Date(a.at).toLocaleString('en-IN'))}</div></div>`).join('') : '<div class="note">Nobody has viewed this profile yet. A hospital can only open details after it accepts a patient — and every time is listed here.</div>'}
        <button class="btn ghost" id="close">Close</button></div>`;
      document.body.appendChild(back);
      $('#close').onclick = () => back.remove();
    } catch (e) { toast(e.message); }
  }

  async function exportProfile(id) {
    try {
      const data = await api('GET', `/v1/privacy/export/${id}`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = 'my-goldenbay-data.json'; a.click();
    } catch (e) { toast(e.message); }
  }

  function profileForm(p) {
    const isNew = !p;
    const back = document.createElement('div'); back.className = 'sheet-back';
    const v = (k, d = '') => esc(p ? (Array.isArray(p[k]) ? p[k].join(', ') : (p[k] ?? d)) : d);
    const c = (p && p.emergencyContacts && p.emergencyContacts[0]) || {};
    back.innerHTML = `<div class="sheet stack"><h2>${isNew ? 'Add a profile' : 'Edit profile'}</h2>
      <p class="small muted">Only enter what a doctor needs in an emergency. Made-up data only in this prototype.</p>
      <label class="field">Full name<input type="text" id="f_name" maxlength="80" value="${v('fullName')}"></label>
      <div class="row"><label class="field grow">Relation<input type="text" id="f_rel" maxlength="30" value="${v('relation')}"></label>
        <label class="field grow">Age<input type="number" id="f_age" min="0" max="120" value="${v('age')}"></label></div>
      <div class="row"><label class="field grow">Sex<select id="f_sex"><option value="">—</option>${['F', 'M', 'Other'].map((s) => `<option ${p?.sex === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
        <label class="field grow">Blood group<input type="text" id="f_bg" maxlength="3" placeholder="B+" value="${v('bloodGroup')}"></label></div>
      <label class="field">Allergies (comma separated)<input type="text" id="f_all" value="${v('allergies')}"></label>
      <label class="field">Medicines (comma separated)<input type="text" id="f_med" value="${v('medications')}"></label>
      <label class="field">Conditions (comma separated)<input type="text" id="f_con" value="${v('conditions')}"></label>
      <label class="field">Past events (comma separated)<input type="text" id="f_past" value="${v('pastEvents')}"></label>
      <label class="field">Cost preference<select id="f_cost">${COST_PREFERENCES.map((o) => `<option value="${o.id}" ${p?.costPreference === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
      <div class="row"><label class="field grow">Emergency contact name<input type="text" id="f_cn" maxlength="40" value="${esc(c.name || '')}"></label>
        <label class="field grow">Phone<input type="tel" id="f_cp" maxlength="20" value="${esc(c.phone || '')}"></label></div>
      ${isNew ? `<label class="field">Whose profile is this?<select id="f_consent">
          <option value="self">My own — I agree to it being shown to a hospital in an emergency</option>
          <option value="parental">My child's — I am the parent or guardian</option>
          <option value="on-behalf">A relative's — they must confirm it later</option></select></label>` : ''}
      <button class="btn" id="save">Save</button><button class="btn ghost" id="close">Cancel</button></div>`;
    document.body.appendChild(back);
    $('#close').onclick = () => back.remove();
    $('#save').onclick = async () => {
      const contactName = $('#f_cn').value.trim();
      const body = {
        fullName: $('#f_name').value, relation: $('#f_rel').value, age: $('#f_age').value, sex: $('#f_sex').value || null,
        bloodGroup: $('#f_bg').value, allergies: $('#f_all').value, medications: $('#f_med').value, conditions: $('#f_con').value,
        pastEvents: $('#f_past').value, costPreference: $('#f_cost').value,
        emergencyContacts: contactName ? [{ name: contactName, relation: 'Family', phone: $('#f_cp').value }] : [],
      };
      try {
        if (isNew) await api('POST', '/v1/profiles', { ...body, consentType: $('#f_consent').value });
        else await api('PUT', `/v1/profiles/${p.id}`, body);
        await loadProfiles(); if (!S.patientId && S.profiles[0]) S.patientId = S.profiles[0].id;
        back.remove(); toast('Saved.'); drawTab();
      } catch (e) { toast(e.message, 5000); }
    };
  }

  // =================================================================== FAMILY
  async function drawMore(el) {
    let notice = null; try { notice = await api('GET', '/v1/privacy/notice'); } catch { /* optional */ }
    if (S.tab !== 'more') return;
    el.innerHTML = `
      <div class="section-title" style="margin-top:16px">Your family</div>
      <div class="card stack">
        <h2>${esc(S.family.name)}</h2>
        <div class="small muted">This phone: ${esc(S.me.label)}</div><div>Family code: <b style="font-size:22px;letter-spacing:.06em">${esc(S.family.joinCode)}</b></div>
        <p class="small muted">Relatives use this code to join. Each phone gets its own secret key.</p>
        <div>${S.members.map((m) => `<span class="chip">${esc(m.label)}</span>`).join('')}</div>
      </div>
      <div class="section-title">Privacy — plain facts</div>
      <div class="card stack">
        <div class="note">${esc(notice?.status?.claim || 'Prototype. Not compliant, not certified.')}</div>
        <p class="small"><b>Hospitals see first:</b> a no-name card — age range, what was reported, how far away.<br>
        <b>After a hospital says yes:</b> first name, allergies, medicines, conditions, blood group, a family contact.<br>
        <b>Never sent:</b> Aadhaar, PAN, home address, email, insurance details, document photos.</p>
        <p class="small muted">Every time a hospital opens your details it is listed under "Who viewed my data" (Profiles tab).</p>
      </div>
      ${S.family.isDemo ? `<div class="section-title">Demo</div>
      <div class="card stack"><p class="small muted">Closes every open emergency and puts the fictional hospitals back to their starting settings, so you can run the demo again from the start.</p>
        <button class="btn ghost" id="reset">Reset demo</button></div>` : ''}
      <div style="margin-top:14px"><button class="btn tan" id="out">Sign out of this phone</button></div>`;
    if ($('#reset')) $('#reset').onclick = async () => {
      if (!confirm('Reset the demo? Open emergencies close and hospitals go back to their starting settings.')) return;
      try {
        const r = await api('POST', '/v1/demo/reset', {});
        S.em = null; stopDrive(); toast(`Demo reset — closed ${r.closed} emergency(s). Ready to start again.`); go('home');
      } catch (er) { toast(er.message); }
    };
    $('#out').onclick = () => { if (confirm('Sign out of this phone?')) signOut(); };
  }

  // =================================================================== go
  if (S.token) boot(); else showJoin();
})();
