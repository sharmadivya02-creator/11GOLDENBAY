// index.js — starts GoldenBay: one server, two apps.
//
//   /            User App      (families)
//   /hospital    Hospital App  (ER staff)
//   /share/:tok  private link for relatives
//   /v1/...      the API both apps use
//   /v1/stream   live updates (Server-Sent Events)
//
// DEMO NOTICE: prototype with synthetic data only. Hospital login is a demo
// login (one shared PIN). Not for real patients.

const fs = require('fs');
const path = require('path');
const http = require('http');

// tiny .env loader (no dependency)
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const store = require('./store');
const { seed } = require('./seed');
const privacy = require('./privacy');
const engine = require('./engine');
const hub = require('./hub');
const ai = require('./ai');
const { createRouter, readBody, send, serveStatic, HttpError } = require('./http');
const routes = require('./routes');

store.load();
seed();
privacy.startRetentionJob();
engine.resumeOpenSearches();

const router = createRouter();
routes.register(router);

const ROOT = path.join(__dirname, '..');
const DIRS = {
  user: path.join(ROOT, 'apps', 'user'),
  hospital: path.join(ROOT, 'apps', 'hospital'),
  common: path.join(ROOT, 'apps', 'common'),
  shared: path.join(ROOT, 'shared'),
};

// Headers on every response. no-referrer matters: the share link carries a
// secret, and a referrer header would leak it to any site the page links to.
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    // ---- live stream
    if (p === '/v1/stream' && req.method === 'GET') {
      if (!hub.openStream(url.searchParams.get('ticket'), req, res)) send(res, 401, { error: { code: 'BAD_TICKET', message: 'stream ticket missing or expired' } });
      return;
    }

    // ---- API
    if (p.startsWith('/v1/')) {
      const m = router.match(req.method, p);
      if (!m) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'no such endpoint' } });
      req.params = m.params;
      req.query = Object.fromEntries(url.searchParams);
      req.body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const out = await m.handlers[0](req, res);
      if (res.headersSent) return;
      if (out && typeof out.status === 'number' && 'body' in out) return send(res, out.status, out.body);
      return send(res, 200, out ?? { ok: true });
    }

    // ---- pages and files
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: { code: 'METHOD', message: 'method not allowed' } });
    if (p.startsWith('/common/') && serveStatic(DIRS.common, p.slice('/common'.length), res)) return;
    if (p.startsWith('/vendor/') && serveStatic(DIRS.common, p, res)) return;
    if (p.startsWith('/shared/') && serveStatic(DIRS.shared, p.slice('/shared'.length), res)) return;
    if (p === '/hospital' || p === '/hospital/') return serveStatic(DIRS.hospital, '/index.html', res) || notFound(res);
    if (p.startsWith('/hospital/') && serveStatic(DIRS.hospital, p.slice('/hospital'.length), res)) return;
    if (/^\/share\/[A-Za-z0-9_-]+$/.test(p)) return serveStatic(DIRS.user, '/share.html', res) || notFound(res);
    if (p === '/') return serveStatic(DIRS.user, '/index.html', res) || notFound(res);
    if (serveStatic(DIRS.user, p, res)) return;
    return notFound(res);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: { code: err.code, message: err.message } });
    console.error('[server] error on', req.method, p, err);
    if (!res.headersSent) send(res, 500, { error: { code: 'SERVER_ERROR', message: 'something went wrong' } });
  }
});

function notFound(res) { send(res, 404, { error: { code: 'NOT_FOUND', message: 'not found' } }); return true; }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`GoldenBay v2 running → http://localhost:${PORT}  (Hospital App: /hospital)`);
  console.log(ai.geminiEnabled()
    ? `AI mode: Gemini (${process.env.GEMINI_MODEL || 'gemini-3.6-flash'})`
    : 'AI mode: plain rules (no Gemini key, or MOCK_AI=true) — every flow still works');
  console.log(`Offer rounds: 5/10/15 km, ${process.env.OFFER_ROUND_SECONDS || 30}s each · hospital demo PIN is set by HOSPITAL_DEMO_PIN (default 2468)`);
});

module.exports = server;
