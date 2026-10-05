# Staff Manual Booking & Back-Office Calendar — Design

**Status:** the back-office calendar and manual booking entry for staff/managers. Creation runs through the **same transaction** as public booking (`create-appointment-transaction-design.md` §3.2, `POST /api/store/appointments`) — any manual path that bypasses quota or double-booking checks is a bug. This document covers UI flow, list endpoints, the permission matrix, and calendar interaction only; it invents no new creation logic.

Baseline: state machine and cancel/reschedule rules are `create-appointment-transaction-design.md` §2/§10. Notifications are `customer-booking-confirmation-reminders-design.md` (manual bookings get the same confirmation SMS). Slot computation reuses the slot engine via the public, login-free `GET /api/store/public/slots`. Authorization is `storeId ∈ caller.AuthorizedStoreIds`; cross-store is 404.

~~`is_test`/🧪 — deferred from the V1 build, 2026-10-03...~~ — **removed entirely 2026-10-05 (Steven, #18 superseded), not deferred.** No competitor (Fresha/Vagaro/Mindbody/Booker/Square/GlossGenius) has a test-appointment concept. Every `is_test`/🧪 mention below has been converted to a removal note.

**P3 — this calendar benchmarks Fresha's back-office calendar directly, no cutting corners on visual polish (2026-10-03, Steven).** Acceptance checklist: `fresha-calendar-teardown-2026-10-03.md`. Its P0 items are the "looks like Fresha" bar; P1 is workflow parity; P2 is polish. Specific deltas from that teardown are called out inline below where they land.

## 1. Decisions

1. ~~v1 calendar interaction is click-based, not drag-and-drop~~ — **amended 2026-10-03 (Steven, #13): drag-and-drop rescheduling is a V1 requirement.** The earlier V2 deferral was a mistake — for the core user of the day view (the store admin moving bookings), dragging is the obvious interaction, and its absence would make V1 feel broken next to every competitor. Click-to-move (§8) **stays** as the touch-device / out-of-view fallback, not removed — dragging and click-to-move are two paths to the same `PATCH .../reschedule` call, not two different features. The server already fully revalidates every reschedule (availability, capacity, qualification, blocklist, concurrency) and returns structured `409` codes — no server change is needed for the drag interaction itself; see §8a for the UI layer this adds.
2. **Any staff member with a live schedule entry at the store can manually book for anyone at the store** (assign to any bookable staff there). A front-desk person answering the phone books for every technician; creating is low-risk (the transaction backstops correctness) — editing *someone else's* appointment is the higher-risk action.
3. **Edit/cancel/no-show/complete are restricted to your own appointments**, unless you're `store_admin`/`chain_admin` (full store / full chain). Matches the "own only" spirit of §4's matrix; a front-desk booking mistake gets fixed by the manager.
4. **`no-show` can only be marked once the appointment has started** (`now >= starts_at`) — guards against fat-fingering a future appointment.
5. **No schema increment** — every field already exists. This is a pure API + UI-flow document.
6. **Staff manual entry is exempt from the chain-wide phone cap, but not from the per-store blocklist.** `create-appointment-transaction-design.md` §1 decisions 10–11: the phone cap (`409 PHONE_LIMIT`) is a public-channel-only anti-scraping defense — this path has a real human making the call and an audit trail, so it never applies here. The blocklist (`403 PHONE_BLOCKED`) applies on every channel, but staff can override it for a single booking with a mandatory reason (§6).
7. **Terminal-state appointments never render as time-blocks in a staff column (NEW, 2026-10-03 — the N2 invariant).** `cancelled`/`completed`/`no_show`/`expired` appointments appear only in list/audit views, never as a block in the day-view grid. Reason: the double-booking exclusion constraint (`create-appointment-transaction-design.md` §6.1) only governs `pending`/`confirmed` rows — a terminal row's `occupied_range` is `NULL`, and Postgres never treats `NULL` as conflicting with anything. Two *active* (`pending`/`confirmed`) blocks for the same staff member structurally cannot overlap — the constraint guarantees it — but a terminal-state "ghost" block (e.g. a cancelled booking) and a later `confirmed` booking that took the same slot legitimately *can* coexist in the data. This rule is what keeps that from ever being a rendering problem: if terminal rows are never drawn as blocks, there is nothing to visually overlap, and no overlap-layout algorithm needs to exist. See §10's Fresha-teardown note (N2) for the acceptance-checklist framing of this same rule.

## 2. Views

| View | Contents | Default scope |
|---|---|---|
| Day, by staff column | One column per staff member, that day's blocks, overlaid with their time off | Staff see their own; `store_admin`/`chain_admin` see the whole store |
| Week agenda | List by day, one week | Whole store (`store_admin`+); staff see their own week |
| Pending queue | `status='pending'` awaiting confirmation (`auto_confirm=false` stores) | Shown with a red badge only when non-empty |

- Time axis granularity follows `slot_granularity_minutes`.
- Each block shows: time, customer name, service summary, status color, ~~🧪 for `is_test` (deferred from the V1 build)~~ (removed 2026-10-05, see above), 💬 for a non-empty `customer_notes` (2026-10-03, Part C — persistent, never dismissed; see §10), last 4 characters of `reference_code`.
- Time off renders as a gray, read-only block (time-off CRUD is `staff-schedule-entry-workflow.md`'s concern, not duplicated here).
- **Column header shows the staff member's photo + name (NEW, 2026-10-03, teardown V2)** — reuses the existing `staff.photo_s3_key` live column (`staff-profile-design.md` §2); a placeholder avatar when `NULL`, same as the public profile page. Columns for staff with no availability that day are hidden when the "scheduled only" team filter is on (below).
- **Toolbar: "Today" button + `‹ date ›` navigator (NEW, teardown V4).** "Today" returns to the current date from any date; the arrows step one day in Day view, one week in Week view. Switching view type preserves the currently-selected date.
- **Team filter (NEW, teardown V5):** a dropdown — all staff at the store / scheduled-only (today) / a single staff member — layered on top of, not replacing, the existing permission scoping (a `staff` caller never sees anyone else's column regardless of this filter's setting).
- **Now-line (NEW, teardown N1, P0):** on today's date in Day view only, a red horizontal line spans every staff column at the current time, with a time pill (e.g. "10:48") at the left edge. Absent on past/future dates. Advances live (client-side timer, ≤1 minute granularity) — no page reload needed to see it move.
- **Block aesthetics (NEW, teardown B2/B3, P0):** pastel background fill (varies by status color, §10), ~8px rounded corners, dark text, ≥8px internal padding, no harsh 1px borders; text truncates with ellipsis, never overflows. Block height is proportional to duration — a 60-minute block renders at 2× the height of a 30-minute block at the same time-axis zoom.

## 3. List endpoint

`GET /api/store/appointments?store_id=&date=&staff_id=&status=&unclaimed=&needs_review=&q=` — `StoreSession`.

- `date` (`YYYY-MM-DD`, store timezone) or `from`/`to` (day view vs. week view; `from`/`to` capped at 31 days, else `400`).
- `staff_id` optional; a `staff`-role caller is **forced** to their own id (passing someone else's → `404`).
- `status` optional, comma-separated; omitted returns everything and lets the client group it — terminal states (`cancelled`/`completed`/`no_show`/`expired`) collapse by default in the UI.
- **`unclaimed=true` (NEW, 2026-10-03, #9):** filters to `customer_id IS NULL` only — guest bookings never linked to a customer profile. Powers the "Show unclaimed only" filter (§10).
- **`needs_review=true` (NEW, 2026-10-03, #10):** filters to `channel='public_web' AND customer_notes IS NOT NULL AND status='pending'` — the same condition that renders a block red (§10). Powers the "Needs review only" filter.
- **`q=` (NEW, teardown F2, P1):** free-text search by customer name or phone (reuses `customer-records-design.md`'s existing search, scoped to this store's appointments) — matches jump the calendar to that appointment rather than filtering the list, since a search is usually "find the one booking," not "show me a subset."
- Response: appointment header + item snapshots + customer display info (`customer_id` resolves a name via customer records; otherwise `guest_name`/`guest_phone`) + `customer_notes`. (~~+ `is_test`~~ — removed 2026-10-05, see §1; no longer part of the response shape.)

```json
{
  "date": "2026-10-05",
  "timezone": "America/Toronto",
  "appointments": [
    {
      "id": "uuid", "reference_code": "K7QXM3P2", "status": "confirmed",
      "staff_id": "uuid", "staff_name": "string",
      "starts_at": "2026-10-05T09:00:00", "ends_at": "2026-10-05T10:00:00",
      "customer_name": "string", "customer_phone": "string", "customer_id": "uuid | null",
      "customer_notes": "string | null", "channel": "public_web",
      "items": [{ "service_name": "string", "option_name": null, "duration_minutes": 60, "price_cents": 8800 }]
    }
  ]
}
```

**Calendar filters (NEW, teardown F1, P1 — capability only; named presets are a fast-follow, see §12).** The calendar/list UI lets staff filter visible appointments by status and by the two booleans above, composed with `AND`. §10's "Needs review only" and §9's "Show unclaimed only" are the two filters this batch ships; a general filter panel with more dimensions can grow from the same `q=`/boolean-param shape later. **Saved, named presets** (save/rename/delete, per-login) are explicitly deferred — see §12.

## 4. Calendar action endpoints

Reused (permissions per §5):
- `POST /api/store/appointments/{id}/confirm` (`pending → confirmed`)
- `POST /api/store/appointments/{id}/cancel`
- `PATCH /api/store/appointments/{id}/reschedule`

New:

| Method & path | Notes |
|---|---|
| `POST /api/store/appointments/{id}/no-show` | `confirmed → no_show`; requires `now >= starts_at`, else `409 TOO_EARLY` |
| `POST /api/store/appointments/{id}/complete` | `confirmed → completed` (early manual completion; the sweeper is the backstop) |

- Both are idempotent: already at the target state → `200`, no-op.
- Both write outbox events (`appointment.no_show` / `appointment.completed`, extending `create-appointment-transaction-design.md` §12's table).

## 5. Permission matrix

| Action | Staff (own store) | `store_admin` (own store) | `chain_admin` (chain) |
|---|---|---|---|
| View calendar | Own only | Whole store | Every store in chain |
| Manual booking | ✅ (can assign to any bookable staff at the store) | ✅ | ✅ |
| Confirm pending | Own only | Whole store | Whole chain |
| Cancel / reschedule | Own only | Whole store | Whole chain |
| Mark no-show / complete | Own only | Whole store | Whole chain |
| View customer phone | Appointments they booked | Store's appointments | Chain's appointments |
| Manage phone blocklist (§7) | View only | ✅ (own store) | ✅ (chain) |
| Override a blocklist hit, single booking (§6) | ✅ | ✅ | ✅ |

- Out-of-scope access → `404` (same "don't let the status code confirm existence" rule used elsewhere).
- ~~`is_test` creation/visibility follows the same matrix; a test appointment always shows the 🧪 badge...~~ — removed 2026-10-05 (§1); there is no `is_test` concept to have a permission matrix over anymore.

## 6. Manual booking flow (UI)

1. Click an empty slot (or "+ New appointment") → modal form.
2. Pick service (+ option if applicable) → pick staff (defaults to the current view's staff column; a staff-role caller can switch to anyone else at the store) → date/time: **pulled from the slots endpoint**, dropdown/click-to-pick only — free-text time entry is not offered, which eliminates "booked into a time nobody has" at the source.
3. Customer: search existing customer records (`customer-records-design.md`) or enter guest name + phone.
4. ~~`is_test` checkbox (staff-side form only...)~~ — removed 2026-10-05 (§1); there is no test-booking checkbox anywhere in this form.
5. Two independent marketing-consent checkboxes, both unchecked by default: "Customer agreed to SMS offers" and "Customer agreed to email offers" (2026-10-02 decision — one combined "SMS/email" checkbox was rejected; CASL's burden of proof needs to show exactly which channel was agreed to, and a customer who only gave a phone number can't plausibly have agreed to email offers at all). Staff only check either after asking verbally; never assumed from the booking itself. Map independently to `sms_marketing_consent`/`email_marketing_consent`, with `consent_text_version`/`consent_at` set alongside whichever is checked (`create-appointment-transaction-design.md` §1 decision 13) — V1 groundwork for V3's AI recall, no V1 consumer yet.
6. Optional "Notes" textarea, max 500 characters (2026-10-03, Part C — same field and limit as the public flow, `public-booking-end-to-end-design.md` §3 Step 5) → `appointments.customer_notes`. **Never forces `pending` on this channel** — the create-transaction's notes-forced-pending rule is public-channel-only (`create-appointment-transaction-design.md` §1 decision 15); the staff member entering this is already talking to the customer, so there's nothing left to force a review of.
7. Submit → `POST /api/store/appointments` → the same transaction (re-validation, quota, idempotency, outbox event all included).
8. Success: the block appears on the calendar immediately; confirmation SMS sent per `customer-booking-confirmation-reminders-design.md`.

Failure handling:
- `409 SLOT_TAKEN` → modal message "That time was just taken," auto-refresh that staff member's slots for re-selection.
- `409 CAPACITY_FULL` → modal message "The store is fully booked for that time" (distinct copy from `SLOT_TAKEN` — store-wide, not staff-specific), auto-refresh slots.
- `409 QUOTA_EXHAUSTED` → free-plan cap reached, copy follows billing §4.3, directs to `chain_admin` for an upgrade.
- `403 PHONE_BLOCKED` → confirmation dialog, not a dead end: "This number is on the blocklist — allow this one booking anyway?" with a required reason field. Confirming resubmits with `override_phone_block_reason` set (`create-appointment-transaction-design.md` §3.2), which is logged to the activity timeline; the blocklist entry itself is untouched, so the next booking attempt from that number is blocked again. No ticket number required — this is a single-booking, in-person, already-audited override, not cross-account access (contrast `groway-admin-impersonation-design.md` §4, where ticket numbers gate a materially higher-stakes action). `409 PHONE_LIMIT` never appears on this path (decision 6).

## 7. Blocklist management

`POST /api/store/phone-blocklist` / `DELETE /api/store/phone-blocklist/{phone}` — `store_admin`+ only (same "staff writes are restricted" convention as elsewhere in this matrix, §5); staff can view the list (to recognize why a number might need an override) but not add or remove entries. Adding requires a `reason`; removing doesn't (undoing a mistake needs no justification).

## 8. Reschedule interaction (click-to-move)

1. Click an appointment block → details drawer → "Reschedule."
2. Enter Move mode: the block follows visually (semi-transparent), day/staff switchable.
3. Click a target slot → confirmation dialog (old → new) → `PATCH .../reschedule`.
4. Success: block lands in the new position. `409 SLOT_TAKEN` / `409 CAPACITY_FULL` → stays in Move mode for re-selection.

### 8a. Drag-and-drop reschedule (NEW, 2026-10-03, #13/#14 — teardown I1/I2, P0)

**Drag a block to a new time and/or staff column** — a semi-transparent "ghost" of the block follows the pointer, same visual language as Move mode's "the block follows visually (semi-transparent)" (§8 step 2), because this is the same mechanism with a different trigger (drag instead of click-to-select-then-click-target). On drop: the same confirmation dialog as click-to-move ("old → new") appears before the `PATCH .../reschedule` call fires — dragging never commits silently. Success moves the block to its new position; a `409` (any code) **snaps the block back to its original position**, never leaves it floating at the drop point, and shows the error (below) — never a silent snap-back with no explanation.

**Proactive validation while dragging (NEW, #14 — presentation only, the server-side validation already exists and is unchanged).** The server already fully revalidates every reschedule — availability, capacity, staff qualification, live schedule presence, blocklist, concurrency — and already returns structured codes (`409 SLOT_TAKEN`, `409 CAPACITY_FULL`, `409 STAFF_NOT_QUALIFIED`, etc.). This item is purely about *using* that existing constraint set while the drag is in progress, not rebuilding it:
- While a drag is active, invalid drop targets (a slot that would fail — unavailable, capacity-full, the target staff unqualified for this service) are greyed out / visually disabled. This can be a client-side approximation of the known constraints, confirmed server-side on drop as always — the point is the user sees likely-invalid targets before committing, not that the client re-implements the full validation logic.
- A failed drop (client approximation missed something, or state changed between drag-start and drop) returns the block to its original position and renders the `409` as a plain-language reason, never the raw code: `SLOT_TAKEN` → "This slot is already taken"; `CAPACITY_FULL` → "This service is at capacity"; `STAFF_NOT_QUALIFIED` → "Technician is not qualified for this service." Same plain-language mapping applies to click-to-move's existing `409` handling (§8 step 4) — one error-copy table, not two.
- **Service changes stay cancel + rebook** (accepted 2026-10-03 — no modify-services endpoint in V1). Dragging only ever changes `start`/`staff_id`; changing which services an appointment covers is not a drag gesture.

Click-to-move (§8) is unchanged and remains the touch-device / out-of-view fallback — both paths converge on the same `PATCH .../reschedule` call and the same error handling.

## 9. Batch cancel

Calendar supports multi-select (click/shift-click/drag-select a range of blocks) → a single "Cancel selected" action. UI-only addition — it calls the existing `POST .../cancel` endpoint (§4) once per selected appointment; no new backend endpoint. Same permission/threshold rules as a single cancel (§5, `create-appointment-transaction-design.md` §10) apply per appointment — a staff member's multi-select is still restricted to their own appointments unless `store_admin`+.

## 10. Display rules

- Status colors: `confirmed` blue / `pending` amber (blinking red badge, awaiting confirmation) / `cancelled` gray (strikethrough) / `no_show` red / `completed` green / `expired` gray. ~~`is_test` always adds a 🧪 badge regardless of status color~~ — removed 2026-10-05 (§1); there is no test-appointment badge of any kind.
- **Bright red "Needs review" treatment for unreviewed notes (2026-10-03, Steven, #10 — REFINES the paragraph below).** When `channel='public_web' AND customer_notes IS NOT NULL AND status='pending'`, the block renders **bright red** with a "Needs review" cue — not just the 💬 badge. This is an actionable sub-state, not a new status: staff must read the note and call the customer to confirm before it can proceed. A 💬 badge alone drowns on a busy day; a missed note (an allergy, a special request) is a real service failure, and red is loud on purpose. This does **not** break the "block color means status" principle below — "pending + unreviewed notes" is a distinct, actionable sub-state of `pending`, and red is correctly *its* status color, the same way `pending` amber is the color for plain "awaiting confirmation." Lifecycle: red while unreviewed; **clears the moment the booking is manually confirmed** (the confirm action *is* the review — read note, call customer, confirm) — reverts to ordinary `confirmed` blue. The 💬 badge (below) persists afterward as the separate "remember this at service time" marker; notes stay pinned at the top of the drawer regardless. **Staff-manual bookings with notes are never red** — the staff member entering it already saw the note (§6 item 6); this treatment is public-channel-only, same scope as the `booking_pending_review` notification it's the visual companion to (`groway-store-notifications-workflow.md` §3b). A "Needs review only" filter (§3) surfaces exactly this set.
- **💬 badge for non-empty `customer_notes` (2026-10-03, Part C) — deliberately does not recolor the block** (except for the red pending-review sub-state immediately above, which is a status-color extension, not a notes-badge). Block color means status; reusing it for "has notes" in the general case would collide with that existing meaning, so this is an additional badge layered on top of the block, not a recolor. **Persistent, no "mark as read," no dismissal** — some notes matter at service time, not just at booking time (an allergy, a room preference), so there's no reason to hide the badge once "seen." No noise problem either: terminal states never render as blocks at all (§1 decision 7, the N2 invariant), so old notes never clutter the active view. No new state column, no new endpoint — purely a read of `customer_notes IS NOT NULL`.
- **Details drawer (§8) pins customer notes at the top, in a highlighted section, shown verbatim** when `customer_notes` is non-empty — above the rest of the appointment detail, not buried in it.
- **Unclaimed badge (NEW, 2026-10-03, #9).** An appointment with `customer_id IS NULL` (a guest booking never linked to a customer profile) shows a visible "Unclaimed" badge on both the calendar block and the list view. A "Show unclaimed only" filter (§3, `unclaimed=true`) lets staff find these to link later. Claiming (`customer-records-design.md` §4.4) and the new unclaim endpoint (reverses `customer_id` back to `NULL`) are designed in that document, not here — this document owns the badge and filter UI only. The claim UI suggests an exact-phone match ("Possible match: {name}") to speed up linking, sourced from the same global phone-exact lookup `customer-records-design.md` §4.1 (#8) uses elsewhere. Deliberately per-appointment, never bulk — one phone number can serve multiple people (family sharing), so bulk-claiming would misattribute.
- **Terminal states never render as time-blocks** — list/audit views only (§1 decision 7, the N2 invariant; this is also why no overlap-rendering logic exists for this calendar — see the Fresha-teardown comparison, item N2).
- The pending queue entry point is pinned in the top bar with a red count badge when non-empty.
- A `confirmed` appointment past `ends_at` that the sweeper hasn't processed yet shows "Awaiting completion," with a manual complete button available.

## 11. Test cases

1. Staff A books an appointment and assigns it to Staff B → `201`; Staff A tries to cancel Staff B's appointment → `404`.
2. `store_admin` cancels Staff B's appointment → `200`.
3. Marking no-show on an appointment starting in one hour → `409 TOO_EARLY`.
4. Marking no-show twice → second call is `200`, no-op, one log line.
5. In Move mode, the target slot gets taken first → `409 SLOT_TAKEN`, original appointment untouched.
6. Booking while quota is exhausted → `409 QUOTA_EXHAUSTED`, no stray block on the calendar.
7. Booking into a capacity-full window → `409 CAPACITY_FULL`; an `occupies_capacity=false` service still books in the same window.
8. ~~`is_test` appointment...~~ — removed 2026-10-05 (§1); no longer a test case, since there is no `is_test` concept left to exercise.
9. Staff passes a `staff_id` for someone at a different store → `404`.
10. Booking a phone that already has 5 upcoming bookings chain-wide via staff entry → `201`, succeeds (decision 6, phone cap doesn't apply here).
11. Booking a blocklisted phone without `override_phone_block_reason` → `403 PHONE_BLOCKED`; with it → `201`, override logged to the activity timeline, blocklist entry unchanged.
12. A staff member attempts to add a blocklist entry → `403` (store_admin+ only, §7).
13. Multi-select 3 appointments, one belonging to another staff member, and hit "Cancel selected" (as a `staff` caller) → the other two cancel, the third returns `404` and stays on the calendar.
14. A manual booking entered with non-empty notes → 💬 badge appears on the block immediately; status still follows `auto_confirm`/`payment_required` as normal (2026-10-03, Part C — never forced to `pending` on this channel). Opening the details drawer shows the note pinned at the top, verbatim.
15. A manual booking with no notes → no 💬 badge; adding notes later via edit (if the UI supports it) makes the badge appear without any other status change.
16. A public booking with notes lands as `pending` → block renders bright red with "Needs review" (#10); staff clicks it, reads the note, calls the customer, taps Confirm → block turns ordinary `confirmed` blue, red clears, 💬 badge remains. "Needs review only" filter shows exactly this appointment while red, and excludes it the instant it's confirmed.
17. The same scenario via staff-manual entry (staff types the note themselves) → the block is never red, only 💬-badged — decision applies to public channel only.
18. Drag a confirmed block to a slot another staff member just took → block snaps back to its original position, "This slot is already taken" shown, no `PATCH` side effect left behind. The same target slot, attempted via click-to-move instead → identical copy, identical snap-back.
19. Drag a block onto a visually-greyed-out target anyway (stale client-side state) → server still rejects with the matching `409`, same snap-back and copy — the grey-out is a hint, never the actual guarantee.
20. A guest booking with `customer_id IS NULL` → shows "Unclaimed" on the calendar and list; `unclaimed=true` filter returns exactly the set of such appointments store-wide; claiming it (via `customer-records-design.md` §4.4) removes the badge on the next load.
21. Two cancelled appointments and one confirmed appointment all touch overlapping time ranges for the same staff member (the cancelled ones are history, not currently occupying anything) → only the confirmed one ever renders as a block; the cancelled ones appear solely in list/audit views, never causing a visual overlap to resolve.

## 12. Deferred

1. Customer-record search endpoint (owned by `customer-records-design.md`; this document only has the call site).
2. Staff-to-staff handoff notes.
3. Month view.
4. Downstream consumers of `appointment.no_show` / `appointment.completed` (reporting/AI) — events are emitted now, consumers come later.
5. **Named, saved filter presets (V1 fast-follow, 2026-10-03 — teardown F1(b)).** The filter *capability* itself (status, unclaimed, needs-review) is V1 (§3); save/rename/delete of named presets, per-login, with their own small data model, is scoped as a fast-follow within V1, not blocking this batch.
6. Color-source setting (staff / category / status) — teardown C1, P2 polish; V1 keeps a fixed status-color map (this document's own, not Fresha's hex values).
7. Week-start-day configuration, 3-Day view — teardown P1/P2 items not in this batch's scope; Day view + Week agenda cover the workflow.
8. Custom appointment statuses, bookable resources/rooms on the calendar, repeat appointments, group-appointment visuals, POS-tied completion — explicit Fresha non-goals (teardown §d); copying these would fork the data model or the fixed state machine this project depends on elsewhere (reporting, reminders, quota).
