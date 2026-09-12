# Deadwax Records

A reissue vinyl shop demo, built as a full-stack pair:

- **`backend/`** — FastAPI + PostgreSQL. Real JWT auth with rotating/revocable
  refresh tokens, Stripe Checkout, and inventory tracking with row-level
  locking to prevent overselling. See [`backend/README.md`](backend/README.md)
  for full setup, the API reference, design notes, and gotchas hit while
  building it (worth reading before you run it).
- **`frontend/DeadwaxRecords.jsx`** — a single-file React component (Tailwind
  core utilities only, no build-time JIT dependency) wired to the live API:
  browsing/filtering/search, a persisted per-user cart, sign-in/register,
  JWT refresh-and-retry on every authenticated call, and a real redirect to
  Stripe Checkout. Animation choices (hover/press feedback, the tab-indicator,
  drawer/modal/toast timing, `prefers-reduced-motion` handling) follow a
  deliberate motion-design pass rather than defaults.

## Running it locally

```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
createdb deadwax
cp .env.example .env
alembic upgrade head
python -m scripts.seed
uvicorn app.main:app --reload
```

(or `docker compose up --build` from `backend/` instead of the manual steps above)

Then drop `frontend/DeadwaxRecords.jsx` into any React + Tailwind project (only
dependency: `lucide-react`), or view it as a Claude artifact — it talks to
`http://localhost:8000` by default, and since it runs in your browser,
"localhost" means *your* machine, so a locally running backend is reachable as
long as its CORS settings allow it (they do, by default: `ALLOWED_ORIGINS=["*"]`,
safe here since auth is Bearer-token, not cookies).

**Note if the frontend is running as a hosted/public-origin page (like a
Claude artifact) while the backend is on `localhost`:** Chrome's Private
Network Access check runs before normal CORS is even considered. The backend
already opts in via `allow_private_network=True`, but Chrome 138+ added a
further "Local Network Access" permission prompt on the *page* itself that the
server can't grant on your behalf — see `backend/README.md`'s Gotchas section
if the catalog won't load.

## Status

Built and verified end-to-end against a real local Postgres instance: 14/14
automated tests pass, and the full register → browse → cart → checkout →
webhook → paid → stock-decremented flow was exercised against a live running
server. Stripe's real API was never reachable in that sandbox (no network
egress to api.stripe.com), so Stripe is verified via mocking that matches its
actual response shape, not a live call — do one real test purchase in Stripe
test mode before going live (see `backend/README.md` for exact steps).
