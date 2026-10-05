# Create Appointment Transaction — Design

**Status:** builds directly on `store-onboarding-v1-design.md` (schema) and `availability-slot-engine.md` (slot computation, including the store-level capacity filter in its Step 5b). This document owns the single "create an appointment" action end to end — request/response contracts, the status state machine, slot re-validation, double-booking prevention, store-level capacity enforcement, idempotency, and quota integration.

~~`is_test` — deferred from the V1 build, 2026-10-03...~~ — **removed entirely 2026-10-05 (Steven, #18 superseded), not deferred.** Competitor check (Fresha/Vagaro/Mindbody/Booker/Square/GlossGenius): none has a test-appointment concept. V1 training story: practice bookings on the live store (they consume quota; acceptable at 100/month) or train pre-launch. Every `is_test` mention below has been converted to a removal note — none of it describes something the V1 build executes, and none of it is coming back without a fresh decision.

Baseline facts (established elsewhere, referenced here, not re-argued):
- `store.appointments` is single-person, single-block: the header carries `staff_id` + `starts_at/ends_at`; multiple services ride as `appointment_items`, performed back-to-back by that same person (`store-onboarding-v1-design.md` §4).
- Occupancy is read from the header; buffers come from the header's own snapshot, never recomputed from the service (`availability-slot-engine.md` §4).
- Quota: `BillingQuotaService.TryConsumeAsync(storeId)`, an atomic conditional upsert; ~~`is_test` skips quota in the retained design~~ — **removed 2026-10-05**, see above (`groway-billing-workflow.md` §4.2) — every appointment counts, no exemptions.
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
10. **A chain-wide phone cap is a third, independent dimension**, defending against anonymous scraping/abuse rather than monetization — the same normalized phone number can't hold more than `platform.abuse_config.max_upcoming_per_phone_per_chain` (default 5) unresolved upcoming bookings across the whole chain. It's counting-shaped like capacity, so it gets the same tool (an advisory lock, §6.3) — but it's **public-channel only** (§3.1), never the staff path (§3.2): staff manual entry already has human judgment and an audit trail behind it, and blocking a front-desk booking with no escalation path makes no sense.
11. **A per-store phone blocklist is a fourth, independent dimension**, store-scoped rather than chain-scoped (a person one store bans may be another store's regular, so chain-wide would over-reach) — unlike the phone cap, this check runs on **every** channel, because the whole point is "this specific store doesn't want this number," not an anonymity-abuse defense. Staff (not the public endpoint) can override it for a single booking, with a mandatory reason, logged — see §9 step 1.5 and §15.
12. **`channel` is a purely descriptive record, never a branching input.** It's written once, at the step-7 `INSERT`, recording which code path (§3.1 or §3.2, and eventually an AI-agent path) created the row — not a column anything upstream of that `INSERT` reads to decide behavior. The existing endpoint-based branches (phone-cap §3.1-only, `min_lead_minutes` skip §3.2-only) stay exactly as they are: the row doesn't exist yet when those checks run, so `channel` physically cannot be their source of truth. (The `is_test` §3.2-only branch this list used to include is gone — the field itself was removed 2026-10-05, see the header above.) A future AI-booking path sets its own `channel` value the same way §3.1/§3.2 do today — the caller always knows its own origin; the column just keeps the record.
13. **Marketing-outreach consent is captured once, at creation, never inferred or assumed.** Both public and staff creation accept two independent opt-in booleans (SMS, email), defaulting to `false`, immutable on the appointment row afterward (same "a booking's origin is a fact" principle as `channel`) — the CASL legal basis this creates lives with that specific booking. Propagating it onto the customer record is `customer-records-design.md`'s concern (§7 there), not this document's.
14. **`utm_source` is a free-text, unbounded companion to `channel` — captured once, at creation, immutable afterward (same posture as `channel`/consent).** `channel` (decision 12) stays purely code-path-derived and is never widened to carry marketing-attribution information — adding per-platform values to its CHECK constraint doesn't scale (social platforms are unbounded; a closed enum chasing them will always be one platform behind). Instead `utm_source` carries whatever value a public booking link's `?src=` query param held (`public-booking-end-to-end-design.md` §5) — `instagram`, `xiaohongshu`, `wechat`, or anything else a future campaign needs — stored verbatim, uninterpreted, `NULL` when the link carried none. This exists so a store can tell which social/marketing channel is actually converting (2026-10-02 decision) without this document ever branching on the value. Public-channel only, by deliberate choice, not just happenstance: §3.2 explicitly ignores any `utm_source` value a staff-create request happens to carry, regardless of input — not merely "nothing on that path ever sends one." The column itself carries no channel restriction; a future AI-booking path is free to set it if it ever has something equivalent to pass through.
15. **Non-empty `customer_notes` forces `pending` on the public channel only (2026-10-03, Part C).** Steven's workflow: a booking that comes with a note needs a human look before it takes effect — the store may need to call the customer, then confirms manually. At step 7 (`INSERT`), `status` is computed as `pending` whenever `channel = 'public_web'` **and** `customer_notes IS NOT NULL`, overriding `auto_confirm=true` for that one booking; every other `status`-determining rule (payment, `auto_confirm=false`) is unchanged and composes normally — this is one more condition that can force `pending`, not a replacement for the others. `expires_at = now() + booking_settings.pending_hold_minutes` as usual (decision 1) — the existing default (15 minutes) is tuned for payment-hold-style pending, not "we'll call you back" pending; a store that relies on notes should configure a longer hold (e.g. 24h). That's a per-store operational decision, not a new feature or a second hold-duration setting. Staff-manual bookings (§3.2) are never affected by this rule — the staff member is already talking to the customer, so there's nothing left to force a review of.

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
  "notes": "string | null",
  "sms_marketing_consent": false,
  "email_marketing_consent": false,
  "consent_text_version": "string | null",
  "consent_at": "2026-10-05T08:59:40 | null",
  "utm_source": "string | null"
}
```

- `items` has 1–5 entries (§7's validation enforces the range and rejects duplicates on this channel); a `price_type='from'` service must carry `option_id` (`OPTION_REQUIRED`, same as the slot engine). Multi-item baskets are promoted, public-facing V1 (sequential-only, merchant-ordered — `availability-slot-engine.md` §1/§9 item 3); parallel/simultaneous multi-staff bookings stay staff-manual, in-store only.
- `staff_id: null` means "any staff" (§5).
- `start` is store-local time and must land exactly on a currently-valid slot start (re-validated per §4).
- `sms_marketing_consent`/`email_marketing_consent`: **two independent booleans, two independent checkboxes** (2026-10-02 decision — a single checkbox covering both channels was rejected: CASL's burden of proof needs to show exactly what was agreed to per channel). Both default `false` if omitted — never inferred from anything else on the request. `email_marketing_consent` is only ever meaningful when `contact.email` was given; capturing it with no email present is accepted but inert. UI copy/placement is `public-booking-end-to-end-design.md` §3 Step 4's concern (two unchecked-by-default checkboxes, CASL copy pending legal review).
- `consent_text_version`/`consent_at`: set together whenever either consent boolean is `true` (the client's own record of which copy it displayed and when the box was checked) — a bare boolean is thin evidence for CASL's burden of proof; these two give an audit trail something to point to. `NULL`/`NULL` when neither consent box was checked.
- `utm_source`: whatever value, if any, the booking link's `?src=` query param carried (`public-booking-end-to-end-design.md` §5) — passed through verbatim, `NULL` when the link carried none (§1 decision 14). Not validated against any fixed list — this is intentionally a free-text passthrough, never an enum.
- `notes` (2026-10-03, Part C — wired up end to end; the column and this field already existed, always `null` until now): optional free text, max 500 characters, written to `appointments.customer_notes`. Server-side: trimmed; an empty or whitespace-only string is stored as `NULL`, not `""`; longer than 500 characters → `400`. On the **public channel only**, a non-empty value forces the created appointment to `pending` regardless of `auto_confirm` — see §1 decision 15 and §9 step 7.

```json
// response 201
{
  "id": "uuid",
  "reference_code": "K7QXM3P2",
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
  "expires_at": "2026-10-05T09:15:00 | null",
  "phone_upcoming_count": 3,
  "channel": "public_web"
}
```

- `expires_at` is set only when `status='pending'`.
- `reference_code`: 8-character uppercase alphanumeric, globally unique, the customer-facing booking number.
- `phone_upcoming_count`: the count §6.3's phone-cap check just computed for this booking's phone number, chain-wide, **including this new booking**. Returned only on this public endpoint (§3.1) — the staff endpoint (§3.2) never runs that check, so the field is always `null` there. This exists purely so the client can show a heads-up when the count reaches the cap without a separate, abusable lookup endpoint (`public-booking-end-to-end-design.md` §3).

### 3.2 Staff create (phone / walk-in / back-office entry)

`POST /api/store/appointments` — `StoreSession`, `storeId ∈ caller.AuthorizedStoreIds`.

Same body as §3.1, plus:
- ~~`is_test: bool` (default `false`) — the manual-booking test checkbox. The public endpoint always forces `false`.~~ — **removed 2026-10-05 (Steven, #18 superseded).** There is no test-booking checkbox in V1; it never existed as something the build executed — see the header above.
- `contact.customer_id` optional — resolved from the store's customer records; record lookup/dedup rules live elsewhere.
- `override_phone_block_reason: string | null` — only meaningful if the submitted phone is on this store's blocklist (§9 step 1.5); required to proceed past a hit, logged to the activity timeline. The UI presents this as a confirmation dialog ("this number is blocklisted — allow this one booking anyway?"), not a bare form field.

Differences from §3.1:
- The phone cap (§6.3) never runs here — only §3.1 (decision 10). A blocklist hit (§9 step 1.5) can be overridden here; it cannot on the public endpoint.
- `channel='staff_manual'` is set unconditionally — it records which code path created the row, same as every other `channel` value (decision 12).
- `sms_marketing_consent`/`email_marketing_consent` (and `consent_text_version`/`consent_at`) are accepted the same way as §3.1 — two independent booleans, default `false` — staff only check a box after asking the customer verbally; nothing here implies consent on the customer's behalf.
- `utm_source` is **ignored** on this endpoint — if a staff-create request includes it anyway, the value is discarded, not persisted; the column is always written as `NULL` here regardless of input. There's no URL `?src=` on a phone call or walk-in for the back office to pass through in the first place, so this is a deliberate discard, not an incidental one.
- `min_lead_minutes` is skipped — a staff member booking a walk-in shouldn't be blocked by a lead-time rule meant for self-serve customers. Business hours, schedule, and double-booking checks still apply unconditionally.
- Runs through the exact same transaction (§7) — no second code path. Any manual-entry route that bypasses quota or double-booking checks is a bug, not a feature.

### 3.3 Confirm / cancel / reschedule

| Method & path | Who | Notes |
|---|---|---|
| `POST /api/store/appointments/{id}/confirm` | `storeId ∈ AuthorizedStoreIds` | `pending → confirmed` — the manual-confirm path, for `auto_confirm=false` stores **and** for any booking forced to `pending` by non-empty `customer_notes` (§1 decision 15, Part C); after the staff calls the customer when needed |
| `POST /api/store/appointments/{id}/cancel` | same, or the appointment's own customer | §9 rules |
| `PATCH /api/store/appointments/{id}/reschedule` | same | §9 rules, in-place |

## 4. Slot re-validation (required at create time)

The slots a client saw are **never trusted**. On create, the server re-runs the slot engine's single-staff, single-day computation (`availability-slot-engine.md` §4 Steps 1–7, specified-staff mode) for the requested `(staff_id, start)`; `start` must land in the resulting set or the request fails `409 SLOT_TAKEN`.

- **Takes an optional `excludeAppointmentId` parameter, always supplied on reschedule (§10), never on create** (there's no existing row to exclude yet). Without it, a reschedule whose new time overlaps the appointment's *own current* occupied block would see itself as the conflict and reject a legitimate reschedule with `409 SLOT_TAKEN` — e.g. moving a 10:00–11:00 appointment to 10:30–11:30 overlaps the row being moved, not some other booking. The occupancy query (Step 5, `availability-slot-engine.md` §4) excludes this one `appointment.id` from its "existing occupied blocks" scan when the parameter is present.
- This computation includes unexpired `pending` occupancy, not just `confirmed` (the slot engine's shared occupancy criteria, `availability-slot-engine.md` §4).
- ~~`is_test` appointments occupy real staff time like any other, consistent with the engine.~~ — moot 2026-10-05: `is_test` no longer exists, so there's no special case to state here at all. Every appointment occupies real staff time — that was always just the engine's ordinary behavior, never an `is_test`-specific rule.
- **Capacity re-check**: in the same pass, re-run the store-level sweep for `(store_id, start)` (same criteria as Step 5b, store-wide, not per-staff). If the candidate block `[start - Bb, start + D + Ba]` falls inside a "full" interval, the request fails `409 CAPACITY_FULL` instead of `SLOT_TAKEN` — the two codes are kept distinct because the cause is different (a busy staff member vs. a full store) and the client UI reacts to them differently (`public-booking-end-to-end-design.md` §3). Stores with `booking_settings.capacity IS NULL` skip this check entirely.
- Passing re-validation doesn't guarantee the row: the actual guarantee comes from the exclusion constraint (staff dimension, §6.1) and the store-level advisory lock (capacity dimension, §6.2). A late conflict still surfaces as `409 SLOT_TAKEN` or `409 CAPACITY_FULL`.

## 5. "Any staff" assignment

When `staff_id` is `null`, the server takes the `staff_ids` list the re-validation pass computed for that `start` (already ordered by the slot engine's sort order) and picks the first entry, writing it to `appointments.staff_id`. The response returns who was actually assigned.

Two concurrent "any staff" requests can resolve to the same person — the exclusion constraint (§6.1) serializes them, and the loser gets `409 SLOT_TAKEN` (test case in §16).

## 6. Concurrency control

### 6.1 Per-staff double-booking: exclusion constraint

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Buffer-inclusive, not just the service span (2026-10-02 fix — see note below).
ALTER TABLE store.appointments
  ADD COLUMN occupied_range TSTZRANGE
    GENERATED ALWAYS AS (
      CASE WHEN status IN ('pending', 'confirmed')
           THEN tstzrange(
             starts_at - make_interval(mins => buffer_before_minutes),
             ends_at   + make_interval(mins => buffer_after_minutes)
           )
      END
    ) STORED;

ALTER TABLE store.appointments
  ADD CONSTRAINT no_double_booking
  EXCLUDE USING gist (staff_id WITH =, occupied_range WITH &&);
```

**This is the sole definition of `occupied_range` in this document** — §16's schema increment references it rather than restating it, to avoid exactly the kind of drift that caused the bug this fixes (below).

- Two rows for the same `staff_id` with overlapping occupied ranges cannot both exist — this is the system's actual, final defense against double-booking, independent of any application-layer lock.
- **`occupied_range` is buffer-inclusive, matching `availability-slot-engine.md` §4's stated occupied interval exactly — it must be, or this constraint silently stops being the "final defense" it claims to be.** An earlier version defined it as the bare service span (`tstzrange(starts_at, ends_at)`, no buffer). Under concurrent requests, two bookings whose *service* times don't overlap but whose *buffer* times do (customer A 10:00–11:00 with a 30-minute `buffer_after`, customer B booked 11:00–12:00, same staff) would both pass the bare-span constraint and both `INSERT` successfully — the staff member ends up double-booked from 11:00–11:30 even though the constraint "passed." Buffers come from the header's own snapshot (`buffer_before_minutes`/`buffer_after_minutes`, already present on this table, `store-onboarding-v1-design.md` §4) — this generated column now reads those same two columns, so it can never drift from what the engine itself promises is the real occupied interval.
- ~~`is_test` rows are bound by it too (they occupy real time).~~ — moot 2026-10-05: no `is_test` rows exist to call out separately; every row is bound by this constraint, with no exceptions of any kind.
- No application-level advisory lock is used for this dimension: a lock can be lost across a process crash or a second instance; a constraint cannot. §4's re-validation exists purely to give the user a clean, friendly `SLOT_TAKEN` before the constraint would have rejected the `INSERT` anyway.

### 6.2 Store-level capacity: advisory lock

An exclusion constraint can only express a **pairwise** invariant ("no two rows overlap") — it has no way to express a **counting** invariant ("no more than N concurrent rows store-wide"). That's a hard limitation of the mechanism, not a style choice, and it's the reason capacity needs a different tool while per-staff conflicts keep using the constraint above. When evaluating a future invariant, classify its shape first — pairwise gets a constraint, counting doesn't have a constraint-shaped equivalent — rather than deciding by which "dimension" (staff vs. store) it happens to live on.

```sql
SELECT pg_advisory_xact_lock(hashtext('groway:store_appt:' || store_id::text));
```

Taken as step 0a of the creation and reschedule transactions (§9) — right after the idempotency claim-or-replay at step 0, not before it (§9's note on why that order matters). This is **not** the kind of application lock ruled out in §6.1: that concern was about locks held in an app process's own memory (a C# `lock`, or a Redis lock without fencing) — state that dies with the process and desyncs across multiple instances. `pg_advisory_xact_lock` is a Postgres server-side lock bound to the transaction: it releases automatically on commit, rollback, or disconnect, and the lock table itself is shared by the database, not any one app instance — two different instances calling it for the same key are still serialized correctly. The two are not the same mechanism, and using this one doesn't reopen §6.1's decision.

Cost: one store's creates/reschedules serialize against each other; different stores don't interact. At v1 scale (single store, low concurrency) lock hold time is one transaction (milliseconds) — negligible.

### 6.3 Phone cap (anti-abuse): a second advisory lock, fixed acquisition order

Same counting shape as capacity (§6.2), same mechanism, different key — and public-channel only (decision 10). An off-by-one here is not a tolerable rounding error: the race it would let through (two concurrent requests both reading "4 upcoming" and both proceeding to 6) happens exactly when an attacker is hammering the endpoint concurrently, which is the one moment the cap actually matters.

```sql
SELECT pg_advisory_xact_lock(hashtext('phone_cap:' || chain_id::text || ':' || normalized_phone));
```

**Lock acquisition order is fixed and must never be reversed**: the capacity lock (§6.2, store-scoped) is always acquired first, at transaction step 0a; this lock is acquired second, at step 4.5 (§9), only on the public channel. PostgreSQL advisory locks don't prevent deadlocks between different keys on their own — that's purely an application discipline. With only two lock types in the system, pinning the order here (rather than leaving it to convention) is cheap insurance against a future third lock being added in the wrong relative order by a different code path.

**Count query** — chain-wide, reading **only `store.appointments`**, via the `normalized_contact_phone` snapshot column (§16):

```sql
SELECT COUNT(*)
FROM store.appointments a
JOIN store.stores s ON s.id = a.store_id
WHERE s.chain_id = :chain_id
  AND a.status IN ('pending', 'confirmed')
  AND a.normalized_contact_phone = :normalized_phone;
```

**No `JOIN store.customers`/`customer.customers` here, ever.** An earlier version of this query reached across into the Customer Module's schema (`LEFT JOIN customer.customers c ON c.id = a.customer_id`) to resolve a claimed booking's phone — a real violation of "extraction-ready, no cross-schema access" (`groway-v1-architecture.md` §5), even without a declared FK: the moment Store Module is ever pulled into its own service with its own database, a raw cross-schema `JOIN` simply can't run anymore, while an FK-less *reference* always could. `normalized_contact_phone` is the Store-local substitute: written once at creation (from `guest_phone`, or from the resolved customer's phone if `customer_id` was already known, §16), and kept current by `customer-records-design.md` §4.4's claim action updating this same column on the claimed row. Because the column is written directly (not joined at query time), the earlier `DISTINCT`-to-avoid-double-counting concern disappears too — there's exactly one phone value per row, so `COUNT(*)` is already correct; claiming a guest booking changes *which* phone that row claims to be, not *how many* rows match a given phone. Normalization reuses the existing E.164 convention (`customer-records-design.md` §2). A count `>= platform.abuse_config.max_upcoming_per_phone_per_chain` (default 5) fails the request with `409 PHONE_LIMIT` (§15); the count **including the new booking**, when it succeeds, is returned to the client as `phone_upcoming_count` (§3.1) rather than queried separately.

```sql
CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE platform.abuse_config (
  key        TEXT PRIMARY KEY,
  value_int  INT NOT NULL
);
INSERT INTO platform.abuse_config (key, value_int) VALUES
  ('max_upcoming_per_phone_per_chain', 5);
-- one global value, Groway-admin editable; no per-store/per-chain override UI in v1
```

## 7. Multi-service sequencing — the normative definition (`availability-slot-engine.md` §3 references this, doesn't restate it)

**Validation, before any sequencing math runs** (public channel only for the size limit; the rest applies to both channels, §3.1/§3.2):
- 2–5 items on the public endpoint (`400` outside that range); staff manual entry has no cap — same staff-exemption pattern as the phone cap (§1 decision 10) and `min_lead_minutes` (§3.2): a trained human assembling a legitimate large combo isn't the thing this limit exists to stop.
- No duplicate `service_id` in the basket (`400`).
- Every item's service belongs to `store_id` (already covered by step 1's per-item existence check — items are validated against the one requested `store_id`, so "all same store" falls out of that for free, not a separate check) and is bookable (`409 SERVICE_NOT_BOOKABLE`, naming the offending service).
- The assigned staff (resolved or specified, §5) is qualified for **every** item — the intersection of `staff_services` rows at `(staff_id, store_id)` across the whole basket, **and** the specified `staff_id` must have a **live schedule entry at this store** (2026-10-03, Batch 4 — "no entries here, no booking" replaces the old assignment-active check; there is no override, on any channel, for booking someone with no live presence at this store). A specified `staff_id` failing either the qualification check or the live-entry check → `409 STAFF_NOT_QUALIFIED`. This is the one validation in this section that only ever surfaces here, at create time — `availability-slot-engine.md`'s read-only slots query never throws it (an unqualified or absent-here specified staff there is a `404`, its own §2 item 5).

**Sequencing** — **items are re-sorted by `(sequence_order, service_name)` before this walk runs**, regardless of what order the caller's `items[]` array arrived in (`store-onboarding-v1-design.md` §7: the merchant's catalog order wins, Fresha parity; a customer adding services in any order ends up with the same execution order every time):

