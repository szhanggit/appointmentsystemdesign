# Create Appointment Transaction — Design

**Status:** builds directly on `store-onboarding-v1-design.md` (schema) and `availability-slot-engine.md` (slot computation, including the store-level capacity filter in its Step 5b). This document owns the single "create an appointment" action end to end — request/response contracts, the status state machine, slot re-validation, double-booking prevention, store-level capacity enforcement, idempotency, and quota integration.

Baseline facts (established elsewhere, referenced here, not re-argued):
- `store.appointments` is single-person, single-block: the header carries `staff_id` + `starts_at/ends_at`; multiple services ride as `appointment_items`, performed back-to-back by that same person (`store-onboarding-v1-design.md` §4).
- Occupancy is read from the header; buffers come from the header's own snapshot, never recomputed from the service (`availability-slot-engine.md` §4).
- Quota: `BillingQuotaService.TryConsumeAsync(storeId)`, an atomic conditional upsert; `is_test` skips quota (`groway-billing-workflow.md` §4.2).
- Authorization: `storeId ∈ caller.AuthorizedStoreIds`; a cross-store resource is `404`, never `403`.
- Times: the API uses store-local `YYYY-MM-DDTHH:mm:ss`; internal comparisons run in UTC.

---

## 1. Decisions

1. **`pending` occupies the slot**, with a TTL (`booking_settings.pending_hold_minutes`, default 15). A `pending` that didn't occupy anything would make `auto_confirm=false` pointless — the customer's "hold" has to be real.
2. **Double-booking prevention is a PostgreSQL exclusion constraint**, not an application lock. A lock is process-scoped and breaks under restarts or multiple instances; a constraint is data-level and always holds.
3. **Guest bookings are allowed** (`name` + `phone` required); `customer_id` is nullable, with separate `guest_*` snapshot columns.
4. **"Any staff" is assigned deterministically** — the first id in slot-engine's `staff_ids` order for that start. Predictable beats "smart" for v1; load balancing is a v2 concern.
5. **Multi-service sequencing is back-to-back by the same person**: service *i+1* starts at `max(service i's buffer_after, service i+1's buffer_before)` after service *i* ends.
6. **Reschedule is an in-place `UPDATE`** on the same row, not cancel+create — cancel still consumes quota, so cancel+create would burn two quota units for a single reschedule.
7. **`confirmed` past `ends_at` is auto-marked `completed`** by a sweeper — staff forget to do this manually, and downstream reporting needs it reliable.
8. **`payment_required=true` creates a `pending` row hooked to payment**; the payment provider integration itself is `payment-deposit-preauth-design.md`.
9. **Store-level concurrent capacity (beds/chairs) is a second, independent dimension** on top of per-staff availability — a store can have fewer beds than staff (e.g. 3 staff, 2 beds). It's enforced with a different mechanism than per-staff double-booking because the invariant has a different shape: staff conflicts are **pairwise** ("no two overlapping rows for the same staff"), capacity is **counting** ("at most N concurrent rows store-wide") — see §6.2.

## 2. State machine

```
pending --(auto_confirm=true, immediate)--------------> confirmed
pending --(auto_confirm=false, staff confirms)--------> confirmed
pending --(payment_required=true, payment succeeds)---> confirmed
pending --(TTL elapsed, sweeper)----------------------> expired
pending --(customer/staff cancels)---------------------> cancelled
confirmed --(cancelled; customer bound by cancel_threshold_hours)--> cancelled
confirmed --(staff marks)------------------------------> no_show
confirmed --(sweeper: ends_at has passed)--------------> completed
```

- `expired` / `cancelled` / `completed` / `no_show` are terminal.
- Only `pending` and `confirmed` occupy staff time and store capacity.
- `auto_confirm=true` (default): created directly as `confirmed`, no `pending` stage.
- `auto_confirm=false`: created as `pending`, `expires_at = created_at + pending_hold_minutes`.

## 3. API contracts

### 3.1 Public create (guest / self-serve)

`POST /api/store/public/appointments` — no login required, rate-limited by IP + `store_id`.

Headers: `Idempotency-Key` (optional, §8).

```json
// request
{
  "store_id": "uuid",
  "items": [{ "service_id": "uuid", "option_id": "uuid | null" }],
  "staff_id": "uuid | null",
  "start": "2026-10-05T09:00:00",
  "contact": { "name": "string", "phone": "string", "email": "string | null" },
  "notes": "string | null"
}
```

- `items` has ≥ 1 entry; a `price_type='from'` service must carry `option_id` (`OPTION_REQUIRED`, same as the slot engine).
- `staff_id: null` means "any staff" (§5).
- `start` is store-local time and must land exactly on a currently-valid slot start (re-validated per §4).

```json
// response 201
{
  "id": "uuid",
  "reference_code": "F7AE5724",
  "status": "confirmed | pending",
  "store_id": "uuid",
  "staff_id": "uuid",
  "starts_at": "2026-10-05T09:00:00",
  "ends_at": "2026-10-05T10:00:00",
  "items": [
    { "service_id": "uuid", "service_name": "string", "option_id": "uuid | null", "option_name": "string | null",
      "duration_minutes": 60, "price_cents": 8800, "starts_at": "...", "ends_at": "..." }
  ],
  "total_price_cents": 8800,
  "expires_at": "2026-10-05T09:15:00 | null"
}
```

- `expires_at` is set only when `status='pending'`.
- `reference_code`: 8-character uppercase alphanumeric, globally unique, the customer-facing booking number.

### 3.2 Staff create (phone / walk-in / back-office entry)

`POST /api/store/appointments` — `StoreSession`, `storeId ∈ caller.AuthorizedStoreIds`.

Same body as §3.1, plus:
- `is_test: bool` (default `false`) — the manual-booking test checkbox. The public endpoint always forces `false`.
- `contact.customer_id` optional — resolved from the store's customer records; record lookup/dedup rules live elsewhere.

Differences from §3.1:
- `is_test=true` is allowed here only.
- `min_lead_minutes` is skipped — a staff member booking a walk-in shouldn't be blocked by a lead-time rule meant for self-serve customers. Business hours, schedule, and double-booking checks still apply unconditionally.
- Runs through the exact same transaction (§7) — no second code path. Any manual-entry route that bypasses quota or double-booking checks is a bug, not a feature.

### 3.3 Confirm / cancel / reschedule

| Method & path | Who | Notes |
|---|---|---|
| `POST /api/store/appointments/{id}/confirm` | `storeId ∈ AuthorizedStoreIds` | `pending → confirmed` (for `auto_confirm=false` stores) |
| `POST /api/store/appointments/{id}/cancel` | same, or the appointment's own customer | §9 rules |
| `PATCH /api/store/appointments/{id}/reschedule` | same | §9 rules, in-place |

## 4. Slot re-validation (required at create time)

The slots a client saw are **never trusted**. On create, the server re-runs the slot engine's single-staff, single-day computation (`availability-slot-engine.md` §4 Steps 1–7, specified-staff mode) for the requested `(staff_id, start)`; `start` must land in the resulting set or the request fails `409 SLOT_TAKEN`.

- This computation includes unexpired `pending` occupancy, not just `confirmed` (the slot engine's shared occupancy criteria, `availability-slot-engine.md` §4).
- `is_test` appointments occupy real staff time like any other, consistent with the engine.
- **Capacity re-check**: in the same pass, re-run the store-level sweep for `(store_id, start)` (same criteria as Step 5b, store-wide, not per-staff). If the candidate block `[start - Bb, start + D + Ba]` falls inside a "full" interval, the request fails `409 CAPACITY_FULL` instead of `SLOT_TAKEN` — the two codes are kept distinct because the cause is different (a busy staff member vs. a full store) and the client UI reacts to them differently (`public-booking-end-to-end-design.md` §3). Stores with `booking_settings.capacity IS NULL` skip this check entirely.
- Passing re-validation doesn't guarantee the row: the actual guarantee comes from the exclusion constraint (staff dimension, §6.1) and the store-level advisory lock (capacity dimension, §6.2). A late conflict still surfaces as `409 SLOT_TAKEN` or `409 CAPACITY_FULL`.

## 5. "Any staff" assignment

When `staff_id` is `null`, the server takes the `staff_ids` list the re-validation pass computed for that `start` (already ordered by the slot engine's sort order) and picks the first entry, writing it to `appointments.staff_id`. The response returns who was actually assigned.

Two concurrent "any staff" requests can resolve to the same person — the exclusion constraint (§6.1) serializes them, and the loser gets `409 SLOT_TAKEN` (test case in §16).

## 6. Concurrency control

### 6.1 Per-staff double-booking: exclusion constraint

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE store.appointments
  ADD COLUMN occupied_range TSTZRANGE
    GENERATED ALWAYS AS (
      CASE WHEN status IN ('pending', 'confirmed')
           THEN tstzrange(starts_at, ends_at)
      END
    ) STORED;

ALTER TABLE store.appointments
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (staff_id WITH =, occupied_range WITH &&);
```

- Two rows for the same `staff_id` with overlapping occupied ranges cannot both exist — this is the system's actual, final defense against double-booking, independent of any application-layer lock.
- `is_test` rows are bound by it too (they occupy real time).
- No application-level advisory lock is used for this dimension: a lock can be lost across a process crash or a second instance; a constraint cannot. §4's re-validation exists purely to give the user a clean, friendly `SLOT_TAKEN` before the constraint would have rejected the `INSERT` anyway.

### 6.2 Store-level capacity: advisory lock

An exclusion constraint can only express a **pairwise** invariant ("no two rows overlap") — it has no way to express a **counting** invariant ("no more than N concurrent rows store-wide"). That's a hard limitation of the mechanism, not a style choice, and it's the reason capacity needs a different tool while per-staff conflicts keep using the constraint above. When evaluating a future invariant, classify its shape first — pairwise gets a constraint, counting doesn't have a constraint-shaped equivalent — rather than deciding by which "dimension" (staff vs. store) it happens to live on.

```sql
SELECT pg_advisory_xact_lock(hashtext('groway:store_appt:' || store_id::text));
```

Taken as step 0 of the creation and reschedule transactions (§7). This is **not** the kind of application lock ruled out in §6.1: that concern was about locks held in an app process's own memory (a C# `lock`, or a Redis lock without fencing) — state that dies with the process and desyncs across multiple instances. `pg_advisory_xact_lock` is a Postgres server-side lock bound to the transaction: it releases automatically on commit, rollback, or disconnect, and the lock table itself is shared by the database, not any one app instance — two different instances calling it for the same key are still serialized correctly. The two are not the same mechanism, and using this one doesn't reopen §6.1's decision.

Cost: one store's creates/reschedules serialize against each other; different stores don't interact. At v1 scale (single store, low concurrency) lock hold time is one transaction (milliseconds) — negligible.

## 7. Multi-service sequencing

```
cursor = start
for i, item in items:
    D_i  = option?.duration_minutes ?? service.duration_minutes
    Bb_i = service.buffer_before_minutes ?? store.buffer_before_minutes
    Ba_i = service.buffer_after_minutes  ?? store.buffer_after_minutes
    item.starts_at = cursor
    item.ends_at   = cursor + D_i
    cursor = item.ends_at + (max(Ba_i, Bb_{i+1}) if a next item exists)
header.starts_at = start
header.ends_at   = items.last.ends_at
header.buffer_before_minutes = Bb_0
header.buffer_after_minutes  = Ba_last
```

- Each item snapshots `price_cents`, `service_name`, `option_name`, `duration_minutes` at creation.
- The full span, `[header.starts_at - Bb_0, header.ends_at + Ba_last]`, must fit inside the assigned staff's available time for the day — checked by §4's re-validation.
- Single-person, single-block: multiple services never split across staff.

## 8. Idempotency

- The public endpoint accepts `Idempotency-Key`; the staff endpoint requires it.
- Semantics: `(store_id, key)` within 24 hours — same key + same request-body hash returns the original `201` response (no second row created); same key + different body is `422 IDEMPOTENCY_KEY_REUSED`.

```sql
CREATE TABLE store.idempotency_keys (
  store_id        UUID NOT NULL REFERENCES store.stores(id),
  key             TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_hash    TEXT NOT NULL,
  response_status INT NOT NULL,
  response_body   JSONB NOT NULL,
  PRIMARY KEY (store_id, key)
);
-- periodic cleanup: created_at < now() - interval '24 hours'
```

## 9. Transaction boundary (single DB transaction)

```
BEGIN
  0. SELECT pg_advisory_xact_lock(hashtext('groway:store_appt:' || store_id::text));
     (unconditional — negligible overhead for a capacity=NULL store, no branch needed)
  1. Validate input: store/service/option/staff existence (cross-store → 404),
     items non-empty, 'from' requires option_id, start is well-formed.
  2. Resolve staff: use staff_id if given; otherwise §5.
  3. Compute duration/buffers/sequencing (§7) → starts_at/ends_at.
  4. Slot re-validation (§4, including capacity): fails → 409 SLOT_TAKEN or
     409 CAPACITY_FULL (rollback, no side effects).
  5. Quota: is_test=false → BillingQuotaService.TryConsumeAsync(storeId), same
     transaction; failure → 409 QUOTA_EXHAUSTED (rollback). is_test=true → skip.
  6. Generate reference_code (8 chars; unique-violation → retry).
  7. INSERT appointments (status from auto_confirm/payment_required; pending
     sets expires_at = now() + pending_hold_minutes; occupies_capacity = OR
     across items' service.occupies_capacity)
     + INSERT appointment_items (snapshots)
     + UPSERT idempotency_keys (if a key was supplied)
     + INSERT store.outbox (§11 event)
COMMIT
-- exclusion violation -> 409 SLOT_TAKEN; reference_code unique violation -> retry generation
-- the advisory lock releases automatically on COMMIT/ROLLBACK
```

Order matters: lock first, re-validate before consuming quota — don't charge quota for a request that was going to fail anyway. `pending` appointments do consume quota immediately (a held slot is a real consumed resource) and it is not refunded on expiry, the same rule as a `cancelled` appointment keeping its quota charge. Any failure rolls back the whole transaction — quota, appointment row, idempotency record, and outbox event are all-or-nothing, and the advisory lock releases with the rollback.

## 10. Cancel / reschedule rules

**Cancel** (`→ cancelled`):
- Customer self-cancel: `starts_at - now() < cancel_threshold_hours` → `409 CANCEL_TOO_LATE` (`0` means any time is fine); the client points the customer to the store's phone number.
- Staff (within `AuthorizedStoreIds`): can cancel any time, not bound by the threshold.
- Cancelling doesn't refund quota; `occupied_range` becomes `NULL` automatically, releasing the slot.

**Reschedule** (in-place `UPDATE starts_at/ends_at[/staff_id]`):
- Re-runs the full §4 validation (including capacity) against the new `(staff, start)`, then §7's sequencing.
- Takes the same store-level advisory lock first (§6.2) — a reschedule and a new booking racing for the same slot are serialized by it exactly like two creates would be.
- No new row, so no additional quota charge.
- Customer self-reschedule is bound by `cancel_threshold_hours` too (it's logically a cancel-and-rebook); staff can reschedule any time.
- The exclusion constraint is sufficient concurrency protection for v1; a stronger optimistic lock (version column) is deferred (§18).

**Terminal transitions:**
- `no_show`: staff-marked only.
- `completed`: sweeper, `UPDATE ... SET status='completed' WHERE status='confirmed' AND ends_at < now()`, idempotent; staff can also mark it early.
- `expired`: sweeper, `UPDATE ... SET status='expired' WHERE status='pending' AND expires_at < now()`, idempotent.

## 11. Nightly capacity audit

Store-level capacity correctness depends entirely on every creation/reschedule path remembering to take the advisory lock (§6.2) — unlike the staff dimension, there's no data-level backstop like the exclusion constraint. A future path that bypasses this transaction (a bulk import tool, a direct-`INSERT` script) could silently push concurrency past `capacity` with nothing noticing.

v1 accepts that risk but adds an after-the-fact audit, not a second real-time gate: a nightly job re-sweeps the last 7 days of actual concurrency per store (reusing the same occupancy criteria as §4/Step 5b) and records any interval where it ever exceeded `capacity`, notifying that store's `chain_admin`.

```sql
CREATE TABLE store.capacity_breaches (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id         UUID NOT NULL REFERENCES store.stores(id),
  day              DATE NOT NULL,
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  capacity         INT NOT NULL,          -- capacity configured at detection time, kept as a historical record
  concurrent_count INT NOT NULL,
  detected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at      TIMESTAMPTZ
);
CREATE INDEX idx_capacity_breaches_store_day ON store.capacity_breaches(store_id, day);
```

- Idempotent: the same `(store_id, window_start, window_end)` detected again is `ON CONFLICT DO NOTHING` (no duplicate notification).
- Append-only: a later data correction that makes an old breach look like a false positive does not delete the row — this is an audit trail, not a live status.
- A silent breach surfaces the next morning, not in real time — acceptable for the pilot stage; this table is not a substitute for §6.2's lock being correct.

## 12. Outbox events

Written in the same transaction as the appointment write; a relay worker delivers these to the notification pipeline (`customer-booking-confirmation-reminders-design.md` owns templates/timing — this document only guarantees the event isn't lost).

| event_type | When |
|---|---|
| `appointment.created` | On create (carries `status`) |
| `appointment.confirmed` | `pending → confirmed` |
| `appointment.cancelled` | Any `→ cancelled` (carries `cancelled_by: customer\|staff`) |
| `appointment.rescheduled` | Successful reschedule (carries old/new `starts_at`) |
| `appointment.expired` | `pending → expired` |

```sql
CREATE TABLE store.outbox (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT NOT NULL DEFAULT 'appointment',
  aggregate_id   UUID NOT NULL,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at   TIMESTAMPTZ
);
```

## 13. Guest & logged-in customers

- The public endpoint never requires login: `contact.name` + `contact.phone` are required, `customer_id` stays `NULL`, and `guest_*` columns hold the snapshot.
- The staff endpoint can pass `customer_id` resolved from the store's own customer records (`customer-records-design.md`).
- Self-serve lookup/cancel/reschedule by the customer is `customer-my-bookings-design.md`'s concern — this document only guarantees `customer_id` has somewhere to live and `reference_code` is usable for guest lookup.

## 14. `payment_required=true` hook (minimal)

- Create goes to `pending`, `expires_at` follows the same pending TTL.
- The row reserves `payment_intent_id TEXT` for the provider to fill in.
- Payment success callback → `pending → confirmed` (via the `appointment.confirmed` event).
- Provider selection, deposit rules, capture/refund are entirely `payment-deposit-preauth-design.md`'s scope; a `payment_required=false` store is unaffected by any of it.

## 15. Error codes

| HTTP | code | Meaning |
|---|---|---|
| 400 | `OPTION_REQUIRED` | A `from` service was booked without `option_id` |
| 400 | `DATE_IN_PAST` / `DATE_TOO_FAR` | Outside the `advance_booking_days` window |
| 400 | `SERVICE_NOT_BOOKABLE` | Service not online-bookable (inactive/soft-deleted/unstaffed) |
| 404 | `STORE_NOT_FOUND` / `SERVICE_NOT_FOUND` / `STAFF_NOT_FOUND` | Includes cross-store (404, never 403) |
| 409 | `SLOT_TAKEN` | Re-validation or exclusion-constraint conflict — guide the client to re-pick a time |
| 409 | `CAPACITY_FULL` | Store-wide capacity full for that interval, independent of staff availability (§4, §6.2) — "this time is fully booked, please choose another" |
| 409 | `STAFF_NOT_AVAILABLE` | Requested staff exists but has no availability that day |
| 409 | `QUOTA_EXHAUSTED` | Free-plan monthly quota exhausted (`groway-billing-workflow.md` §4.3 copy) |
| 409 | `CANCEL_TOO_LATE` | Customer cancel/reschedule inside `cancel_threshold_hours` |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key, different request body |

## 16. Schema increment (ALTER on top of `store-onboarding-v1-design.md`)

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE store.appointments
  ADD COLUMN reference_code    VARCHAR(12) NOT NULL,   -- add first, backfill, then unique (below)
  ADD COLUMN expires_at        TIMESTAMPTZ,             -- pending only
  ADD COLUMN guest_name        TEXT,
  ADD COLUMN guest_phone       TEXT,
  ADD COLUMN guest_email       TEXT,
  ADD COLUMN customer_notes    TEXT,
  ADD COLUMN payment_intent_id TEXT,                    -- §14
  ALTER COLUMN customer_id DROP NOT NULL,
  ADD COLUMN occupied_range TSTZRANGE
    GENERATED ALWAYS AS (
      CASE WHEN status IN ('pending', 'confirmed')
           THEN tstzrange(starts_at, ends_at) END
    ) STORED;

ALTER TABLE store.appointments DROP CONSTRAINT appointments_status_check;
ALTER TABLE store.appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('pending','confirmed','completed','cancelled','no_show','expired'));

ALTER TABLE store.appointments
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (staff_id WITH =, occupied_range WITH &&);

-- after backfilling reference_code on existing rows:
ALTER TABLE store.appointments
  ADD CONSTRAINT uq_appointments_reference_code UNIQUE (reference_code);

CREATE INDEX idx_appointments_pending_expiry
  ON store.appointments (expires_at) WHERE status = 'pending';
CREATE INDEX idx_appointments_confirm_completion
  ON store.appointments (ends_at) WHERE status = 'confirmed';

ALTER TABLE store.booking_settings
  ADD COLUMN pending_hold_minutes INT NOT NULL DEFAULT 15 CHECK (pending_hold_minutes > 0);
```

`reference_code` generation: `upper(substr(md5(gen_random_uuid()::text), 1, 8))`, retry on collision. `store.idempotency_keys` (§8), `store.outbox` (§12), and `store.capacity_breaches` (§11) are new tables, defined in their own sections above.

## 17. Test cases

Concurrency (must pass under real parallel load, not just sequential simulation):

1. Same staff, same `start`, two requests in the same millisecond → one `201`, one `409 SLOT_TAKEN`; one DB row.
2. `staff_id=null`, only one staff member free at that `start` → two concurrent requests, one `201` (assigned to that staff), one `409 SLOT_TAKEN`.
3. `pending` at its TTL boundary: confirm succeeds one second before `expires_at`; the sweeper run one second after flips it to `expired` and frees the slot for rebooking.
4. Same appointment, two concurrent reschedules → one succeeds, one `409 SLOT_TAKEN`.
5. Free-plan quota at the 99/100 boundary: two concurrent creates → exactly one `409 QUOTA_EXHAUSTED`, usage settles at 100.
6. Same `Idempotency-Key` sent twice → same `reference_code`, one DB row, second call returns the first response body.
7. `capacity=2`, two `confirmed` already in the window → a third, overlapping create → `409 CAPACITY_FULL`, no new row.
8. `capacity=1`, staff A and B both free: book A at 09:00 → succeeds; book B at 09:00 (B fully free) → `409 CAPACITY_FULL` (proves capacity is independent of staff availability).
9. Concurrent: `capacity=1`, two requests in the same millisecond for the same window, different staff → one `201`, one `409 CAPACITY_FULL`; one DB row.
10. `occupies_capacity=false` service: bookable even when the store's capacity is full for that window, and doesn't count toward concurrency.
11. `pending` expiry (sweeper or live `expires_at < now()` check) releases capacity for rebooking.
12. `capacity=NULL` store: Step 5b and the capacity re-check are both skipped; behavior matches pre-capacity baseline (regression).
13. Reschedule into a capacity-full window → `409 CAPACITY_FULL`, original appointment untouched.
14. Cancelling one appointment in a full window makes that window's slots reappear.

## 18. Deferred

1. Guest self-serve cancel/reschedule by `reference_code` + phone — `customer-my-bookings-design.md`.
2. Strong optimistic locking (version column) for reschedule — v1 relies on the exclusion constraint.
3. Waitlist.
4. Repeated submissions under different `Idempotency-Key`s from the same abusive client — covered by IP/store rate limiting, no extra defense in v1.
5. Per-bed/room assignment, room types, equipment-based capacity — explicitly out of scope; staff can see which physical bed is free, no system assignment needed. Variable capacity by time-of-day, capacity pre-holds, and waitlist integration with capacity are also out of scope.
