// shared.js — helpers used by all three views.

// Tiny wrapper around fetch() for our JSON API.
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
  return data;
}

// Human-readable labels for each emergency status.
const STATUS_STEPS = [
  ['RECEIVED', 'Emergency received'],
  ['ANALYZING', 'AI composing clinical picture'],
  ['HOSPITAL_MATCHED', 'Right hospital matched'],
  ['AMBULANCE_DISPATCHED', 'Ambulance on the way'],
  ['PATIENT_PICKED_UP', 'Patient picked up — heading to hospital'],
  ['ARRIVED_AT_HOSPITAL', 'Arrived — ER was ready'],
];
const STATUS_ORDER = STATUS_STEPS.map(([k]) => k);

function renderTimeline(el, currentStatus) {
  const idx = STATUS_ORDER.indexOf(currentStatus);
  el.innerHTML = STATUS_STEPS.map(([key, label], i) => {
    const cls = i < idx ? 'done' : i === idx ? 'active' : '';
    return `<li class="${cls}">${label}</li>`;
  }).join('');
  if (currentStatus === 'NEEDS_MANUAL_DISPATCH') {
    el.innerHTML += `<li class="active">Automatic flow unavailable — dispatcher handling manually</li>`;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Renders the AI clinical picture into a container.
function renderClinicalPicture(el, cp) {
  if (!cp) { el.innerHTML = '<p class="muted">Clinical picture not ready yet…</p>'; return; }
  el.innerHTML = `
    <p>
      <span class="badge ${esc(cp.urgency)}">${esc(cp.urgency)}</span>
      <span class="badge source">${cp._source === 'gemini' ? '✦ Gemini' : 'mock AI'}</span>
    </p>
    <p class="kv"><b>Suspected</b> ${esc(cp.suspectedCategory)}</p>
    <p style="font-size:14.5px">${esc(cp.clinicalSummary)}</p>
    ${cp.keyRisks?.length ? `<h3>Key risks</h3><ul class="plain">${cp.keyRisks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    <p class="muted">AI organises information only — it does not diagnose. Confirmation by medical professionals required.</p>
  `;
}

// Leaflet map with patient / hospital / ambulance markers.
function createLiveMap(elId) {
  const map = L.map(elId, { zoomControl: false, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  const icon = (emoji) =>
    L.divIcon({ className: '', html: `<div style="font-size:26px;filter:drop-shadow(0 1px 2px #000)">${emoji}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });

  let patientMarker = null, hospitalMarker = null, ambulanceMarker = null, routeLine = null;

  return {
    setScene(emergency, hospital) {
      const p = emergency.location;
      if (!patientMarker) patientMarker = L.marker([p.lat, p.lng], { icon: icon('📍') }).addTo(map).bindPopup('Patient');
      if (hospital && !hospitalMarker) {
        hospitalMarker = L.marker([hospital.lat, hospital.lng], { icon: icon('🏥') }).addTo(map).bindPopup(hospital.name);
      }
      if (emergency.route && !routeLine) {
        routeLine = L.polyline(emergency.route.map((r) => [r.lat, r.lng]), { color: '#f0b429', weight: 3, dashArray: '6 8', opacity: 0.7 }).addTo(map);
      }
      const pts = [[p.lat, p.lng]];
      if (hospital) pts.push([hospital.lat, hospital.lng]);
      map.fitBounds(L.latLngBounds(pts).pad(0.35));
    },
    moveAmbulance(pos) {
      if (!pos) return;
      if (!ambulanceMarker) ambulanceMarker = L.marker([pos.lat, pos.lng], { icon: icon('🚑') }).addTo(map);
      else ambulanceMarker.setLatLng([pos.lat, pos.lng]);
    },
  };
}
