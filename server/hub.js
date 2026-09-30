// hub.js — live updates to the browser, using Server-Sent Events (SSE).
//
// SSE is built into every modern browser (EventSource) and into Node's http
// module, so live updates need no extra library.
//
// WHO HEARS WHAT — every message goes to one channel, and a browser can only
// listen to channels its login allows:
//   family:<familyId>      the family's own devices
//   hospital:<hospitalId>  one hospital's screens
//   share:<emergencyId>    relatives holding that emergency's private link
// There is no "everyone" channel. That is the fix for the old app, which sent
// every emergency and every camera frame to every hospital screen.
//
// Browsers cannot put a secret header on an EventSource, and a secret in a URL
// can end up in logs. So a logged-in page first asks for a one-time ticket
// (valid 60 s, usable once) and opens the stream with that instead.

const crypto = require('crypto');

const tickets = new Map();          // ticket -> { channels, expires }
const clients = new Set();          // { res, channels:Set }

function issueTicket(channels) {
  const ticket = crypto.randomBytes(18).toString('base64url');
  tickets.set(ticket, { channels, expires: Date.now() + 60_000 });
  return ticket;
}

function openStream(ticket, req, res) {
  const t = tickets.get(ticket);
  tickets.delete(ticket);                               // single use
  if (!t || t.expires < Date.now()) return false;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',                          // ask proxies not to buffer
  });
  res.write('retry: 3000\n\n');
  const client = { res, channels: new Set(t.channels) };
  clients.add(client);
  const beat = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
  req.on('close', () => { clearInterval(beat); clients.delete(client); });
  return true;
}

function publish(channel, event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) if (c.channels.has(channel)) c.res.write(msg);
}

// housekeeping: forget expired tickets
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
}, 60_000).unref();

module.exports = { issueTicket, openStream, publish, _clients: clients };
