# Staff Schedule & Availability Entry Workflow

**Architecture:** see `groway-v1-architecture.md`. Lives entirely inside the **Store Module**, `store` schema, `StoreSession` scheme, `/api/store/*`.

**Relationship to other documents:**
- `store-onboarding-v1-design.md` owns the tables this document fills in — `business_hours`, `staff_schedules` (`staff_id` + `store_id` keyed, `deleted_at` for soft-delete), `staff_time_offs` (person-level, `staff_id`) — and the account/role model (`chain_admin`/`store_admin`/`staff`) this document's permissions are built on. `store.staff.chain_id` is the employment contract (2026-10-03, Batch 4) — there is no `staff_store_assignments` table; it has been dropped entirely.
- `availability-slot-engine.md` is the consumer: everything entered here is exactly what `GET /api/store/public/slots` reads.
- `growayshop-staff-invite-workflow.md`: "adding a person to a store" (that document's add-to-store flow) is what creates this person's first `staff_services` row and initial schedule entries at that store — this document starts *after* that, and also owns every subsequent edit to the same timetable.

**Scope:** who can fill/edit business hours, weekly staff schedules, and time off; when in the onboarding sequence each happens; validation rules (including conflicts with already-booked future appointments); the derived "can this store actually be booked" condition. Not in scope: the slot-computation algorithm itself (`availability-slot-engine.md`) or appointment creation (`create-appointment-transaction-design.md`).

---

## 0. The chain owns one timetable (2026-10-03, Batch 4 principle)

**A staff member contracts with the chain, never with a store.** A store is like a room in the shop — nobody signs a contract with a room. Consequently `staff_schedules` is not a per-store table and not a per-person table in any structural sense: **the chain owns exactly one timetable — the set of every schedule entry of every one of its staff.** A store's view ("who works here, and when") and a person's view ("my week") are both just filtered reads over that one timetable (`WHERE store_id = :x` / `WHERE staff_id = :y`) — never separate tables, never a per-store copy or cache that could drift from it. Every rule below is a consequence of this, not an exception to it:

- There is no per-store employment state anywhere — no per-store status, no per-store membership table, no per-store contract. The contract (`store.staff.chain_id`) is chain-level; the timetable is the only place "where does this person work" lives, and it lives chain-wide.
- "Staff A won't work at store B anymore" means exactly one thing: **A's timetable no longer has live entries tagged `store_id = B`.** There is no separate "deactivation" concept, no status flag, no dedicated endpoint for this — it is an ordinary edit to the timetable, made through the same store-scoped `PUT` as any other schedule change (§4). Removed entries are soft-deleted (`deleted_at` set), kept as history, and never read by anything live.
- "Works at store B" is **derived**, never stored: ⟺ the person has ≥1 live (`deleted_at IS NULL`) schedule entry tagged `store_id = B`. Re-adding time blocks at B through the same `PUT` is reinstatement — there is nothing else to "turn back on."

## 1. Who fills what

| Data | Table | Scoped to | Who fills it | Who can edit it |
|---|---|---|---|---|
| Store business hours | `business_hours` | Store | `store_admin` (a step in the store-creation flow) | `store_admin` of that store, `chain_admin` of that chain |
| Weekly schedule template | `staff_schedules` | The chain's one timetable; each entry tagged with the store it belongs to (§0) | `store_admin` (or `chain_admin`) on the staff member's behalf — no staff self-service in V1 (2026-10-03) | `store_admin`/`chain_admin`, store-scoped per the entries' `store_id` even though the underlying table is chain-wide |
| Time off / exceptions | `staff_time_offs` | Person (`staff_id`), chain-wide | `store_admin` (or `chain_admin`) on the staff member's behalf — no staff self-service in V1 (2026-10-03) | `store_admin`/`chain_admin` |

Authorization is uniformly **`storeId ∈ caller.AuthorizedStoreIds`** (`store-onboarding-v1-design.md` §6), with one wrinkle for the person-level time-off endpoints, which carry no `storeId` at all:

**Time-off authorization (chain-membership test, revised 2026-10-04):** a caller may act on `staffId`'s time off ⟺ **the caller is `store_admin`/`chain_admin` (never `staff` — the blanket `403` below) and `staffId` belongs to the same chain as the caller** — `staff.chain_id = caller's chain`, the caller's chain resolved exactly as `growayshop-registration-workflow.md` §2.1 already does elsewhere (`store.chains.chain_admin_id` lookup for a `chain_admin` caller; via the caller's own store's `chain_id` for a `store_admin` caller). This replaces the earlier store-level "has some association with a store I'm authorized on" test (checking for a live schedule entry or a `staff_services` row at an authorized store) — that test was store-scoped while time off's effect is chain-wide (below), so the permission check and the effect it gates were measuring different things. Aligning both to chain scope removes the mismatch rather than papering over it.

```sql
staff.chain_id = :callerChainId
```

**By design (2026-10-04), not a side effect:** because time off's effect is already chain-wide, so is the permission to grant it — a `store_admin` at Store A can grant/edit time off for a staff member who *also* works at Store B, and that time off blocks them at Store B too, the same as at Store A. There is no "only affects Store A" option in V1 (requesting one is a real, expected ask once a chain runs multiple stores with overlapping staff — a V2 "store-scoped exception" feature, not designed here). A chain-admin-visible "this affects other stores too" notice remains the only mitigation, not a hard restriction — acceptable for V1 given the initial pilot is single-store-dominant.

**`staff`-role callers get `403 FORBIDDEN` on every endpoint in this document in V1** (`business_hours`, weekly schedules, time off) — staff do not touch the system at all (2026-10-03). This is defense-in-depth, since no staff login interface exists in V1 to call these endpoints with in the first place; the V2 staff portal is a separate, later project and nothing here is designed to anticipate it.

---

## 2. When this happens (onboarding sequence)

### 2.1 Store level: one step in store creation

```
Create store → fill business hours (7 rows, NULL = closed) → create services → invite staff
```

Order matters: the "default inherit" step (§3.3) when a person is later added to the store needs business hours to already exist.

### 2.2 Adding a person to a store: an admin checklist, not a staff onboarding flow

Once an admin adds a person to a store (`growayshop-staff-invite-workflow.md`'s add-to-store flow — creates a `staff_services` row at that store, and this is where the admin does the following, all on the person's behalf, per principle #1):

1. **Enter the schedule for this store** — the system has already copied the store's business hours in as entries tagged with this store (§3.3), as a starting point the admin only needs to edit where it differs. This is additive to the person's one existing timetable (§0), never a fresh "set up a schedule from scratch" step once they have entries anywhere — adding a second store just means adding more B-tagged entries to the same timetable.
2. **Assign which services they can perform at this store** (`staff_services`, keyed on `(staff_id, store_id)` — `store-onboarding-v1-design.md` §7.5).
3. Optional: pre-fill time off (person-level, chain-wide).

Skills and schedule are handled independently per store: `staff_services` is a genuine store-level fact (a second store always needs its own service assignment, and `store-onboarding-v1-design.md` §8's catalog-copy feature has nothing to do with it), while the schedule is just more entries on the one chain timetable that already exists — there's nothing to "copy over," since there's only ever one table. `staff-schedule-entry-workflow.md` §3.5 (copying another *person's* entries at the same store onto this one) is a separate, deliberate convenience feature at this scope — don't conflate it with `store-onboarding-v1-design.md` §8's unrelated service-catalog copy between stores.

### 2.3 Store go-live threshold (derived, not stored)

A store is **operationally ready** ⟺ all of:
- `business_hours` has all 7 days filled in (open or explicitly closed);
- ≥ 1 staff member is "bookable" there (§6);
- ≥ 1 service is "bookable" (`store-onboarding-v1-design.md` §7.6).

This is separate from `store.stores.status` (`store-onboarding-v1-design.md` §2) — see that document for how the two compose: `status='active'` is a manual business decision, this readiness condition is a live fact, and a store only accepts real bookings when both are true.

---

## 3. Entry UX

### 3.1 Business hours editor

Seven rows, one per day: `open–close` (`HH:mm`) or "closed" (= both `NULL`). Submitting is a **full replace of all 7 rows** (`PUT`, idempotent).

### 3.2 Weekly schedule editor (a person, at one store)

Seven days, each with zero or more shift-segment rows (though V1's own `business_hours` never has more than one segment — this editor's shape stays general for the staff-schedule case, which genuinely can have gaps within a day even though the store's own hours don't split). An empty day shows as "off." Submitting is a **full replace of this person's entries at this one store only** (2026-10-02, Batch 2 Change 2 — `staff_schedules` is person-level now, but each store-scoped `PUT` still only touches that store's slice of the person's timetable; their entries at any other store are untouched by this call). Same-day rows overlapping **at this store** → the client should flag it, and the server rejects with `400 SCHEDULE_OVERLAP`; the same check also runs **across every store** this person works, since the underlying rule is per-person, not per-store (§5.1).

### 3.3 Default inheritance and "reset to store hours"

At the moment an admin adds a person to a store (§2.2), the system materializes the store's current `business_hours` into that person's `staff_schedules`, as entries tagged with that store's `store_id` (a copy, not a live reference — the store changing its hours later never silently rewrites anyone's existing schedule; it only adds to the person's one timetable, never touches their entries at any other store). "Reset to store hours" on the schedule editor re-runs the same copy on demand, going through the same `PUT` and the same conflict check (§5.2). The store admin sees a passive notice when store hours change ("N staff schedules no longer match the new hours") — nothing is auto-updated; each is handled individually if the admin chooses to. Both this materialization and "reset to store hours" write `staff_schedules` rows for a `staff_id` and so must hold the advisory lock described in §5.1 before writing, same as every other writer of this table.

### 3.4 Time off (person-level)

Entered as a start/end datetime pair (store-local time in the UI, stored as UTC). Shortcuts: "one day" fills `00:00`–`23:59:59` that date; "several days" is several rows. The UI states plainly that time off blocks every store the person works at (§1). `reason` is optional, with quick-pick categories (vacation/sick/personal/other) plus free text. Removing time off is a plain `DELETE` — V1 has no approval workflow.

**Required "offline-coordination confirmed" checkbox (NEW, 2026-10-04).** The entry form has a mandatory checkbox, unchecked by default: "Offline-coordination confirmed." Submitting with it unchecked is blocked client-side, and the server independently rejects it too — `400 OFFLINE_CONFIRM_REQUIRED` if `offlineConfirmed` is missing or not `true` on `POST /staff/{staffId}/time-offs` (§4) — the client-side block is a convenience, the server check is the actual guard, same posture as `SCHEDULE_CONFLICT`/`SCHEDULE_OVERLAP` elsewhere in this document (an API caller can skip the UI; only the server can actually stop them). A line of microcopy next to the checkbox states the reason plainly: "This system only records time off — please coordinate the actual arrangement with the other staff member first." This is not an approval step (the "V1 has no approval workflow" sentence above still holds) — it's confirmation that the human coordination already happened, not a request for someone else's sign-off.

### 3.5 Copying a schedule between staff (same store only)

`POST /stores/{storeId}/staff/{staffId}/schedule/copy` with `{ fromStaffId }` copies another person's entries **at this one store** onto the target person's own entries at that same store (full overwrite of just that store's slice of the target's timetable — their entries at any other store are untouched). Cross-store copy is rejected (`400`): the call always compares `fromStaffId` and `staffId` at the *same* `storeId` named in the path. Comparing two different people's hours only makes sense within one shared store context — "Jordan's Tuesday at the King West location" and "Anna's Tuesday at Yorkville" aren't hours anyone would ever want copied onto each other. This write holds the same advisory lock as every other `staff_schedules` writer (§5.1), keyed on the **target** `staffId`, and its result is still subject to the person-level overlap check against the rest of the target's timetable.

This is a different feature at a different scope from `store-onboarding-v1-design.md` §8 (copying the *service catalog* between stores when opening a new one) — don't conflate the two "copy" actions.

---

## 4. API (`StoreSession`, base `/api/store`; paths below omit that prefix for readability)

### Store-level (hours, schedules)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/stores/{storeId}/business-hours` | All 7 days, including closed ones |
| `PUT` | `/stores/{storeId}/business-hours` | Full replace of 7 days; supports `?dry_run=true` |
| `GET` | `/stores/{storeId}/staff/{staffId}/schedule` | This person's live entries tagged with this store (a filtered slice of the chain's one timetable, §0). **`200` with an empty array if the person exists in this chain but has no entries here yet** (e.g. just added, services set but schedule not entered — §2.2) — this is a normal, expected state, not an error. `404` only if `staffId` doesn't resolve to a person in the caller's chain at all. |
| `PUT` | `/stores/{storeId}/staff/{staffId}/schedule` | Full replace of this person's entries at this store only (§3.2), **upsert-with-restore semantics** (2026-10-03, Batch 4): an entry in the request body whose `id` matches an existing soft-deleted row undeletes it (`deleted_at=NULL`); a request entry with no matching `id` inserts a new row; a currently-live entry at this store absent from the request body is soft-deleted (`deleted_at=now()`), never hard-deleted. Supports `?dry_run=true`; holds the advisory lock (§5.1) before writing. |
| `DELETE` | `/stores/{storeId}/staff/{staffId}/schedule` | Convenience sibling of the `PUT` above, for the common "this person no longer works here" case — soft-deletes every currently-live entry this person has at this store in one call. Exactly equivalent to `PUT` with an empty body; this just names the common case plainly. Subject to the same `409 SCHEDULE_CONFLICT` check (§5.2) and the same advisory lock. |
| `POST` | `/stores/{storeId}/staff/{staffId}/schedule/copy` | `{ fromStaffId }` — same store only (§3.5); holds the advisory lock keyed on the target `staffId` |
| `POST` | `/stores/{storeId}/staff/{staffId}/schedule/reset-to-store-hours` | Re-copies current business hours onto this person's entries at this store (§3.3); holds the advisory lock |

