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

**Occupancy criteria — defined once here, referenced by both Step 5 and Step 5b, never restated.** (An earlier version of this document stated this separately in each step; Step 5b's copy drifted from Step 5's and fell out of sync with the `pending`-counts-too decision below. Defining it once removes the ability for that to happen again.) An appointment occupies time when:
- its `status` is one that still holds the slot — `confirmed`, or `pending` with `expires_at IS NULL OR expires_at > now()` (an expired, unconfirmed hold is already released — this engine checks live, it doesn't wait for a sweeper to catch up);
- not soft-deleted (if/when `appointments` gains a `deleted_at`);
- `is_test` appointments occupy like any other — real time regardless of billing-quota treatment (`groway-billing-workflow.md`'s quota semantics are a separate, already-settled question).

Its occupied interval is always `[starts_at - buffer_before_minutes, ends_at + buffer_after_minutes]`, read from the **appointment header's own buffer snapshot** (`store-onboarding-v1-design.md` §4), never recomputed from the service. Single-person-single-block baseline: read from the `appointments` header directly, never by drilling into `appointment_items`.

Step 5b additionally requires `occupies_capacity = true` (also a header snapshot) — a flag that's meaningless to Step 5, since a non-bed-occupying service (e.g. a phone consult) still occupies the *staff member's* time; it just doesn't occupy a bed.

### Steps

1. **Store open interval `O`**: `business_hours WHERE store_id AND day_of_week = dow(T) AND open_time IS NOT NULL` → `[open_time, close_time]`. Empty (closed, or hours never set) → return empty `slots` immediately.
2. **Staff working interval `W`**: `staff_schedules WHERE staff_store_assignment_id AND day_of_week = dow(T)` → all `[start_time, end_time]` rows.
3. **Base availability `A0 = O ∩ W`** (interval-set intersection).
4. **Subtract time off**: `staff_time_offs WHERE staff_id` intersecting `tstzrange(store-midnight(T), store-midnight(T+1))` (converted to UTC for comparison) — subtract the intersecting portion from `A0`. **Person-level**: this staff member's time off at *any* store blocks them here too; no need to know what else they have booked elsewhere, the row already covers it.
5. **Subtract existing occupied blocks**: every `store.appointments` row `WHERE store_id AND staff_id` meeting the **occupancy criteria** above, overlapping `T`. Subtract each one's interval from `A0`.
6. **Subtract elapsed time**: if `T` is today (store timezone), subtract `[store-midnight(T), now() + min_lead_minutes]`.
7. **Slice into candidate starts**: for each remaining interval `[a, b]`, a start `s` is feasible iff `[s - Bb, s + D + Ba] ⊆ [a, b]`, i.e. `s ∈ [a + Bb, b - Ba - D]`, aligned up to the nearest `slot_granularity_minutes` step from the lower bound. An interval too short to fit the whole block is skipped entirely — no half-length slots are ever offered.

**Step 5b — store-level capacity filter (2026-09-30), after the per-assignment loop, before Step 8's merge:** Steps 1–7 above compute availability *per staff member* — a store with fewer beds/chairs than staff (e.g. 3 staff, 2 beds) can still oversell if each staff member's own schedule looks free, because the thing actually in short supply is the store's concurrent capacity, not any one person's time. This step is store-wide, not per-assignment, and runs once against the *combined* `slotsByStart` built by the loop, not inside it.

Skipped entirely when `booking_settings.capacity IS NULL` (not configured = unlimited, §3 in `store-onboarding-v1-design.md`). Otherwise:

- A booking counts toward concurrency under the same **occupancy criteria** defined above Step 1, plus `occupies_capacity = true` (capacity's one extra condition, not shared with Step 5) — aggregated **per-store** this time, across every staff member, not per-assignment.
- Sweep every such interval at the store for date `T` into a set of "full" sub-intervals where concurrent count `≥ capacity`.
- Drop any candidate `start` (in *either* "any staff" or "specific staff" mode — a full store is full regardless of who's asking) whose block `[s - Bb, s + D + Ba]` intersects a full interval. In "any staff" mode this removes the whole `start` key, not just individual `staff_ids` — if the store is full, no staff substitution helps.

This is a filter, not a new occupancy source of truth — the actual prevention of overselling happens in the appointment-creation transaction (outside this document's scope), the same division of labor this document already has with staff-level double-booking: this engine answers "what looks bookable," the transaction is what actually makes it safe under concurrent requests.

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
        A = subtract(A, occupiedBlocks(store.id, a.staff_id, date)) # Step 5: occupancy criteria above, filtered WHERE staff_id = a.staff_id
        if date == today(store.tz):
            A = subtract(A, [midnight, now() + min_lead_minutes])
        for [s_lo, s_hi] in feasibleStarts(A, Bb, Ba, D, slot_granularity_minutes):
            for s in range(s_lo, s_hi + 1, slot_granularity_minutes):
                slotsByStart[s].add(a.staff_id)   # person-level id in the output

    cap = bookingSettings(store).capacity
    if cap is not NULL:                              # Step 5b
        blocks = storeWideOccupiedBlocks(store.id, date)   # same occupancy criteria + occupies_capacity=true, no staff_id filter - deliberately a different query than occupiedBlocks above, not just a rename
        full = sweepFullIntervals(blocks, cap)             # intervals where concurrent count >= cap
        for s in list(keys(slotsByStart)):
            if intersects([s - Bb, s + D + Ba], full):
                delete slotsByStart[s]                     # whole start removed, not just staff_ids

    return sorted(slotsByStart)
```

Complexity: one store, one day — trivial, milliseconds, including Step 5b's interval sweep (O(n log n) in the number of occupying appointments that day, negligible at V1 volume). **V1 computes this live on every call, no caching** (correctness first — same philosophy as the `from`-price computation in `store-onboarding-v1-design.md` §7.4).

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

1. ~~`auto_confirm=false`: whether a `pending` booking should occupy a slot~~ — **resolved, 2026-09-30**: yes. `appointments.status` does have a `pending` value (with a TTL, `expires_at`); the occupancy criteria above (§4) count `pending` the same as `confirmed` as long as it hasn't expired. This document previously only subtracted `status='confirmed'`, which — for any store running `auto_confirm=false` or `payment_required=true` — silently under-counted occupancy and would have let the engine show a time as bookable that the creation transaction would then reject. Fixed by defining the criteria once and sharing it between Step 5 and Step 5b, instead of each step stating its own (and drifting).
2. ~~`is_test` appointments~~ — **resolved**: they occupy real time like any other appointment (§4's shared occupancy criteria); billing-quota treatment is a separate, independently-settled question.
3. **Multi-service sequencing**: this engine's `GET /slots` only ever queries a **single** service (+ option) at a time. A booking with several services back-to-back is sequenced into one continuous block at creation time (the appointment header's `starts_at`/`ends_at` *is* that block) — the exact sequencing rule belongs to the create-appointment document.

## 9. Explicitly not in V1

- Slot pre-reservation / temporary locking — correctness is guaranteed by the (future) creation transaction's atomicity instead; a losing race reports `SLOT_TAKEN` and the client re-queries.
- Waitlists; time-of-day dynamic pricing; **multi-attendee services** (one slot, many customers — e.g. a group class) — `max_guests`/`allow_group` were deliberately cut (`store-onboarding-v1-design.md` §4's `booking_settings`). Not to be confused with Step 5b's store-level concurrent *capacity* (bed/chair count) above, which is a different, unrelated concept despite the similar name — that one's in scope, this one isn't.
