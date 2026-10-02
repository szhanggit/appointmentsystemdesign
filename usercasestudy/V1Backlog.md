# V1 Backlog

Everything not in V1 scope lives here. **Rule:** when an item is promoted into
V1, its design moves into the relevant `usercasestudy/` doc and the line is
deleted here — a backlog that still lists shipped features is a lie.

## Booking, payments & trust

- Customer deposit payment (客户付定金) — full design in
  `payment-deposit-preauth-design.md` (V2; V1 only reserves the schema seam,
  `create-appointment-transaction-design.md` §14).
- Tips (gratuity) — distinct from deposits.
- Pre-auth hold.
- Phone OTP step-up for guest booking (v1 uses rate limiting only).
- Parallel/simultaneous multi-staff bookings (e.g. two technicians on one customer
  at once) — stays staff-manual, in-store request only; never offered through the
  public flow.
- Per-room/per-bed assignment (v1: store-level capacity number only).
- Coupons.

## Customers

- Full review system (write + display; v1 hides ratings entirely).
- min_rating surfacing / rating filters.
- Member accounts (login).
- Favorites.

## Beauty map discovery

- Keyword search.
- 30-day NEW badge.
- Nearby recommendations.
- Price bands / amenity flags.
- Server-side clustering.
- Marker branding / navigation deep-links.

## Store operations

- Reports & analytics.
- Marketing (campaigns; the booking-time consent columns are the V1 groundwork
  for this).
- Waitlist — AI-shaped, not a dumb notification list (see the V2 shape
  constraint in "V2/V3 vision" below).
- Packages / memberships / gift cards.
- Photo moderation queue UI (the staff-profile R1/R8 staging gate exists in v1;
  the Groway-side review UI is backlog).
- Chain-wide aggregate stats.

## Platform & accounts

- Groway admin console (cross-tenant dashboard).
- 'Login as' impersonation UI (protocol designed in
  `groway-admin-impersonation-design.md`; the admin-side UI is backlog).
- category-taxonomy / spoken-languages / abuse_config admin UIs.

## Med-aesthetics clinical module

- Charting, consent forms, before/after photos, practitioner credential checks,
  stricter deposits, treatment packages. **Legal review required before storing
  any health data (PHIPA)** — see the reservation below.

## AI layer

- AI front desk, AI gap-filling, AI recall — the exit-line bet. Direction lives
  in "V2/V3 vision" below; zero design docs by design until V1 pilot data exists.

## V1 architectural reservations (seams V1 must not close)

Rule: reserve the seam, don't build the room. When a reservation is consumed
(the feature gets built), delete the line here and in the V1 groundwork brief
(local file, handed to Claude Code separately).

1. `appointments.payment_intent_id TEXT` + `payment_status`
   (`none|awaiting|succeeded|failed|refunded|partially_refunded`) — columns exist
   from day one so V2 deposits/pre-auth need no backfill.
2. `store.messages` uses the `system_subtype` pattern — a new system-generated
   message kind never widens `message_type`'s enum.
3. `platform.spoken_languages` (BCP 47) stays permanently independent from the
   customer notification language — never "unify" them.
4. No cross-schema foreign keys, ever — cross-module references are
   application-level IDs (extraction-ready).
5. `appointment.customer_linked` domain event is emitted even with no V1 consumers.
6. `stores.geo_place_id` kept on every address write (future provider migration).
7. Impersonation `ticket_ref` rule is forward-looking — suspend/refund aren't built,
   but ticket-required enforcement applies automatically the day they are.
8. One person, multiple chains = separate logins; no cross-chain session.
9. "Merchant" terminology stays retired/reserved — do not reuse for chain/store.
10. Med-aesthetics tables must be isolatable (encryption, audit logs, hard
    permissions); **legal review before storing any health data (PHIPA).**
    (Forward-looking for the dedicated clinical tables; `customer.customers.notes`
    is constrained to operational preferences only in v1.)

