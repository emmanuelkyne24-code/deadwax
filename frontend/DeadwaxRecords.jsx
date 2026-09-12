import React, { useState, useRef, useLayoutEffect, useEffect, useCallback } from "react";
import { ShoppingBag, X, Plus, Minus, ChevronDown, Search, Play, User, LogOut } from "lucide-react";

/* -------------------------------------------------------------------- */
/* Backend wiring                                                        */
/*                                                                        */
/* This talks to a real FastAPI server (see the deadwax-backend project).*/
/* Run it locally with `uvicorn app.main:app --reload` (defaults to      */
/* http://localhost:8000) - since this artifact renders in your browser, */
/* "localhost" means *your* machine, so a locally running backend is     */
/* reachable from here as long as its CORS settings allow it (the        */
/* backend's default ALLOWED_ORIGINS=["*"] already does).                */
/* -------------------------------------------------------------------- */

const API_BASE = "http://localhost:8000";

const ACCENTS = ["#E8622C", "#E3A62F", "#2F8F8F", "#C1432B"];
const NAVY = "#0F1E3D";
const PAPER = "#EAE3D3";
const INK = "#14110D";

const GENRES = ["All", "Jazz", "Soul", "Latin", "Global"];
const SORTS = [
  { label: "Newest", value: "newest" },
  { label: "Price: Low to High", value: "price_asc" },
  { label: "Price: High to Low", value: "price_desc" },
];

// Deterministic accent per record so a card's color doesn't shift when the
// list re-sorts - derived from the catalog number rather than list position.
function accentFor(catalogNumber) {
  const sum = [...catalogNumber].reduce((a, c) => a + c.charCodeAt(0), 0);
  return ACCENTS[sum % ACCENTS.length];
}

/* -------------------------------------------------------------------- */
/* Record cover (CSS-only cover art, no images needed)                  */
/* -------------------------------------------------------------------- */

