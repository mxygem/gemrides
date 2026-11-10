import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { server, verifySignature, formatSubmission } from './server.js';

const SECRET = 'test-secret';
const payload = {
  eventId: 'e1',
  eventType: 'FORM_RESPONSE',
  data: {
    formName: 'Ride Preferences',
    fields: [
      { key: 'q1', label: 'Name', type: 'INPUT_TEXT', value: 'Sam' },
      {
        key: 'q2', label: 'Music', type: 'MULTIPLE_CHOICE', value: ['o2'],
        options: [{ id: 'o1', text: 'Quiet' }, { id: 'o2', text: 'Chill' }],
      },
      { key: 'q3', label: 'Notes', type: 'TEXTAREA', value: null },
    ],
  },
};
const sign = (body) => createHmac('sha256', SECRET).update(body).digest('base64');

let ntfy, received = [], base;

before(async () => {
  ntfy = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, title: req.headers.title, body });
      res.end('ok');
    });
  });
  await new Promise((r) => ntfy.listen(0, r));
  await new Promise((r) => server.listen(0, r));
  process.env.TALLY_SIGNING_SECRET = SECRET;
  process.env.NTFY_TOPIC = 'gem-test';
  process.env.NTFY_SERVER = `http://localhost:${ntfy.address().port}`;
  base = `http://localhost:${server.address().port}`;
});

after(() => {
  server.close();
  ntfy.close();
});

test('verifySignature', () => {
  const body = Buffer.from('{"a":1}');
  assert.ok(verifySignature(body, sign(body), SECRET));
  assert.ok(!verifySignature(body, 'nope', SECRET));
  assert.ok(!verifySignature(body, undefined, SECRET));
});

test('formatSubmission resolves choices and skips blanks', () => {
  const { title, body } = formatSubmission(payload);
  assert.equal(title, 'New ride preferences (Ride Preferences)');
  assert.equal(body, 'Name: Sam\nMusic: Chill');
});

test('rejects bad signature', async () => {
  const res = await fetch(`${base}/tally/ride-pref`, {
    method: 'POST', headers: { 'Tally-Signature': 'bad' }, body: JSON.stringify(payload),
  });
  assert.equal(res.status, 401);
});

test('signed submission sends a notification', async () => {
  received = [];
  const body = JSON.stringify(payload);
  const res = await fetch(`${base}/tally/ride-pref`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Tally-Signature': sign(body) },
    body,
  });
  assert.equal(res.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/gem-test');
  assert.equal(received[0].body, 'Name: Sam\nMusic: Chill');
});

test('unknown path is 404', async () => {
  assert.equal((await fetch(`${base}/other`)).status, 404);
});