## V2/V3 vision (direction, not design — revisit after the V1 pilot)

Destinations, not specs. This section exists so V1 decisions can be checked against
a direction ("does this close off the AI future?"). Anything here that needs schema
gets a reservation line in the section above; behavior stays undesigned until its
version. Expect this section to be rewritten once V1 pilot data exists.

### V2 — monetization & retention (the business grows up)

> 2026-10-02: `appointments.channel`, booking-time marketing/AI-outreach consent,
> and `stores.policies_text` were approved into V1 scope — build checklist lives in
> the V1 groundwork brief (local file, handed to Claude Code separately).

- **[V2] Structured cancellation reasons** — AI gap-filling triggers on
  `appointment.cancelled` and needs the why: `customer_cancelled`, `no_show`,
  `staff_cancelled`, `rescheduled_away`. V1: emit the event with an extendable reason
  code (VARCHAR, not a closed enum). V2: the gap-fill consumer.
- **[V2] Waitlist, shaped for AI** — not a dumb notification list. Each entry needs:
  desired service(s), acceptable time windows, staff preference (or any), contact
  channel, expiry. Build it in V2 as "a list of phone numbers" and V3 AI gap-filling
  remodels it. (Already listed under Store operations — this is the shape constraint.)
- **[V2] Customer identity resolution** — AI recall lives or dies on "quiet 60+ days per
  real human." Guest bookings fragment identity (same phone, several guest rows). V2
  needs: hardened claim flow + a staff dedup/merge tool. The `customer_linked` event
  (reserved above) is the seam.
- **[V2] Full review system** — already listed under Customers. Feeds the AI front desk
  ("what do people say about…") and social proof. No new thought.
- **[V2] Member accounts, packages/memberships/gift cards, coupons, tips, reports &
  analytics, phone OTP step-up, keyword search, NEW badge, price bands, server-side
  clustering, admin console + impersonation UI, photo-moderation queue UI, chain-wide
  aggregate stats** — already listed under their headings. No new thought.
- No action: phone number as identity anchor — V1 already normalizes E.164 and counts
  per phone; the AI front desk's caller-ID → customer lookup rides on this for free.

### V3 — the AI layer (the exit-line bet)

V3 is the three exit-line criteria — AI 前台 + AI 填空位 + AI 召回 — built + deployed
+ **measured**, by 2027-03-28. Direction only; the design gets written after V1 pilot
data exists.

- **[V3] AI front desk** — answers calls/messages 24/7, books into the calendar through
  the same agent-callable APIs (idempotency keys are already V1). Needs: the V2
  knowledge base (`policies_text` + catalog), conversation memory, a human-escalation
  path, and **per-chain AI cost metering** — the partner bears AI API costs under the
  funding agreement, so usage must be attributable per chain for the bill.
- **[V3] AI gap-filling** — cancellation detected → best-fit waitlisted customer offered
  the slot → booking attributed `ai_gapfill`. Needs: the V2 AI-shaped waitlist, V2
  cancellation reasons, the V1 `channel` column.
- **[V3] AI recall** — quiet 60+ days → personalized win-back ("Anna has an opening
  Thursday — she did your last shellac"). Needs: V2 identity resolution, V2 consent,
  the V1 `channel` column. Staff affinity derives from `appointments.staff_id` —
  explicitly no new V1 column needed.
- **[V3] Measurement is the feature** — "front-desk time saved" needs a pre-AI baseline
  measured operationally during the pilot (not software). "Filled slots" and "recovered
  customers" come from the `channel` column. If it can't be measured, it doesn't count
  toward the exit line.
- **[V3] Conversation logs & model lineage** — every AI touchpoint logs model version,
  prompt version, I/O summary, cost. Needed for debugging, cost control, and (for voice)
  potential compliance. V3 infra; V1/V2 just don't prohibit it.
