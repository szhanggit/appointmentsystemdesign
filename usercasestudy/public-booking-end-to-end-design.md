# Public Booking End-to-End — Design

**Status:** the complete self-serve customer booking flow — from opening the booking page to the confirmation screen. Chains together `availability-slot-engine.md` (query times), `create-appointment-transaction-design.md` (create), and `customer-booking-confirmation-reminders-design.md` (notify). This document defines step order, which endpoint each step calls, and how the UI reacts to failure — it does not introduce new business rules.

Baseline: step order is service → staff → time → contact info → confirm. The public API requires no login and is rate-limited by IP + `store_id`. A `from` service's displayed price is `MIN(options)`, computed live.

## 1. Decisions

1. **v1 books exactly one service (+ option) per public order.** Multi-service slot computation isn't designed yet (`availability-slot-engine.md` §9 item 3); staff can still book multi-service orders manually (`staff-manual-booking-calendar-design.md`). Unlocks once the engine supports merged multi-service slots.
2. **The confirmation screen offers an `.ics` download.** Trivial to implement (client-side string), good no-show prevention.
3. **Double-submit protection**: the submit button disables on click, plus an `Idempotency-Key`. Mobile users on weak connections tap repeatedly.
4. **`409 SLOT_TAKEN` never shows an error page** — the client silently re-queries that day's slots and highlights what's still open. Being beaten to a slot is normal, not exceptional.
5. **`409 CAPACITY_FULL` gets an explicit message, not a silent refresh** — unlike `SLOT_TAKEN`, a full store is store-wide state, and at peak times neighboring slots are often full too; silently refreshing would make the customer repeatedly hit the same wall with no explanation.

## 2. Flow

```
/book/{store_id}
  Step 1 Service → Step 2 Staff → Step 3 Date/Time → Step 4 Contact → Step 5 Review → Confirmation
```

A step indicator at the top allows back-navigation (prior selections are kept). Each step depends only on earlier selections; `store_id` stays in the URL throughout.

## 3. Steps

**Step 1 — Service.** `GET /api/store/services?store_id=` (active, non-deleted, online-bookable only). Grouped by category; `from` services show "from $X" (live `MIN(options)`), `free` services show "Free." A `from` service routes to an option picker before Step 2.

**Step 2 — Staff.** Options: "Any available" (default) plus the list of staff who can perform the service. Source: `GET /api/store/staff?store_id=&service_id=` (§6, deferred if not yet built — fall back to aggregating from the slots response). Selecting "Any" sends `staff_id: null` forward.

**Step 3 — Date & time.** Date picker spans `today(store_tz)` through `today + advance_booking_days`; past dates disabled. On date selection: `GET /api/store/public/slots?store_id=&service_id=&option_id=&date=&staff_id=`. Times render at `slot_granularity_minutes` resolution; in "any staff" mode the UI shows only the time, not which staff member (kept for the confirmation screen — a customer who cares can pick a specific person in Step 2). No slots that day → "Fully booked today," with a one-tap jump to the next day.

**Step 4 — Contact.** Name and phone required; email optional (confirmation email only sent if present). Phone format-validated (Canadian 10-digit); no OTP in v1 — rate limiting already covers abuse, OTP is a v2 hardening. One checkbox: "Booking confirmation and reminders will be sent to this number."

**Step 5 — Review.** Shows store name, service (+option), staff ("to be assigned" if "Any"), date/time, price, contact info. Submit button: "Confirm booking."

**Confirmation screen.** Large `reference_code`, booking details, "Confirmation sent to {phone}." Buttons: [Download calendar (.ics)] [Book another]. Copy: "To reschedule or cancel, call {store_phone}" (self-serve management is `customer-my-bookings-design.md`, not linked from here in v1). A `pending` result (`auto_confirm=false` stores) shows "Received — awaiting confirmation," matching the pending SMS template.

## 3. Submit request (Step 5 → Confirmation)

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
- `409 STAFF_NOT_AVAILABLE` / `400`-series → return to the relevant step, highlighted.
- Network failure/timeout: **no automatic retry** — the user taps "Retry," which resends with the **same** `Idempotency-Key` (server-side dedup guarantees only one booking, test case §7.3).

## 4. Entry point

- Booking page URL: `/book/{store_id}`. In-store signage/QR code points at the same URL.
- Unknown or non-`active` `store_id` → `404`, generic copy ("Online booking isn't available for this store"), no existence-leaking detail.
- Confirmation URL carries no sensitive data (`reference_code` is shown once on the page, never in the URL).

## 5. Responsive / UX notes (v1 minimum)

- Mobile-first, single column, large touch targets (≥44px) for time slots.
- Page language follows the browser; SMS language follows `customer-booking-confirmation-reminders-design.md`'s rules. i18n framework required from day one; copy ships in `en` + `zh`.
- Slot query shows a skeleton within 300ms; a timeout shows a retry button.

## 6. Interfaces consumed

| Step | Endpoint | Owning document |
|---|---|---|
| 1 | `GET /api/store/services` | `store-onboarding-v1-design.md` §7 |
| 2 | `GET /api/store/staff` | deferred, §7 |
| 3 | `GET /api/store/public/slots` | `availability-slot-engine.md` §7 |
| 5 | `POST /api/store/public/appointments` | `create-appointment-transaction-design.md` §3.1 |
| Confirmation | `.ics` generated client-side | §1 decision 2 |
| SMS / Email | outbox → relay | `customer-booking-confirmation-reminders-design.md` |

## 7. End-to-end test checklist

1. Full happy path: service → staff → time → contact → confirm → `201` → confirmation shows `reference_code` → SMS arrives within a minute.
2. Two phones race the same slot → one reaches confirmation, the other gets the toast and a refreshed list; no duplicate booking.
3. Weak network, triple-tap confirm → one booking (same `Idempotency-Key`).
4. Timeout then "Retry" → same `reference_code`, one DB row.
5. Free-plan quota exhausted mid-flow → call-to-action page, no orphaned appointment.
6. `auto_confirm=false` store → confirmation shows "awaiting confirmation," pending SMS received.
7. A store at capacity → booking a full window shows the `CAPACITY_FULL` message and a refreshed, narrower slot list; a non-`occupies_capacity` service still books normally in the same window.
8. Back navigation from Step 5 to Step 3, pick a different time → the booking uses the new time.
9. Expired date / invalid `store_id` → correct `400`/`404` page.

## 8. Deferred

1. `GET /api/store/staff` filtered by service — if not built yet, fall back to aggregating from the slots response; a dedicated endpoint comes later.
2. Multi-service public booking (waits on multi-service slot merging in the engine).
3. Logged-in member login / My Bookings link from the confirmation screen.
4. Deep links to Google/Apple calendar beyond plain `.ics`.
5. Tips / deposits (`payment-deposit-preauth-design.md`).
