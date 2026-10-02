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
- Simultaneous/parallel services (e.g. head wash + foot wash at the same time, two technicians). DECIDED 2026-10-02: follow Fresha — online books sequential multi-service only; simultaneous must be requested in-store and is done staff-manual (two overlapping appointments, different staff — no system block; burns 2 quota units, counts 2 against capacity). No self-service parallel booking, no DB change needed.
- Per-room / per-bed assignment (V1 uses a store-level capacity number; granular assignment waits for the med-aesthetics store).

## Customers

- Full review system: review-writing UI, moderation, scoring, staff-tagged display
  (`store.reviews.staff_id` is already reserved in the schema).
- Surfacing `min_rating` in the map UI (the API param already exists and is inert in V1).
- Member accounts: login, "My bookings" link from the confirmation screen, saved payment methods.
- Favorites / recently viewed stores.
- Full customer profiles + visit history (beyond guest snapshots + claim; the record the AI recall layer will eventually read).

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

## V1 architectural reservations (seams V1 must not close)

Not features — these are the extension points V1 schema/code must leave open so
V2/V3 don't need breaking migrations. Rule: **reserve the seam, don't build the
room.** When a reservation is consumed (the feature gets built), delete the line.
(Three more reservations already live under their feature headings: `reviews.staff_id`
under Customers, the inert `min_rating` param under Customers, the waitlist nav slot
under Store operations.)

- `appointments.payment_intent_id TEXT` + `payment_status`
  (`none|awaiting|succeeded|failed|refunded|partially_refunded`) — columns exist from
  day one so deposits/pre-auth (V2+) need no backfill; the state machine already names
  the future states (`create-appointment-transaction-design.md` §14,
  `payment-deposit-preauth-design.md` §7).
- `store.messages` uses the `system_subtype` pattern — a new system-generated message
  kind never widens `message_type`'s enum (`groway-store-notifications-workflow.md` §1).
- `platform.spoken_languages` (BCP 47) stays permanently independent from the customer
  notification language — never "unify" the two taxonomies (staff-profile-design.md §4).
- No cross-schema foreign keys, ever — cross-module references are application-level IDs,
  so a schema can later move to its own database without breaking
  (`groway-v1-architecture.md` §5).
- `appointment.customer_linked` domain event is emitted with no V1 consumers — reserved
  for future consumers (`customer-records-design.md` §4.4).
- `stores.geo_place_id` is kept on every address write — the one input a future
  geocoding-provider migration needs (`growayshop-registration-workflow.md` §2.2).
- Impersonation `ticket_ref` rule is forward-looking — suspend/refund aren't built, but
  the ticket-required enforcement applies automatically the day they are
  (`groway-admin-impersonation-design.md` §4).
- One person, multiple chains = separate logins; no cross-chain session, no "switch
  account" (`growayshop-registration-workflow.md` §6.0).
- "Merchant" terminology is retired and reserved for a different future use — do not
  reuse it for chain/store (`store-onboarding-v1-design.md` §1).
- Med-aesthetics clinical module ships later as a default-off module on the shared booking
  engine; health-data tables must be isolatable (encryption, audit logs, hard permissions).
  **Legal review required before storing any health data (PHIPA).**