### Person-level (time off)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/staff/{staffId}/time-offs?from=&to=` | Filtered by a UTC range |
| `POST` | `/staff/{staffId}/time-offs` | `{ startsAt, endsAt, reason?, offlineConfirmed }` (store-local ISO in the request; server converts to UTC); `offlineConfirmed` must be `true` or `400 OFFLINE_CONFIRM_REQUIRED` (§3.4, NEW 2026-10-04) |
| `DELETE` | `/staff/{staffId}/time-offs/{timeOffId}` | Remove |

Every store-level `PUT`/`POST`/`DELETE` that would leave a **future, `pending` or `confirmed`** appointment's occupied block no longer fully inside the updated available time returns `409 SCHEDULE_CONFLICT` (§5.2) unless called with `?confirm=true`. `?dry_run=true` runs the same conflict check without writing anything.

---

## 5. Validation rules

### 5.1 Time validity

- **Schedules:** `start_time < end_time`; same-day rows must not overlap (`400 SCHEDULE_OVERLAP`) — **checked per person, not per store**: for a given `staff_id` and `day_of_week`, no two **live** (`deleted_at IS NULL`) `staff_schedules` rows may overlap regardless of which `store_id` they're tagged with. Soft-deleted rows are invisible to this check entirely — they're history, not data. One timetable means a person can't be in two places at once; rejecting this at write time is what lets the slot engine skip any special cross-store handling entirely. V1 doesn't support an overnight shift (e.g. 22:00–02:00).

  **Advisory lock, not a DB exclusion constraint.** The same person's entries at different stores are written through independent, store-scoped endpoints (§4) — two concurrent writes (one per store) could each pass the overlap check above against a snapshot that doesn't yet include the other's in-flight write, and both commit a genuinely overlapping timetable. A `gist` exclusion constraint on `(staff_id, day_of_week, time-range)` would close this at the DB level but is heavier than this admin-only, near-zero-contention write path warrants (no native `TIME`-range type; a composite `gist` index to build and maintain for it, and it would need to exclude soft-deleted rows via a partial index). Instead: **any transaction that `INSERT`s, `UPDATE`s, or `DELETE`s `staff_schedules` rows for a given `staff_id` — including soft-deletes and un-deletes — must hold `pg_advisory_xact_lock(hashtext('staff_schedule:' || staff_id))` before doing so** — the same pattern already used for the idempotency-claim fix (`create-appointment-transaction-design.md` §9 step 0). Concurrent writers serialize; the second one to acquire the lock sees the first's already-committed rows and gets a correct `400 SCHEDULE_OVERLAP` instead of racing past it. This is a blanket rule stated once, not an enumerated endpoint list that can go stale — it covers both schedule `PUT`/`DELETE` endpoints (§4), `POST .../schedule/reset-to-store-hours` (§3.3), the add-to-store schedule materialization (§3.3), and `POST .../schedule/copy` (§3.5); any future writer of this table follows the same rule.