```
sortedItems = sortBy(items, (service.sequence_order, service.name))
cursor = start
for i, item in sortedItems:
    D_i  = option?.duration_minutes ?? service.duration_minutes
    Bb_i = service.buffer_before_minutes ?? store.buffer_before_minutes
    Ba_i = service.buffer_after_minutes  ?? store.buffer_after_minutes
    item.starts_at = cursor
    item.ends_at   = cursor + D_i
    cursor = item.ends_at + (max(Ba_i, Bb_{i+1}) if a next item exists)
header.starts_at = start
header.ends_at   = sortedItems.last.ends_at
header.buffer_before_minutes = Bb_first   # sortedItems[0]'s Bb
header.buffer_after_minutes  = Ba_last    # sortedItems[-1]'s Ba
D_total = header.ends_at - header.starts_at
```

- Each item snapshots `price_cents`, `service_name`, `option_name`, `duration_minutes` at creation, **in execution order** (`sortedItems`), not the order the request body listed them in.
- The full span, `[header.starts_at - Bb_first, header.ends_at + Ba_last]`, must fit inside the assigned staff's available time for the day — checked by §4's re-validation, which for a multi-item basket is exactly `D_total`/`Bb_first`/`Ba_last` handed to the same single-block algorithm (`availability-slot-engine.md` §3/§4 — no separate multi-service algorithm exists anywhere).
- Single-person, single-block: multiple services never split across staff.
- Quota, capacity, and the phone cap all count this as **one** appointment regardless of item count — one row, one quota unit, one capacity unit. A multi-service booking is strictly cheaper (quota-wise) than the old staff-manual workaround of two separate single-service appointments back to back.

