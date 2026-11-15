const { Pool } = require('pg');

// DATABASE_URL is required. Set DATABASE_SSL=true for hosted Postgres that needs TLS (Neon, Supabase).
function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id        text PRIMARY KEY,
  provider  text NOT NULL,
  start_at  timestamptz NOT NULL,
  end_at    timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        bigserial PRIMARY KEY,
  id         text NOT NULL UNIQUE DEFAULT gen_random_uuid()::text,
  slot_id    text NOT NULL REFERENCES slots(id),
  name       text NOT NULL,
  email      text NOT NULL,
  status     text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Level 3: at most one confirmed booking per slot, enforced by the database itself.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);

-- Level 5: every booking attempt is recorded so attempts can be counted per email.
CREATE TABLE IF NOT EXISTS booking_attempts (
  seq   bigserial PRIMARY KEY,
  email text NOT NULL,
  at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_at ON booking_attempts (email, at);

-- Level 4: stored responses for Idempotency-Key headers.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        text PRIMARY KEY,
  body_hash  text NOT NULL,
  status     integer NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

async function migrate(pool) {
  await pool.query(SCHEMA);
}

module.exports = { createPool, migrate };