- **Business hours:** both times `NULL` or both set (`chk_business_hours_null`, `store-onboarding-v1-design.md` §4); non-closed days need `close_time > open_time`.
- **Time off:** `ends_at > starts_at` (`chk_time_off_range`); `starts_at` can't be in the past (`400 DATE_IN_PAST`); overlapping ranges for the same person are rejected DB-side (`409 TIME_OFF_OVERLAP`, the `EXCLUDE USING gist` constraint) — a full-day entry and a same-day partial entry conflict too (the full day already covers it; the partial entry is redundant input, correctly rejected).

### 5.2 Conflict with existing future appointments — also the timetable-edit guard (2026-10-03, Batch 4)

**Definition:** a schedule/hours/time-off change conflicts if it would leave any appointment with `status IN ('pending', 'confirmed')` and `starts_at` in the future whose occupied block (`[starts_at - buffer_before_minutes, ends_at + buffer_after_minutes]`, the snapshot on the appointment itself — `store-onboarding-v1-design.md` §4) no longer entirely inside the *updated* available time (2026-10-03 widening — `pending` is included, not just `confirmed`: a pending booking already occupies the slot and the customer already has an expectation; stranding it needs the same human look as a confirmed one). Since `appointments.staff_id` is person-level, a time-off conflict check must cover that person's future appointments **at every store**, not just the one being edited.