## 8. Idempotency

- The public endpoint accepts `Idempotency-Key`; the staff endpoint requires it.
- Semantics: `(store_id, key)` within 24 hours — same key + same request-body hash returns the original `201` response (no second row created); same key + different body is `422 IDEMPOTENCY_KEY_REUSED`.
- **This promise is enforced by where the check runs, not just by the table existing.** An earlier version of this document had the idempotency row written at step 7 — *after* slot re-validation (step 4) — which meant a retry of a request whose first attempt already succeeded would see its own row occupying the slot and fail with `409 SLOT_TAKEN` before ever reaching the idempotency check, never reaching the replay this section promises. The fix (§9): claim-or-replay is step 0 itself, ahead of the advisory lock (now step 0a) and everything else, not a check tacked onto the end.

```sql
CREATE TABLE store.idempotency_keys (
  store_id        UUID NOT NULL REFERENCES store.stores(id),
  key             TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_hash    TEXT NOT NULL,
  response_status INT,              -- NULL while the original request is still in flight
  response_body   JSONB,            -- NULL while the original request is still in flight
  PRIMARY KEY (store_id, key)
);
-- periodic cleanup: created_at < now() - interval '24 hours'
```

`response_status`/`response_body` are nullable now (not `NOT NULL`) — a row can exist in a genuinely in-flight state, claimed but not yet resolved, which is exactly the state the claim-or-replay pattern below depends on being able to represent.

