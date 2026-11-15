# Clinic booking API

Node.js + Express API backed by Postgres, plus a booking page served at `/`.

## Run locally

```bash
npm install
createdb clinic_dev
export DATABASE_URL=postgres://localhost/clinic_dev
export API_KEY=change-me
npm start            # http://localhost:3000
npm test             # runs the test suite against DATABASE_URL
```

## Environment variables

| Name | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (required) |
| `DATABASE_SSL` | Set to `true` for hosted Postgres that requires TLS |
| `API_KEY` | Value every request must send in `X-API-Key` (required) |
| `PORT` | Port to listen on (defaults to 3000; hosts usually set this) |

## Endpoints

All requests need `X-API-Key`. Errors look like `{"error": "..."}`.

- `POST /reset` (L1): replace all slots, clear bookings
- `GET /slots` (L1): list slots earliest first, with `available`; optional `?provider=`
- `POST /bookings` (L1–L5): book a slot; supports `Idempotency-Key`; 429 with `Retry-After` after 5 attempts per email per minute
- `GET /bookings?email=…&limit=…&cursor=…` (L4): a person's bookings, oldest first, cursor-paginated
- `GET /bookings/:id` (L1): look up a booking
- `DELETE /bookings/:id` (L3): cancel a booking and free the slot

## How the levels are enforced

- **No double booking (L3):** a partial unique index on `bookings (slot_id) WHERE status = 'confirmed'` lets the database reject concurrent duplicates.
- **Idempotency (L4):** requests with the same `Idempotency-Key` are serialized with an advisory lock; the first response is stored and replayed.
- **Rate limit (L5):** every attempt is recorded in `booking_attempts`, and checks are serialized per email with an advisory lock.