**This is the mechanism that protects "removing a person's entries at a store"** — there is no separate "deactivation" check (§0): soft-deleting someone's live entries at store B is an ordinary `PUT`/`DELETE` against this same guard. If B has a future pending/confirmed appointment with this person, the edit is rejected here, the same as any other schedule change that would strand one — not because something special is being "deactivated," but because this edit, like any other, can't leave a booked customer stranded without a human looking at it first.

**Handling:** `409 {error: SCHEDULE_CONFLICT, conflicts: [...]}` — collects **every** affected appointment in one response (not fail-fast on the first one found), same philosophy as the chain-wide bulk operations elsewhere in this project; the UI lists them all, and the caller either resolves them out-of-band and retries with `?confirm=true` (the system never auto-cancels or auto-reschedules anything — a human contacts the customer), or abandons the change. An edit that only *extends* availability (more hours, fewer restrictions) can never conflict and always writes straight through.

---

## 6. "Bookable" (a person, at a store) — derived, not stored

A person is considered by the slot engine at a given store ⟺ **both**:
1. They have ≥ 1 **live** (`deleted_at IS NULL`) `staff_schedules` entry tagged with that `store_id` (2026-10-03, Batch 4 — there is no assignment-status leg anymore; "works here at all" and "is active here" collapsed into the same fact, since a removed relationship simply has no live entries left);
2. They have ≥ 1 `staff_services` row at `(staff_id, store_id)` (can perform at least one service there).

