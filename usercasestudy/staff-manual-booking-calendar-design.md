# Staff Manual Booking & Back-Office Calendar — Design

**Status:** the back-office calendar and manual booking entry for staff/managers. Creation runs through the **same transaction** as public booking (`create-appointment-transaction-design.md` §3.2, `POST /api/store/appointments`) — any manual path that bypasses quota or double-booking checks is a bug. This document covers UI flow, list endpoints, the permission matrix, and calendar interaction only; it invents no new creation logic.

Baseline: state machine and cancel/reschedule rules are `create-appointment-transaction-design.md` §2/§10. Notifications are `customer-booking-confirmation-reminders-design.md` (manual bookings get the same confirmation SMS). Slot computation reuses the slot engine via the public, login-free `GET /api/store/public/slots`. Authorization is `storeId ∈ caller.AuthorizedStoreIds`; cross-store is 404.

## 1. Decisions

1. **v1 calendar interaction is click-based, not drag-and-drop.** Drag/drop adds real pointer/touch complexity; "click an empty slot to book, click an appointment to see details, Move mode + click a new slot to reschedule" covers the full workflow. Drag-and-drop is a v2 UX polish.
2. **Any staff member with an assignment at the store can manually book for anyone at the store** (assign to any bookable staff there). A front-desk person answering the phone books for every technician; creating is low-risk (the transaction backstops correctness) — editing *someone else's* appointment is the higher-risk action.
3. **Edit/cancel/no-show/complete are restricted to your own appointments**, unless you're `store_admin`/`chain_admin` (full store / full chain). Matches the "own only" spirit of §4's matrix; a front-desk booking mistake gets fixed by the manager.
4. **`no-show` can only be marked once the appointment has started** (`now >= starts_at`) — guards against fat-fingering a future appointment.
5. **No schema increment** — every field already exists. This is a pure API + UI-flow document.
6. **Staff manual entry is exempt from the chain-wide phone cap, but not from the per-store blocklist.** `create-appointment-transaction-design.md` §1 decisions 10–11: the phone cap (`409 PHONE_LIMIT`) is a public-channel-only anti-scraping defense — this path has a real human making the call and an audit trail, so it never applies here. The blocklist (`403 PHONE_BLOCKED`) applies on every channel, but staff can override it for a single booking with a mandatory reason (§6).

## 2. Views

| View | Contents | Default scope |
|---|---|---|
| Day, by staff column | One column per staff member, that day's blocks, overlaid with their time off | Staff see their own; `store_admin`/`chain_admin` see the whole store |
| Week agenda | List by day, one week | Whole store (`store_admin`+); staff see their own week |
| Pending queue | `status='pending'` awaiting confirmation (`auto_confirm=false` stores) | Shown with a red badge only when non-empty |

- Time axis granularity follows `slot_granularity_minutes`.
- Each block shows: time, customer name, service summary, status color, 🧪 for `is_test`, last 4 characters of `reference_code`.
- Time off renders as a gray, read-only block (time-off CRUD is `staff-schedule-entry-workflow.md`'s concern, not duplicated here).

## 3. List endpoint

`GET /api/store/appointments?store_id=&date=&staff_id=&status=` — `StoreSession`.

- `date` (`YYYY-MM-DD`, store timezone) or `from`/`to` (day view vs. week view; `from`/`to` capped at 31 days, else `400`).
- `staff_id` optional; a `staff`-role caller is **forced** to their own id (passing someone else's → `404`).
- `status` optional, comma-separated; omitted returns everything and lets the client group it — terminal states (`cancelled`/`completed`/`no_show`/`expired`) collapse by default in the UI.
- Response: appointment header + item snapshots + customer display info (`customer_id` resolves a name via customer records; otherwise `guest_name`/`guest_phone`) + `is_test`.

```json
{
  "date": "2026-10-05",
  "timezone": "America/Toronto",
  "appointments": [
    {
      "id": "uuid", "reference_code": "F7AE5724", "status": "confirmed",
      "staff_id": "uuid", "staff_name": "string",
      "starts_at": "2026-10-05T09:00:00", "ends_at": "2026-10-05T10:00:00",
      "customer_name": "string", "customer_phone": "string",
      "is_test": false,
      "items": [{ "service_name": "string", "option_name": null, "duration_minutes": 60, "price_cents": 8800 }]
    }
  ]
}
```

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
- `is_test` creation/visibility follows the same matrix; a test appointment always shows the 🧪 badge on the calendar so it's never confused with a real one.

## 6. Manual booking flow (UI)

1. Click an empty slot (or "+ New appointment") → modal form.
2. Pick service (+ option if applicable) → pick staff (defaults to the current view's staff column; a staff-role caller can switch to anyone else at the store) → date/time: **pulled from the slots endpoint**, dropdown/click-to-pick only — free-text time entry is not offered, which eliminates "booked into a time nobody has" at the source.
3. Customer: search existing customer records (`customer-records-design.md`) or enter guest name + phone.
4. `is_test` checkbox (staff-side form only; the public endpoint always forces `false`).
5. Marketing consent checkbox, unchecked by default: "Customer agreed to receive occasional offers by SMS/email" — staff only checks this after asking verbally; it's never assumed from the booking itself. Maps to `sms_marketing_consent`/`email_marketing_consent` (`create-appointment-transaction-design.md` §1 decision 13) — V1 groundwork for V3's AI recall, no V1 consumer yet.
6. Submit → `POST /api/store/appointments` → the same transaction (re-validation, quota, idempotency, outbox event all included).
7. Success: the block appears on the calendar immediately; confirmation SMS sent per `customer-booking-confirmation-reminders-design.md`.

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

## 9. Batch cancel

Calendar supports multi-select (click/shift-click/drag-select a range of blocks) → a single "Cancel selected" action. UI-only addition — it calls the existing `POST .../cancel` endpoint (§4) once per selected appointment; no new backend endpoint. Same permission/threshold rules as a single cancel (§5, `create-appointment-transaction-design.md` §10) apply per appointment — a staff member's multi-select is still restricted to their own appointments unless `store_admin`+.

## 10. Display rules

- Status colors: `confirmed` blue / `pending` amber (blinking red badge, awaiting confirmation) / `cancelled` gray (strikethrough) / `no_show` red / `completed` green / `expired` gray; `is_test` always adds a 🧪 badge regardless of status color.
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
8. `is_test` appointment: occupies the slot (invisible to public slot queries), doesn't consume quota, shows 🧪 on the calendar.
9. Staff passes a `staff_id` for someone at a different store → `404`.
10. Booking a phone that already has 5 upcoming bookings chain-wide via staff entry → `201`, succeeds (decision 6, phone cap doesn't apply here).
11. Booking a blocklisted phone without `override_phone_block_reason` → `403 PHONE_BLOCKED`; with it → `201`, override logged to the activity timeline, blocklist entry unchanged.
12. A staff member attempts to add a blocklist entry → `403` (store_admin+ only, §7).
13. Multi-select 3 appointments, one belonging to another staff member, and hit "Cancel selected" (as a `staff` caller) → the other two cancel, the third returns `404` and stays on the calendar.

## 12. Deferred

1. Drag-and-drop reschedule (v2).
2. Customer-record search endpoint (owned by `customer-records-design.md`; this document only has the call site).
3. Staff-to-staff handoff notes.
4. Month view.
5. Downstream consumers of `appointment.no_show` / `appointment.completed` (reporting/AI) — events are emitted now, consumers come later.
