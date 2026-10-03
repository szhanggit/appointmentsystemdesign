# Staff Schedule & Availability Entry Workflow

**Architecture:** see `groway-v1-architecture.md`. Lives entirely inside the **Store Module**, `store` schema, `StoreSession` scheme, `/api/store/*`.

**Relationship to other documents:**
- `store-onboarding-v1-design.md` owns the tables this document fills in — `business_hours`, `staff_schedules` (2026-10-02, Batch 2 Change 2: **person-level**, keyed on `staff_id` + `store_id`, one timetable per person tagged per store — no longer keyed on `staff_store_assignment_id`), `staff_time_offs` (person-level, `staff_id`) — and the account/role model (`chain_admin`/`store_admin`/`staff`) this document's permissions are built on.
- `availability-slot-engine.md` is the consumer: everything entered here is exactly what `GET /api/store/public/slots` reads.
- `growayshop-staff-invite-workflow.md`: a `staff_store_assignments` row already exists by the time any of this runs — this document starts *after* that.

**Scope:** who can fill/edit business hours, weekly staff schedules, and time off; when in the onboarding sequence each happens; validation rules (including conflicts with already-booked future appointments); the derived "can this store actually be booked" condition. Not in scope: the slot-computation algorithm itself (`availability-slot-engine.md`) or appointment creation (a future, not-yet-written document).

---

## 1. Who fills what

| Data | Table | Scoped to | Who fills it | Who can edit it |
|---|---|---|---|---|
| Store business hours | `business_hours` | Store | `store_admin` (a step in the store-creation flow) | `store_admin` of that store, `chain_admin` of that chain |
| Weekly schedule template | `staff_schedules` | Person, each entry tagged with its own store (2026-10-02: one timetable per person, not per assignment — Change 2) | The staff member themself (preferred), or `store_admin` on their behalf, per store | The staff member (only their own, at that store), `store_admin`/`chain_admin` (any assignment at a store they're authorized on) — writes are still store-scoped even though the table is person-level |
| Time off / exceptions | `staff_time_offs` | Person (`staff_id`) | The staff member themself (preferred), or `store_admin` on their behalf | The staff member (only their own), `store_admin`/`chain_admin` |

Authorization is uniformly **`storeId ∈ caller.AuthorizedStoreIds`** (`store-onboarding-v1-design.md` §6), with one wrinkle for the person-level time-off endpoints, which carry no `storeId` at all:

**Time-off authorization**: a caller may act on `staffId`'s time off ⟺ **(`staffId` is the caller themself) OR (`staffId` has at least one `staff_store_assignments` row whose `store_id ∈ caller.AuthorizedStoreIds`)**.

```sql
EXISTS (
    SELECT 1 FROM store.staff_store_assignments
    WHERE staff_id = :targetStaffId AND store_id = ANY(:callerAuthorizedStoreIds)
)
```

**Known V1 side effect, not a bug:** because time off is person-level, a `store_admin` at Store A can grant/edit time off for a staff member who *also* works at Store B — and that time off blocks them at Store B too. There is no "only affects Store A" option in V1 (requesting one is a real, expected ask once a chain runs multiple stores with overlapping staff — a V2 "store-scoped exception" feature, not designed here). Acceptable for V1 given the initial pilot is single-store-dominant; a chain-admin-visible "this affects other stores too" notice is the only mitigation, not a hard restriction.

`staff` cannot touch `business_hours` at all (`403 FORBIDDEN`) — only their own schedule and time off.

---

## 2. When this happens (onboarding sequence)

### 2.1 Store level: one step in store creation

```
Create store → fill business hours (7 rows, NULL = closed) → create services → invite staff
```

Order matters: an assignment's "default inherit" step (§3.3) needs business hours to already exist.

### 2.2 Staff level: a per-assignment checklist, plus one per-person item

Once a person is added to a store (`staff_store_assignments` row created, `growayshop-staff-invite-workflow.md`):

1. **Confirm the schedule includes this store** — the system has already copied the store's business hours in as entries tagged with this store (§3.3); the person only edits the days that differ. Accepting everything as-is just means clicking "confirm." (2026-10-02, Batch 2 Change 2: this item moved from a *per-assignment* checklist item to touching the person's one, already-existing timetable — it's additive, not a fresh "set up your schedule from scratch" step, once they have a first store. See the correction below.)
2. **Assign which services they can perform at this store** (`staff_services`, keyed on the assignment — already designed in `store-onboarding-v1-design.md` §7.5).
3. Optional: pre-fill time off (person-level).

**Correction (2026-10-02, Batch 2 Change 2):** the sentence this section used to carry — "schedule and skills are both store-level facts that don't carry over automatically" — is now only half true. **Skills stay store-level** (`staff_services`, unchanged, item 2 above): the same person joining a second store still repeats that part of the checklist independently, and `store-onboarding-v1-design.md` §8's catalog-copy feature has nothing to do with it. **The weekly schedule is now person-level** (`staff_schedules`, Change 2): there's no "copying it over" when someone joins a second store, because there's only ever one timetable — joining store B just means adding B-tagged entries to the timetable that already exists, confirmed in item 1. `staff-schedule-entry-workflow.md` §3.5 (copying another *person's* template at the same store) is the one surviving "copy" feature at this scope — don't conflate it with `store-onboarding-v1-design.md` §8's unrelated service-catalog copy between stores.

