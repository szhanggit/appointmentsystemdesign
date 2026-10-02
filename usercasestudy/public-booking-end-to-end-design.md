# Public Booking End-to-End — Design

**Status:** the complete self-serve customer booking flow — from opening the booking page to the confirmation screen. Chains together `availability-slot-engine.md` (query times), `create-appointment-transaction-design.md` (create), and `customer-booking-confirmation-reminders-design.md` (notify). This document defines step order, which endpoint each step calls, and how the UI reacts to failure — it does not introduce new business rules.

Baseline: step order is service → staff → time → contact info → confirm. The public API requires no login and is rate-limited by IP + `store_id`. A `from` service's displayed price is `MIN(options)`, computed live.

## 1. Decisions

1. **v1 books exactly one service (+ option) per public order.** Multi-service slot computation isn't designed yet (`availability-slot-engine.md` §9 item 3); staff can still book multi-service orders manually (`staff-manual-booking-calendar-design.md`). Unlocks once the engine supports merged multi-service slots.
2. **The confirmation screen offers an `.ics` download.** Trivial to implement (client-side string), good no-show prevention.
3. **Double-submit protection**: the submit button disables on click, plus an `Idempotency-Key`. Mobile users on weak connections tap repeatedly.
4. **`409 SLOT_TAKEN` never shows an error page** — the client silently re-queries that day's slots and highlights what's still open. Being beaten to a slot is normal, not exceptional.
5. **`409 CAPACITY_FULL` gets an explicit message, not a silent refresh** — unlike `SLOT_TAKEN`, a full store is store-wide state, and at peak times neighboring slots are often full too; silently refreshing would make the customer repeatedly hit the same wall with no explanation.
6. **One flow, three entry URLs.** The map/profile pages (`beauty-map-ui-design.md`, `staff-profile-design.md`) all deep-link into this same flow with an optional preselection — a store-detail page, a staff profile's "Book them" CTA, and a service row's "Book" button all land on `/book/{store_id}` with a different optional query param (§4). There's exactly one booking flow to maintain, never a parallel "quick book" path.
7. **A deposit, when required, is its own step** — not folded into Step 5's review. `payment_required=true` stores insert a Payment step between Review and Confirmation (§3), so the customer sees "review" and "pay" as two distinct, clearly-labeled moments rather than one combined screen.
8. **The phone-cap heads-up lives on the confirmation screen, after a successful booking — never as a pre-submit lookup.** A separate "check how many bookings this phone has" call, triggered as the customer types their number in Step 4, would be a standalone oracle: anyone could probe an arbitrary phone number's booking activity with no booking attempt required. Instead, the create endpoint's own response already carries `phone_upcoming_count` (`create-appointment-transaction-design.md` §3.1) — zero new queries, zero new endpoints, and the count is only ever disclosed to whoever just successfully booked with that number. The cost is timing: the customer learns they're near the cap one booking later than ideal (after their 5th succeeds, not while typing their 6th attempt) — acceptable, since "surprise" means learning only at the wall, and this always shows the heads-up at least once before that.

## 2. Flow

```
/book/{store_id}[?staff_id=xxx | ?service_id=xxx]   (§4 — optional preselection)
  Step 1 Service → Step 2 Staff → Step 3 Date/Time → Step 4 Contact → Step 5 Review
    → [Step 6 Payment, only if payment_required=true] → Confirmation
```

A step indicator at the top allows back-navigation (prior selections are kept). Each step depends only on earlier selections; `store_id` stays in the URL throughout.

## 3. Steps

**Step 1 — Service.** `GET /api/store/services?store_id=` (active, non-deleted, online-bookable only). Grouped by category; `from` services show "from $X" (live `MIN(options)`), `free` services show "Free." A `from` service routes to an option picker before Step 2.

**Step 2 — Staff.** Options: "Any available" (default) plus the list of staff who can perform the service. Source: `GET /api/store/staff?store_id=&service_id=` (§6, deferred if not yet built — fall back to aggregating from the slots response). Selecting "Any" sends `staff_id: null` forward.