function Cover({ record, size = "normal" }) {
  const accent = accentFor(record.catalog_number);
  const big = size === "big";
  return (
    <div
      className="dw-grooves relative w-full aspect-square overflow-hidden rounded-sm"
      style={{ backgroundColor: NAVY }}
    >
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(115deg, transparent 55%, ${accent} 55%)` }}
      />
      <div
        className="absolute top-3 left-3 font-mono tracking-widest"
        style={{ color: PAPER, fontSize: big ? 12 : 10, opacity: 0.85 }}
      >
        {record.catalog_number}
      </div>
      <div className="absolute inset-0 flex items-end p-4">
        <div className="font-display uppercase dw-leading-85" style={{ color: PAPER, fontSize: big ? 34 : 22 }}>
          {record.title}
        </div>
      </div>
      {record.stock <= 0 && (
        <div
          className="absolute top-3 right-3 px-2 py-1 font-mono dw-text-9 tracking-widest rounded-sm"
          style={{ backgroundColor: PAPER, color: INK }}
        >
          SOLD OUT
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Main component                                                        */
/* -------------------------------------------------------------------- */

export default function DeadwaxRecords() {
  /* ---- catalog browsing state -------------------------------------- */
  const [records, setRecords] = useState([]);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [recordsError, setRecordsError] = useState(null);
  const [genre, setGenre] = useState("All");
  const [sort, setSort] = useState("newest");
  const [sortOpen, setSortOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [quickView, setQuickView] = useState(null);
  const [heroRevealed, setHeroRevealed] = useState(false);

  /* ---- auth ----------------------------------------------------------
     Kept in React state only (artifacts can't use localStorage), so
     signing in lasts for this session/tab, not across a page reload -
     acceptable for a demo, and a real deploy would swap this for
     persisted storage on your own domain. */
  const [tokens, setTokens] = useState(null); // { access_token, refresh_token }
  const [me, setMe] = useState(null); // { email, ... }
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login"); // 'login' | 'register'
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const tokensRef = useRef(null); // avoids stale closures inside authFetch
  tokensRef.current = tokens;

  /* ---- cart ----------------------------------------------------------
     Source of truth is the backend, not local state - every mutation
     re-fetches /cart so the UI reflects real inventory-checked totals. */
  const [cart, setCart] = useState({ items: [], subtotal: "0.00" });
  const [cartOpen, setCartOpen] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(false);

  const [toastText, setToastText] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimer = useRef(null);
  const sortBtnRef = useRef(null);

  function showToast(text) {
    setToastText(text);
    setToastVisible(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastVisible(false), 3200);
  }

  /* ---- authFetch: attaches the bearer token, and on a 401 tries a
     single refresh-and-retry before giving up and asking the user to
     sign in again. Centralizing this here means every call site below
     (cart, checkout, /users/me) gets refresh handling for free. ------ */
  const authFetch = useCallback(async (path, options = {}) => {
    const doFetch = (accessToken) =>
      fetch(`${API_BASE}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
      });

    let current = tokensRef.current;
    if (!current) {
      throw new Error("__NEEDS_AUTH__");
    }

    let res = await doFetch(current.access_token);
    if (res.status !== 401) return res;

    // Access token likely expired - try the refresh token once.
    const refreshRes = await fetch(`${API_BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: current.refresh_token }),
    });
    if (!refreshRes.ok) {
      setTokens(null);
      setMe(null);
      throw new Error("__NEEDS_AUTH__");
    }
    const fresh = await refreshRes.json();
    setTokens(fresh);
    tokensRef.current = fresh;
    res = await doFetch(fresh.access_token);
    return res;
  }, []);

  async function extractError(res, fallback) {
    try {
      const body = await res.json();
      return body.detail || fallback;
    } catch {
      return fallback;
    }
  }

  /* ---- load catalog from the backend --------------------------------- */
  const loadRecords = useCallback(async () => {
    setRecordsLoading(true);
    setRecordsError(null);
    try {
      const params = new URLSearchParams({ sort });
      if (genre !== "All") params.set("genre", genre);
      if (query.trim()) params.set("q", query.trim());
      const res = await fetch(`${API_BASE}/records?${params.toString()}`);
      if (!res.ok) throw new Error(`Server responded ${res.status}`);
      const data = await res.json();
      setRecords(data);
    } catch (err) {
      setRecordsError(
        err.message === "Failed to fetch"
          ? "Can't reach the Deadwax API. Is it running at " + API_BASE + "?"
          : err.message
      );
    } finally {
      setRecordsLoading(false);
    }
  }, [genre, sort, query]);

  useEffect(() => {
    const t = setTimeout(loadRecords, 200); // small debounce for the search box
    return () => clearTimeout(t);
  }, [loadRecords]);

  useEffect(() => {
    const t = setTimeout(() => setHeroRevealed(true), 150);
    return () => clearTimeout(t);
  }, []);

  /* ---- refresh /users/me whenever we get a fresh set of tokens ------- */
  useEffect(() => {
    if (!tokens) {
      setMe(null);
      return;
    }
    authFetch("/users/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data && setMe(data))
      .catch(() => {});
    refreshCart();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokens]);

  async function refreshCart() {
    try {
      const res = await authFetch("/cart");
      if (res.ok) setCart(await res.json());
    } catch {
      // Not signed in yet, or session expired - leave cart as-is; the
      // relevant action (add/open) will prompt sign-in.
    }
  }

  /* ---- auth actions ---------------------------------------------------- */
  function openAuth(mode) {
    setAuthMode(mode);
    setAuthError("");
    setAuthOpen(true);
  }

  async function submitAuth(e) {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError("");
    try {
      const res = await fetch(`${API_BASE}/auth/${authMode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: authEmail, password: authPassword }),
      });
      if (!res.ok) {
        setAuthError(await extractError(res, "Something went wrong. Try again."));
        return;
      }
      const data = await res.json();
      setTokens(data);
      setAuthOpen(false);
      setAuthPassword("");
      showToast(authMode === "register" ? "Welcome to Deadwax." : "Signed in.");
    } catch {
      setAuthError("Can't reach the Deadwax API. Is it running at " + API_BASE + "?");
    } finally {
      setAuthLoading(false);
    }
  }

  async function logout() {
    if (tokens) {
      fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: tokens.refresh_token }),
      }).catch(() => {});
    }
    setTokens(null);
    setMe(null);
    setCart({ items: [], subtotal: "0.00" });
    setCartOpen(false);
    showToast("Signed out.");
  }

  /* ---- cart actions ------------------------------------------------------
     Every mutation requires auth; if signed out, we open the sign-in
     modal instead of silently failing. */
  async function addToCart(record) {
    if (!tokens) return openAuth("login");
    try {
      const res = await authFetch("/cart/items", {
        method: "POST",
        body: JSON.stringify({ record_id: record.id, quantity: 1 }),
      });
      if (res.status === 409) {
        showToast(await extractError(res, "Not enough stock."));
        return;
      }
      if (!res.ok) {
        showToast(await extractError(res, "Couldn't add that to your crate."));
        return;
      }
      setCart(await res.json());
      showToast(`Added "${record.title}" to your crate`);
    } catch (err) {
      if (err.message === "__NEEDS_AUTH__") openAuth("login");
      else showToast("Couldn't reach the Deadwax API.");
    }
  }

  async function changeQty(recordId, nextQty) {
    try {
      const res =
        nextQty <= 0
          ? await authFetch(`/cart/items/${recordId}`, { method: "DELETE" })
          : await authFetch(`/cart/items/${recordId}`, {
              method: "PATCH",
              body: JSON.stringify({ quantity: nextQty }),
            });
      if (res.status === 409) {
        showToast(await extractError(res, "Not enough stock."));
        return;
      }
      if (res.ok) setCart(await res.json());
    } catch (err) {
      if (err.message === "__NEEDS_AUTH__") openAuth("login");
    }
  }

  async function checkout() {
    if (!tokens) return openAuth("login");
    setCheckoutLoading(true);
    try {
      const res = await authFetch("/checkout/session", { method: "POST" });
      if (!res.ok) {
        showToast(await extractError(res, "Checkout isn't available right now."));
        return;
      }
      const data = await res.json();
      // Real redirect to Stripe Checkout. In local dev without live Stripe
      // keys configured on the backend, this call itself will 502 (Stripe
      // rejects the placeholder key) and surface via the branch above -
      // that's the backend correctly reporting a Stripe-side failure, not
      // a bug in this wiring.
      window.location.href = data.checkout_url;
    } catch (err) {
      if (err.message === "__NEEDS_AUTH__") openAuth("login");
      else showToast("Couldn't reach the Deadwax API.");
    } finally {
      setCheckoutLoading(false);
    }
  }

  const cartCount = cart.items.reduce((a, x) => a + x.quantity, 0);
  const quickViewRecord = records.find((r) => r.id === quickView);

  return (
    <div
      className="min-h-screen w-full"
      style={{
        // eslint-disable-next-line
        "--ease-out": "cubic-bezier(0.23, 1, 0.32, 1)",
        "--ease-in-out": "cubic-bezier(0.77, 0, 0.175, 1)",
        "--ease-drawer": "cubic-bezier(0.32, 0.72, 0, 1)",
        backgroundColor: PAPER,
        color: INK,
        fontFamily: "'Space Grotesk', sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;500&display=swap');

        .font-display { font-family: 'Archivo Black', sans-serif; }
        .font-mono { font-family: 'IBM Plex Mono', monospace; }

        .dw-grooves::after {
          content: "";
          position: absolute;
          inset: 0;
          background-image: repeating-radial-gradient(circle at 88% 12%, rgba(234,227,211,0.08) 0px, rgba(234,227,211,0.08) 1px, transparent 1px, transparent 5px);
          pointer-events: none;
        }

        .dw-card { transition: transform 200ms var(--ease-out), box-shadow 200ms var(--ease-out); }
        @media (hover: hover) and (pointer: fine) {
          .dw-card:hover { transform: translateY(-6px); box-shadow: 0 18px 30px -14px rgba(15,30,64,0.35); }
        }

        .dw-press { transition: transform 160ms var(--ease-out); }
        .dw-press:active { transform: scale(0.97); }

        .dw-popover { transform-origin: top right; transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
        .dw-popover-hidden { opacity: 0; transform: scale(0.95); pointer-events: none; }
        .dw-popover-visible { opacity: 1; transform: scale(1); }

        .dw-backdrop { transition: opacity 250ms var(--ease-out); }
        .dw-backdrop-hidden { opacity: 0; pointer-events: none; }
        .dw-backdrop-visible { opacity: 1; }

        .dw-modal-panel { transform-origin: center; transition: opacity 250ms var(--ease-out), transform 250ms var(--ease-out); }
        .dw-modal-hidden { opacity: 0; transform: scale(0.96); pointer-events: none; }
        .dw-modal-visible { opacity: 1; transform: scale(1); }

        .dw-drawer-panel { transition: transform 500ms var(--ease-drawer); }
        .dw-drawer-hidden { transform: translateX(100%); }
        .dw-drawer-visible { transform: translateX(0); }

        .dw-toast { transition: opacity 400ms ease, transform 400ms ease; }
        .dw-toast-hidden { opacity: 0; transform: translateY(140%); pointer-events: none; }
        .dw-toast-visible { opacity: 1; transform: translateY(0); }

        .dw-tab-indicator { transition: clip-path 250ms var(--ease-in-out); }

        .dw-hero-disc-wrap { transition: transform 900ms var(--ease-out); }
        .dw-hero-disc-hidden { transform: translateX(-46%); }
        .dw-hero-disc-visible { transform: translateX(28%); }
        .dw-hero-disc-spin { animation: dwSpin 7s linear infinite; }
        @keyframes dwSpin { to { transform: rotate(360deg); } }

        .dw-hero-tonearm { transition: transform 400ms var(--ease-out) 850ms; transform: rotate(-22deg); transform-origin: top right; }
        .dw-hero-tonearm-visible { transform: rotate(0deg); }

        .dw-stagger-item { opacity: 0; transform: translateY(8px); animation: dwFadeUp 320ms var(--ease-out) forwards; }
        @keyframes dwFadeUp { to { opacity: 1; transform: translateY(0); } }

        .dw-text-9 { font-size: 9px; }
        .dw-text-10 { font-size: 10px; }
        .dw-text-11 { font-size: 11px; }
        .dw-leading-85 { line-height: 0.85; }
        .dw-leading-90 { line-height: 0.9; }
        .dw-badge-minw { min-width: 20px; }
        .dw-toast-maxw { max-width: 90vw; }
        .dw-z-60 { z-index: 60; }
        .dw-z-70 { z-index: 70; }

        @media (prefers-reduced-motion: reduce) {
          .dw-card:hover { transform: none; box-shadow: none; }
          .dw-hero-disc-spin { animation: none; }
          .dw-hero-disc-wrap, .dw-hero-tonearm { transition: none; }
          .dw-stagger-item { animation: dwFadeReduced 200ms ease forwards; }
          @keyframes dwFadeReduced { to { opacity: 1; } }
        }
      `}</style>

      {/* ---------------------------------------------------------------- */}
      {/* Header                                                           */}
      {/* ---------------------------------------------------------------- */}
      <header className="sticky top-0 z-40 border-b" style={{ backgroundColor: PAPER, borderColor: "rgba(20,17,13,0.12)" }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-4 flex items-center justify-between gap-4">
          <div className="font-display text-xl sm:text-2xl tracking-tight" style={{ color: NAVY }}>
            DEADWAX
          </div>

          <div className="hidden sm:flex items-center gap-2 flex-1 max-w-xs">
            <div className="flex items-center gap-2 w-full px-3 py-2 rounded-sm border" style={{ borderColor: "rgba(20,17,13,0.2)" }}>
              <Search size={15} style={{ color: INK, opacity: 0.5 }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search title or artist"
                className="w-full bg-transparent outline-none text-sm"
                style={{ color: INK }}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            {me ? (
              <button
                onClick={logout}
                className="dw-press hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-sm text-xs font-medium border"
                style={{ borderColor: "rgba(20,17,13,0.2)" }}
                title={me.email}
              >
                <LogOut size={14} /> Sign out
              </button>
            ) : (
              <button
                onClick={() => openAuth("login")}
                className="dw-press hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-sm text-xs font-medium border"
                style={{ borderColor: "rgba(20,17,13,0.2)" }}
              >
                <User size={14} /> Sign in
              </button>
            )}

            <button
              onClick={() => {
                setCartOpen(true);
                if (tokens) refreshCart();
              }}
              className="dw-press relative flex items-center gap-2 px-3 py-2 rounded-sm"
              style={{ backgroundColor: NAVY, color: PAPER }}
            >
              <ShoppingBag size={16} />
              <span className="text-sm font-medium hidden sm:inline">Crate</span>
              {cartCount > 0 && (
                <span
                  className="absolute -top-2 -right-2 dw-badge-minw h-5 px-1 rounded-full flex items-center justify-center dw-text-11 font-mono"
                  style={{ backgroundColor: ACCENTS[0], color: PAPER }}
                >
                  {cartCount}
                </span>
              )}
            </button>
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Hero                                                             */}
      {/* ---------------------------------------------------------------- */}
      <section className="relative overflow-hidden" style={{ backgroundColor: NAVY, color: PAPER }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-24 grid sm:grid-cols-2 gap-10 items-center">
          <div>
            <div className="font-mono text-xs tracking-widest opacity-70 mb-4">CATALOG DW &mdash; EST. REISSUES</div>
            <h1 className="font-display uppercase dw-leading-90 text-4xl sm:text-6xl mb-6">
              Pressed again.
              <br />
              Played forever.
            </h1>
            <p className="max-w-sm opacity-80 mb-8 leading-relaxed">
              Out-of-print jazz, soul, Latin and global sides, remastered from the original tapes and
              pressed in small, numbered runs.
            </p>
            <a href="#shop" className="dw-press inline-block px-6 py-3 rounded-sm font-medium" style={{ backgroundColor: ACCENTS[0], color: PAPER }}>
              Browse the catalog
            </a>
          </div>

          <div className="relative h-64 sm:h-80 hidden sm:block">
            <div className={`dw-hero-disc-wrap absolute right-8 top-1/2 -translate-y-1/2 ${heroRevealed ? "dw-hero-disc-visible" : "dw-hero-disc-hidden"}`}>
              <div
                className="dw-hero-disc-spin relative rounded-full"
                style={{
                  width: 220,
                  height: 220,
                  background: "repeating-radial-gradient(circle, #1b2c52 0px, #1b2c52 6px, #16233f 6px, #16233f 12px)",
                  boxShadow: "0 25px 50px -20px rgba(0,0,0,0.6)",
                }}
              >
                <div
                  className="absolute rounded-full flex items-center justify-center font-mono dw-text-9 tracking-widest"
                  style={{ inset: "38%", backgroundColor: ACCENTS[0], color: PAPER }}
                >
                  DW
                </div>
              </div>
            </div>
            <div className="absolute right-0 top-8" style={{ width: 140, height: 140 }}>
              <div
                className={`dw-hero-tonearm relative ${heroRevealed ? "dw-hero-tonearm-visible" : ""}`}
                style={{ width: 6, height: 130, backgroundColor: PAPER, borderRadius: 3, marginLeft: "auto" }}
              >
                <div className="absolute -top-1 left-1/2 -translate-x-1/2 rounded-full" style={{ width: 14, height: 14, backgroundColor: PAPER }} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Filter bar                                                       */}
      {/* ---------------------------------------------------------------- */}
      <section id="shop" className="max-w-6xl mx-auto px-5 sm:px-8 pt-10 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <GenreTabs genre={genre} setGenre={setGenre} />

          <div className="relative">
            <button
              ref={sortBtnRef}
              onClick={() => setSortOpen((o) => !o)}
              className="dw-press flex items-center gap-2 px-4 py-2 rounded-sm border text-sm"
              style={{ borderColor: "rgba(20,17,13,0.25)" }}
            >
              {SORTS.find((s) => s.value === sort)?.label}
              <ChevronDown size={14} />
            </button>

            {sortOpen && (
              <button aria-label="Close sort menu" onClick={() => setSortOpen(false)} className="fixed inset-0 z-30 cursor-default" style={{ background: "transparent" }} />
            )}

            <div
              className={`dw-popover absolute right-0 mt-2 w-56 rounded-sm border shadow-lg z-40 overflow-hidden ${sortOpen ? "dw-popover-visible" : "dw-popover-hidden"}`}
              style={{ backgroundColor: PAPER, borderColor: "rgba(20,17,13,0.15)" }}
            >
              {SORTS.map((s) => (
                <button
                  key={s.value}
                  onClick={() => {
                    setSort(s.value);
                    setSortOpen(false);
                  }}
                  className="w-full text-left px-4 py-2.5 text-sm hover:bg-black/5"
                  style={{ color: INK, fontWeight: s.value === sort ? 600 : 400 }}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Product grid                                                     */}
      {/* ---------------------------------------------------------------- */}
      <section className="max-w-6xl mx-auto px-5 sm:px-8 pb-24">
        {recordsError ? (
          <div className="py-20 text-center">
            <p className="font-display uppercase text-lg mb-2">Can't load the catalog</p>
            <p className="opacity-70 mb-6 max-w-md mx-auto">{recordsError}</p>
            <button onClick={loadRecords} className="dw-press px-5 py-2.5 rounded-sm text-sm font-medium" style={{ backgroundColor: NAVY, color: PAPER }}>
              Retry
            </button>
          </div>
        ) : recordsLoading ? (
          <div className="py-20 text-center opacity-60 font-mono text-sm">Loading the catalog&hellip;</div>
        ) : records.length === 0 ? (
          <div className="py-20 text-center">
            <p className="font-display uppercase text-lg mb-2">Nothing in the crate for that</p>
            <p className="opacity-70 mb-6">Try another genre, or clear your search.</p>
            <button
              onClick={() => {
                setQuery("");
                setGenre("All");
              }}
              className="dw-press px-5 py-2.5 rounded-sm text-sm font-medium"
              style={{ backgroundColor: NAVY, color: PAPER }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-5 sm:gap-6">
            {records.map((record, i) => (
              <div key={record.id} className="dw-card dw-stagger-item" style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}>
                <button onClick={() => setQuickView(record.id)} className="block w-full text-left">
                  <Cover record={record} />
                </button>
                <div className="pt-3">
                  <div className="font-mono dw-text-10 tracking-widest opacity-50 mb-1">
                    {record.genre.toUpperCase()} &middot; {record.year}
                  </div>
                  <div className="font-medium leading-tight">{record.title}</div>
                  <div className="text-sm opacity-70 mb-2">{record.artist}</div>
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm">${Number(record.price).toFixed(2)}</span>
                    <button
                      onClick={() => addToCart(record)}
                      disabled={record.stock <= 0}
                      className="dw-press px-3 py-1.5 rounded-sm text-xs font-medium disabled:opacity-40"
                      style={{ backgroundColor: NAVY, color: PAPER }}
                    >
                      {record.stock <= 0 ? "Sold out" : "Add to crate"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Footer                                                           */}
      {/* ---------------------------------------------------------------- */}
      <footer className="border-t" style={{ borderColor: "rgba(20,17,13,0.12)" }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-10 flex flex-col sm:flex-row justify-between gap-4 text-sm opacity-70">
          <div>&copy; {new Date().getFullYear()} Deadwax Records. Every side numbered, nothing repressed twice the same way.</div>
          <div className="font-mono text-xs">LIVE CATALOG &mdash; {API_BASE}</div>
        </div>
      </footer>

      {/* ---------------------------------------------------------------- */}
      {/* Quick view modal                                                 */}
      {/* ---------------------------------------------------------------- */}
      <div className={`dw-backdrop fixed inset-0 z-50 bg-black/50 ${quickView ? "dw-backdrop-visible" : "dw-backdrop-hidden"}`} onClick={() => setQuickView(null)} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className={`dw-modal-panel pointer-events-auto w-full max-w-lg rounded-md overflow-hidden ${quickView ? "dw-modal-visible" : "dw-modal-hidden"}`} style={{ backgroundColor: PAPER }}>
          {quickViewRecord && (
            <div className="grid sm:grid-cols-2">
              <Cover record={quickViewRecord} size="big" />
              <div className="p-5 flex flex-col">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <div className="font-mono dw-text-10 tracking-widest opacity-50 mb-1">{quickViewRecord.catalog_number}</div>
                    <div className="font-display uppercase text-lg leading-tight">{quickViewRecord.title}</div>
                    <div className="text-sm opacity-70">{quickViewRecord.artist}</div>
                  </div>
                  <button onClick={() => setQuickView(null)} className="dw-press p-1">
                    <X size={18} />
                  </button>
                </div>

                <div className="text-sm mb-4 grid grid-cols-2 gap-3 flex-1">
                  <div>
                    <div className="font-mono dw-text-10 tracking-widest opacity-50 mb-1.5">SIDE A</div>
                    {quickViewRecord.side_a.map((t) => (
                      <div key={t} className="flex items-center gap-1.5 opacity-80 mb-1">
                        <Play size={10} /> {t}
                      </div>
                    ))}
                  </div>
                  <div>
                    <div className="font-mono dw-text-10 tracking-widest opacity-50 mb-1.5">SIDE B</div>
                    {quickViewRecord.side_b.map((t) => (
                      <div key={t} className="flex items-center gap-1.5 opacity-80 mb-1">
                        <Play size={10} /> {t}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between pt-3 border-t" style={{ borderColor: "rgba(20,17,13,0.12)" }}>
                  <span className="font-mono">${Number(quickViewRecord.price).toFixed(2)}</span>
                  <button
                    onClick={() => {
                      addToCart(quickViewRecord);
                      setQuickView(null);
                    }}
                    disabled={quickViewRecord.stock <= 0}
                    className="dw-press px-4 py-2 rounded-sm text-sm font-medium disabled:opacity-40"
                    style={{ backgroundColor: NAVY, color: PAPER }}
                  >
                    {quickViewRecord.stock <= 0 ? "Sold out" : "Add to crate"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Cart drawer                                                      */}
      {/* ---------------------------------------------------------------- */}
      <div className={`dw-backdrop fixed inset-0 z-50 bg-black/50 ${cartOpen ? "dw-backdrop-visible" : "dw-backdrop-hidden"}`} onClick={() => setCartOpen(false)} />
      <div className="fixed inset-0 z-50 flex justify-end pointer-events-none">
        <div className={`dw-drawer-panel pointer-events-auto w-full max-w-sm h-full flex flex-col ${cartOpen ? "dw-drawer-visible" : "dw-drawer-hidden"}`} style={{ backgroundColor: PAPER }}>
          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "rgba(20,17,13,0.12)" }}>
            <div className="font-display uppercase text-sm">Your Crate</div>
            <button onClick={() => setCartOpen(false)} className="dw-press p-1">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {!tokens ? (
              <div className="pt-8 text-center">
                <p className="opacity-60 text-sm mb-4">Sign in to see your crate.</p>
                <button onClick={() => openAuth("login")} className="dw-press px-4 py-2 rounded-sm text-sm font-medium" style={{ backgroundColor: NAVY, color: PAPER }}>
                  Sign in
                </button>
              </div>
            ) : cart.items.length === 0 ? (
              <p className="opacity-60 text-sm pt-8 text-center">Your crate is empty. Go dig through the catalog.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {cart.items.map(({ record, quantity }) => (
                  <div key={record.id} className="flex gap-3">
                    <div className="w-16 h-16 flex-shrink-0">
                      <Cover record={record} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{record.title}</div>
                      <div className="text-xs opacity-60 truncate mb-1.5">{record.artist}</div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => changeQty(record.id, quantity - 1)} className="dw-press p-1 rounded-sm border" style={{ borderColor: "rgba(20,17,13,0.2)" }}>
                          <Minus size={12} />
                        </button>
                        <span className="text-sm font-mono w-4 text-center">{quantity}</span>
                        <button onClick={() => changeQty(record.id, quantity + 1)} className="dw-press p-1 rounded-sm border" style={{ borderColor: "rgba(20,17,13,0.2)" }}>
                          <Plus size={12} />
                        </button>
                      </div>
                    </div>
                    <div className="font-mono text-sm">${(Number(record.price) * quantity).toFixed(2)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="px-5 py-4 border-t" style={{ borderColor: "rgba(20,17,13,0.12)" }}>
            <div className="flex items-center justify-between mb-3 text-sm">
              <span className="opacity-70">Subtotal</span>
              <span className="font-mono">${Number(cart.subtotal).toFixed(2)}</span>
            </div>
            <button
              onClick={checkout}
              disabled={!tokens || cart.items.length === 0 || checkoutLoading}
              className="dw-press w-full py-3 rounded-sm text-sm font-medium disabled:opacity-40"
              style={{ backgroundColor: ACCENTS[0], color: PAPER }}
            >
              {checkoutLoading ? "Redirecting to checkout\u2026" : "Press my order"}
            </button>
          </div>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Auth modal                                                       */}
      {/* ---------------------------------------------------------------- */}
      <div className={`dw-backdrop fixed inset-0 dw-z-60 bg-black/50 ${authOpen ? "dw-backdrop-visible" : "dw-backdrop-hidden"}`} onClick={() => setAuthOpen(false)} />
      <div className="fixed inset-0 dw-z-60 flex items-center justify-center p-4 pointer-events-none">
        <div className={`dw-modal-panel pointer-events-auto w-full max-w-sm rounded-md overflow-hidden p-6 ${authOpen ? "dw-modal-visible" : "dw-modal-hidden"}`} style={{ backgroundColor: PAPER }}>
          <div className="flex justify-between items-start mb-4">
            <div className="font-display uppercase text-lg">{authMode === "login" ? "Sign in" : "Create account"}</div>
            <button onClick={() => setAuthOpen(false)} className="dw-press p-1">
              <X size={18} />
            </button>
          </div>

          <form onSubmit={submitAuth} className="flex flex-col gap-3">
            <input
              type="email"
              required
              placeholder="Email"
              value={authEmail}
              onChange={(e) => setAuthEmail(e.target.value)}
              className="px-3 py-2.5 rounded-sm border text-sm bg-transparent outline-none"
              style={{ borderColor: "rgba(20,17,13,0.25)" }}
            />
            <input
              type="password"
              required
              minLength={8}
              placeholder="Password (min. 8 characters)"
              value={authPassword}
              onChange={(e) => setAuthPassword(e.target.value)}
              className="px-3 py-2.5 rounded-sm border text-sm bg-transparent outline-none"
              style={{ borderColor: "rgba(20,17,13,0.25)" }}
            />
            {authError && (
              <p className="text-xs" style={{ color: ACCENTS[3] }}>
                {authError}
              </p>
            )}
            <button
              type="submit"
              disabled={authLoading}
              className="dw-press w-full py-2.5 rounded-sm text-sm font-medium mt-1 disabled:opacity-50"
              style={{ backgroundColor: NAVY, color: PAPER }}
            >
              {authLoading ? "Please wait\u2026" : authMode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>

          <button
            onClick={() => {
              setAuthMode(authMode === "login" ? "register" : "login");
              setAuthError("");
            }}
            className="dw-press w-full text-center text-xs opacity-70 mt-4"
          >
            {authMode === "login" ? "New here? Create an account" : "Already have an account? Sign in"}
          </button>
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Toast                                                            */}
      {/* ---------------------------------------------------------------- */}
      <div
        className={`dw-toast fixed bottom-6 left-1/2 -translate-x-1/2 dw-z-70 px-5 py-3 rounded-sm text-sm font-medium shadow-lg dw-toast-maxw text-center ${toastVisible ? "dw-toast-visible" : "dw-toast-hidden"}`}
        style={{ backgroundColor: INK, color: PAPER }}
      >
        {toastText}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Genre tabs with clip-path indicator recipe                            */
/* -------------------------------------------------------------------- */

function GenreTabs({ genre, setGenre }) {
  const containerRef = useRef(null);
  const tabRefs = useRef({});
  const [clip, setClip] = useState({ left: 0, right: 0 });

  function recompute() {
    const btn = tabRefs.current[genre];
    const container = containerRef.current;
    if (!btn || !container) return;
    const cRect = container.getBoundingClientRect();
    const bRect = btn.getBoundingClientRect();
    setClip({ left: bRect.left - cRect.left, right: cRect.right - bRect.right });
  }

  useLayoutEffect(() => {
    recompute();
    const t = setTimeout(recompute, 250);
    window.addEventListener("resize", recompute);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", recompute);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genre]);

  return (
    <div ref={containerRef} className="relative inline-flex rounded-sm border" style={{ borderColor: "rgba(20,17,13,0.2)" }}>
      {GENRES.map((g) => (
        <button key={g} ref={(el) => (tabRefs.current[g] = el)} onClick={() => setGenre(g)} className="relative z-10 px-4 py-2 text-sm font-medium" style={{ color: INK }}>
          {g}
        </button>
      ))}

      <div className="dw-tab-indicator absolute inset-0 flex overflow-hidden pointer-events-none" style={{ clipPath: `inset(0px ${clip.right}px 0px ${clip.left}px)` }}>
        <div className="flex w-full h-full" style={{ backgroundColor: NAVY }}>
          {GENRES.map((g) => (
            <div key={g} className="px-4 py-2 text-sm font-medium whitespace-nowrap" style={{ color: PAPER }}>
              {g}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