### 2.3 Store go-live threshold (derived, not stored)

A store is **operationally ready** ⟺ all of:
- `business_hours` has all 7 days filled in (open or explicitly closed);
- ≥ 1 assignment is "bookable" (§6);
- ≥ 1 service is "bookable" (`store-onboarding-v1-design.md` §7.6).

This is separate from `store.stores.status` (`store-onboarding-v1-design.md` §2) — see that document for how the two compose: `status='active'` is a manual business decision, this readiness condition is a live fact, and a store only accepts real bookings when both are true.

---

## 3. Entry UX

### 3.1 Business hours editor

Seven rows, one per day: `open–close` (`HH:mm`) or "closed" (= both `NULL`). Submitting is a **full replace of all 7 rows** (`PUT`, idempotent).

### 3.2 Weekly schedule editor (a person, at one store)

Seven days, each with zero or more shift-segment rows (though V1's own `business_hours` never has more than one segment — this editor's shape stays general for the staff-schedule case, which genuinely can have gaps within a day even though the store's own hours don't split). An empty day shows as "off." Submitting is a **full replace of this person's entries at this one store only** (2026-10-02, Batch 2 Change 2 — `staff_schedules` is person-level now, but each store-scoped `PUT` still only touches that store's slice of the person's timetable; their entries at any other store are untouched by this call). Same-day rows overlapping **at this store** → the client should flag it, and the server rejects with `400 SCHEDULE_OVERLAP`; the same check also runs **across every store** this person works, since the underlying rule is per-person, not per-store (§5.1).

### 3.3 Default inheritance and "reset to store hours"

At the moment an assignment is **created**, the system materializes the store's current `business_hours` into that person's `staff_schedules`, as entries tagged with that store's `store_id` (2026-10-02, Batch 2 Change 2 — a copy, not a live reference — the store changing its hours later never silently rewrites anyone's existing schedule; it only adds to the person's one timetable, never touches their entries at any other store). "Reset to store hours" on the schedule editor re-runs the same copy on demand, going through the same `PUT` and the same conflict check (§5.2). The store admin sees a passive notice when store hours change ("N staff schedules no longer match the new hours") — nothing is auto-updated; each is handled individually if the admin chooses to. Both this materialization and "reset to store hours" write `staff_schedules` rows for a `staff_id` and so must hold the advisory lock described in §5.1 before writing, same as the two `PUT` endpoints.

### 3.4 Time off (person-level)

Entered as a start/end datetime pair (store-local time in the UI, stored as UTC). Shortcuts: "one day" fills `00:00`–`23:59:59` that date; "several days" is several rows. The UI states plainly that time off blocks every store the person works at (§1). `reason` is optional, with quick-pick categories (vacation/sick/personal/other) plus free text. Removing time off is a plain `DELETE` — V1 has no approval workflow.

### 3.5 Copying a schedule between staff (same store only) — kept under Change 2, rekeyed

`POST /stores/{storeId}/staff/{staffId}/schedule/copy` with `{ fromStaffId }` copies another person's entries **at this one store** onto the target person's own entries at that same store (full overwrite of just that store's slice of the target's timetable — their entries at any other store are untouched). Cross-store copy is still rejected (`400`): the call always compares `fromStaffId` and `staffId` at the *same* `storeId` named in the path.

