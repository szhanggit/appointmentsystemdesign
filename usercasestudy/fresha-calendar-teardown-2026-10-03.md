# Fresha Back-Office Calendar Teardown → Acceptance Checklist

**Date:** 2026-10-03 · **Purpose:** turn Steven's directive ("calendar visual polish benchmarks Fresha directly — no cutting corners," P3 in the afternoon batch) into a checkable acceptance list for whoever builds our back-office calendar (human or AI).

**Method:** read-only research. No signups, no accounts created. Sources weighted by reliability: Fresha help center / Fresha Academy (high), official Fresha marketing screenshots inspected pixel-by-pixel (high), third-party "Fresha-style" reconstructions (medium), Capterra user reviews (low–medium, generic praise only).

**Our spec under test:** `staff-manual-booking-calendar-design.md` (Staff Manual Booking & Back-Office Calendar — Design).

---

## (a) Fresha calendar pattern catalog

### 1. Views & chrome
- View selector in the calendar toolbar: Day / 3 Days / Week / Month. "Open the Calendar and click on the Calendar view selector in the calendar toolbar. Choose from any of the views and the calendar will update automatically." — *Create and manage resources*, support.fresha.com
- Day view = one column per team member, each column headed by a circular staff avatar photo + name. Time axis down the left with hourly gridlines. — observed in official screenshot (images.fresha.com/.../calendarImg.3437414e.webp)
- Toolbar: "Today" button, date navigator (‹ date ›), location selector dropdown, team filter dropdown ("Scheduled team" / "Working"), settings gear, view selector ("Day" dropdown), prominent "Add" button. — observed in official screenshots
- Display settings: customizable views, filters, week start day, time zone, time format. — *Calendar and schedule index*, "Manage your calendar time and date"
- Left nav is a dark icon sidebar (calendar, clients, etc.); top-right has global search, notifications bell (with red dot), cart, avatar. — observed

### 2. Block anatomy (what's on an appointment block)
From pixel inspection of official screenshots:
- Three-line layout: time range (small, e.g. "8:00 – 9:00") → client name (bold, e.g. "Brenda Massey") → service name (smaller, e.g. "Blow Dry").
- Pastel background (light blue / peach / pink / teal / lavender), rounded corners (~8px), dark text, generous internal padding, no harsh borders.
- No price on the block. No reference/confirmation code on the block.
- Block height is proportional to appointment duration (a 2h block is ~4× a 30-min block).
- Short blocks still show all three lines; nothing observed about truncation — assume text clips with ellipsis.

### 3. Color system
- Color source is configurable (Settings → Scheduling → Time and Calendar → Calendar settings): Team member (color from staff profile) / Category (service-category color from catalog) / Status. — *Organize appointments by color*
- Status colors (when organized by status): Booked = Blue, Confirmed = Purple, Arrived = Orange, Started = Green, No-show = Red, Complete = Gray. Color updates automatically on status change. — same article
- Capterra reviewers explicitly praise this: "we even color coordinate… so its clear and easy to see"; "Good color for ayes [eyes]".

### 4. Interactions
- Drag-and-drop reschedule: "To reschedule, pick a new date and time within the appointment or drag and drop it to a new slot like this." — Fresha Academy: *Manage appointments*, lesson 3. Corroborated by user review: "reschedule appointments with drag and drop" (zombsio.org massage-software review roundup) and "easy it is to move services over/to a different time" (Capterra, Veornica, CA).
- Out-of-view moves: "If you want to move the appointment to another time or team member outside of your current view, open the appointment and reschedule using quick actions." — same Academy lesson
- Click appointment → detail with quick actions: status update (incl. cancel, mark no-show), edit services/price/team member/"add extra time" — "Once applied, these changes will be reflected instantly in your calendar." — same lesson
- Click empty slot to book: not in the help center text I could verify, but consistently described in third-party reconstructions ("Click any empty slot to book" — sk-webmaker/appointment-software-, medium confidence).
- Drag bottom edge to extend duration: third-party reconstruction only (same repo, medium confidence) — not verified in Fresha's own docs.

### 5. Now-line & density
- Now-line CONFIRMED: red horizontal line spanning all staff columns with a time pill (observed "10:48") at the left. — official calendarImg webp, pixel-inspected.
- Overlap: no overlap visible in official screenshots; third-party reconstruction says "overlapping appointments stack side-by-side in the staff column" (medium confidence). Industry-standard behavior; Fresha's own docs don't specify.
- Instant reflect: changes appear in the calendar immediately, no manual refresh (Academy lesson; our spec also requires this).

