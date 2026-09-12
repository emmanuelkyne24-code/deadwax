# Deadwax Records API

FastAPI + PostgreSQL backend for the Deadwax reissue record shop. Real auth (JWT
access tokens + rotating, revocable refresh tokens), Stripe Checkout for payments,
and inventory tracking with row-level locking to prevent overselling.

This has been built and verified end-to-end in a local sandbox: migrations ran
against a real Postgres instance, all 14 automated tests pass, and the full
register → browse → cart → checkout → (simulated) webhook → paid → stock-decremented
flow was exercised against a live running server, including the admin-only guard
rejecting a non-admin user with 403. Stripe's real API was never reachable during
development (no network egress to api.stripe.com in that sandbox), so the Stripe
integration is verified via mocking in tests, matching the actual Stripe API shape —
but you should do one real test purchase in Stripe test mode before going live.

## Stack

- **FastAPI** + **SQLAlchemy 2.0** + **Alembic** migrations
- **PostgreSQL**
- **JWT** access tokens (`python-jose`) + hashed, rotating refresh tokens stored in the DB
- **bcrypt** via `passlib` (pinned to `bcrypt==4.0.1` — newer bcrypt removed an
  attribute passlib's backend probe depends on; see Gotchas below)
- **Stripe** Checkout Sessions + webhooks for payment

## Project layout

```
app/
  core/        # settings, password hashing, JWT
  db/          # engine/session
  models/      # SQLAlchemy models (User, RefreshToken, Record, CartItem, Order, OrderItem)
  schemas/     # Pydantic request/response models
  api/
    deps.py    # get_current_user / get_current_admin
    routers/   # auth, users, records, cart, checkout, webhooks, orders
  services/    # stripe_service, inventory_service
  main.py      # FastAPI app + router wiring
alembic/       # migrations (initial schema already generated)
scripts/seed.py
tests/         # pytest suite, Stripe mocked
```

## Local setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

createdb deadwax          # or via docker-compose, see below
cp .env.example .env      # fill in SECRET_KEY and Stripe test keys

alembic upgrade head
python -m scripts.seed    # loads the 8 Deadwax records + an admin user
uvicorn app.main:app --reload
```

Or with Docker:

```bash
docker compose up --build
```

This starts Postgres, waits for it to be healthy, runs migrations, seeds the
catalog, and starts the API on `:8000`.

**Default admin login** (created by the seed script — change the password
immediately in any real deployment): `admin@deadwax.example` / `change-this-password`

## Running tests

```bash
createdb deadwax_test
pytest -v
```

Tests use a separate `deadwax_test` database, truncate all tables between tests,
and mock Stripe entirely (`monkeypatch` on `stripe_service.create_checkout_session`
and `verify_webhook_signature`) — no real Stripe credentials or network access needed.
14 tests cover: registration/login/duplicate-email, refresh token rotation and
revocation-on-replay, genre filtering, cart stock limits, checkout creating a
pending order without touching stock, checkout rejecting an oversold cart,
webhook fulfillment decrementing stock and clearing the cart, and idempotent
webhook retries (Stripe retries webhooks — a duplicate delivery must not
double-decrement stock).

## API overview

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` |
| Users | `GET /users/me` |
| Records | `GET /records` (filter by `genre`, search `q`, `sort`, pagination), `GET /records/{id}` |
| Records (admin) | `POST /records`, `PATCH /records/{id}`, `POST /records/{id}/stock` |
| Cart | `GET /cart`, `POST /cart/items`, `PATCH /cart/items/{record_id}`, `DELETE /cart/items/{record_id}`, `DELETE /cart` |
| Checkout | `POST /checkout/session` → creates a pending `Order` + Stripe Checkout Session |
| Webhooks | `POST /webhooks/stripe` → fulfills paid orders, decrements stock, clears cart |
| Orders | `GET /orders`, `GET /orders/{id}` |

Interactive docs at `/docs` once the server is running.

## Design notes

**Auth.** Access tokens are short-lived JWTs (30 min default). Refresh tokens are
opaque random strings; only their SHA-256 hash is stored, so a stolen DB dump can't
be replayed as a session. Refreshing **rotates** the token — the old one is marked
revoked, so a leaked-and-later-stolen refresh token has a limited window.

**Inventory.** Stock is checked twice: once when adding to cart (fast feedback),
and again right before creating the Stripe session (`check_availability`) so a
stale cart doesn't reach Stripe. The actual decrement happens in the webhook
handler inside a transaction with `SELECT ... FOR UPDATE` on each record
(`inventory_service.decrement_stock_for_order`), so two webhook deliveries (or two
concurrent buyers) can't both decrement past zero.

**Idempotent fulfillment.** Stripe retries webhooks on any non-2xx response or
timeout. The handler looks up the order by `stripe_checkout_session_id` and no-ops
if it's already `paid` — verified in `test_webhook_is_idempotent_on_retry`.

**Order snapshots.** `OrderItem` stores `title_snapshot` and `unit_price_snapshot`
at time of purchase, so a later price change or rename doesn't rewrite history.

**What's a known simplification, not an oversight:**
- Cart and checkout require a logged-in user (no guest checkout). Real stores
  often support both; adding guest checkout would mean a session-token cart
  keyed by a cookie instead of `user_id`.
- If stock is insufficient at the moment a webhook is *actually* processed
  (extremely rare race — checkout already blocks the common case), the order is
  still marked paid rather than silently failing, since the money has already
  moved. It's logged as an oversell for manual reconciliation/refund rather than
  auto-refunded, since auto-refunding on a payment webhook has its own failure
  modes worth deciding deliberately rather than defaulting into.
- No email sending (order confirmation, password reset) — hook in a provider of
  your choice in `webhooks._fulfill_order` and `auth.py` respectively.
- Rate limiting isn't implemented; add `slowapi` or a reverse-proxy-level limit
  before exposing `/auth/*` publicly.

## Gotchas hit while building this (so you don't have to)

- **`bcrypt` 4.1+ breaks `passlib`'s backend detection** (`module 'bcrypt' has no
  attribute '__about__'`). Fixed by pinning `bcrypt==4.0.1` in `requirements.txt`.
  If you bump dependencies later and hit this again, either re-pin bcrypt or
  switch to `passlib`'s successor / hash directly with the `bcrypt` package.
- Alembic's `env.py` was pointed at `app.core.config.settings.DATABASE_URL`
  instead of reading `sqlalchemy.url` from `alembic.ini`, so the same `.env`
  drives both the app and migrations — one source of truth for the connection
  string.
- **Chrome blocks a public page from fetching `localhost`, even with correct
  CORS.** If you're calling this API from something hosted on a public origin
  (a Claude artifact, a deployed frontend, etc.) while the API itself runs on
  your machine, Chrome's Private Network Access check runs *before* your normal
  CORS headers are even considered, and fails the preflight with
  `Disallowed CORS private-network` unless the server opts in. Fixed here by
  passing `allow_private_network=True` to `CORSMiddleware` in `app/main.py`
  (Starlette ≥ 0.36 supports this directly — no custom middleware needed).
  Newer Chrome (138+) goes further with "Local Network Access", which also
  requires a permission grant on the *embedding* page/iframe itself — a
  setting this backend can't control from the server side. If requests are
  still blocked after this fix, check the site's permission icon in the address
  bar for a "Local network access" prompt, or simplest: expose the API through
  a public HTTPS tunnel (`ngrok http 8000`) and point the frontend at that URL
  instead of `localhost` — a public-to-public request sidesteps this class of
  restriction entirely.

## Wiring up real Stripe

1. Get test-mode keys from the Stripe dashboard, put them in `.env`.
2. Run `stripe listen --forward-to localhost:8000/webhooks/stripe` locally to get
   a webhook signing secret for `STRIPE_WEBHOOK_SECRET`.
3. Use Stripe's test card `4242 4242 4242 4242` to complete a checkout and confirm
   the webhook fires, the order flips to `paid`, and stock decrements — this
   exact path is unit-tested with Stripe mocked, but hasn't been run against the
   real Stripe API in this environment, so it's worth the one manual pass.