**Correction (2026-10-02, Batch 2 F8):** an earlier version of this batch's brief mislabeled this feature as "copy schedule to another store" and marked it deleted, conflating it with `store-onboarding-v1-design.md` §8 (copying the *service catalog* between stores) — exactly the conflation the paragraph below already warned against. This feature is **kept**: it copies between two different *people* at the same store (e.g. "set up this new hire with the same shifts as Jordan"), a live use case that survives one-timetable-per-person unchanged — it's a mechanical rekey from assignment-keyed rows to `(staff_id, store_id)`-keyed ones, not a removal. The old justification — "a schedule is a store-level fact" — is obsolete now that `staff_schedules` is person-level; the real reason cross-store copy has no sensible meaning is simpler: comparing two different people's hours only makes sense within one shared store context, since "Jordan's Tuesday at the King West location" and "Anna's Tuesday at Yorkville" aren't hours anyone would ever want copied onto each other. This write holds the same advisory lock as every other `staff_schedules` writer (§5.1), keyed on the **target** `staffId`, and its result is still subject to the person-level overlap check against the rest of the target's timetable.

This remains a different feature at a different scope from `store-onboarding-v1-design.md` §8 (copying the *service catalog* between stores when opening a new one) — don't conflate the two "copy" actions.

---

## 4. API (`StoreSession`, base `/api/store`; paths below omit that prefix for readability)

### Store-level (hours, schedules)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/stores/{storeId}/business-hours` | All 7 days, including closed ones |
| `PUT` | `/stores/{storeId}/business-hours` | Full replace of 7 days; supports `?dry_run=true` |
| `GET` | `/stores/{storeId}/staff/{staffId}/schedule` | This person's entries tagged with this store (a slice of their one person-level timetable, §2.2/Change 2); 404 if this person has no `staff_store_assignments` row at this store **of any status** — an inactive assignment still returns its old entries, so an admin can see what's there before deciding to reactivate (Change 2's "free reversibility") |
| `PUT` | `/stores/{storeId}/staff/{staffId}/schedule` | Full replace of this person's entries at this store only (§3.2); supports `?dry_run=true`; holds the advisory lock (§5.1) before writing |
| `POST` | `/stores/{storeId}/staff/{staffId}/schedule/copy` | `{ fromStaffId }` — same store only, kept under Change 2 (§3.5, F8); holds the advisory lock keyed on the target `staffId` |
| `POST` | `/stores/{storeId}/staff/{staffId}/schedule/reset-to-store-hours` | Re-copies current business hours onto this person's entries at this store (§3.3); holds the advisory lock |

### Person-level (time off)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/staff/{staffId}/time-offs?from=&to=` | Filtered by a UTC range |
| `POST` | `/staff/{staffId}/time-offs` | `{ startsAt, endsAt, reason? }` (store-local ISO in the request; server converts to UTC) |
| `DELETE` | `/staff/{staffId}/time-offs/{timeOffId}` | Remove |

Every store-level `PUT`/`POST` that would leave a **future, `confirmed`** appointment's occupied block no longer fully inside the updated available time returns `409 SCHEDULE_CONFLICT` (§5.2) unless called with `?confirm=true`. `?dry_run=true` runs the same conflict check without writing anything.

---

## 5. Validation rules

### 5.1 Time validity

- **Schedules:** `start_time < end_time`; same-day rows must not overlap (`400 SCHEDULE_OVERLAP`) — **checked per person, not per store** (2026-10-02, Batch 2 Change 2): for a given `staff_id` and `day_of_week`, no two `staff_schedules` rows may overlap regardless of which `store_id` they're tagged with. One timetable means a person can't be in two places at once; rejecting this at write time is what lets the slot engine skip any special cross-store handling entirely. V1 doesn't support an overnight shift (e.g. 22:00–02:00).

  **Advisory lock, not a DB exclusion constraint (2026-10-02, Batch 2 Q3/F4).** The same person's entries at different stores are now written through independent, store-scoped endpoints (§4) — two concurrent writes (one per store) could each pass the overlap check above against a snapshot that doesn't yet include the other's in-flight write, and both commit a genuinely overlapping timetable. A `gist` exclusion constraint on `(staff_id, day_of_week, time-range)` would close this at the DB level but is heavier than this admin-only, near-zero-contention write path warrants (no native `TIME`-range type; a composite `gist` index to build and maintain for it). Instead: **any transaction that `INSERT`s, `UPDATE`s, or `DELETE`s `staff_schedules` rows for a given `staff_id` must hold `pg_advisory_xact_lock(hashtext('staff_schedule:' || staff_id))` before doing so** — the same pattern already used for the idempotency-claim fix (`create-appointment-transaction-design.md` §9 step 0). Concurrent writers serialize; the second one to acquire the lock sees the first's already-committed rows and gets a correct `400 SCHEDULE_OVERLAP` instead of racing past it. This is a blanket rule stated once, not an enumerated endpoint list that can go stale — it covers both schedule `PUT` endpoints (§4), `POST .../schedule/reset-to-store-hours` (§3.3), the assignment-creation schedule materialization (§3.3), and `POST .../schedule/copy` (§3.5); any future writer of this table follows the same rule.
- **Business hours:** both times `NULL` or both set (`chk_business_hours_null`, `store-onboarding-v1-design.md` §4); non-closed days need `close_time > open_time`.
- **Time off:** `ends_at > starts_at` (`chk_time_off_range`); `starts_at` can't be in the past (`400 DATE_IN_PAST`); overlapping ranges for the same person are rejected DB-side (`409 TIME_OFF_OVERLAP`, the `EXCLUDE USING gist` constraint) — a full-day entry and a same-day partial entry conflict too (the full day already covers it; the partial entry is redundant input, correctly rejected).

### 5.2 Conflict with existing future appointments

**Definition:** a schedule/hours/time-off change conflicts if it would leave any `status='confirmed'` appointment with `starts_at` in the future whose occupied block (`[starts_at - buffer_before_minutes, ends_at + buffer_after_minutes]`, the snapshot on the appointment itself — `store-onboarding-v1-design.md` §4) no longer entirely inside the *updated* available time. Since `appointments.staff_id` is person-level, a time-off conflict check must cover that person's future appointments **at every store**, not just the one being edited.

**Handling:** `409 {error: SCHEDULE_CONFLICT, conflicts: [...]}` — the UI lists the affected appointments; the caller either resolves them out-of-band and retries with `?confirm=true` (the system never auto-cancels or auto-reschedules anything — a human contacts the customer), or abandons the change. An edit that only *extends* availability (more hours, fewer restrictions) can never conflict and always writes straight through.

---

## 6. "Bookable" (an assignment) — derived, not stored

An assignment is considered by the slot engine ⟺ all of:
1. Its own `status = 'active'` (2026-10-02, Batch 2 Change 1 — moved from the now-dropped, person-level `store.staff.status`; the relationship itself must be active, not just the person existing somewhere);
2. It has ≥ 1 `staff_schedules` row **tagged with this assignment's `store_id`** (2026-10-02, Batch 2 Change 2 — `staff_schedules` is person-level now, so this checks for at least one entry at *this* store specifically, not just that the person has a timetable somewhere);
3. It has ≥ 1 `staff_services` row (can perform at least one service there).

Failing any of these keeps the assignment out of `GET /slots` entirely; the back office shows it greyed out with the specific reason ("no schedule set" / "no services assigned"), linking straight to the fix — a nudge, not a blocking error.

---

## 7. Error codes

| Code | HTTP | Meaning |
|---|---|---|
| `SCHEDULE_OVERLAP` | 400 | Same-day schedule segments overlap |
| `HOURS_INVALID` | 400 | Business hours half-`NULL`, or `close <= open` |
| `TIME_OFF_OVERLAP` | 409 | Overlapping time-off range (DB exclusion constraint) |
| `SCHEDULE_CONFLICT` | 409 | Change would strand a future confirmed appointment (retry with `?confirm=true`) |
| `DATE_IN_PAST` | 400 | Time-off start is in the past |
| `FORBIDDEN` | 403 | `staff` touching `business_hours`, or requesting time off for someone else |
| *(cross-store / no assignment)* | 404 | Standard out-of-scope-resource convention — never confirms existence |

---

## 8. Explicitly not in V1

- Time-off approval workflows; recurring time off (e.g. "every Wednesday afternoon off") — express as multiple dated rows instead.
- Overnight shifts / split (multi-segment) business hours.
- Store-scoped time-off exceptions (§1's known side effect) — time off is chain-wide-per-person in V1.
- Automatic customer notification when a schedule change affects them — that's the reminder pipeline's concern, not this document's.
- Work-hours reporting / time-clock — a schedule here is "bookable availability," not an attendance record.

---

## 9. Open questions

1. Exactly how `?confirm=true` interacts with a chain-wide time-off side effect spanning many future appointments across several stores at once isn't worked through in detail — the mechanism (§5.2) generalizes, but the UX for "this affects 12 appointments across 2 stores" hasn't been designed.
2. Everything `store-onboarding-v1-design.md` and `availability-slot-engine.md` already leave open (multi-service sequencing, `auto_confirm=false`/pending status, `is_test` occupancy) is inherited here unresolved, since this document assumes an appointment-creation mechanism that doesn't exist yet.
