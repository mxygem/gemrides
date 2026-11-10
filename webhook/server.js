// Receives Tally webhooks for the ride-preference form and notifies Gem.
//
// Zero dependencies (Node 22+). Configure with environment variables:
//   TALLY_SIGNING_SECRET  Signing secret from the Tally webhook settings. When
//                         set, requests without a valid Tally-Signature are rejected.
//   NTFY_TOPIC            Send a push via ntfy.sh to this topic (pick something unguessable).
//   NTFY_SERVER           Optional, defaults to https://ntfy.sh
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, NOTIFY_TO
//                         Send an SMS via Twilio from TWILIO_FROM to NOTIFY_TO.
// Any notifier that is configured is used; configure at least one.

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT) || 8080;
const MAX_BODY = 1024 * 1024;

export function verifySignature(rawBody, signature, secret) {
  if (!secret) return true;
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Turns a Tally field value into readable text, resolving choice option ids.
function fieldText(field) {
  const { value, options } = field;
  if (value === null || value === undefined || value === '') return null;
  const values = Array.isArray(value) ? value : [value];
  const text = values.map((v) => {
    const opt = options?.find((o) => o.id === v);
    if (opt) return opt.text;
    if (v && typeof v === 'object') return v.url ?? v.name ?? JSON.stringify(v);
    return String(v);
  });
  return text.join(', ');
}

export function formatSubmission(payload) {
  const data = payload?.data ?? {};
  const lines = [];
  for (const field of data.fields ?? []) {
    const text = fieldText(field);
    if (text !== null) lines.push(`${field.label || field.key}: ${text}`);
  }
  return {
    title: `New ride preferences${data.formName ? ` (${data.formName})` : ''}`,
    body: lines.length ? lines.join('\n') : '(no answers)',
  };
}

async function sendNtfy({ title, body }) {
  const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
  const res = await fetch(`${server}/${encodeURIComponent(process.env.NTFY_TOPIC)}`, {
    method: 'POST',
    headers: { Title: title },
    body,
  });
  if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
}

async function sendTwilio({ title, body }) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = process.env;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}` },
    body: new URLSearchParams({
      From: process.env.TWILIO_FROM,
      To: process.env.NOTIFY_TO,
      Body: `${title}\n${body}`,
    }),
  });
  if (!res.ok) throw new Error(`Twilio responded ${res.status}: ${await res.text()}`);
}

function notifiers() {
  const env = process.env;
  const list = [];
  if (env.NTFY_TOPIC) list.push(['ntfy', sendNtfy]);
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM && env.NOTIFY_TO) {
    list.push(['twilio', sendTwilio]);
  }
  return list;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain' }).end(text);
}

export const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, 'ok');
  if (req.url !== '/tally/ride-pref') return send(res, 404, 'not found');
  if (req.method !== 'POST') return send(res, 405, 'method not allowed');

  let raw;
  try {
    raw = await readBody(req);
  } catch {
    return send(res, 413, 'payload too large');
  }

  if (!verifySignature(raw, req.headers['tally-signature'], process.env.TALLY_SIGNING_SECRET)) {
    return send(res, 401, 'invalid signature');
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return send(res, 400, 'invalid json');
  }
  if (payload.eventType !== 'FORM_RESPONSE') return send(res, 200, 'ignored');

  const message = formatSubmission(payload);
  const active = notifiers();
  if (active.length === 0) console.warn('No notifier configured; submission:', message);

  const results = await Promise.allSettled(active.map(([, fn]) => fn(message)));
  const failed = results
    .map((r, i) => (r.status === 'rejected' ? `${active[i][0]}: ${r.reason.message}` : null))
    .filter(Boolean);
  failed.forEach((f) => console.error('Notify failed', f));

  // Non-2xx makes Tally retry; only do that if every notifier failed.
  if (active.length > 0 && failed.length === active.length) return send(res, 502, 'notify failed');
  send(res, 200, 'ok');
});

if (import.meta.url === `file://${process.argv[1]}`) {
  server.listen(PORT, () => console.log(`Listening on :${PORT}`));
}
