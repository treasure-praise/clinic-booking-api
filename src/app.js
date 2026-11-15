const express = require('express');
const crypto = require('crypto');
const path = require('path');

const RATE_LIMIT_MAX = 5; // Level 5: attempts per email
const RATE_LIMIT_WINDOW_SECONDS = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isoOrNull(value) {
  return value instanceof Date ? value.toISOString().replace('.000Z', 'Z') : value;
}

function bookingFromRow(row) {
  return {
    id: row.id,
    slot_id: row.slot_id,
    name: row.name,
    email: row.email,
    status: row.status,
    created_at: isoOrNull(row.created_at),
  };
}

function slotFromRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    start: isoOrNull(row.start_at),
    end: isoOrNull(row.end_at),
  };
}

function stableHash(body) {
  const sorted = Object.keys(body)
    .sort()
    .map((k) => [k, body[k]]);
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function requireApiKey(expectedKey) {
  const expected = Buffer.from(expectedKey || '');
  return (req, res, next) => {
    const given = Buffer.from(req.get('X-API-Key') || '');
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) {
      return res.status(401).json({ error: 'missing or invalid API key' });
    }
    next();
  };
}

function createApp({ pool, apiKey }) {
  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const auth = requireApiKey(apiKey);

  // POST /reset (Level 1): wipe bookings and replace slots.
  app.post('/reset', auth, async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || !Array.isArray(body.slots)) {
      return res.status(400).json({ error: 'slots must be an array' });
    }
    for (const s of body.slots) {
      if (
        !s ||
        typeof s.id !== 'string' || !s.id.trim() ||
        typeof s.provider !== 'string' ||
        Number.isNaN(Date.parse(s.start)) ||
        Number.isNaN(Date.parse(s.end))
      ) {
        return res.status(400).json({ error: 'each slot needs id, provider, start and end' });
      }
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM bookings');
      await client.query('DELETE FROM booking_attempts');
      await client.query('DELETE FROM idempotency_keys');
      await client.query('DELETE FROM slots');
      for (const s of body.slots) {
        await client.query(
          'INSERT INTO slots (id, provider, start_at, end_at) VALUES ($1, $2, $3, $4)',
          [s.id, s.provider, s.start, s.end]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(400).json({ error: 'duplicate slot id' });
      }
      throw err;
    } finally {
      client.release();
    }
    res.status(200).json({ ok: true, slots: body.slots.length });
  });

  // GET /slots (Level 1): all slots, earliest first, with availability.
  app.get('/slots', auth, async (req, res) => {
    const params = [];
    let where = '';
    if (typeof req.query.provider === 'string') {
      params.push(req.query.provider);
      where = 'WHERE s.provider = $1';
    }
    const { rows } = await pool.query(
      `SELECT s.id, s.provider, s.start_at, s.end_at,
              NOT EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.slot_id = s.id AND b.status = 'confirmed'
              ) AS available
         FROM slots s
         ${where}
        ORDER BY s.start_at ASC, s.id ASC`,
      params
    );
    res.json({
      slots: rows.map((r) => ({ ...slotFromRow(r), available: r.available })),
    });
  });

  // POST /bookings (Levels 1-5)
  app.post('/bookings', auth, async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const idemKey = req.get('Idempotency-Key');
    const bodyHash = stableHash(body);

    const client = await pool.connect();
    let outcome;
    try {
      await client.query('BEGIN');

      // Level 4: serialise requests that share an Idempotency-Key.
      if (idemKey) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['idem:' + idemKey]);
        const { rows } = await client.query(
          'SELECT body_hash, status, response FROM idempotency_keys WHERE key = $1',
          [idemKey]
        );
        if (rows[0]) {
          await client.query('COMMIT');
          if (rows[0].body_hash !== bodyHash) {
            return res.status(422).json({ error: 'Idempotency-Key was already used with a different body' });
          }
          return res.status(rows[0].status).json(rows[0].response);
        }
      }

      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

      // Level 5: rate limit per email. Every attempt counts, including failed ones.
      if (email) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['email:' + email]);
        const { rows } = await client.query(
          `SELECT count(*)::int AS n,
                  EXTRACT(EPOCH FROM (min(at) + make_interval(secs => $2) - now())) AS retry_after
             FROM booking_attempts
            WHERE email = $1 AND at > now() - make_interval(secs => $2)`,
          [email, RATE_LIMIT_WINDOW_SECONDS]
        );
        if (rows[0].n >= RATE_LIMIT_MAX) {
          await client.query('COMMIT');
          const retryAfter = Math.max(1, Math.ceil(Number(rows[0].retry_after)));
          res.set('Retry-After', String(retryAfter));
          return res.status(429).json({ error: 'too many booking attempts for this email, try again later' });
        }
        await client.query('INSERT INTO booking_attempts (email) VALUES ($1)', [email]);
      }

      outcome = await createBooking(client, body);

      if (idemKey && [201, 400, 404, 409].includes(outcome.status)) {
        await client.query(
          'INSERT INTO idempotency_keys (key, body_hash, status, response) VALUES ($1, $2, $3, $4)',
          [idemKey, bodyHash, outcome.status, JSON.stringify(outcome.body)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    res.status(outcome.status).json(outcome.body);
  });

  async function createBooking(client, body) {
    const slotId = typeof body.slot_id === 'string' ? body.slot_id.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    // Level 2: validation.
    if (!slotId || !name || !email) {
      return { status: 400, body: { error: 'slot_id, name and email are required' } };
    }
    if (!EMAIL_RE.test(email)) {
      return { status: 400, body: { error: 'email is not valid' } };
    }

    const { rows } = await client.query(
      'SELECT id, start_at <= now() AS started FROM slots WHERE id = $1',
      [slotId]
    );
    if (!rows[0]) {
      return { status: 404, body: { error: 'slot not found' } };
    }
    if (rows[0].started) {
      return { status: 400, body: { error: 'slot has already started' } };
    }

    // Level 3: the partial unique index makes concurrent inserts race safely.
    await client.query('SAVEPOINT booking_insert');
    try {
      const inserted = await client.query(
        `INSERT INTO bookings (slot_id, name, email, status)
         VALUES ($1, $2, $3, 'confirmed')
         RETURNING id, slot_id, name, email, status, created_at`,
        [slotId, name, email]
      );
      await client.query('RELEASE SAVEPOINT booking_insert');
      return { status: 201, body: bookingFromRow(inserted.rows[0]) };
    } catch (err) {
      if (err.code !== '23505') throw err;
      await client.query('ROLLBACK TO SAVEPOINT booking_insert');
      return { status: 409, body: { error: 'slot is already booked' } };
    }
  }

  // GET /bookings (Level 4): one person's bookings, oldest first, cursor-paginated.
  app.get('/bookings', auth, async (req, res) => {
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
    if (!email) {
      return res.status(400).json({ error: 'email query parameter is required' });
    }

    let limit = 10;
    if (req.query.limit !== undefined) {
      const raw = String(req.query.limit);
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 50) {
        return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
      }
      limit = Number(raw);
    }

    let afterSeq = 0;
    if (req.query.cursor !== undefined) {
      const raw = String(req.query.cursor);
      if (!/^\d+$/.test(raw)) {
        return res.status(400).json({ error: 'cursor is not valid' });
      }
      afterSeq = Number(raw);
    }

    const { rows } = await pool.query(
      `SELECT seq, id, slot_id, name, email, status, created_at
         FROM bookings
        WHERE email = $1 AND seq > $2
        ORDER BY seq ASC
        LIMIT $3`,
      [email, afterSeq, limit + 1]
    );

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    res.json({
      bookings: page.map(bookingFromRow),
      next_cursor: hasMore ? String(page[page.length - 1].seq) : null,
    });
  });

  // GET /bookings/:id (Level 1)
  app.get('/bookings/:id', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT id, slot_id, name, email, status, created_at FROM bookings WHERE id = $1',
      [req.params.id]
    );
    if (!rows[0]) {
      return res.status(404).json({ error: 'booking not found' });
    }
    res.json(bookingFromRow(rows[0]));
  });

  // DELETE /bookings/:id (Level 3): cancel and free the slot.
  app.delete('/bookings/:id', auth, async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE bookings SET status = 'cancelled'
        WHERE id = $1 AND status = 'confirmed'
        RETURNING id, slot_id, name, email, status, created_at`,
      [req.params.id]
    );
    if (rows[0]) {
      return res.json(bookingFromRow(rows[0]));
    }
    const existing = await pool.query('SELECT status FROM bookings WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) {
      return res.status(404).json({ error: 'booking not found' });
    }
    return res.status(409).json({ error: 'booking is already cancelled' });
  });

  // Malformed JSON and anything else unexpected.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'request body is not valid JSON' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request body is too large' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp };
