# Availability Slot Engine

**Architecture:** see `groway-v1-architecture.md`. Lives entirely inside the **Store Module**, `store` schema. Public, unauthenticated endpoint under `/api/store/public/*`.

**Relationship to other documents:**
- `store-onboarding-v1-design.md` defines every table this engine reads (`business_hours`, `staff_schedules`, `staff_time_offs`, `booking_settings`, `services`/`service_options`, `appointments`).
- `staff-schedule-entry-workflow.md` is how those input tables get filled in.
- A **future, not-yet-written** document owns the actual appointment-creation transaction and double-booking prevention — this engine only answers "what's bookable," it never locks or reserves anything.

**One-line scope:** given (store, service/option, date, optional staff), compute every bookable start time that day. **Pure computation, no side effects** — it never writes to the database, never pre-reserves a slot. Seeing a slot in the response is not the same as owning it.

---

## 1. Input and output

### Input (`GET /api/store/public/slots` query parameters)

| Param | Required | Notes |
|---|---|---|
| `store_id` | Yes | |
| `service_id` | Yes | |
| `option_id` | Conditional | Required if the service's `price_type='from'`, else `400 OPTION_REQUIRED` |
| `date` | Yes | `YYYY-MM-DD`, interpreted in the store's timezone |
| `staff_id` | No | A specific person (`store.staff.id`, person-level); omitted = "any available staff" mode |

### Output

```json
{
  "store_id": "…",
  "service_id": "…",
  "option_id": "…",
  "date": "2026-10-05",
  "timezone": "America/Toronto",
  "duration_minutes": 60,
  "buffer_before_minutes": 0,
  "buffer_after_minutes": 10,
  "slots": [
    { "start": "2026-10-05T09:00:00", "end": "2026-10-05T10:00:00", "staff_ids": ["uuid-a", "uuid-b"] },
    { "start": "2026-10-05T09:15:00", "end": "2026-10-05T10:15:00", "staff_ids": ["uuid-a"] }
  ]
}
```

- Times are always store-local (`YYYY-MM-DDTHH:mm:ss`), per architecture-wide convention.
- `staff_ids` is always **person-level** — the customer is choosing a person, not an assignment; the engine works internally in assignments (§4).
- `end = start + duration_minutes` — buffer is excluded from the displayed window; it only affects *whether* a start is offered, never what's shown.

## 2. Preconditions (any failure short-circuits before the algorithm runs)

1. Store exists and `status='active'` — else `404`. (`store.stores.status` has no separate "deleted" state; `pending` and `suspended` are both rejected here, uniformly as `404` — a public, unauthenticated caller has no business distinguishing "still being onboarded" from "temporarily closed" from "never existed." This is the actual enforcement point for `store-onboarding-v1-design.md`'s "`status='active'` AND derived readiness" rule — without it, a `pending` store that already has business hours filled in would leak real bookable slots before anyone decided it was open for business.)
2. Service belongs to this store, `status='active'`, not soft-deleted — else `404` (cross-store non-existence convention).
3. Service is bookable (`store-onboarding-v1-design.md` §7.6: active + not deleted + ≥1 assignment has it assigned + a `from` service has ≥1 live option) — else `409 SERVICE_NOT_BOOKABLE`.
4. `date` is valid: `today(store_tz) ≤ date ≤ today + advance_booking_days` — past date → `400 DATE_IN_PAST`; too far → `400 DATE_TOO_FAR`.
5. If `staff_id` is given: that person exists and has an assignment at this store (no assignment → `404`). Having zero open slots that day is still a `200` with an empty `slots` array — "exists but fully booked" is not "doesn't exist."

## 3. Duration and buffer

- `D` (duration): the chosen option's `duration_minutes` for a `from` service, otherwise the service's own.
- `Bb` / `Ba` (buffer before/after): the service's `buffer_before/after_minutes` if set, else the store's `booking_settings` defaults.
- Total occupied block for a candidate start `s`: `[s - Bb, s + D + Ba]`.

## 4. Algorithm

Let `T` be the target date (store timezone), `dow(T)` its day of week. Computed **independently per candidate assignment**, then merged.

Candidate set = assignments at this store satisfying "bookable" (`staff-schedule-entry-workflow.md` §6); in specified-staff mode, only that person's assignment at this store.

### Steps

1. **Store open interval `O`**: `business_hours WHERE store_id AND day_of_week = dow(T) AND open_time IS NOT NULL` → `[open_time, close_time]`. Empty (closed, or hours never set) → return empty `slots` immediately.
2. **Staff working interval `W`**: `staff_schedules WHERE staff_store_assignment_id AND day_of_week = dow(T)` → all `[start_time, end_time]` rows.
3. **Base availability `A0 = O ∩ W`** (interval-set intersection).
4. **Subtract time off**: `staff_time_offs WHERE staff_id` intersecting `tstzrange(store-midnight(T), store-midnight(T+1))` (converted to UTC for comparison) — subtract the intersecting portion from `A0`. **Person-level**: this staff member's time off at *any* store blocks them here too; no need to know what else they have booked elsewhere, the row already covers it.
5. **Subtract existing occupied blocks**: `store.appointments WHERE store_id AND staff_id AND status = 'confirmed'` overlapping `T`. Each occupies `[starts_at - buffer_before_minutes, ends_at + buffer_after_minutes]` — read from the **appointment header's own buffer snapshot** (`store-onboarding-v1-design.md` §4), not recomputed from the service. Subtract from `A0`.
   (Single-person-single-block baseline: occupancy is read from the `appointments` header directly, never by drilling into `appointment_items`. Whether an `is_test` appointment should occupy a slot is answered here as **yes, it occupies it like any other** — it's real staff time regardless of billing-quota treatment; `groway-billing-workflow.md`'s quota semantics are a separate question, reconciled if the future create-appointment document says otherwise — §8 item 2.)
6. **Subtract elapsed time**: if `T` is today (store timezone), subtract `[store-midnight(T), now() + min_lead_minutes]`.
7. **Slice into candidate starts**: for each remaining interval `[a, b]`, a start `s` is feasible iff `[s - Bb, s + D + Ba] ⊆ [a, b]`, i.e. `s ∈ [a + Bb, b - Ba - D]`, aligned up to the nearest `slot_granularity_minutes` step from the lower bound. An interval too short to fit the whole block is skipped entirely — no half-length slots are ever offered.
8. **Merge (only in "any staff" mode)**: group by `start`; `staff_ids` is every person who can serve that start (ordered by, e.g., assignment sort order or creation time).

### Pseudocode

```
function getSlots(store, service, option, date, staffId?):
    run §2 preconditions
    D, Bb, Ba = §3
    O = businessHours(store, dow(date))            # non-NULL row only
    if O empty: return []
    assigns = bookableAssignments(store, service, staffId?)
    slotsByStart = {}
    for a in assigns:
        W = staffSchedules(a.id, dow(date))
        A = intersect(O, W)
        A = subtract(A, timeOffsIntersecting(a.staff_id, date))     # Step 4, person-level
        A = subtract(A, occupiedBlocks(store.id, a.staff_id, date)) # Step 5, reads appointments header
        if date == today(store.tz):
            A = subtract(A, [midnight, now() + min_lead_minutes])
        for [s_lo, s_hi] in feasibleStarts(A, Bb, Ba, D, slot_granularity_minutes):
            for s in range(s_lo, s_hi + 1, slot_granularity_minutes):
                slotsByStart[s].add(a.staff_id)   # person-level id in the output
    return sorted(slotsByStart)
```

Complexity: one store, one day — trivial, milliseconds. **V1 computes this live on every call, no caching** (correctness first — same philosophy as the `from`-price computation in `store-onboarding-v1-design.md` §7.4).

## 5. "Any staff" vs. a specific one

- **Specific staff**: only that person's assignment at this store is considered; `staff_ids` is always a single element.
- **Any staff**: the union across assignments, with each slot's own `staff_ids` list. The engine does **not** decide who a customer actually gets when they pick "any" — the create-appointment transaction takes the first id in `staff_ids` order (simple, predictable for V1; a smarter assignment strategy is that document's to design later).

## 6. Timezone and DST

- `date`, day-of-week, "today," and "now" are all evaluated in `stores.timezone`; internal comparisons convert to UTC.
- DST transition days get no special handling in V1 (flagged for QA to regression-test each spring/fall transition).

## 7. API

`GET /api/store/public/slots?store_id=&service_id=&option_id=&date=&staff_id=`

- Public, unauthenticated, rate-limited by IP + `store_id`.
- Returns `200` even with an empty `slots` array — "nothing available" is a normal business outcome, not an error.
- Error codes: `OPTION_REQUIRED` (400), `DATE_IN_PAST` (400), `DATE_TOO_FAR` (400), `SERVICE_NOT_BOOKABLE` (409), out-of-scope resource (404).
- Supersedes an earlier sketch, `GET /public/stores/{slug}/availability` — everything under `/api/store` now, addressed by `store_id`, per the architecture doc's route-prefix rule.

## 8. Left open (not decided in this document)

1. **`auto_confirm=false`**: `appointments.status` has no `pending` value yet. Whether an unconfirmed booking should occupy a slot is for the future create-appointment document; this engine, for now, only ever subtracts `status='confirmed'` occupancy (§4 Step 5).
2. **`is_test` appointments**: this document treats them as occupying real time (§4 Step 5) — if `groway-billing-workflow.md`'s quota semantics ever imply something different about *availability* (as opposed to *quota*, which is already settled), the create-appointment document reconciles it.
3. **Multi-service sequencing**: this engine's `GET /slots` only ever queries a **single** service (+ option) at a time. A booking with several services back-to-back is sequenced into one continuous block at creation time (the appointment header's `starts_at`/`ends_at` *is* that block) — the exact sequencing rule belongs to the create-appointment document.

## 9. Explicitly not in V1

- Slot pre-reservation / temporary locking — correctness is guaranteed by the (future) creation transaction's atomicity instead; a losing race reports `SLOT_TAKEN` and the client re-queries.
- Waitlists; time-of-day dynamic pricing; capacity-based services (one slot, many attendees) — `max_guests`/`allow_group` were deliberately cut (`store-onboarding-v1-design.md` §4's `booking_settings`).
