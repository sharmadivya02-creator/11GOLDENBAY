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
  const EM_STATE = { SEARCHING: 'Looking for a hospital', ACCEPTED: 'A hospital said yes', ARRIVED: 'Arrived', CANCELLED: 'Cancelled', DIVERTED: 'Moved to another hospital', NO_ACCEPT_YET: 'No hospital yet — told to call 112' };
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
    profileView: null,
    em: null, showLog: false, hospitals: [], showDoctor: false,
    live: null, driveTimer: null, sending: false,
  };
  const api = makeApi(() => (S.token ? { 'x-family-token': S.token } : {}));
  const $ = (s) => document.querySelector(s);
  const root = $('#app');
  // sheets open inside the phone frame, not over the whole browser window
  const host = () => document.querySelector('.phone') || document.body;

  // ---- shared bits of the phone layout
  const initials = (n) => String(n || '?').replace(/\s*\(DEMO\)\s*/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const header = () => `<div class="hdr"><div class="logo">${icon('heartPulse', { size: 26 })}</div>
      <div class="grow"><div class="brand">GoldenBay<span class="ai-pill ${S.ai === 'gemini' ? 'on' : ''}">${S.ai === 'gemini' ? '✦ Gemini' : 'Basic'}</span></div><div class="tagline">Ready before you arrive.</div></div>
      <a class="call112" href="tel:112">${icon('phone', { size: 16 })} 112</a></div>`;
  const banner = () => `<div class="demo-banner">${icon('alertTriangle', { size: 18 })}<span>Demo with made-up data — not a real emergency service. Real emergency in India: call <b>112</b>.</span></div>`;

  // =================================================================== sign in / join
  function showJoin(msg) {
    if (S.live) { S.live.stop(); S.live = null; }
    root.innerHTML = `<div class="phone">
      ${header()}${banner()}
      <div class="screen"><div class="pad">
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
      </div></div></div>`;
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

  window.addEventListener('gb-unauth', () => { if (S.token) { signOut(); toast('You were signed out. Please join again.', 5000); } });
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
      <div class="screen" id="scroll"><div class="pad" id="tab"></div></div>
      <div class="tabbar">
        <button data-t="home">${icon('home')}<span>Home</span></button>
        <button data-t="profiles">${icon('users')}<span>Profiles</span></button>
        <button data-t="sos">${icon('heartPulse')}<span>Emergency</span></button>
        <button data-t="more">${icon('menu')}<span>More</span></button>
      </div></div>`;
    document.querySelectorAll('.tabbar button').forEach((b) => b.onclick = () => go(b.dataset.t));
    drawTab();
  }

  function go(tab) { S.tab = tab; if (tab !== 'profiles') S.profileView = null; drawTab(); const sc = $('#scroll'); if (sc) sc.scrollTop = 0; }

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

      <div class="section-head"><h2>Active profile</h2><button class="link" id="switch">Switch</button></div>
      ${p ? `<div class="card row" style="align-items:flex-start;gap:16px">
          <div class="avatar big av${S.profiles.indexOf(p) % 4}">${esc(initials(p.fullName))}</div>
          <div class="grow"><h3>${esc(p.fullName)}</h3><div class="small muted">${esc(p.relation || '')} · Age ${esc(p.age ?? '?')}</div>
            <div style="margin-top:8px">${(p.allergies || []).map((a) => `<span class="chip need">${icon('alertTriangle', { size: 14 })}${esc(a)}</span>`).join('')}
            ${(p.medications || []).slice(0, 1).map((m) => `<span class="chip">${icon('pill', { size: 14 })}${esc(m)}</span>`).join('')}</div></div></div>`
        : '<div class="card muted">No profile yet — add one in the Profiles tab.</div>'}

      <div class="section-head"><h2>Family</h2><button class="link" id="seeAll">See all</button></div>
      <div class="plist">${S.profiles.slice(0, 4).map(profRow).join('')}</div>`;
    $('#sosGo').onclick = () => go('sos');
    $('#seeAll').onclick = () => go('profiles');
    $('#switch').onclick = chooseActive;
    if ($('#liveBanner')) $('#liveBanner').onclick = () => go('sos');
    el.querySelectorAll('[data-prof]').forEach((b) => b.onclick = () => { go('profiles'); openProfile(b.dataset.prof); });
  }

  function chooseActive() {
    const back = document.createElement('div'); back.className = 'sheet-back';
    back.innerHTML = `<div class="sheet stack"><h2>Who is the active profile?</h2>
      <p class="small muted">The Emergency tab starts with this person.</p>
      <div class="list">${S.profiles.map((x, i) => `<button class="list-item" data-pick="${esc(x.id)}"><div class="avatar av${i % 4}">${esc(initials(x.fullName))}</div><div><div class="name">${esc(x.fullName)}</div><div class="meta">${esc(x.relation || '')}, Age ${esc(x.age ?? '?')}</div></div></button>`).join('')}</div>
      <button class="btn ghost" id="close">Close</button></div>`;
    host().appendChild(back);
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
        <div class="row"><button class="btn tan small" id="mic">🎤 Speak</button><span class="small muted" id="micnote">Phone numbers, ID numbers and emails are hidden before anything is analysed. Names are not — please avoid typing full names.</span></div>
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
    host().appendChild(back);
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
        ${ACTIVE.includes(e.status) ? `<a class="card row" style="text-decoration:none;color:inherit" href="/cpr?e=${encodeURIComponent(e.id)}"><span class="logo" style="width:42px;height:42px">${icon('heartPulse', { size: 22 })}</span><span class="grow"><b>Not breathing? Open the CPR coach</b><br><span class="small muted">Camera keeps your rhythm. ${e.hospital ? `${esc(e.hospital.name)} can watch live.` : 'The hospital can watch once one says yes.'}</span></span>${icon('chevronRight')}</a>` : ''}
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
    host().appendChild(back);
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
    host().appendChild(back);
    $('#close').onclick = () => back.remove();
  }


  // =================================================================== LOCK-SCREEN QR
  // HONEST LIMIT: a website is not allowed to change a phone's wallpaper — no
  // browser offers that. So the app does everything up to that last tap:
  //   1. it takes YOUR current wallpaper photo (you pick it) — or a plain one,
  //   2. puts a small QR in the corner you choose,
  //   3. opens the phone's share sheet with the finished image, where Android
  //      shows "Set as wallpaper" / "Use as" and iPhone shows "Save Image"
  //      (then Photos → Use as Wallpaper). Setting it with no tap at all needs
  //      the Android app version (see the roadmap).
  function qrSheet(p) {
    if (!p) return;
    const back = document.createElement('div'); back.className = 'sheet-back';
    const on = !!p.qr?.enabled;
    const st = { photo: null, corner: 'bottom-right', png: null, file: null };
    back.innerHTML = `<div class="sheet stack">
      <h2>Lock-screen QR for ${esc(shortName(p.fullName))}</h2>
      <p class="small">If ${esc(shortName(p.fullName))} collapses, anyone can scan the small QR on the locked phone and see <b>blood group, allergies</b> and a button to call the family. Nothing else.</p>
      <div><div class="small muted" style="margin-bottom:6px">1 · Background</div>
        <div class="row wrap"><label class="btn small tan" style="margin:0">${icon('camera', { size: 16 })}&nbsp;Use my wallpaper photo<input type="file" id="qrPhoto" accept="image/*" hidden></label>
        <button class="btn small ghost" id="qrPlain">Plain background</button></div></div>
      <div><div class="small muted" style="margin-bottom:6px">2 · Where should the QR go?</div>
        <div class="pat-pick" id="qrCorner">${[['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right'], ['middle', 'Middle']].map(([k, l]) => `<button data-c="${k}" class="${k === 'bottom-right' ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <label class="row" style="align-items:flex-start"><input type="checkbox" id="qrPrint" ${p.qr?.printOnWallpaper ? 'checked' : ''} style="margin-top:4px">
        <span><b>Also print blood group and allergies next to the QR</b><br><span class="small muted">Works without internet, but anyone who sees the phone can read them, and turning the QR off won't remove them from an image you already saved.</span></span></label>
      <button class="btn" id="qrMake">${on ? 'Make my wallpaper (new link)' : 'Turn on and make my wallpaper'}</button>
      <div id="qrPrev" style="text-align:center"></div>
      ${on ? '<button class="btn ghost" id="qrOff">Turn QR off (old wallpapers stop working)</button>' : ''}
      <p class="small muted">Every scan is listed under "Who viewed my data". ${['localhost', '127.0.0.1'].includes(location.hostname) ? '<b>You are on localhost — a phone cannot open this link. Make the wallpaper from your Render link.</b>' : ''}</p>
      <button class="btn tan" id="close">Close</button></div>`;
    host().appendChild(back);
    const q = (sel) => back.querySelector(sel);
    q('#close').onclick = () => back.remove();
    q('#qrPhoto').onchange = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const img = new Image(); img.onload = () => { st.photo = img; toast('Photo added — now make the wallpaper.'); }; img.src = URL.createObjectURL(f);
    };
    q('#qrPlain').onclick = () => { st.photo = null; toast('Plain background.'); };
    back.querySelectorAll('[data-c]').forEach((b) => b.onclick = () => { st.corner = b.dataset.c; back.querySelectorAll('[data-c]').forEach((x) => x.classList.toggle('on', x === b)); });
    if (on) q('#qrOff').onclick = async () => {
      try { await api('DELETE', `/v1/profiles/${p.id}/qr`); await loadProfiles(); toast('QR switched off. Old wallpapers now open "not available".'); back.remove(); drawTab(); } catch (e) { toast(e.message); }
    };
    q('#qrMake').onclick = async () => {
      try {
        const printOn = q('#qrPrint').checked;
        const r = await api('POST', `/v1/profiles/${p.id}/qr`, { printOnWallpaper: printOn });
        await loadProfiles();
        const canvas = wallpaper(location.origin + r.qr.path, printOn ? p : null, st.photo, st.corner);
        st.png = canvas.toDataURL('image/png');
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
        st.file = new File([blob], 'goldenbay-lockscreen.png', { type: 'image/png' });
        const canShare = !!(navigator.canShare && navigator.canShare({ files: [st.file] }));
        q('#qrPrev').innerHTML = `<img src="${st.png}" alt="Wallpaper preview" style="width:52%;border-radius:22px;border:6px solid #17130f;margin-top:4px">
          ${canShare ? '<button class="btn ok" id="qrSet" style="margin-top:12px">Set as lock screen…</button>' : ''}
          <a class="btn ${canShare ? 'ghost' : 'ok'}" style="margin-top:10px;width:100%" download="goldenbay-lockscreen.png" href="${st.png}">Download wallpaper</a>
          <p class="small muted" style="margin-top:8px;text-align:left">${canShare
            ? '<b>Android:</b> in the list that opens, pick <b>Set as wallpaper</b> (or Photos → Use as → Wallpaper) → Lock screen.<br><b>iPhone:</b> pick <b>Save Image</b>, then Photos → Share → <b>Use as Wallpaper</b>.'
            : '<b>Android:</b> open the downloaded image → ⋮ → Set as wallpaper → Lock screen.<br><b>iPhone:</b> save it to Photos → Share → Use as Wallpaper.'}
            <br>A new link was made, so older wallpapers no longer work.</p>`;
        if (canShare) q('#qrSet').onclick = async () => {
          try { await navigator.share({ files: [st.file], title: 'GoldenBay lock screen' }); } catch (e) { if (e.name !== 'AbortError') toast('Sharing did not open — use Download instead.'); }
        };
      } catch (e) { toast(e.message, 5000); }
    };
  }

  // Draws a 1080×2340 phone wallpaper. The top third is left free for the
  // clock; the QR sits small in the chosen corner, on a white card so it scans
  // on any photo.
  function wallpaper(url, printProfile, photo, corner) {
    const W = 1080, H = 2340, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    if (photo) { // cover-fit the person's own photo
      const r = Math.max(W / photo.width, H / photo.height), w = photo.width * r, h = photo.height * r;
      g.drawImage(photo, (W - w) / 2, (H - h) / 2, w, h);
    } else {
      const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#f7f3ec'); bg.addColorStop(1, '#e3dac9');
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
    }
    const qr = GBQR.make(url);
    const cell = Math.max(6, Math.floor(300 / (qr.size + 8))), side = cell * (qr.size + 8);
    const pad = 26, label = 58, info = printProfile ? 92 : 0;
    const cardW = side + pad * 2, cardH = side + pad * 2 + label + info;
    const margin = 70, bottomGap = 330; // stay clear of the phone's own bottom buttons
    const x = corner === 'bottom-left' ? margin : corner === 'middle' ? (W - cardW) / 2 : W - margin - cardW;
    const y = corner === 'middle' ? (H - cardH) / 2 + 180 : H - bottomGap - cardH;
    g.save(); g.shadowColor = 'rgba(0,0,0,.28)'; g.shadowBlur = 30; g.shadowOffsetY = 8;
    g.fillStyle = '#fff'; roundRect(g, x, y, cardW, cardH, 34); g.fill(); g.restore();
    g.fillStyle = '#a61414'; g.textAlign = 'center';
    let fs = 34; do { g.font = `800 ${fs}px system-ui, sans-serif`; fs -= 1; } while (g.measureText('EMERGENCY? SCAN').width > cardW - 36 && fs > 14);
    g.fillText('EMERGENCY? SCAN', x + cardW / 2, y + pad + 34);
    const qx = x + pad, qy = y + pad + label;
    g.fillStyle = '#17130f';
    for (let yy = 0; yy < qr.size; yy++) for (let xx = 0; xx < qr.size; xx++) if (qr.get(xx, yy)) g.fillRect(qx + (xx + 4) * cell, qy + (yy + 4) * cell, cell, cell);
    if (printProfile) {
      g.fillStyle = '#8c0303'; g.font = '800 32px system-ui, sans-serif';
      g.fillText(`Blood ${printProfile.bloodGroup || '?'}`, x + cardW / 2, qy + side + 38);
      g.font = '600 24px system-ui, sans-serif'; g.fillStyle = '#2b1a16';
      const al = (printProfile.allergies || []).join(', ') || 'no allergies recorded';
      g.fillText(al.length > 26 ? al.slice(0, 25) + '…' : al, x + cardW / 2, qy + side + 74);
    }
    return c;
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }

  // =================================================================== PROFILES
  // List of family members → tap one → a detail page, one row per kind of
  // information (like a phone's contact card). Tap a row to change it.
  const CONSENT = { self: 'Confirmed by the patient', parental: 'Declared by a parent or guardian', 'on-behalf': 'Added by a relative — not confirmed yet' };
  const COST = { any: 'Any hospital', government: 'Government hospitals first', pmjay: 'Ayushman Bharat (PM-JAY)', 'private-insurance': 'Private insurance' };
  const avClass = (p) => `av${Math.max(0, S.profiles.indexOf(p)) % 4}`;
  function profRow(p) {
    return `<button class="prow" data-prof="${esc(p.id)}">
      <div class="avatar ${avClass(p)}">${esc(initials(p.fullName))}</div>
      <div class="grow"><div class="name">${esc(p.fullName)}${p.id === S.patientId ? '<span class="badge-active">Active</span>' : ''}</div>
        <div class="rel">${esc(p.relation || 'Family')}, Age ${esc(p.age ?? '?')}${p.consent?.type === 'on-behalf' ? ' · <span style="color:var(--crimson)">not confirmed</span>' : ''}</div></div>
      <span class="chev">${icon('chevronRight')}</span></button>`;
  }
  function openProfile(id) { S.profileView = id; drawTab(); const sc = $('#scroll'); if (sc) sc.scrollTop = 0; }

  function drawProfiles(el) {
    const p = S.profileView && S.profiles.find((x) => x.id === S.profileView);
    if (p) return drawProfileDetail(el, p);
    el.innerHTML = `
      <div class="section-head" style="margin-top:14px"><h2>Family profiles</h2></div>
      <div class="plist">${S.profiles.map(profRow).join('') || '<div class="prow muted">No profiles yet.</div>'}</div>
      <button class="add-row" id="add">${icon('plus', { size: 18 })} Add family member</button>
      <p class="small muted" style="margin-top:14px">Hospitals see these details only after they say yes — and you can see every time they do.</p>`;
    $('#add').onclick = () => profileForm(null);
    el.querySelectorAll('[data-prof]').forEach((b) => b.onclick = () => openProfile(b.dataset.prof));
  }

  function drow(key, ic, color, label, value, hint, soft) {
    return `<button class="drow tap" data-row="${key}"><span class="ic ${color}">${icon(ic, { size: 19 })}</span>
      <span class="body"><div class="label">${esc(label)}</div><div class="value ${soft ? 'soft' : ''}">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</span>
      <span class="chev">${icon('chevronRight', { size: 18 })}</span></button>`;
  }

  function drawProfileDetail(el, p) {
    const c = (p.emergencyContacts || [])[0];
    const list = (a) => (a && a.length ? esc(a.join(', ')) : null);
    const none = '<span class="muted">None recorded</span>';
    const cType = p.consent?.type;
    el.innerHTML = `
      <div class="topbar-nav"><button class="icon-btn" id="back" aria-label="Back">${icon('arrowLeft', { size: 18 })}</button>
        <div class="title">${esc(p.relation || 'Profile')}</div><span></span></div>
      <div class="detail-head"><div class="avatar xl ${avClass(p)}">${esc(initials(p.fullName))}</div>
        <div><h1>${esc(p.fullName)}</h1><p>${esc(p.relation || 'Family')} · Age ${esc(p.age ?? '?')}${p.bloodGroup ? ` · ${esc(p.bloodGroup)}` : ''}</p></div></div>
      ${cType === 'on-behalf' ? `<div class="note bad" style="margin-bottom:12px">${esc(shortName(p.fullName))} hasn't confirmed this profile, so it can't be sent to hospitals yet.${(p.age == null || p.age >= 18) ? ' <button class="link" id="confirmMe" style="color:var(--crimson);font-weight:750;background:none;border:0;text-decoration:underline">This is me — confirm</button>' : ''}</div>` : ''}
      ${p.stale ? `<div class="note warn" style="margin-bottom:12px">Medical details last updated ${esc(p.daysSinceUpdate)} days ago — hospitals will see that. Please check them.</div>` : ''}

      <div class="dlist">
        ${drow('edit', 'heartPulse', 'red', 'Blood group', p.bloodGroup ? esc(p.bloodGroup) : none)}
        ${drow('edit', 'alertTriangle', 'red', 'Allergies', list(p.allergies) || none)}
        ${drow('edit', 'pill', 'blue', 'Medicines', list(p.medications) || none)}
        ${drow('edit', 'clock', 'amber', 'Conditions & history', list([...(p.conditions || []), ...(p.pastEvents || [])]) || none)}
        ${drow('edit', 'phone', 'green', 'Emergency contact', c ? `${esc(c.name)}${c.relation ? ` (${esc(c.relation)})` : ''} · ${esc(c.phone)}` : none)}
        ${drow('edit', 'hospital', 'red', 'Hospital cost preference', esc(COST[p.costPreference] || 'Any hospital'), 'Only changes the order when a case is not life-threatening')}
        ${drow('edit', 'shield', 'blue', 'Insurance', p.insurance ? esc(p.insurance) : none, 'Never sent to hospitals', true)}
      </div>

      <div class="dlist">
        ${cType !== 'on-behalf' ? drow('qr', 'qr', 'violet', 'Lock-screen QR', p.qr?.enabled ? 'On — tap to make or change the wallpaper' : 'Off — tap to set up', null, !p.qr?.enabled) : ''}
        ${drow('labs', 'file', 'green', 'Lab reports', 'Read, checked, and put side by side', null, true)}
        ${drow('viewed', 'users', 'violet', 'Who viewed my data', 'Every hospital or QR scan that opened this profile', null, true)}
        ${drow('privacy', 'shield', 'violet', 'Privacy & your data', esc(CONSENT[cType] || 'Consent not recorded'), `Updated ${esc(fmtDate(p.lastMedicalUpdate))}`, true)}
      </div>

      <button class="btn" id="sosFor">Start emergency for ${esc(shortName(p.fullName))}</button>`;
    $('#back').onclick = () => { S.profileView = null; drawTab(); };
    $('#sosFor').onclick = () => { S.patientId = p.id; go('sos'); };
    if ($('#confirmMe')) $('#confirmMe').onclick = async () => {
      if (!confirm('Confirm this is YOUR profile and that you agree to it being shown to a hospital in an emergency?')) return;
      try { await api('POST', `/v1/profiles/${p.id}/confirm`, {}); await loadProfiles(); toast('Confirmed.'); drawTab(); } catch (e) { toast(e.message); }
    };
    el.querySelectorAll('[data-row]').forEach((b) => b.onclick = () => {
      const k = b.dataset.row;
      if (k === 'edit') return profileForm(p);
      if (k === 'qr') return qrSheet(p);
      if (k === 'labs') { location.href = `/labs?p=${encodeURIComponent(p.id)}`; return; }
      if (k === 'viewed') return showAccessLog(p.id);
      if (k === 'privacy') return privacySheet(p);
    });
  }

  function privacySheet(p) {
    const back = document.createElement('div'); back.className = 'sheet-back';
    back.innerHTML = `<div class="sheet stack"><h2>Privacy & your data</h2>
      <div class="note">${esc(CONSENT[p.consent?.type] || 'Consent not recorded')}</div>
      <p class="small">Hospitals first see a no-name card. Only the hospital that says yes sees ${esc(shortName(p.fullName))}'s medical details — and it shows up in "Who viewed my data". Insurance, Aadhaar, PAN and home address are never sent.</p>
      <button class="btn ghost" id="exp">View all of ${esc(shortName(p.fullName))}'s data (readable, can be printed)</button>
      <button class="btn ghost" id="expraw">Download the same data as a computer file (JSON)</button>
      <button class="btn ghost" id="era" style="color:var(--dark)">Erase this profile and everything linked to it</button>
      <button class="btn tan" id="close">Close</button></div>`;
    host().appendChild(back);
    back.querySelector('#close').onclick = () => back.remove();
    back.querySelector('#exp').onclick = () => exportProfile(p.id);
    back.querySelector('#expraw').onclick = () => exportProfile(p.id, 'raw');
    back.querySelector('#era').onclick = async () => {
      if (!confirm('Delete this profile and every record linked to it? This cannot be undone.')) return;
      try { await api('DELETE', `/v1/privacy/erase/${p.id}`); await loadProfiles(); back.remove(); S.profileView = null; toast('Erased.'); drawTab(); } catch (e) { toast(e.message); }
    };
  }

  async function showAccessLog(id) {
    try {
      const { entries } = await api('GET', `/v1/profiles/${id}/access-log`);
      const p = S.profiles.find((x) => x.id === id);
      const back = document.createElement('div'); back.className = 'sheet-back';
      back.innerHTML = `<div class="sheet stack"><h2>Who viewed ${esc(shortName(p.fullName))}'s data</h2>
        ${entries.length ? entries.map((a) => `<div class="card"><b>${esc(a.hospitalName)}</b><div class="small muted">${esc(a.what)} · ${esc(new Date(a.at).toLocaleString('en-IN'))}</div></div>`).join('') : '<div class="note">Nobody has viewed this profile yet. A hospital can only open details after it accepts a patient — and every time is listed here.</div>'}
        <button class="btn ghost" id="close">Close</button></div>`;
      host().appendChild(back);
      $('#close').onclick = () => back.remove();
    } catch (e) { toast(e.message); }
  }

  // Readable copy of everything held about one person (opens as a normal page; can be printed / saved as PDF)
  function readablePage(d) {
    const p = d.profile || {};
    const list = (a) => (a && a.length ? a.map((x) => `<li>${esc(x)}</li>`).join('') : '<li class="none">None recorded</li>');
    const when = (t) => (t ? new Date(t).toLocaleString('en-IN') : '—');
    const c = (p.emergencyContacts || [])[0];
    const ems = (d.emergencies || []).map((e) => `<tr><td>${esc(when(e.createdAt))}</td><td>${esc((e.types || []).map((t) => (GB.EMERGENCY_TYPES.find((x) => x.id === t) || { label: t }).label).join(', ') || '—')}</td><td>${esc(EM_STATE[e.status] || e.status || '—')}</td></tr>`).join('');
    const labs = (d.labReports || []).map((r) => `<tr><td>${esc(r.reportDate || when(r.createdAt))}</td><td>${esc(r.labName || 'Lab report')} · ${(r.values || []).length} values</td></tr>`).join('');
    const views = (d.whoViewedThisData || []).map((a) => `<tr><td>${esc(when(a.at))}</td><td>${esc(a.hospitalName || '—')}</td><td>${esc(a.what || '')}</td></tr>`).join('');
    const docs = (p.documents || []).map((x) => `<figure><img alt="${esc(x.name)}" src="${esc(x.dataUrl || '')}"><figcaption>${esc(x.name)} · ${esc(x.category || '')}</figcaption></figure>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.fullName || 'Profile')} — my GoldenBay data</title>