## 9. Transaction boundary (single DB transaction)

**Step 0 (if an `Idempotency-Key` was supplied) is a claim-or-replay, and it's the first thing this transaction does — before even the advisory lock.** An earlier version of this document ran the equivalent check at step 7 instead (§8 explains why that broke the replay promise: a retry would see its own already-created row and fail `SLOT_TAKEN` at step 4, never reaching step 7 to discover it should have replayed). It's inside the same `BEGIN`/`COMMIT` as everything else, deliberately — a rollback later in this same transaction rolls back this claim too, so a request that fails outright (e.g. `409 SLOT_TAKEN`) leaves no stale row behind for the next retry to trip over; only a request that reaches `COMMIT` leaves a resolved record.

```
BEGIN
  0. IF Idempotency-Key provided:
       WITH upsert AS (
         INSERT INTO store.idempotency_keys (store_id, key, request_hash, response_status, response_body)
         VALUES (:store_id, :key, :hash, NULL, NULL)
         ON CONFLICT (store_id, key) DO UPDATE SET store_id = store.idempotency_keys.store_id
           -- a no-op update, purely to force a row lock: if another in-flight
           -- request already claimed this key, this blocks until that other
           -- transaction commits or rolls back, then re-reads the outcome
         RETURNING request_hash, response_status, response_body
       )
       SELECT * FROM upsert;
       -- response_status IS NOT NULL  -> already resolved by an earlier attempt:
       --   request_hash matches  -> return that stored response verbatim, COMMIT, stop (no re-execution)
       --   request_hash differs  -> 422 IDEMPOTENCY_KEY_REUSED, COMMIT, stop
       -- response_status IS NULL -> freshly claimed (first attempt, or every
       --   prior attempt with this key rolled back entirely, taking its claim
       --   with it) -> continue to step 0a below
  0a. SELECT pg_advisory_xact_lock(hashtext('groway:store_appt:' || store_id::text));
     (unconditional — negligible overhead for a capacity=NULL store, no branch needed)
  1. Validate input: store/service/option/staff existence (cross-store → 404),
     items non-empty, 'from' requires option_id, start is well-formed.
  1.5. Blocklist check (both channels — §1 decision 11): SELECT 1 FROM
     store.phone_blocklist WHERE store_id = :store_id AND phone =
     normalize_phone(:contact_phone). Hit → 403 PHONE_BLOCKED, unless the
     staff endpoint (§3.2) passed override_phone_block_reason (non-empty) —
     then proceed, and write the override to the activity timeline (not the
     blocklist row itself, which stays untouched; the next booking from this
     number is blocked again).
  2. Resolve staff: use staff_id if given; otherwise §5.
  3. Compute duration/buffers/sequencing (§7) → starts_at/ends_at.
  4. Slot re-validation (§4, including capacity): fails → 409 SLOT_TAKEN or
     409 CAPACITY_FULL (rollback, no side effects).
  4.5. Public channel only (§3.1; skipped entirely for §3.2 staff create and
     for reschedule, §10): SELECT pg_advisory_xact_lock('phone_cap:...') (§6.3,
     always after the step-0a capacity lock) → COUNT → >= cap → 409 PHONE_LIMIT
     (rollback, no side effects, no quota touched). This runs before quota for
     the same reason step 4 does: don't charge quota for a request that was
     going to fail anyway.
  5. Quota: BillingQuotaService.TryConsumeAsync(storeId), same transaction,
     unconditionally for every appointment, no exceptions — failure → 409
     QUOTA_EXHAUSTED (rollback). (~~is_test=false → consume, is_test=true →
     skip~~ — removed 2026-10-05: no is_test branch exists anymore.)
  6. Generate reference_code (8 chars; unique-violation → retry).
  7. INSERT appointments (status from auto_confirm/payment_required, OR
     'pending' unconditionally when channel='public_web' AND customer_notes
     IS NOT NULL (§1 decision 15, Part C) — whichever condition fires, the
     result is 'pending'; pending (from any cause) sets expires_at = now() +
     pending_hold_minutes; occupies_capacity = OR across items' service.
     occupies_capacity; channel = 'public_web' or 'staff_manual' per the
     calling endpoint, §1 decision 12; sms/email_marketing_consent from the
     request, default false, consent_text_version/consent_at set together
     whenever either consent boolean is true, §1 decision 13;
     normalized_contact_phone = normalize_phone(contact.phone) — always the
     phone on the request, regardless of whether customer_id also resolved,
     §6.3; utm_source = the request's utm_source verbatim on §3.1, NULL when
     absent; forced NULL unconditionally on §3.2 regardless of request content
     (§1 decision 14) — never branched on, purely recorded; customer_notes =
     the request's notes, trimmed, empty string normalized to NULL, §3.1/§3.2;
     staff_specified = channel='public_web' AND request.staff_id IS NOT NULL,
     NEW 2026-10-03 #12 — unconditionally false on §3.2, regardless of whether
     a specific staff_id was passed there, since this signal is specifically
     about the CUSTOMER's own explicit choice, not any staff_id's mere
     presence on the request)
     + INSERT appointment_items (snapshots)
     + UPDATE idempotency_keys SET response_status=201, response_body=:body
       WHERE store_id=:store_id AND key=:key (if a key was supplied — the row
       was already claimed at step -1; this resolves it, it never inserts)
     + INSERT store.outbox (§11 event — carries customer_id when resolved,
       so a consumer can propagate consent onto the customer record,
       customer-records-design.md §7, without this transaction crossing
       into the Customer Module's schema itself)
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
- **Reschedule limit (NEW, 2026-10-03, Part D)**: on the **customer self-serve channel only**, `reschedule_seq >= booking_settings.max_reschedules` (default 3, `store-onboarding-v1-design.md` §4) → `409 RESCHEDULE_LIMIT_EXCEEDED`, copy: "This booking has been rescheduled {n} times — please call {store_phone} and we'll help you find a time." Checked **before** the §4 re-validation below (same "cheapest, most certain check first" ordering as every other guard in this section). The staff path is exempt, same convention as `cancel_threshold_hours` — a staff member rescheduling on the phone is human judgment, not abuse. The counter is a single, flat, **cross-channel** count: a staff-performed reschedule still increments `reschedule_seq` (it's the same occurrence counter the notification-dedup key depends on, §16), and a customer's later self-reschedule attempt is checked against that same cumulative count regardless of who performed the earlier ones. This is deliberate (Steven, 2026-10-03): the limit defends against operational churn — a booking being passed back and forth — not specifically "the customer being abusive," so it doesn't need a separate customer-only counter. Scope is per appointment row: a new booking always starts at `reschedule_seq = 0`.
- Re-runs the full §4 validation (including capacity) against the new `(staff, start)`, **passing this appointment's own id as `excludeAppointmentId`** (§4) — without it, a new time overlapping the appointment's own current block would be rejected as a conflict with itself — then §7's sequencing.
- Takes the same store-level advisory lock first (§6.2) — a reschedule and a new booking racing for the same slot are serialized by it exactly like two creates would be.
- No new row, so no additional quota charge.
- **On success, if the new `starts_at` is more than 24h/2h away from now, clear the matching `reminder_24h_sent_at`/`reminder_2h_sent_at`** (columns owned by `customer-booking-confirmation-reminders-design.md` §10) — otherwise the new time gets no reminder at all, since the old ones are already marked sent. `customer-booking-confirmation-reminders-design.md` §3 already states this as a requirement on this document's reschedule path; this is that requirement, written down here where the reschedule logic actually lives.
- **Also increment `appointments.reschedule_seq` by 1** (§16) — the occurrence discriminator `customer-booking-confirmation-reminders-design.md` §7's notification dedup key needs. Without it, a second reschedule's confirmation notification collides with the first reschedule's dedup key `(appointment_id, event_type='rescheduled', channel)` and is silently dropped — and the same collision would independently suppress a *second* round of reminders after the clearing above, since the dedup key doesn't otherwise know "this `reminder_24h` is for a different booking of the same slot than the one already logged."
- Customer self-reschedule is bound by `cancel_threshold_hours` too (it's logically a cancel-and-rebook); staff can reschedule any time.
- The exclusion constraint is sufficient concurrency protection for v1; a stronger optimistic lock (version column) is deferred (§18).
- Reschedule never runs the phone-cap check (§6.3/§9 step 4.5): it doesn't create a new row, so the phone's upcoming count is unchanged by it. It **does** still run the blocklist check (step 1.5) — a store that doesn't want this number shouldn't have it rescheduled into a new slot either.

**Terminal transitions:**
- `no_show`: staff-marked only.
- `completed`: sweeper, `UPDATE ... SET status='completed' WHERE status='confirmed' AND ends_at < now()`, idempotent; staff can also mark it early.
- `expired`: sweeper, `UPDATE ... SET status='expired' WHERE status='pending' AND expires_at < now()`, idempotent.

## 11. Nightly capacity audit — bidirectional (2026-10-03, Part E)

Store-level capacity correctness depends entirely on every creation/reschedule path remembering to take the advisory lock (§6.2) — unlike the staff dimension, there's no data-level backstop like the exclusion constraint. A future path that bypasses this transaction (a bulk import tool, a direct-`INSERT` script) could silently push concurrency past `capacity` with nothing noticing.

v1 accepts that risk but adds an after-the-fact audit, not a second real-time gate, and the sweep now runs **both directions**:

- **Backward sweep (unchanged):** re-sweeps the last 7 days of actual concurrency per store (reusing the same occupancy criteria as §4/Step 5b) and records any interval where it ever exceeded `capacity`, notifying that store's `chain_admin`. A past violation can only be investigated after the fact.
- **Forward sweep (NEW):** from `now()` to the store's `advance_booking_days` horizon, same occupancy criteria (unexpired `pending` + `confirmed`), flags any **future** interval where concurrency would exceed `capacity` if every currently-held booking in it actually happens, and notifies that store's `chain_admin`. Rationale (Steven's): a future violation can still be fixed — call customers, add capacity — while a past one can only be investigated. The detection logic already exists for the backward sweep; this only widens the window it runs against. Recorded in the same `capacity_breaches` table (below), distinguished by `window_start`/`window_end` falling in the future relative to `detected_at` — no new table, no new column.

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
| 409 | `STAFF_NOT_QUALIFIED` | Requested staff can't perform every service in the basket (§7) — create-time only, never thrown by `availability-slot-engine.md`'s read-only slots query |
| 409 | `QUOTA_EXHAUSTED` | Free-plan monthly quota exhausted (`groway-billing-workflow.md` §4.3 copy) |
| 409 | `CANCEL_TOO_LATE` | Customer cancel/reschedule inside `cancel_threshold_hours` |
| 409 | `RESCHEDULE_LIMIT_EXCEEDED` | Customer-channel reschedule with `reschedule_seq >= max_reschedules` (§10, Part D). Staff exempt. |
| 409 | `PHONE_LIMIT` | This phone already has `max_upcoming_per_phone_per_chain` upcoming bookings chain-wide (§6.3). Public channel only. Copy: "You've reached the limit of 5 upcoming bookings for this phone number — please call {store_phone} and we'll book you in right away." (the escape door matters — staff entry isn't subject to this cap, §1 decision 10) |
| 403 | `PHONE_BLOCKED` | This phone is on this store's blocklist (§9 step 1.5). Staff can override with a reason (§3.2); the public endpoint cannot |
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
  -- V1 groundwork for the V2/V3 AI layer (2026-10-02 ruling) - §1 decisions 12/13.
  ADD COLUMN channel VARCHAR(20) NOT NULL DEFAULT 'public_web'
    CHECK (channel IN ('public_web','staff_manual','ai_agent','ai_recall','ai_gapfill')),
    -- the three ai_* values have no V1 writer; reserved now so a future AI
    -- booking path needs no ALTER. Immutable after INSERT - reschedule/
    -- cancel/claim never touch it (a booking's origin is a fact).
  ADD COLUMN sms_marketing_consent   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN email_marketing_consent BOOLEAN NOT NULL DEFAULT FALSE,
    -- meaningful only when guest_email/the resolved customer has an email;
    -- the CASL basis for V3's AI recall SMS. Propagation onto customer.customers
    -- is customer-records-design.md §7's job, not this table's.
  ADD COLUMN consent_text_version TEXT,              -- §1 decision 13 — which copy the checkboxes showed
  ADD COLUMN consent_at           TIMESTAMPTZ,        -- when consent was captured, not just that it was
    -- a bare boolean is thin evidence for CASL's burden of proof ("what did
    -- they see, when did they click") — these two columns are the minimum
    -- that lets a future audit answer that. NULL/NULL when both consent
    -- booleans are false (nothing was agreed to, nothing to date-stamp).
  -- Phone-cap's count query (§6.3) must never cross into the Customer
  -- Module's schema (architecture doc §5; "extraction-ready" means no raw
  -- cross-schema JOIN, not just no FK). This snapshot is the Store-local
  -- substitute: written at creation (guest_phone, or the resolved
  -- customer's phone if customer_id was already known), kept current by
  -- customer-records-design.md §4.4's claim action. It is also, incidentally,
  -- an audit record of "what number did we actually count this against."
  ADD COLUMN normalized_contact_phone TEXT,
  -- Occurrence discriminator for notification dedup (2026-10-02 fix) -
  -- customer-booking-confirmation-reminders-design.md §7 uses this as part
  -- of notification_log's unique key, so a second reschedule's confirmation
  -- (or a second round of reminders after reschedule resets the sent-at
  -- flags) doesn't collide with the first and get silently ON CONFLICT
  -- DO NOTHING'd away.
  ADD COLUMN reschedule_seq INT NOT NULL DEFAULT 0,
  -- Free-text marketing attribution (2026-10-02 decision, §1 decision 14) -
  -- deliberately NOT an enum/CHECK: social platforms are unbounded, and a
  -- closed list chasing them will always be one platform behind. Carries
  -- whatever ?src= a public booking link held (public-booking-end-to-end-
  -- design.md §5); channel itself is untouched and stays purely code-path-
  -- derived (decision 12) - this column is the only attribution signal.
  ADD COLUMN utm_source TEXT,
  -- Most-requested-technician signal (NEW, 2026-10-03, #12/#20). TRUE only
  -- when a public-channel create carried an explicit customer-chosen
  -- staff_id (a Step-2 pick or a ?staff_id= deep link from the staff profile)
  -- - FALSE for "any available" (server-resolved) and for staff-manual
  -- bookings. Derived at INSERT from the request (staff_id IS NOT NULL on
  -- the public create, §3.1) - no client change needed, the information was
  -- already in the request, it just was never persisted before this. Read by
  -- staff-profile-design.md §5's chain-wide "most requested" stat - only
  -- status='completed' rows count there, this column just records the fact,
  -- it doesn't itself gate anything.
  ADD COLUMN staff_specified BOOLEAN NOT NULL DEFAULT false,
  ALTER COLUMN customer_id DROP NOT NULL;
  -- occupied_range and no_double_booking are defined once, in §6.1 — not restated here.

ALTER TABLE store.appointments DROP CONSTRAINT appointments_status_check;
ALTER TABLE store.appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('pending','confirmed','completed','cancelled','no_show','expired'));

-- after backfilling reference_code on existing rows:
ALTER TABLE store.appointments
  ADD CONSTRAINT uq_appointments_reference_code UNIQUE (reference_code);

CREATE INDEX idx_appointments_pending_expiry
  ON store.appointments (expires_at) WHERE status = 'pending';
CREATE INDEX idx_appointments_confirm_completion
  ON store.appointments (ends_at) WHERE status = 'confirmed';

ALTER TABLE store.booking_settings
  ADD COLUMN pending_hold_minutes INT NOT NULL DEFAULT 15 CHECK (pending_hold_minutes > 0);

-- Store-scoped blocklist (§1 decision 11, §9 step 1.5)
CREATE TABLE store.phone_blocklist (
  store_id    UUID NOT NULL REFERENCES store.stores(id),
  phone       TEXT NOT NULL,      -- normalized, same E.164 convention as customer-records-design.md §2
  reason      TEXT NOT NULL,
  created_by  UUID NOT NULL REFERENCES store.store_users(id),  -- store_admin+ only, see growayshop-registration-workflow.md §1
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, phone)
);
```