### 6. Filters & search
- Calendar filters: "applying filters that highlight specific appointment types, statuses, or booking details… your calendar will update to show only the relevant appointments." Saved filter presets: "appear in your list of Saved filters in the top right of the Filters view… ready to be applied." Rename/delete supported. — *Customize your calendar view*
- Global search icon in top bar (observed; target not verified).

### 7. Statuses
- Lifecycle: Booked (default for team-created and online bookings without payment policy) → Confirmed (client confirms / payment policy accepted) → Completed (checked out via POS; always has a sale linked). Cancelled only if start is in the future. No-show manual, only after start time passed. Custom statuses creatable (e.g. "Arrived", "Started"). Status changes trigger client notifications. — *Update appointment statuses*
- Statuses are "color-coded and visible across your calendar, appointment list, and client profiles."

### 8. Blocked time / time off
- Blocked time renders as a diagonal-hatched gray band inside the staff column (observed in official screenshot, Michael Bradshaw's column). Distinct from appointment blocks; clearly non-interactive.
- Time off is per-team-member with customizable leave types. — help center index

### 9. Mobile
- "I'll be showing you how to do this on desktop, but you can do everything on mobile too" — Fresha Academy. Dedicated "Fresha for Business" app; mobile day view = single staff column with bottom nav (calendar / $ / + / clients / more). — observed in official screenshot (phone mock).

### 10. Notes on appointments
- "View important client information such as forms, patch tests, documents, and notes, all directly on the appointment." — fresha.com/for-business/features
- Third-party reconstruction: "An amber marker always appears (even on a short booking) so nothing is missed, the note itself shows when the block has room, and the full text is in the hover tooltip." (medium confidence)
- Client-level "staff alert" on the profile surfaces on all of that client's appointments. — from repeat-appointments FAQ ("consider adding a staff alert to the client's profile… visible when viewing all of their appointments")

---

## (b) Comparison: our spec vs Fresha

| # | Pattern | Fresha | Our spec | Verdict |
|---|---|---|---|---|
| V1 | Day view, one column per staff | ✅ | ✅ §2 | HAVE |
| V2 | Staff avatar photo + name in column header | ✅ (circular photo) | Not specified | GAP |
| V3 | View selector: Day / 3 Days / Week / Month | ✅ | Day + Week-agenda(list) only; Month explicitly deferred §12 | DIFFERS (no 3-day; our "week" is a list, theirs is a grid) |
| V4 | "Today" button + ‹ date › navigator in toolbar | ✅ | Not specified | GAP |
| V5 | Team filter ("Scheduled team"/"Working" dropdown) | ✅ | Permission scoping only, no filter UI | GAP |
| V6 | Pending-approval queue | ❌ (no such concept; Booked is default) | ✅ §2 (our own design) | HAVE (ours-only, keep) |
| B1 | Block: time / bold client / service, 3-line layout | ✅ | ✅ §2 (time, name, service summary) | HAVE |
| B2 | Pastel fills, rounded corners, generous padding | ✅ (observed) | Not specified — "status color" only | GAP (the core of "华丽") |
| B3 | Block height ∝ duration | ✅ (observed) | Implied, not stated | GAP (state explicitly) |
| B4 | No price on block | ✅ | ✅ (not in block contents) | HAVE |
| B5 | Reference code last-4 on block | ❌ | ✅ §2 (our addition) | HAVE (ours-only, harmless) |
| C1 | Color source configurable (staff / category / status) | ✅ | Fixed: status colors only §10 | GAP |
| C2 | Status → color mapping | Booked Blue / Confirmed Purple / Arrived Orange / Started Green / No-show Red / Complete Gray | confirmed blue / pending amber / cancelled gray / no_show red / completed green / expired gray | DIFFERS (notably: their Complete=Gray vs our completed=green; they have no pending) |
| C3 | Custom statuses (Arrived/Started) | ✅ | Fixed state machine (deliberate) | DIFFERS (keep ours; see non-goals) |
| I1 | Drag-and-drop reschedule | ✅ (Academy-verified) | ❌ click-to-move; drag explicitly v2 §1.1/§12.1 | DIFFERS — ⚠️ spec conflicts with Steven's "benchmark Fresha" directive; directive wins, spec needs amendment |
| I2 | Drag bottom edge to extend duration | Medium confidence (3rd-party only) | Not specified | GAP (low priority, verify before building) |
| I3 | Click empty slot → create booking | ✅ (3rd-party; consistent) | ✅ §6.1 | HAVE |
| I4 | Click block → detail drawer w/ quick actions | ✅ | ✅ §8/§10 drawer | HAVE |
| I5 | Out-of-view reschedule via detail | ✅ ("quick actions") | ✅ (Move mode, day/staff switchable) | HAVE (different path, same coverage) |
| I6 | Batch cancel (multi-select) | Unknown | ✅ §9 (our design) | HAVE (ours-only) |
| N1 | Now-line (red line + time pill, today only) | ✅ (pixel-verified) | Not specified | GAP |
| N2 | Overlapping blocks side-by-side | Medium confidence | Not specified | GAP (state explicitly regardless) |
| N3 | Changes reflect instantly, no refresh | ✅ | ✅ §6.8, §8.4 | HAVE |
| F1 | Calendar filters (type/status/detail) + saved presets | ✅ | Not specified (only terminal-state collapse) | GAP |
| F2 | In-calendar search (client name/phone) | ✅ icon observed | Not specified | GAP |
| S1 | Statuses incl. no-show gating (only after start) | ✅ | ✅ §1.4, §4 | HAVE |
| T1 | Time off / blocked time as hatched gray band | ✅ hatched | ✅ "gray, read-only block" §2 | DIFFERS (solid vs hatched — minor) |
| T2 | Time axis granularity | ✅ | ✅ follows `slot_granularity_minutes` | HAVE |
| D1 | Notes indicator on block | ✅ (amber marker per 3rd-party) | ✅ 💬 badge §10 + bright-red pending-review (batch #10) | HAVE (ours goes further) |
| D2 | Notes pinned in detail | ✅ ("directly on the appointment") | ✅ pinned at top of drawer §10 | HAVE |

---

## (c) Acceptance checklist

**How to use:** each item is pass/fail, verifiable by looking at the running UI. "Fresha parity" = all P0 pass. Items marked **[SPEC-DELTA]** require amending `staff-manual-booking-calendar-design.md` (Steven's directive overrides the deferred items — already applied, 2026-10-03 afternoon batch).

### P0 — the "looks like Fresha" bar
- [ ] Day view columns: one column per staff member with scheduled time that day; column header shows circular staff photo + name; columns for staff with no availability today are hidden when the "scheduled only" filter is on.
- [ ] Time axis: hourly gridlines down the left, 12h or 24h per store setting; slot granularity follows `slot_granularity_minutes`.
- [ ] Block anatomy: every appointment block shows exactly three lines — time range (small, top), client name (bold), service summary — in that order; block height is proportional to duration (a 60-min block is 2× the height of a 30-min block at the same zoom).
- [ ] Block aesthetics: pastel background fills, ~8px rounded corners, dark text, ≥8px internal padding; no harsh 1px borders; text truncates with ellipsis (never overflows the block).
- [ ] Now-line: on today's day view, a red horizontal line spans all staff columns at the current time with a time pill (e.g. "10:48") at the left edge; it is absent on past/future dates; it advances without a page reload (≤1 min granularity).
- [x] Overlap: **N/A (2026-10-03) — structurally impossible.** Two *active* (`pending`/`confirmed`) appointments for the same staff member cannot overlap: the exclusion constraint (`create-appointment-transaction-design.md` §6.1) guarantees it. The only way two blocks could *visually* overlap is a terminal-state "ghost" (e.g. a cancelled booking whose slot was later legitimately re-booked) sharing a slot with an active one — closed by the new invariant that terminal-state appointments never render as time-blocks at all (`staff-manual-booking-calendar-design.md` §1 decision 7). No overlap-layout algorithm is built or needed.
- [ ] Status colors: every non-terminal block's color matches its status per the status→color map; changing a status updates the block color immediately with no manual refresh.
- [ ] Click empty slot opens the booking modal with that staff member and start time prefilled.
- [ ] Click block opens the details drawer: notes pinned at top (verbatim, highlighted), then time/staff/service/price, then actions (Confirm / Reschedule / Cancel / No-show / Complete per permissions).
- [ ] **[SPEC-DELTA]** Drag-and-drop reschedule: dragging a block to another time and/or staff column shows a semi-transparent ghost following the pointer; on drop, a confirm dialog (old → new) appears; success moves the block, 409 keeps it in place with the error shown. (Overrides spec §1.1/§12.1 per Steven 2026-10-03 — applied, see §1 decision 1 and §8a.)
- [ ] Badges: 🧪 on every test appointment (design retained, deferred from the V1 build); 💬 on every appointment with non-empty notes; pending-review appointments (public + notes + still pending) render bright red per batch #10; badges never overlap block text.

### P1 — workflow parity
- [ ] View switcher in toolbar: Day / Week(grid). Week grid shows 7 day-columns; switching views preserves the selected date.
- [ ] "Today" button returns to the current date from any date; ‹ › arrows step one day (day view) / one week (week view).
- [ ] Staff filter: dropdown to show all staff vs. scheduled-only vs. a single staff member.
- [ ] Calendar filters: filter visible appointments by status; **capability only in this batch** — at least status, unclaimed-only (#9), needs-review-only (#10). Saved, named presets (save/rename/delete) are a V1 fast-follow, not required for this item to pass.
- [ ] Search: a search box finds appointments by client name or phone and jumps the calendar to the match.
- [ ] Pending queue: pinned entry point in the top bar with a red count badge; badge hidden when the queue is empty; clicking it lists only pending appointments with one-tap Confirm.
- [ ] Time off: renders as a non-interactive gray band (hatched or solid — either is acceptable) inside the staff column; clicking it does nothing (no booking, no drawer).
- [ ] Instant reflect: creating, rescheduling, cancelling, or changing status updates the calendar in place within 1s, no manual refresh, no stale blocks.
- [ ] Batch cancel: shift-click/drag-select multiple blocks → one "Cancel selected" → per-appointment permission rules still enforced (others' appointments refuse with 404 and stay).
- [ ] Phone/tablet web usability: the calendar is fully usable at phone and tablet widths — no horizontal breakage, tap targets ≥44px. (Merged from the former separate "M1 mobile app parity" item, 2026-10-03 — no native app is in scope anywhere in this project; this is a restatement of responsive-web usability, not two requirements.)

### P2 — polish
- [ ] Color-source setting (Settings): color blocks by staff / service category / status; default = status.
- [ ] Week start day configurable (Sunday/Monday).
- [ ] Terminal states (cancelled/completed/no_show/expired) collapse by default in day view with an expander (list/audit view only, per the N2 invariant — never as blocks).
- [ ] "Awaiting completion": a confirmed appointment past `ends_at` shows the label with a manual Complete button (per spec §10).

---

## (d) Non-goals — Fresha things we deliberately do NOT copy

- **Bookable resources / rooms on the calendar** (Fresha: "Create and allocate resources… track equipment and spaces"). Our V1 models capacity as a store-level number; per-room scheduling is deferred to the med-aesthetics module. Copying this would fork the data model.
- **Custom appointment statuses** (Fresha: user-created "Arrived"/"Started"). Our state machine is fixed deliberately (`pending`→`confirmed`→`completed` / `cancelled` / `no_show` / `expired`); custom statuses would break reporting, reminders, and quota logic that branch on status.
- **Repeat appointments** (Fresha: "Create repeat appointments… populate up to one year"). Not in V1 scope; series semantics (edit-one-vs-series) are a separate design.
- **Group appointments on the calendar** (Fresha: multi-client group booking). Ours is V1.1 (`V1Backlog.md`); the calendar must not pre-build group visuals.
- **Waitlist UI** (Fresha: automated waitlist with matching). V1.1; the calendar only needs the "book into freed slot" path to keep working.
- **POS checkout tied to completion** (Fresha: Completed = checked out via POS with a sale linked). Payments are out of V1; our completed is a status flip, nothing more.
- **Marketplace-side panels** (the consumer listing card visible in Fresha's marketing screenshot). N/A to back-office.
- **Fresha's exact status→color values.** We keep our own map (notably our pending=amber + bright-red pending-review, and completed=green vs their Complete=Gray) — the point is a coherent, glanceable system, not their hex codes.
- **AI Concierge / marketing blast UI.** Out of scope.
- **"Booked = Blue" as default status.** We keep pending/confirmed semantics (quota, notifications, and the pending-review flow depend on them); Fresha's Booked≈our confirmed-for-auto_confirm-stores.

---

## Source list (verbatim URLs)

- https://www.fresha.com/help-center/knowledge-base/calendar/
- https://www.fresha.com/help-center/knowledge-base/calendar/487-organize-appointments-by-color-in-your-calendar
- https://www.fresha.com/help-center/knowledge-base/calendar/290-customize-your-calendar-view-1
- https://www.fresha.com/help-center/knowledge-base/calendar/600-update-appointment-statuses
- https://www.fresha.com/help-center/academy/run-your-business/schedule-appointments/lessons/3
- https://support.fresha.com/hc/en-us/articles/360005850694-Create-and-manage-resources
- https://fresha.com/for-business/features
- Screenshots inspected: thedigitalmerchant.com/wp-content/uploads/2025/09/Fresha-front-desk.jpg, images.fresha.com/production-static-fresha/assets/b2b-mktg/_next/static/media/calendarImg.3437414e.webp, blog.miosalon.com/wp-content/uploads/2026/02/Screenshot-2026-02-09-171840-1.png
- Secondary (medium confidence): https://github.com/sk-webmaker/appointment-software-
- Reviews: Capterra (shedul-com / fresha) — ease-of-use and color-coding praise; zombsio.org massage-software roundup (drag-and-drop mention)