**Step 3 — Date & time.** Date picker spans `today(store_tz)` through `today + advance_booking_days`; past dates disabled. On date selection: `GET /api/store/public/slots?store_id=&service_id=&option_id=&date=&staff_id=`. Times render at `slot_granularity_minutes` resolution; in "any staff" mode the UI shows only the time, not which staff member (kept for the confirmation screen — a customer who cares can pick a specific person in Step 2). No slots that day → "Fully booked today," with a one-tap jump to the next day.

**Step 4 — Contact.** Name and phone required; email optional (confirmation email only sent if present). Phone format-validated (Canadian 10-digit); no OTP in v1 — rate limiting already covers abuse, OTP is a v2 hardening. One checkbox: "Booking confirmation and reminders will be sent to this number."

**Step 5 — Review.** Shows store name, service (+option), staff ("to be assigned" if "Any"), date/time, price, contact info. Submit button: "Confirm booking" (or "Continue to payment" when Step 6 follows).

**Step 6 — Payment** (only when `booking_settings.payment_required=true`). Submitting Step 5 creates the appointment (`pending`, `payment_status='awaiting'`) and immediately presents the Stripe Payment Element (`payment-deposit-preauth-design.md` §6) for the deposit — this is a distinct, clearly-labeled screen, not merged into Step 5's review. Confirmation only follows the `payment_intent.succeeded` webhook, same as that document's flow; a `payment_required=false` store never sees this step.

**Confirmation screen.** Large `reference_code`, booking details, "Confirmation sent to {phone}." Buttons: [Download calendar (.ics)] [Book another]. Copy: "To reschedule or cancel, call {store_phone}" (self-serve management is `customer-my-bookings-design.md`, not linked from here in v1). A `pending` result (`auto_confirm=false` stores, or payment still awaiting) shows "Received — awaiting confirmation," matching the pending SMS template. When the `201` response's `phone_upcoming_count` is at or above the cap minus one (default cap 5, so `count >= 4`), also show a non-blocking line: "Heads up: you now have {count} upcoming appointments with {store} — that's the limit for online booking, please call us for more." (§1 decision 8).

## 4. Submit request (Step 5 → Step 6 or Confirmation)

```
POST /api/store/public/appointments
Idempotency-Key: <uuid v4, generated on entering Step 5, held for that session>
{ store_id, items: [{service_id, option_id}], staff_id, start, contact: {name, phone, email}, notes: null }
```

- Button disables on click and stays disabled until the response returns.
- `201` → confirmation screen (`reference_code`, `status`).
- `409 SLOT_TAKEN` → no error page: toast "That time was just taken," silently re-query that day's slots, restore Step 3 state with the refreshed list.
- `409 CAPACITY_FULL` → **does not** silently refresh like `SLOT_TAKEN`: show an explicit message, "This time is fully booked — try another time," then re-query that day's slots (still auto-refreshed, just with a visible, distinct message rather than a quiet swap).
- `409 QUOTA_EXHAUSTED` → full-page message (billing §4.3 copy): "This store's monthly booking limit is reached — please call {store_phone}."
- `409 PHONE_LIMIT` → full-page message with the escape door spelled out (`create-appointment-transaction-design.md` §15 copy): "You've reached the limit of 5 upcoming bookings for this phone number — please call {store_phone} and we'll book you in right away." Not a silent retry — this phone number is capped chain-wide, re-querying slots won't help.
- `403 PHONE_BLOCKED` → full-page message, no override option on this channel (overriding is staff-only, `staff-manual-booking-calendar-design.md` §6): "We're unable to complete this booking online — please call {store_phone}."
- `409 STAFF_NOT_AVAILABLE` / `400`-series → return to the relevant step, highlighted.
- Network failure/timeout: **no automatic retry** — the user taps "Retry," which resends with the **same** `Idempotency-Key` (server-side dedup guarantees only one booking, test case §8.3).

## 5. Entry points

- Booking page URL: `/book/{store_id}`. In-store signage/QR code points at the same bare URL.
- Two optional deep-link variants, both landing on the same flow with a preselection:

| Entry | URL | Preselects |
|---|---|---|
| Store detail page [Book] | `/book/{store_id}` | Nothing |
| Staff profile [Book them] (`staff-profile-design.md` §1 CTA) | `/book/{store_id}?staff_id=xxx` | Staff for Step 2 — still changeable |
| Service row [Book] | `/book/{store_id}?service_id=xxx` | Service for Step 1 — still changeable |

- An unknown or invalid `staff_id`/`service_id` is **ignored**, not a `400` — the flow starts at its ordinary default. Deep links have to be fault-tolerant; a stale profile link or a since-deleted service shouldn't break the funnel.
- Unknown or non-`active` `store_id` → `404`, generic copy ("Online booking isn't available for this store"), no existence-leaking detail — this check runs regardless of which variant was used.
- Confirmation URL carries no sensitive data (`reference_code` is shown once on the page, never in the URL).

## 6. Responsive / UX notes (v1 minimum)

- Mobile-first, single column, large touch targets (≥44px) for time slots.
- Page language follows the browser; SMS language follows `customer-booking-confirmation-reminders-design.md`'s rules. i18n framework required from day one; copy ships in `en` + `zh`.
- Slot query shows a skeleton within 300ms; a timeout shows a retry button.

## 7. Interfaces consumed

| Step | Endpoint | Owning document |
|---|---|---|
| 1 | `GET /api/store/services` | `store-onboarding-v1-design.md` §7 |
| 2 | `GET /api/store/staff` | deferred, §9 |
| 3 | `GET /api/store/public/slots` | `availability-slot-engine.md` §7 |
| 5 | `POST /api/store/public/appointments` (response carries `phone_upcoming_count`, no separate lookup) | `create-appointment-transaction-design.md` §3.1, §6.3 |
| 6 | Stripe Payment Element / webhook | `payment-deposit-preauth-design.md` §6 |
| Confirmation | `.ics` generated client-side | §1 decision 2 |
| SMS / Email | outbox → relay | `customer-booking-confirmation-reminders-design.md` |

## 8. End-to-end test checklist

1. Full happy path: service → staff → time → contact → confirm → `201` → confirmation shows `reference_code` → SMS arrives within a minute.
2. Two phones race the same slot → one reaches confirmation, the other gets the toast and a refreshed list; no duplicate booking.
3. Weak network, triple-tap confirm → one booking (same `Idempotency-Key`).
4. Timeout then "Retry" → same `reference_code`, one DB row.
5. Free-plan quota exhausted mid-flow → call-to-action page, no orphaned appointment.
6. `auto_confirm=false` store → confirmation shows "awaiting confirmation," pending SMS received.
7. A store at capacity → booking a full window shows the `CAPACITY_FULL` message and a refreshed, narrower slot list; a non-`occupies_capacity` service still books normally in the same window.
8. Back navigation from Step 5 to Step 3, pick a different time → the booking uses the new time.
9. Expired date / invalid `store_id` → correct `400`/`404` page.
10. `/book/{store_id}?staff_id=<unknown>` and `?service_id=<unknown>` → the param is ignored, flow starts at its normal default, no `400`.
11. `/book/{store_id}?staff_id=xxx` from a staff profile → Step 2 opens preselected to that staff member, still changeable.
12. `payment_required=true` store → Step 6 appears after Review; `payment_required=false` → Step 5 goes straight to Confirmation.
13. A phone's 5th successful booking → confirmation screen shows the heads-up line; its 6th attempt → full-page `PHONE_LIMIT` message with the escape-door copy, not a silent re-query.
14. A blocklisted phone → full-page `PHONE_BLOCKED` message, no retry/override control anywhere on this flow.

## 9. Deferred

1. `GET /api/store/staff` filtered by service — if not built yet, fall back to aggregating from the slots response; a dedicated endpoint comes later.
2. Multi-service public booking (waits on multi-service slot merging in the engine).
3. Logged-in member login / My Bookings link from the confirmation screen.
4. Deep links to Google/Apple calendar beyond plain `.ics`.
5. Tips (gratuity) — distinct from deposits, which Step 6 / `payment-deposit-preauth-design.md` already cover.
