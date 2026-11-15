const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createPool, migrate } = require('../src/db');
const { createApp } = require('../src/app');

const API_KEY = 'test-key-123';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/clinic_dev';

let server;
let base;
let pool;

const future = (days, hour = 9) => {
  const d = new Date(Date.now() + days * 86400000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};
const addMinutes = (iso, m) => new Date(Date.parse(iso) + m * 60000).toISOString();

async function call(method, path, { body, key = API_KEY, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (key !== null) h['X-API-Key'] = key;
  if (body !== undefined || raw !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, {
    method,
    headers: h,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  return { status: res.status, data, headers: res.headers };
}

function seedSlots() {
  return [
    { id: 's1', provider: 'Dr Ade', start: future(2, 9), end: addMinutes(future(2, 9), 30) },
    { id: 's2', provider: 'Dr Ade', start: future(2, 10), end: addMinutes(future(2, 10), 30) },
    { id: 's3', provider: 'Dr Bola', start: future(3, 9), end: addMinutes(future(3, 9), 30) },
    { id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' },
  ];
}

const reset = (slots = seedSlots()) => call('POST', '/reset', { body: { slots } });

before(async () => {
  pool = createPool(DATABASE_URL);
  await migrate(pool);
  const app = createApp({ pool, apiKey: API_KEY });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

beforeEach(async () => {
  const r = await reset();
  assert.equal(r.status, 200);
});

// ---------- Level 1 ----------
test('L1: lists slots earliest first, with availability', async () => {
  const r = await call('GET', '/slots');
  assert.equal(r.status, 200);
  assert.equal(r.data.slots.length, 4);
  assert.deepEqual(r.data.slots[0].id, 'past');
  const s1 = r.data.slots.find((s) => s.id === 's1');
  assert.equal(s1.provider, 'Dr Ade');
  assert.equal(s1.available, true);
  assert.ok(s1.start && s1.end);
});

test('L1: filters slots by exact provider', async () => {
  const r = await call('GET', '/slots?provider=Dr%20Bola');
  assert.deepEqual(r.data.slots.map((s) => s.id), ['s3']);
});

test('L1: books a slot (201, confirmed) and looks it up', async () => {
  const b = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada Obi', email: 'ada@example.com' } });
  assert.equal(b.status, 201);
  assert.equal(b.data.status, 'confirmed');
  assert.equal(b.data.slot_id, 's1');
  assert.equal(b.data.name, 'Ada Obi');
  assert.ok(b.data.id);
  assert.ok(b.data.created_at);

  const g = await call('GET', `/bookings/${b.data.id}`);
  assert.equal(g.status, 200);
  assert.equal(g.data.id, b.data.id);

  const s = await call('GET', '/slots');
  assert.equal(s.data.slots.find((x) => x.id === 's1').available, false);
});

test('L1: unknown booking id returns 404', async () => {
  const r = await call('GET', '/bookings/does-not-exist');
  assert.equal(r.status, 404);
  assert.ok(r.data.error);
});

// ---------- Level 2 ----------
test('L2: missing or wrong API key returns 401', async () => {
  assert.equal((await call('GET', '/slots', { key: null })).status, 401);
  assert.equal((await call('GET', '/slots', { key: 'wrong' })).status, 401);
  const r = await call('GET', '/slots', { key: 'wrong' });
  assert.ok(r.data.error);
});

test('L2: every protected route checks the key', async () => {
  assert.equal((await call('POST', '/reset', { key: null, body: { slots: [] } })).status, 401);
  assert.equal((await call('POST', '/bookings', { key: null, body: {} })).status, 401);
  assert.equal((await call('GET', '/bookings?email=a@b.co', { key: null })).status, 401);
  assert.equal((await call('DELETE', '/bookings/x', { key: null })).status, 401);
});

test('L2: rejects missing or empty fields with 400', async () => {
  const cases = [{}, { slot_id: 's1', name: 'A' }, { slot_id: 's1', email: 'a@b.co' }, { name: 'A', email: 'a@b.co' },
    { slot_id: '  ', name: 'A', email: 'a@b.co' }, { slot_id: 's1', name: '   ', email: 'a@b.co' }];
  for (const body of cases) {
    const r = await call('POST', '/bookings', { body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.data.error);
  }
});

test('L2: rejects invalid email with 400', async () => {
  const r = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'A', email: 'not-an-email' } });
  assert.equal(r.status, 400);
});

test('L2: unknown slot returns 404', async () => {
  const r = await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'A', email: 'a@b.co' } });
  assert.equal(r.status, 404);
});

test('L2: a slot that already started returns 400', async () => {
  const r = await call('POST', '/bookings', { body: { slot_id: 'past', name: 'A', email: 'a@b.co' } });
  assert.equal(r.status, 400);
});

test('L2: trims name and email, lowercases email', async () => {
  const r = await call('POST', '/bookings', { body: { slot_id: 's1', name: '  Ada Obi  ', email: '  ADA@Example.COM ' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.name, 'Ada Obi');
  assert.equal(r.data.email, 'ada@example.com');
});

test('L2: malformed JSON returns 400 with an error body', async () => {
  const r = await call('POST', '/bookings', { raw: '{not json' });
  assert.equal(r.status, 400);
  assert.ok(r.data.error);
});

// ---------- Level 3 ----------
test('L3: a second booking of the same slot returns 409', async () => {
  const body = { slot_id: 's1', name: 'Ada', email: 'ada@example.com' };
  assert.equal((await call('POST', '/bookings', { body })).status, 201);
  const r = await call('POST', '/bookings', { body: { ...body, email: 'bola@example.com' } });
  assert.equal(r.status, 409);
  assert.ok(r.data.error);
});

test('L3: concurrent requests for one slot produce exactly one booking', async () => {
  const requests = Array.from({ length: 20 }, (_, i) =>
    call('POST', '/bookings', { body: { slot_id: 's2', name: `Person ${i}`, email: `p${i}@example.com` } })
  );
  const results = await Promise.all(requests);
  const codes = results.map((r) => r.status).sort();
  assert.equal(codes.filter((c) => c === 201).length, 1, `codes: ${codes}`);
  assert.equal(codes.filter((c) => c === 409).length, 19, `codes: ${codes}`);
  const rows = await pool.query("SELECT count(*)::int AS n FROM bookings WHERE slot_id = 's2' AND status = 'confirmed'");
  assert.equal(rows.rows[0].n, 1);
});

test('L3: cancelling frees the slot, and a second cancel returns 409', async () => {
  const b = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada', email: 'ada@example.com' } });
  const c = await call('DELETE', `/bookings/${b.data.id}`);
  assert.equal(c.status, 200);
  assert.equal(c.data.status, 'cancelled');

  const again = await call('DELETE', `/bookings/${b.data.id}`);
  assert.equal(again.status, 409);

  const g = await call('GET', `/bookings/${b.data.id}`);
  assert.equal(g.data.status, 'cancelled');

  const rebook = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Bola', email: 'bola@example.com' } });
  assert.equal(rebook.status, 201);
});

test('L3: cancelling an unknown booking returns 404', async () => {
  const r = await call('DELETE', '/bookings/nope');
  assert.equal(r.status, 404);
});

// ---------- Level 4 ----------
test('L4: same Idempotency-Key and body returns the same booking, no duplicate', async () => {
  const headers = { 'Idempotency-Key': 'key-abc' };
  const body = { slot_id: 's1', name: 'Ada', email: 'ada@example.com' };
  const first = await call('POST', '/bookings', { body, headers });
  const second = await call('POST', '/bookings', { body, headers });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(second.data.id, first.data.id);
  const rows = await pool.query("SELECT count(*)::int AS n FROM bookings WHERE slot_id = 's1'");
  assert.equal(rows.rows[0].n, 1);
});

test('L4: same Idempotency-Key with a different body returns 422', async () => {
  const headers = { 'Idempotency-Key': 'key-xyz' };
  await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada', email: 'ada@example.com' }, headers });
  const r = await call('POST', '/bookings', { body: { slot_id: 's3', name: 'Ada', email: 'ada@example.com' }, headers });
  assert.equal(r.status, 422);
  assert.ok(r.data.error);
});

test('L4: a retried request after a 409 gets the same 409 response', async () => {
  await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Ada', email: 'ada@example.com' } });
  const headers = { 'Idempotency-Key': 'retry-409' };
  const body = { slot_id: 's1', name: 'Bola', email: 'bola@example.com' };
  const first = await call('POST', '/bookings', { body, headers });
  const second = await call('POST', '/bookings', { body, headers });
  assert.equal(first.status, 409);
  assert.equal(second.status, 409);
});

test('L4: lists a person’s bookings oldest first, paginated by cursor', async () => {
  const email = 'pager@example.com';
  const ids = [];
  for (const slot of ['s1', 's2', 's3']) {
    const r = await call('POST', '/bookings', { body: { slot_id: slot, name: 'Pager', email } });
    assert.equal(r.status, 201);
    ids.push(r.data.id);
  }
  // A different person's booking must not appear.
  await call('POST', '/bookings', { body: { slot_id: 'past', name: 'Other', email: 'other@example.com' } });

  const p1 = await call('GET', `/bookings?email=${encodeURIComponent('PAGER@example.com')}&limit=2`);
  assert.equal(p1.status, 200);
  assert.deepEqual(p1.data.bookings.map((b) => b.id), ids.slice(0, 2));
  assert.ok(p1.data.next_cursor);

  const p2 = await call('GET', `/bookings?email=${encodeURIComponent(email)}&limit=2&cursor=${p1.data.next_cursor}`);
  assert.deepEqual(p2.data.bookings.map((b) => b.id), ids.slice(2));
  assert.equal(p2.data.next_cursor, null);
});

test('L4: default limit is 10 and limits outside 1..50 return 400', async () => {
  const r = await call('GET', '/bookings?email=nobody@example.com');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.bookings, []);
  assert.equal(r.data.next_cursor, null);
  for (const limit of ['0', '51', 'abc', '-1']) {
    const bad = await call('GET', `/bookings?email=nobody@example.com&limit=${limit}`);
    assert.equal(bad.status, 400, `limit=${limit}`);
  }
});

test('L4: email query is required', async () => {
  const r = await call('GET', '/bookings');
  assert.equal(r.status, 400);
});

// ---------- Level 5 ----------
test('L5: the 6th attempt from one email in a minute returns 429 with Retry-After', async () => {
  const email = 'spammer@example.com';
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/bookings', { body: { slot_id: 'nope', name: 'S', email } });
    assert.equal(r.status, 404, `attempt ${i + 1}`);
  }
  const r = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'S', email } });
  assert.equal(r.status, 429);
  const retry = Number(r.headers.get('Retry-After'));
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After=${r.headers.get('Retry-After')}`);
});

test('L5: failed attempts count, and other emails are not affected', async () => {
  const spam = 'counted@example.com';
  for (let i = 0; i < 5; i++) {
    await call('POST', '/bookings', { body: { slot_id: 'missing-fields', name: '', email: spam } });
  }
  assert.equal((await call('POST', '/bookings', { body: { slot_id: 's1', name: 'X', email: spam } })).status, 429);
  const other = await call('POST', '/bookings', { body: { slot_id: 's1', name: 'Y', email: 'fine@example.com' } });
  assert.equal(other.status, 201);
});

test('L5: booking retries with the same Idempotency-Key do not consume attempts', async () => {
  const email = 'retrier@example.com';
  const headers = { 'Idempotency-Key': 'retry-no-count' };
  const body = { slot_id: 's1', name: 'R', email };
  await call('POST', '/bookings', { body, headers });
  for (let i = 0; i < 10; i++) {
    const r = await call('POST', '/bookings', { body, headers });
    assert.equal(r.status, 201, `replay ${i + 1}`);
  }
});

test('reset clears bookings', async () => {
  await call('POST', '/bookings', { body: { slot_id: 's1', name: 'A', email: 'a@example.com' } });
  await reset();
  const s = await call('GET', '/slots');
  assert.equal(s.data.slots.find((x) => x.id === 's1').available, true);
});