<style>body{font:16px/1.5 system-ui,Segoe UI,Roboto,sans-serif;margin:0;background:#f7f3ec;color:#2a2018}main{max-width:720px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:26px;margin:.2em 0}h2{font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:#8c0303;margin:26px 0 8px;border-bottom:2px solid #e3dac9;padding-bottom:4px}
.card{background:#fff;border:1px solid #e3dac9;border-radius:14px;padding:12px 16px}ul{margin:0;padding-left:20px}.none{color:#8a7d6e}li.none{list-style:none;margin-left:-20px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:7px 6px;border-bottom:1px solid #eee5d6;vertical-align:top}
.k{color:#8a7d6e;font-size:13px}.note{background:#fff7e0;border:1px solid #e8d38a;border-radius:12px;padding:10px 14px;font-size:14px}
figure{margin:0 0 12px}img{max-width:100%;border:1px solid #e3dac9;border-radius:10px}figcaption{font-size:13px;color:#8a7d6e}
button{font:inherit;background:#a61414;color:#fff;border:0;border-radius:12px;padding:12px 18px;margin:8px 8px 0 0}
@media print{button,.noprint{display:none}body{background:#fff}}</style></head><body><main>
<div class="noprint"><button onclick="window.print()">Print or save as PDF</button></div>
<p class="k">GoldenBay · copy made ${esc(when(d.exportedAt))}</p><h1>${esc(p.fullName || 'Profile')}</h1>
<p class="k">${esc(p.relation || '')}${p.age != null ? ` · Age ${esc(p.age)}` : ''}${p.sex ? ` · ${esc(p.sex)}` : ''}</p>
<div class="note">${esc(d.aboutThisFile || '')}</div>
<h2>Medical details</h2><div class="card"><p><span class="k">Blood group</span><br><b>${esc(p.bloodGroup || 'Not recorded')}</b></p>
<p class="k" style="margin-bottom:2px">Allergies</p><ul>${list(p.allergies)}</ul><p class="k" style="margin-bottom:2px">Medicines</p><ul>${list(p.medications)}</ul>
<p class="k" style="margin-bottom:2px">Conditions</p><ul>${list(p.conditions)}</ul><p class="k" style="margin-bottom:2px">Past events</p><ul>${list(p.pastEvents)}</ul>
<p class="k">Medical details last updated: ${esc(when(p.medicalUpdatedAt))}</p></div>
<h2>Emergency contact</h2><div class="card">${c ? `<b>${esc(c.name)}</b>${c.relation ? ` (${esc(c.relation)})` : ''}<br>${esc(c.phone)}` : '<span class="none">None recorded</span>'}</div>
<h2>Other details</h2><div class="card"><p><span class="k">Insurance (never sent to hospitals)</span><br>${esc(p.insurance || 'Not recorded')}</p>
<p><span class="k">Consent</span><br>${esc(CONSENT[p.consent?.type] || 'Not recorded')} · ${esc(when(p.consent?.at))}</p></div>
<h2>Documents (${(p.documents || []).length})</h2>${docs || '<div class="card none">No documents</div>'}
<h2>Emergencies (${(d.emergencies || []).length})</h2>${ems ? `<table><tr><th>When</th><th>What</th><th>Result</th></tr>${ems}</table>` : '<div class="card none">None</div>'}
<h2>Lab reports (${(d.labReports || []).length})</h2>${labs ? `<table><tr><th>When</th><th>Report</th></tr>${labs}</table>` : '<div class="card none">None</div>'}
<h2>Who viewed this data (${(d.whoViewedThisData || []).length})</h2>${views ? `<table><tr><th>When</th><th>Who</th><th>What</th></tr>${views}</table>` : '<div class="card none">Nobody yet</div>'}
</main></body></html>`;
  }

  async function exportProfile(id, kind = 'readable') {
    try {
      const data = await api('GET', `/v1/privacy/export/${id}`);
      const safe = (data.profile?.fullName || 'profile').replace(/[^\w]+/g, '-').toLowerCase();
      const isRaw = kind === 'raw';
      const blob = isRaw
        ? new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        : new Blob([readablePage(data)], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      if (!isRaw) { const w = window.open(url, '_blank'); if (w) return; }
      const a = document.createElement('a');
      a.href = url; a.download = `goldenbay-${safe}.${isRaw ? 'json' : 'html'}`; document.body.appendChild(a); a.click(); a.remove();
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
    host().appendChild(back);
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
        <div class="small muted">This phone: ${esc(S.me.label)}</div><div>Family code: <b style="font-size:20px;letter-spacing:.04em;white-space:nowrap">${esc(S.family.joinCode)}</b></div>
        <p class="small muted">Relatives use this code to join. Each phone gets its own secret key.</p>
        <div>${S.members.map((m) => `<span class="chip">${esc(m.label)}</span>`).join('')}</div>
      </div>
      <div class="section-title">Tools</div>
      <div class="list">
        <a class="list-item" style="text-decoration:none" href="/labs"><span class="avatar av3">${icon('file', { size: 20 })}</span><span><span class="name">Lab report reader</span><br><span class="meta">Reads a report, checks every number, shows the trend</span></span><span class="chev">${icon('chevronRight')}</span></a>
        <a class="list-item" style="text-decoration:none" href="/cpr"><span class="avatar av0">${icon('heartPulse', { size: 20 })}</span><span><span class="name">CPR coach (practice)</span><br><span class="meta">Try it before you ever need it</span></span><span class="chev">${icon('chevronRight')}</span></a>
      </div>
      <div class="section-title">Privacy — plain facts</div>
      <div class="card stack">
        <div class="note">${esc(notice?.status?.claim || 'Prototype. Not compliant, not certified.')}</div>
        <div class="note warn">In typed words, our own rules hide phone numbers, ID numbers and emails. Names are <b>not</b> hidden.</div>
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
