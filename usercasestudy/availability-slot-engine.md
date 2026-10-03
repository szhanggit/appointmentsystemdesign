# Availability Slot Engine

**Architecture:** see `groway-v1-architecture.md`. Lives entirely inside the **Store Module**, `store` schema. Public, unauthenticated endpoint under `/api/store/public/*`.

**Relationship to other documents:**
- `store-onboarding-v1-design.md` defines every table this engine reads (`business_hours`, `staff_schedules`, `staff_time_offs`, `booking_settings`, `services`/`service_options`, `appointments`).
- `staff-schedule-entry-workflow.md` is how those input tables get filled in.
- `create-appointment-transaction-design.md` owns the actual appointment-creation transaction and double-booking prevention — this engine only answers "what's bookable," it never locks or reserves anything. For a multi-service basket, that document's §7 is the **normative, single definition** of how per-item duration/buffers combine into one block (`D_total`, `Bb_first`, `Ba_last`) — this document references that definition rather than restating it (§3 below), the same discipline that fixed the Step 5/5b occupancy-criteria drift earlier in this project: two documents each independently describing the same formula is how that kind of bug happens.

**One-line scope:** given (store, 1–5 services/options in merchant-set sequence, date, optional staff), compute every bookable start time that day for the combined block. **Pure computation, no side effects** — it never writes to the database, never pre-reserves a slot. Seeing a slot in the response is not the same as owning it.

---

## 1. Input and output

### Input (`GET /api/store/public/slots` query parameters)

| Param | Required | Notes |
|---|---|---|
| `store_id` | Yes | |
| `service_id` | Yes (single-item form) | Mutually exclusive with `service_ids[]` below |
| `option_id` | Conditional | Required if the service's `price_type='from'`, else `400 OPTION_REQUIRED` |
| `service_ids[]` | Yes (multi-item form) | 2–5 entries, merchant-set sequence order is irrelevant to the caller — the engine re-sorts by `services.sequence_order` before computing anything (`store-onboarding-v1-design.md` §7). Duplicate ids → `400`. All must belong to `store_id` and be bookable, else `409 SERVICE_NOT_BOOKABLE` naming the offending service. |
| `option_ids[]` | Conditional | Positional, aligned to `service_ids[]`'s *input* order (not the re-sorted execution order) — same `from`-service rule as `option_id`, per entry |
| `date` | Yes | `YYYY-MM-DD`, interpreted in the store's timezone |
| `staff_id` | No | A specific person (`store.staff.id`, person-level); omitted = "any available staff" mode |

The single-item form (`service_id`/`option_id`) keeps working unchanged — it's equivalent to `service_ids[]` with exactly one entry, not a separate code path.

### Output

```json
{
  "store_id": "…",
  "services": [
    { "service_id": "…", "option_id": "…", "duration_minutes": 60 },
    { "service_id": "…", "option_id": null, "duration_minutes": 30 }
  ],
  "date": "2026-10-05",
  "timezone": "America/Toronto",
  "total_duration_minutes": 90,
  "buffer_before_minutes": 0,
  "buffer_after_minutes": 10,
  "slots": [
    { "start": "2026-10-05T09:00:00", "end": "2026-10-05T10:30:00", "staff_ids": ["uuid-a", "uuid-b"] },
    { "start": "2026-10-05T09:15:00", "end": "2026-10-05T10:45:00", "staff_ids": ["uuid-a"] }
  ]
}
```

- `services[]` echoes the request **in execution order** (post-`sequence_order`-sort), not the order the caller sent them in — this is what the client's basket UI re-displays as "here's the order it'll actually run in."
- A single-item request still returns this same shape (`services` has one entry) — no conditional response format.
- Times are always store-local (`YYYY-MM-DDTHH:mm:ss`), per architecture-wide convention.
- `staff_ids` is always **person-level** — the customer is choosing a person, and the engine computes per-person-per-store (§4).
- `end = start + total_duration_minutes` — buffer is excluded from the displayed window; it only affects *whether* a start is offered, never what's shown.

### 1a. Companion endpoint: `GET /api/store/staff` (promoted to V1-built, 2026-10-02)

Public, unauthenticated, same rate-limit tier as `/slots`. Powers Step 2 of `public-booking-end-to-end-design.md` (picking a staff member *before* a date is chosen) — a narrower, date-independent question than `/slots` answers, reusing the same qualification data.

