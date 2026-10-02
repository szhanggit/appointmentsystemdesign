# Customer My Bookings — Design

**Status:** self-serve lookup, cancellation, and reschedule for customers. Closes out three deferred items: `create-appointment-transaction-design.md` §13 (guest self-serve), `customer-booking-confirmation-reminders-design.md` §12 (`{manage_link}`), and `public-booking-end-to-end-design.md` §8 (My Bookings).

Baseline: cancel/reschedule business rules are fixed in `create-appointment-transaction-design.md` §10 (`cancel_threshold_hours`, in-place reschedule, the terminal state machine) — this document only defines who the customer is, how they prove it, and which endpoint they call; it invents no new rules. Notifications reuse the existing event pipeline. Cross-module access follows the established pattern: Customer Module routes, in-process call into Store Module (same shape as Admin Module → Store Module).

## 1. Decisions

1. **Guests look themselves up by `reference_code` + phone number, no SMS OTP.** An 8-character code space (36^8) resists enumeration when combined with rate limiting, and the data being viewed is already in the customer's own SMS inbox. OTP is deferred to v2.
2. **Routes live on the Customer Module (`/api/customer/bookings`), data stays in the store schema**, called in-process. Routing ownership is Customer's; data ownership is Store's — matches the project's established cross-module pattern.
3. **Customer-side cancel/reschedule rules are identical to the staff-side rules** (same `cancel_threshold_hours`) — one rule set, no "why can the store refund me but I can't cancel myself" confusion.
4. **Reschedule UI reuses the public flow's date/time picker** (`public-booking-end-to-end-design.md` Step 3) — no second time-selection UI.

## 2. Identity and "my bookings"

Two identities, two lookup paths:

| Identity | Proof | Visibility |
|---|---|---|
| Logged-in customer (CustomerSession) | Session | All bookings where `customer_id = self` (upcoming + past 12 months) |
| Guest | `reference_code` + the phone number on that booking | That one booking only |

- A guest booking is **not auto-linked** when the guest later registers an account (even on a matching phone number) — account merge/claim rules belong to the customer-records document, not here.
- Enumeration protection: the guest lookup endpoint is rate-limited by IP + `reference_code`; 5 consecutive phone mismatches locks that code for 15 minutes.

## 3. Endpoints

### 3.1 Logged-in customer's booking list

`GET /api/customer/bookings?scope=upcoming|past` — requires `CustomerSession`.

- `upcoming`: `status IN ('pending','confirmed')` and `starts_at > now()`, ascending.
- `past`: terminal states + past `confirmed`, descending, capped at 50 (no pagination in v1).
- Customer Module calls Store Module in-process, filtered by `customer_id`.
- Returns the same fields as the back-office list (`staff-manual-booking-calendar-design.md` §3), minus staff-internal fields (there are none to drop).

### 3.2 Guest single-booking lookup

`GET /api/customer/bookings/lookup?reference_code=&phone=` — public, rate-limited.

- A hit returns that booking (same fields as §3.1); an unknown `reference_code` is `404`; a mismatched phone is also `404` (**indistinguishable**, to resist enumeration).
- After a successful lookup, the client re-sends `reference_code` + `phone` on every subsequent §3.3/§3.4 call (no session to persist them).

### 3.3 Cancel

`POST /api/customer/bookings/{id}/cancel` — `CustomerSession`, or guest params (`reference_code` + `phone`).

- Ownership check: logged-in → `customer_id` match; guest → that booking's `reference_code` + `guest_phone` match. Failure → `404`.
- Rule: `create-appointment-transaction-design.md` §10 (`cancel_threshold_hours` violation → `409 CANCEL_TOO_LATE`, "please call {store_phone}").
- Success → `cancelled` + event → cancellation SMS (existing template).

### 3.4 Reschedule

`PATCH /api/customer/bookings/{id}/reschedule` — same auth as §3.3.

- Body: `{ new_staff_id?, new_start }` (`new_start` in store-local time).
- Runs the full re-validation + in-place `UPDATE` (`create-appointment-transaction-design.md` §10); a conflict returns `409 SLOT_TAKEN` (staff busy) or `409 CAPACITY_FULL` (store-wide capacity full, independent of staff availability) — either way the original booking is left untouched. The chain-wide phone cap never applies to a reschedule (no new row, count unchanged); the per-store blocklist still does, with no override available on this self-serve channel (`create-appointment-transaction-design.md` §1 decisions 10–11).
- Also bound by `cancel_threshold_hours` (logically a cancel-and-rebook).
- Success → event → reschedule confirmation SMS; the reminders scheduler resets the sent-at flags per `customer-booking-confirmation-reminders-design.md` §3 (new time gets its own reminders).

## 4. UI flow

**Booking list page** (`/bookings` logged-in, or the guest lookup result page):
- Upcoming group (pending ones pinned at top with an "awaiting confirmation" badge) and a Past group.
- Each row: date/time, store name, service, staff, `reference_code`, status badge; `pending` shows "awaiting confirmation," `confirmed` shows [Reschedule][Cancel].
- Guest entry point: `/bookings?ref={reference_code}` pre-fills the code field (this is the query-param exception noted in §6) — the phone-match check (§2) still runs before anything is shown. This is the page `customer-booking-confirmation-reminders-design.md`'s `{manage_link}` points to.

**Cancel**: tap cancel → confirmation dialog (shows the threshold copy, e.g. "call us if it's within X hours of start") → `POST` §3.3 → moves to the Cancelled group on success.

**Reschedule**: tap reschedule → reuse the public flow's Step 3 date/time picker (same component, `store_id`/`service_id`/`option_id` carried from the original booking) → pick a new time → confirm (old → new) → `PATCH` §3.4.

## 5. Notifications

- Cancel/reschedule success reuses the existing outbox events → `customer-booking-confirmation-reminders-design.md`'s SMS/Email templates directly — no new templates here.
- The guest lookup page masks the phone number (`416-***-4567`) to prevent shoulder-surfing.

## 6. Security notes

1. Any unauthorized or non-existent access → `404`, undistinguished.
2. Guest endpoint rate limits: 10/minute per IP; 5 wrong-phone attempts on one code locks it for 15 minutes.
3. Reschedule/cancel concurrency: the exclusion constraint backstops it (`create-appointment-transaction-design.md` §6.1) — if a customer and staff member act on the same booking simultaneously, one wins.
4. `reference_code` never appears in a URL except as the guest lookup's required query parameter (its one legitimate use as the guest's "key"); the logged-in list page's URL carries no identifying data.

## 7. Schema increment

**None.** Every field already exists; this document adds Customer Module routes and an in-process client, not tables.

## 8. Test cases

1. A logged-in customer sees their own two bookings, not anyone else's (`customer_id` isolation).
2. A guest enters the right code with the wrong phone 5 times → the 6th attempt (even with the correct phone) is locked for 15 minutes.
3. A guest uses code A's phone number to look up code B → `404`.
4. Cancel inside the threshold → `409 CANCEL_TOO_LATE`, booking untouched.
5. Reschedule into a slot taken by someone else → `409 SLOT_TAKEN`, original untouched.
6. Reschedule into a capacity-full window → `409 CAPACITY_FULL`, original untouched.
7. Cancel → the 24h reminder for that booking never fires (scheduler filters by status).
8. Reschedule to a later date → reminder flags reset, both reminders fire normally for the new time.

## 9. Deferred

1. Automatic linking between a guest booking and an account created afterward — belongs to the customer-records document.
2. SMS OTP for lookup (v2, revisit if abuse patterns show up).
3. Pagination for past bookings (v1 caps at 50).
4. Waitlist.
5. Membership/loyalty balance display (loyalty is v2).