Failing either keeps them out of `GET /slots` entirely at that store. The back office distinguishes two states for a person who's been added to a store but isn't bookable there yet (2026-10-03, Batch 4 — resolves the "just added, not yet bookable" gap): **"待设置" (set up pending)** — a `staff_services` row exists at that store but zero live schedule entries yet, shown with a nudge straight to the schedule editor; versus bookable, once both conditions hold. Neither state is a stored flag — both are read live off the same two tables.

---

## 7. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `SCHEDULE_OVERLAP` | 400 | Same-day schedule segments overlap |
| `HOURS_INVALID` | 400 | Business hours half-`NULL`, or `close <= open` |
| `TIME_OFF_OVERLAP` | 409 | Overlapping time-off range (DB exclusion constraint) |
| `SCHEDULE_CONFLICT` | 409 | Change would strand a future pending or confirmed appointment — collects every affected appointment, not just the first (retry with `?confirm=true`) |
| `DATE_IN_PAST` | 400 | Time-off start is in the past |
| `OFFLINE_CONFIRM_REQUIRED` | 400 | Time-off entry submitted without the offline-coordination checkbox (§3.4, NEW 2026-10-04) |
| `FORBIDDEN` | 403 | `staff`-role caller on any endpoint in this document (V1: admin-only entry, 2026-10-03) |
| *(cross-store / person not in chain)* | 404 | Standard out-of-scope-resource convention — never confirms existence. Note: zero schedule entries at an otherwise-valid store is **not** this — that's a `200` empty array (§4) |

