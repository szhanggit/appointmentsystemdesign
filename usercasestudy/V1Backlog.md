# V1 Backlog

Items deliberately cut from V1. V1 = core booking + beauty map, to staging.
Everything below is **not** in V1 scope. When an item is promoted, move its
design into the relevant `usercasestudy/` doc and delete the line here.

## Platform & accounts (Groway admin)

- Groway admin console (invite-only + MFA + audit) — V1 seeds stores manually, no UI.
- "Login as" impersonation UI for support (audited, ticket-ref, post-hoc owner notice).
- `platform.category_taxonomy` admin UI (V1 seeds via migration; growing the list is manual SQL).
- `platform.spoken_languages` admin UI (same pattern as taxonomy).
- `platform.abuse_config` editor (per-phone cap default 5, adjustable).

## Booking, payments & trust

- **Customer deposit payment** (`payment-deposit-preauth-design.md` is the design;
  Stripe integration + booking Step 6 are not built in V1).
- Tips / gratuity (distinct from deposits).
- Pre-auth hold (deferred to v2; v1 uses direct capture to avoid the 7-day expiry problem).
- Phone OTP step-up for booking abuse (v2 hardening; v1 relies on rate limiting + per-phone cap + blocklist).
- Multi-service public booking (waits on multi-service slot merging in the slot engine).
- Per-room / per-bed assignment (V1 uses a store-level capacity number; granular assignment waits for the med-aesthetics store).

## Customers

- Full review system: review-writing UI, moderation, scoring, staff-tagged display
  (`store.reviews.staff_id` is already reserved in the schema).
- Surfacing `min_rating` in the map UI (the API param already exists and is inert in V1).
- Real notification sending — SMS/email reminders (templates are designed; sending is V1.1).
- Member accounts: login, "My bookings" link from the confirmation screen, saved payment methods.
- Favorites / recently viewed stores.

## Beauty map (discovery)

- Keyword / name search ("head spa near me") — V1 is map-browse only.
- "NEW" badge for stores in their first 30 days (backlog per 2026-10-02 decision; cold-start traffic vs gaming risk, revisit in V1.1).
- "Venues nearby" recommendations on the store detail page.
- Two-sided price range / price bands ($/$$/$$$); amenity flags ("accepts walk-ins", "parking"); saved filter presets.
- Server-side clustering (V1 clusters client-side in Mapbox GL JS).
- Per-store map marker branding; in-app turn-by-turn navigation (V1 hands off to the external maps app).

## Store operations

- Reports & analytics: revenue, utilization, no-show rate (the daily numbers owners actually live by).
- Marketing: coupons, campaigns, email allowance overage.
- Waitlist (the appointments page reserves the nav slot; no design yet).
- Treatment packages, memberships, gift cards (needed by the med-aesthetics clinical module).
- Store photo uploads + moderation queue UI (schema + manual process designed; the queue UI is V1.1).
- Chain-wide aggregate stats view (per-store stats on staff profiles are the permanent V1 semantic).

## Med-aesthetics clinical module (~20% delta on the shared booking engine)

- Treatment charting, consent forms, before/after photos, practitioner credential checks,
  stricter deposits, treatment packages. V1 ships for spa first; the module activates
  when the med spa opens. **Legal review required before storing any health data (PHIPA).**

## AI layer (the exit-line bet: built + deployed + measured, all three)

- AI front desk (answers calls/messages 24/7, books into the calendar).
- AI gap-filling (detects cancellations, offers the slot to waitlisted customers).
- AI recall (win back customers quiet 60+ days).
- Zero design docs exist for any of the three as of 2026-10-02 — this is the largest
  blank area in the repo relative to its strategic weight.