```
GET /api/store/staff?store_id=&service_id=        (single-item form)
GET /api/store/staff?store_id=&service_ids[]=      (multi-item form, same 2-5/dedup/bookable
                                                      validation as §2 items 2-3, store-wide, not date-scoped)
```

```json
{ "staff": [{ "staff_id": "…", "name": "…" }, ...] }
```

- The list is the same intersection §4's candidate-set definition computes — every staff member bookable at `store_id` (live schedule entry there, `staff-schedule-entry-workflow.md` §6) qualified for **every** requested service — just without a `date`/`staff_time_offs`/occupied-block filter, since this endpoint answers "who could ever do this combo," not "who's free on a specific day." An empty list is a normal `200`, same philosophy as an empty `slots` array.
- This is what `public-booking-end-to-end-design.md` §3's Step 2 calls directly; it does **not** derive this list by calling `/slots` first (that would need a date up front, which Step 2 doesn't have yet) and does not call `/slots` internally either — two independent reads of the same underlying qualification data, not one endpoint wrapping the other.

## 2. Preconditions (any failure short-circuits before the algorithm runs)

1. Store exists and `status='active'` — else `404`. (`store.stores.status` has no separate "deleted" state; `pending` and `suspended` are both rejected here, uniformly as `404` — a public, unauthenticated caller has no business distinguishing "still being onboarded" from "temporarily closed" from "never existed." This is the actual enforcement point for `store-onboarding-v1-design.md`'s "`status='active'` AND derived readiness" rule — without it, a `pending` store that already has business hours filled in would leak real bookable slots before anyone decided it was open for business.)
2. 1–5 services requested (`400` outside that range); no duplicate `service_id` in the basket (`400`). Each one belongs to this store, `status='active'`, not soft-deleted — else `404` (cross-store non-existence convention).
3. Each service is bookable (`store-onboarding-v1-design.md` §7.6: active + not deleted + ≥1 person with a live schedule entry at this store has it assigned + a `from` service has ≥1 live option) — else `409 SERVICE_NOT_BOOKABLE`, naming the first offending service.
4. `date` is valid: `today(store_tz) ≤ date ≤ today + advance_booking_days` — past date → `400 DATE_IN_PAST`; too far → `400 DATE_TOO_FAR`.
5. If `staff_id` is given: that person exists and has a **live schedule entry at this store** (none → `404`; 2026-10-03, Batch 4 — "works at this store" is the only test now; there is no assignment or status to be active/inactive). **Not** being qualified for every requested service is **not** a precondition failure here — it just means that person's candidate set is empty (§4), producing an ordinary `200` with an empty `slots` array. The hard `409 STAFF_NOT_QUALIFIED` only exists at create time (`create-appointment-transaction-design.md` §7); this read-only endpoint never throws it — "exists but can't do this combo" gets the same empty-array treatment as "exists but fully booked," not a special error. "No live entries at this store" is different from both — it's a `404`, not an empty array, because there's no relationship to this store at all to query against.

## 3. Duration and buffer (multi-service: see `create-appointment-transaction-design.md` §7)

Single service: `D` is the chosen option's `duration_minutes` for a `from` service, otherwise the service's own; `Bb`/`Ba` are that service's `buffer_before/after_minutes` if set, else the store's `booking_settings` defaults.

**Multi-service basket**: sort the requested services by `(sequence_order, service_name)` — the merchant's execution order, irrespective of the order the customer added them in (`store-onboarding-v1-design.md` §7). Then compute `D_total`, `Bb_first` (the first item's `Bb`), and `Ba_last` (the last item's `Ba`) by running `create-appointment-transaction-design.md` §7's cursor walk over that sorted list. **This document does not restate that formula** — it's defined exactly once, there, and referenced here; inter-item buffers are already folded into `D_total` by that walk (each gap is `max(Ba_i, Bb_{i+1})`), so nothing here needs to know about them directly.

For a single-item basket, `D_total = D`, `Bb_first = Bb`, `Ba_last = Ba` — the multi-item path is a strict generalization, not a fork.

Total occupied block for a candidate start `s`: `[s - Bb_first, s + D_total + Ba_last]`. Everywhere the rest of this document says `D`/`Bb`/`Ba`, read `D_total`/`Bb_first`/`Ba_last` for a multi-service basket — the algorithm itself (§4) doesn't change shape, only which three numbers it's handed.

## 4. Algorithm

Let `T` be the target date (store timezone), `dow(T)` its day of week. Computed **independently per candidate person**, then merged.

Candidate set = people **bookable at this store** (`staff-schedule-entry-workflow.md` §6: ≥1 live schedule entry at `store_id`, 2026-10-03 Batch 4) **and qualified for every requested service** — the intersection of `staff_services` rows across the whole basket, not just any one item (a single-item basket's "intersection" is trivially that one service's own qualified set). In specified-staff mode, only that person, and only if they're in that intersection — otherwise the candidate set is empty for them (§2 item 5).

**Occupancy criteria — defined once here, referenced by both Step 5 and Step 5b, never restated.** (An earlier version of this document stated this separately in each step; Step 5b's copy drifted from Step 5's and fell out of sync with the `pending`-counts-too decision below. Defining it once removes the ability for that to happen again.) An appointment occupies time when:
- its `status` is one that still holds the slot — `confirmed`, or `pending` with `expires_at IS NULL OR expires_at > now()` (an expired, unconfirmed hold is already released — this engine checks live, it doesn't wait for a sweeper to catch up);
- not soft-deleted (if/when `appointments` gains a `deleted_at`);
- `is_test` appointments occupy like any other — real time regardless of billing-quota treatment (`groway-billing-workflow.md`'s quota semantics are a separate, already-settled question).

Its occupied interval is always `[starts_at - buffer_before_minutes, ends_at + buffer_after_minutes]`, read from the **appointment header's own buffer snapshot** (`store-onboarding-v1-design.md` §4), never recomputed from the service. Single-person-single-block baseline: read from the `appointments` header directly, never by drilling into `appointment_items`.

Step 5b additionally requires `occupies_capacity = true` (also a header snapshot) — a flag that's meaningless to Step 5, since a non-bed-occupying service (e.g. a phone consult) still occupies the *staff member's* time; it just doesn't occupy a bed.

### Steps

1. **Store open interval `O`**: `business_hours WHERE store_id AND day_of_week = dow(T) AND open_time IS NOT NULL` → `[open_time, close_time]`. Empty (closed, or hours never set) → return empty `slots` immediately.
2. **Staff working interval `W`**: `staff_schedules WHERE staff_id AND store_id = <the store being queried> AND day_of_week = dow(T) AND deleted_at IS NULL` → all `[start_time, end_time]` rows (`staff_schedules` is the chain's one timetable, each entry tagged with its own `store_id`; this step reads the live slice tagged with the store currently being queried, soft-deleted entries excluded).
3. **Base availability `A0 = O ∩ W`** (interval-set intersection).
4. **Subtract time off**: `staff_time_offs WHERE staff_id` intersecting `tstzrange(store-midnight(T), store-midnight(T+1))` (converted to UTC for comparison) — subtract the intersecting portion from `A0`. **Person-level**: this staff member's time off at *any* store blocks them here too; no need to know what else they have booked elsewhere, the row already covers it.
5. **Subtract existing occupied blocks**: every `store.appointments` row `WHERE staff_id` (**not** also filtered to this `store_id` — 2026-10-02 fix, see note below) meeting the **occupancy criteria** above, overlapping `T`. Subtract each one's interval from `A0`.

   **Why no `store_id` filter here, unlike Step 5b**: `no_double_booking` (`create-appointment-transaction-design.md` §6.1) is a plain `(staff_id, occupied_range)` exclusion constraint with no store scoping at all — a staff member physically cannot hold two overlapping bookings at *any* stores, because the constraint doesn't know "store" exists. An earlier version of this step filtered `WHERE store_id AND staff_id`, matching Step 4 (time off, already correctly person-level with no store filter) in spirit but not in fact: for a staff member working at two stores in the same chain, that version would show a slot as available at Store B that the constraint would then reject at create time, because the real conflict sat in Store A's own appointments and this store-scoped query never saw it. Scoping to `staff_id` alone — at minimum within the chain, since cross-chain multi-store staff aren't a modeled case — makes this step's view match what the constraint actually enforces, the same way Step 5b's occupancy criteria and the constraint's own buffer-inclusive range were brought into alignment (`create-appointment-transaction-design.md` §6.1).
6. **Subtract elapsed time**: if `T` is today (store timezone), subtract `[store-midnight(T), now() + min_lead_minutes]`.
7. **Slice into candidate starts**: for each remaining interval `[a, b]`, a start `s` is feasible iff `[s - Bb, s + D + Ba] ⊆ [a, b]`, i.e. `s ∈ [a + Bb, b - Ba - D]`, aligned up to the nearest `slot_granularity_minutes` step from the lower bound. An interval too short to fit the whole block is skipped entirely — no half-length slots are ever offered.

**Step 5b — store-level capacity filter (2026-09-30), after the per-person loop, before Step 8's merge:** Steps 1–7 above compute availability *per staff member* — a store with fewer beds/chairs than staff (e.g. 3 staff, 2 beds) can still oversell if each staff member's own schedule looks free, because the thing actually in short supply is the store's concurrent capacity, not any one person's time. This step is store-wide, not per-assignment, and runs once against the *combined* `slotsByStart` built by the loop, not inside it.

Skipped entirely when `booking_settings.capacity IS NULL` (not configured = unlimited, §3 in `store-onboarding-v1-design.md`). Otherwise:

- A booking counts toward concurrency under the same **occupancy criteria** defined above Step 1, plus `occupies_capacity = true` (capacity's one extra condition, not shared with Step 5) — aggregated **per-store** this time, across every staff member, not per-person.
- Sweep every such interval at the store for date `T` into a set of "full" sub-intervals where concurrent count `≥ capacity`.
- Drop any candidate `start` (in *either* "any staff" or "specific staff" mode — a full store is full regardless of who's asking) whose block `[s - Bb, s + D + Ba]` intersects a full interval. In "any staff" mode this removes the whole `start` key, not just individual `staff_ids` — if the store is full, no staff substitution helps.

This is a filter, not a new occupancy source of truth — the actual prevention of overselling happens in the appointment-creation transaction (outside this document's scope), the same division of labor this document already has with staff-level double-booking: this engine answers "what looks bookable," the transaction is what actually makes it safe under concurrent requests.

8. **Merge (only in "any staff" mode)**: group by `start`; `staff_ids` is every person who can serve that start (ordered by, e.g., name or creation time).

### Pseudocode

```
function getSlots(store, services[], date, staffId?):   # services[] has 1-5 entries, each {service_id, option_id}
    run §2 preconditions
    sortedServices = sortBy(services, (sequence_order, service_name))   # §3, store-onboarding-v1-design.md §7
    D_total, Bb_first, Ba_last = create-appointment-transaction-design.md §7's cursor walk over sortedServices
    O = businessHours(store, dow(date))            # non-NULL row only
    if O empty: return []
    assigns = bookableAssignments(store, sortedServices, staffId?)   # intersection across every service, §4
    slotsByStart = {}
    for a in assigns:
        W = staffSchedules(a.staff_id, a.store_id, dow(date))   # staff_id+store_id keyed, not assignment id (2026-10-02, Batch 2 Q6)
        A = intersect(O, W)
        A = subtract(A, timeOffsIntersecting(a.staff_id, date))     # Step 4, person-level
        A = subtract(A, occupiedBlocks(a.staff_id, date)) # Step 5: occupancy criteria above, filtered WHERE staff_id = a.staff_id only — no store_id (2026-10-02 fix, see Step 5's note)
        if date == today(store.tz):
            A = subtract(A, [midnight, now() + min_lead_minutes])
        for [s_lo, s_hi] in feasibleStarts(A, Bb_first, Ba_last, D_total, slot_granularity_minutes):
            for s in range(s_lo, s_hi + 1, slot_granularity_minutes):
                slotsByStart[s].add(a.staff_id)   # person-level id in the output

    cap = bookingSettings(store).capacity
    if cap is not NULL:                              # Step 5b
        blocks = storeWideOccupiedBlocks(store.id, date)   # same occupancy criteria + occupies_capacity=true, no staff_id filter - deliberately a different query than occupiedBlocks above, not just a rename
        full = sweepFullIntervals(blocks, cap)             # intervals where concurrent count >= cap
        for s in list(keys(slotsByStart)):
            if intersects([s - Bb_first, s + D_total + Ba_last], full):
                delete slotsByStart[s]                     # whole start removed, not just staff_ids

    return sorted(slotsByStart)
```

Complexity: one store, one day — trivial, milliseconds, including Step 5b's interval sweep (O(n log n) in the number of occupying appointments that day, negligible at V1 volume). **V1 computes this live on every call, no caching** (correctness first — same philosophy as the `from`-price computation in `store-onboarding-v1-design.md` §7.4).

## 5. "Any staff" vs. a specific one

- **Specific staff**: only that one person, at this store, is considered; `staff_ids` is always a single element.
- **Any staff**: the union across every bookable person at this store, with each slot's own `staff_ids` list. The engine does **not** decide who a customer actually gets when they pick "any" — the create-appointment transaction takes the first id in `staff_ids` order (simple, predictable for V1; a smarter assignment strategy is that document's to design later).

## 6. Timezone and DST

- `date`, day-of-week, "today," and "now" are all evaluated in `stores.timezone`; internal comparisons convert to UTC.
- DST transition days get no special handling in V1 (flagged for QA to regression-test each spring/fall transition).

## 7. API

`GET /api/store/public/slots?store_id=&service_id=&option_id=&date=&staff_id=` (single-item)
`GET /api/store/public/slots?store_id=&service_ids[]=&service_ids[]=&option_ids[]=&option_ids[]=&date=&staff_id=` (multi-item, 2–5)

- Public, unauthenticated, rate-limited by IP + `store_id`.
- Returns `200` even with an empty `slots` array — "nothing available" is a normal business outcome, not an error. This includes a specified `staff_id` who exists but isn't qualified for every requested service (§2 item 5) — empty, not an error.
- Error codes: `OPTION_REQUIRED` (400), `DATE_IN_PAST` (400), `DATE_TOO_FAR` (400), `SERVICE_NOT_BOOKABLE` (409), out-of-scope resource (404), basket size/duplicate (400, §2 item 2). `STAFF_NOT_QUALIFIED` (409) is **not** one of this endpoint's error codes — it only exists at create time (`create-appointment-transaction-design.md` §7).
- Supersedes an earlier sketch, `GET /public/stores/{slug}/availability` — everything under `/api/store` now, addressed by `store_id`, per the architecture doc's route-prefix rule.

## 8. Left open (not decided in this document)

1. ~~`auto_confirm=false`: whether a `pending` booking should occupy a slot~~ — **resolved, 2026-09-30**: yes. `appointments.status` does have a `pending` value (with a TTL, `expires_at`); the occupancy criteria above (§4) count `pending` the same as `confirmed` as long as it hasn't expired. This document previously only subtracted `status='confirmed'`, which — for any store running `auto_confirm=false` or `payment_required=true` — silently under-counted occupancy and would have let the engine show a time as bookable that the creation transaction would then reject. Fixed by defining the criteria once and sharing it between Step 5 and Step 5b, instead of each step stating its own (and drifting).
2. ~~`is_test` appointments~~ — **resolved**: they occupy real time like any other appointment (§4's shared occupancy criteria); billing-quota treatment is a separate, independently-settled question.
3. ~~**Multi-service sequencing**~~ — **resolved, 2026-10-02, promoted to V1**: `GET /slots` now accepts a 2–5 service basket (`§1`), sorted into merchant-set execution order and merged into one combined-block query using `create-appointment-transaction-design.md` §7's `D_total`/`Bb_first`/`Ba_last` (§3, §4) — no new merge algorithm, every eligible staff member (now an intersection across all requested services, not just one) runs the same single-block algorithm this document already had, just with those three numbers instead of a single service's own. Sequential-only; parallel/simultaneous multi-staff bookings remain staff-manual, in-store only (`V1Backlog.md`).

## 9. Explicitly not in V1

- Slot pre-reservation / temporary locking — correctness is guaranteed by the (future) creation transaction's atomicity instead; a losing race reports `SLOT_TAKEN` and the client re-queries.
- Waitlists; time-of-day dynamic pricing; **multi-attendee services** (one slot, many customers — e.g. a group class) — `max_guests`/`allow_group` were deliberately cut (`store-onboarding-v1-design.md` §4's `booking_settings`). Not to be confused with Step 5b's store-level concurrent *capacity* (bed/chair count) above, which is a different, unrelated concept despite the similar name — that one's in scope, this one isn't.