---

## 8. Explicitly not in V1

- **Staff self-service, in any form** (2026-10-03) — no staff login interface exists; every endpoint in this document is `store_admin`/`chain_admin` only, with `staff`-role callers getting a blanket `403`. The V2 staff portal is a separate, later project.
- Time-off approval workflows; recurring time off (e.g. "every Wednesday afternoon off") — express as multiple dated rows instead.
- Overnight shifts (e.g. 22:00–02:00) / split (multi-segment) store business hours. Staff `staff_schedules` rows may still be multiple non-overlapping segments per day — lunch gaps are supported (§3.2); only the store's own `business_hours` is single-segment in V1. Why: the schedule model is keyed on `day_of_week`, so a cross-midnight shift has no clean day attribution, and this is a spa booking system — overnight shifts are YAGNI. The slot engine already operates on interval sets, so split business hours later is a UI + constraint change, not an engine change.
- Store-scoped time-off exceptions (§1's "by design" box) — time off is chain-wide-per-person in V1.
- A bulk "clear this person's entire chain-wide timetable in one call" endpoint — "leaving the company" is handled per store via the existing `PUT`/`DELETE` (§4), one call per store that still has entries. If this proves painful in practice, a bulk-clear endpoint can be added later.
- Automatic customer notification when a schedule change affects them — that's the reminder pipeline's concern, not this document's.
- Work-hours reporting / time-clock — a schedule here is "bookable availability," not an attendance record.

---

## 9. Open questions

1. Exactly how `?confirm=true` interacts with a chain-wide time-off side effect spanning many future appointments across several stores at once isn't worked through in detail — the mechanism (§5.2) generalizes, but the UX for "this affects 12 appointments across 2 stores" hasn't been designed.
2. Everything `store-onboarding-v1-design.md` and `availability-slot-engine.md` already leave open (multi-service sequencing, `auto_confirm=false`/pending status, ~~`is_test` occupancy~~ — moot 2026-10-05, `is_test` removed entirely) is inherited here unresolved, since this document assumes an appointment-creation mechanism that doesn't exist yet.