**`reference_code` generation (corrected, 2026-10-02): a true CSPRNG-backed base32 encoding, not `md5`.** The previous formula, `upper(substr(md5(gen_random_uuid()::text), 1, 8))`, is hex — only 16 distinct symbols — giving 16^8 (~4.3 billion) possibilities, not the 36^8 this document and `customer-my-bookings-design.md` (guest lookup's anti-enumeration argument) both claimed. The randomness source was never the problem (`gen_random_uuid()` is a real CSPRNG); the alphabet was too narrow for what was promised. Fix direction is the generator catching up to the documented promise, not the promise being quietly downgraded to match the code:

```sql
-- Base32 (RFC 4648 alphabet, no padding), 8 characters = 40 bits of entropy (32^8) —
-- every character drawn from a CSPRNG, not derived from a UUID's hex digest.
upper(encode(gen_random_bytes(5), 'base32'))
```

Collision handling needs a `SAVEPOINT`, not a bare retry-in-place: Postgres aborts the **entire** enclosing transaction on any error, including a `unique_violation` — without an explicit `SAVEPOINT` before the `INSERT` attempt, a collision would roll back everything already done in steps 0–6, not just the code generation. Pattern: `SAVEPOINT gen_ref; INSERT ...; -- on unique_violation: ROLLBACK TO SAVEPOINT gen_ref; regenerate; retry`.

`store.idempotency_keys` (§8), `store.outbox` (§12), `store.capacity_breaches` (§11), `store.phone_blocklist` (above), and `platform.abuse_config` (§6.3) are new tables, defined where introduced above.

**Note on `ALTER` vs. base schema**: this section is written as `ALTER` statements because that's the actual order these decisions landed in relative to `store-onboarding-v1-design.md`'s original `CREATE TABLE`. A genuinely fresh V1 deployment has no reason to replay that history — folding these columns directly into that document's base `CREATE TABLE store.appointments` is equally correct and arguably clearer. Written as `ALTER` here specifically so the sequence remains legible to anyone tracing *why* each column exists, not because a migration-by-migration deploy is required.

## 17. Test cases

Concurrency (must pass under real parallel load, not just sequential simulation):

1. Same staff, same `start`, two requests in the same millisecond → one `201`, one `409 SLOT_TAKEN`; one DB row.
2. `staff_id=null`, only one staff member free at that `start` → two concurrent requests, one `201` (assigned to that staff), one `409 SLOT_TAKEN`.
3. `pending` at its TTL boundary: confirm succeeds one second before `expires_at`; the sweeper run one second after flips it to `expired` and frees the slot for rebooking.
4. Same appointment, two concurrent reschedules → one succeeds, one `409 SLOT_TAKEN`.
5. Free-plan quota at the 99/100 boundary: two concurrent creates → exactly one `409 QUOTA_EXHAUSTED`, usage settles at 100.
6. Same `Idempotency-Key` sent twice, **the first call allowed to fully succeed and commit before the second is sent** (the regression case for the step-0-vs-step-7 bug): same `reference_code`, one DB row, second call returns the first response body as a `201` — **not** `409 SLOT_TAKEN` from colliding with its own first-attempt row.
7. `capacity=2`, two `confirmed` already in the window → a third, overlapping create → `409 CAPACITY_FULL`, no new row.
8. `capacity=1`, staff A and B both free: book A at 09:00 → succeeds; book B at 09:00 (B fully free) → `409 CAPACITY_FULL` (proves capacity is independent of staff availability).
9. Concurrent: `capacity=1`, two requests in the same millisecond for the same window, different staff → one `201`, one `409 CAPACITY_FULL`; one DB row.
10. `occupies_capacity=false` service: bookable even when the store's capacity is full for that window, and doesn't count toward concurrency.
11. `pending` expiry (sweeper or live `expires_at < now()` check) releases capacity for rebooking.
12. `capacity=NULL` store: Step 5b and the capacity re-check are both skipped; behavior matches pre-capacity baseline (regression).
13. Reschedule into a capacity-full window → `409 CAPACITY_FULL`, original appointment untouched.
14. Cancelling one appointment in a full window makes that window's slots reappear.
15. Public channel, same chain, phone already has 5 upcoming bookings → a 6th → `409 PHONE_LIMIT`, no new row; the staff endpoint (§3.2) for the same phone, same chain → `201` (channel-exempt, §1 decision 10).
16. Concurrent: two public requests for the same phone in the same millisecond, both reading "4 upcoming" → one `201` (returning `phone_upcoming_count: 5`), one `409 PHONE_LIMIT`; never both succeed.
17. Guest books 5 (public channel), gets claimed onto a customer record (`customer-records-design.md` §4.4, which updates `normalized_contact_phone` to the customer's number on the claimed row), then tries to book a 6th → `409 PHONE_LIMIT` — the claimed row still counts exactly once, against its new phone value, the same as any other row (§6.3's snapshot-column design has no `DISTINCT`/double-counting case left to guard against).
18. A blocklisted phone on the public endpoint → `403 PHONE_BLOCKED`, no override option offered. The same phone via staff entry with `override_phone_block_reason` set → `201`; without it → `403 PHONE_BLOCKED`. Either way, the blocklist row itself is untouched — the next booking attempt from that number is blocked again.
19. Basket of 2 services, added in reverse of the merchant's `sequence_order` → the created appointment's `appointment_items` are in merchant order regardless, and the slots that were offered already reflected the merchant-ordered block.
20. Staff qualified for only one of two basket services, submitted directly via `staff_id` → `409 STAFF_NOT_QUALIFIED`, no row created; the same staff member omitted (any-staff mode) with no one else qualified and free → empty result at the slots-query stage, not an error, and nothing to submit.
21. A 6-service public basket, or a basket with a duplicate `service_id` → `400`, rejected before any other validation runs. The same baskets via staff entry → no cap, proceeds normally.
22. Customer A books 10:00–11:00 with `buffer_after_minutes=30`; Customer B (same staff) books 11:00–12:00 — the service spans don't overlap, but the buffer-inclusive occupied ranges do. The second `INSERT` must be rejected by `no_double_booking` (§6.1) even though a bare service-time check would have let both through.
23. Reschedule an appointment to a new time that overlaps its own current block (e.g. 10:00–11:00 moved to 10:30–11:30) → succeeds; `excludeAppointmentId` (§4) must keep the row from being treated as a conflict with itself.
24. An `Idempotency-Key`'d request that fails outright (e.g. `409 SLOT_TAKEN` at step 1-4) → the whole transaction, including the step-0 idempotency claim, rolls back; retrying with the same key afterward is a genuinely fresh attempt, not a stuck "in-flight forever" row.
25. Phone-cap's count query (§6.3) never issues a query against `customer.customers` — verifiable by inspection of the generated SQL, not just by test data.
26. A public booking submitted with `utm_source: "instagram"` → the created row's `utm_source` is `"instagram"`, `channel` is still `public_web` (unaffected by decision 14). The same request with `utm_source` omitted → `utm_source` is `NULL`, everything else identical.
27. A staff-created booking (§3.2) → `utm_source` is always `NULL`, regardless of what (if anything) the back-office client sends in that field.
28. A public booking with `auto_confirm=true` and non-empty `notes` → created as `pending`, not `confirmed` (§1 decision 15); the same request with `notes` omitted or empty-string → `confirmed` as `auto_confirm` dictates. `notes` longer than 500 characters → `400`; a whitespace-only `notes` → stored as `NULL`, status unaffected by decision 15.
29. A staff-manual booking (§3.2) with non-empty `notes` → status follows `auto_confirm`/`payment_required` exactly as if `notes` were absent — decision 15 never applies on this channel.
30. Customer self-reschedule on an appointment with `reschedule_seq = max_reschedules` → `409 RESCHEDULE_LIMIT_EXCEEDED`, no change made. The same appointment rescheduled by staff → succeeds regardless of `reschedule_seq`, and still increments it. A customer self-reschedule immediately after that staff reschedule, now at `reschedule_seq = max_reschedules + 1` → still `409` (the limit was already exceeded before this attempt).
31. A new booking's `reschedule_seq` starts at `0`; `max_reschedules=0` for a store that wants to disable self-serve rescheduling entirely → a customer's very first self-reschedule attempt is already `409`.

## 18. Deferred

1. Guest self-serve cancel/reschedule by `reference_code` + phone — `customer-my-bookings-design.md`.
2. Strong optimistic locking (version column) for reschedule — v1 relies on the exclusion constraint.
3. Waitlist.
4. Repeated submissions under different `Idempotency-Key`s from the same abusive client — covered by IP/store rate limiting, no extra defense in v1.
5. Per-bed/room assignment, room types, equipment-based capacity — explicitly out of scope; staff can see which physical bed is free, no system assignment needed. Variable capacity by time-of-day, capacity pre-holds, and waitlist integration with capacity are also out of scope.
6. Same-phone/same-IP rate-based abuse detection (e.g. "N bookings in an hour") and OTP step-up for suspicious patterns — v1.1 and v2 respectively; the phone cap (§6.3) and blocklist (§9 step 1.5) are the only anti-abuse mechanisms in v1.
7. Per-store/per-chain override of `platform.abuse_config.max_upcoming_per_phone_per_chain` — v1 is one global value, Groway-admin editable only.
