// gb.js — small helpers shared by the User App and the Hospital App.
// No libraries. Loaded with a normal <script> tag.

const GBX = (() => {
  // ---- safe text: every value that came from the server or a person goes through esc()
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, ms = 3200) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // Browser storage can be missing or blocked — never let that break the app.
  const keep = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // JSON API caller. `headers()` returns the sign-in header for this app.
  function makeApi(headers) {
    return async function api(method, path, body) {
      const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(headers() || {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data?.error?.message || `Something went wrong (${res.status})`);
        err.status = res.status; err.code = data?.error?.code;
        throw err;
      }
      return data;
    };
  }

  // Live updates. Two things run together on purpose:
  //   1. a live stream (Server-Sent Events) — instant when the network allows it
  //   2. a light poll every few seconds — the safety net, in case a proxy
  //      (some hosts) buffers or drops the stream. The screen is correct either way.
  function goLive({ api, ticketHeaders, ticketBody, events, onEvent, onPoll, pollMs = 3500 }) {
    let es = null, stopped = false, retry = null;
    async function connect() {
      if (stopped) return;
      try {
        const { ticket } = await api('POST', '/v1/stream-ticket', ticketBody || {});
        es = new EventSource('/v1/stream?ticket=' + encodeURIComponent(ticket));
        (events || []).forEach((name) => es.addEventListener(name, (ev) => {
          let data = {}; try { data = JSON.parse(ev.data); } catch { /* ignore */ }
          onEvent(name, data);
        }));
        es.onerror = () => { try { es.close(); } catch { /* ignore */ } es = null; if (!stopped) retry = setTimeout(connect, 4000); };
      } catch { if (!stopped) retry = setTimeout(connect, 6000); }
    }
    connect();
    const timer = setInterval(() => { if (!document.hidden) onPoll(); }, pollMs);
    return { stop() { stopped = true; clearInterval(timer); clearTimeout(retry); try { es && es.close(); } catch { /* ignore */ } } };
  }

  // A short two-tone beep for a new request (browsers only allow sound after a tap;
  // the login button is that tap).
  let audio = null;
  function unlockSound() { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume && audio.resume(); } catch { /* ignore */ } }
  function beep() {
    try {
      if (!audio) return;
      [0, 0.22, 0.44].forEach((d, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'square'; o.frequency.value = i % 2 ? 660 : 880;
        g.gain.setValueAtTime(0.0001, audio.currentTime + d);
        g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + d + 0.18);
        o.connect(g); g.connect(audio.destination);
        o.start(audio.currentTime + d); o.stop(audio.currentTime + d + 0.2);
      });
    } catch { /* ignore */ }
  }

  const mmss = (sec) => `${Math.floor(Math.max(0, sec) / 60)}:${String(Math.floor(Math.max(0, sec) % 60)).padStart(2, '0')}`;
  const secSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 1000 : 0);
  const chips = (arr, cls = '') => (arr || []).map((x) => `<span class="chip ${cls}">${esc(x)}</span>`).join('');
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown');

  return { esc, toast, keep, makeApi, goLive, unlockSound, beep, mmss, secSince, chips, fmtDate };
})();
